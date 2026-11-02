import * as path from 'path';
import * as vscode from 'vscode';
import { GIT_EXTENSION_ID, GitApiLike, GitExtensionLike, PaneDecorations } from './decorations';
import { Environment } from './environments';
import { FocusTracker } from './focus';
import {
	Commit,
	CommitList,
	commitSubject,
	EMPTY_TREE,
	gitHeadUri,
	GitInfo,
	gitRevisionUri,
	isoLocal,
	readCommitFiles,
	readCommits,
	readHeadSha,
	readStatus,
	readToplevel,
	shortTime,
	TreeChange,
	TreeStatus,
} from './git';
import { environmentUri, EnvironmentPaths, isUnder, parseLinkText, resolveLinkPath } from './paths';
import { hasAgent, paneLabel, parsePaneMoved, SessionModel, Snapshot, SnapshotPane } from './sessions';
import { agentIcon } from './status';
import { TilesPanels } from './tilesPanel';
import { memoryMemento, TouchedStore } from './touched';
import { makePaneKey, splitPaneKey } from './tilesProtocol';
import { SessionsView } from './views/sessionsView';
import { agentTooltip, paneClickCommand, PaneRef } from './views/spacesView';

export const PANE_CONTEXT_VIEW = 'herdr.paneContext';
/** A click on a change row: its diff. */
export const OPEN_CHANGES_COMMAND = 'herdr.paneContext.openChanges';
/** Context key: whether the view is pinned. */
export const PANE_CONTEXT_PINNED_KEY = 'herdr.paneContextPinned';
/** Context key and workspaceState key: change sections show only the followed pane's files. */
export const PANE_FILES_ONLY_KEY = 'herdr.paneContext.paneFilesOnly';
export const NO_PANE_MESSAGE = 'Click into a herdr pane to see its files.';
/** A change section with nothing this pane touched. */
export const NOTHING_RECORDED = 'Nothing recorded for this pane';
/** First row of each change section for a shell pane in pane mode. */
export const NO_AGENT_NOTE = 'No agent in this pane: showing all files';
/** How many commits' files load at once (pane mode loads them all). */
const COMMIT_FILES_PARALLEL = 4;

const POLL_MS = 5000;
const WATCH_DEBOUNCE_MS = 500;

// ── The followed pane ───────────────────────────────────────────────────────

/**
 * The pane the view follows: the pinned one; else the window's last focused
 * tile; else, while no tile has ever been focused in this window, herdr's own
 * focused pane in the selected session. Focusing anything else in VS Code
 * changes none of these, so it does not change the view.
 */
export function followedPaneKey(state: {
	pinned?: string;
	lastFocused?: string;
	selectedSession?: string;
	herdrFocused?: string;
}): string | undefined {
	if (state.pinned ?? state.lastFocused) {
		return state.pinned ?? state.lastFocused;
	}
	return state.selectedSession && state.herdrFocused ? makePaneKey(state.selectedSession, state.herdrFocused) : undefined;
}

/** The view's header while no pane is followed (or the followed one cannot be found). */
export function paneContextMessage(pinned: boolean): string {
	return pinned ? 'The pinned pane is not available. Unpin to follow panes again.' : NO_PANE_MESSAGE;
}

/** The pane row's description: `<space> › <tab>`, then ` · not open in a tile` when no tile shows it. */
export function paneRowDescription(space: string, tab: string, shown: boolean): string {
	return `${space} › ${tab}${shown ? '' : ' · not open in a tile'}`;
}

/** The Repo row's description. */
export function repoDescription(git: Pick<GitInfo, 'head' | 'changes' | 'ahead' | 'behind'>): string {
	const changed = git.changes.length > 0 ? ` · ● ${git.changes.length}` : '';
	const ahead = git.ahead > 0 ? ` ↑${git.ahead}` : '';
	const behind = git.behind > 0 ? ` ↓${git.behind}` : '';
	return `⎇ ${git.head}${changed}${ahead}${behind}`;
}

/** Whether **Add to Workspace** applies: a plain file that is not a workspace folder yet. */
export function canAddToWorkspace(root: vscode.Uri, folders: readonly { uri: vscode.Uri }[] | undefined): boolean {
	return root.scheme === 'file' && !(folders ?? []).some((f) => f.uri.toString() === root.toString());
}

/** `readDirectory` entries for display: directories first, then files, each alphabetical. */
export function sortEntries(entries: [string, vscode.FileType][]): [string, vscode.FileType][] {
	const isDir = (type: vscode.FileType) => (type & vscode.FileType.Directory) !== 0;
	return [...entries].sort(
		(a, b) => Number(isDir(b[1])) - Number(isDir(a[1])) || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }) || a[0].localeCompare(b[0]),
	);
}

/** The parts of a `Memento` the toggle uses. */
export interface PaneFilesMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

/** **Show Only This Pane's Files** / **Show All Files**: the view, the workspaceState value and the context key. */
export async function applyPaneFilesOnly(
	on: boolean,
	view: Pick<PaneContextView, 'setPaneFilesOnly'>,
	memento: PaneFilesMemento,
	setContext: (key: string, value: boolean) => Thenable<unknown> = (key, value) => vscode.commands.executeCommand('setContext', key, value),
): Promise<void> {
	view.setPaneFilesOnly(on);
	await memento.update(PANE_FILES_ONLY_KEY, on);
	await setContext(PANE_FILES_ONLY_KEY, on);
}

/** The mode stored in workspaceState (default off). */
export function storedPaneFilesOnly(memento: PaneFilesMemento): boolean {
	return memento.get<boolean>(PANE_FILES_ONLY_KEY) === true;
}

// ── Tree nodes ──────────────────────────────────────────────────────────────

/** The followed pane itself: the first row. */
export interface PaneRowNode {
	type: 'pane';
	/** `<pane key>|pane`. */
	id: string;
	label: string;
	description: string;
	pane: SnapshotPane;
	ref: PaneRef;
	/** A tile in this window shows the pane. */
	shown: boolean;
}

export interface RootNode {
	type: 'root';
	id: string;
	label: string;
	description?: string;
	isRepo: boolean;
	canAdd: boolean;
	/** **Open in Source Control** applies: a `file:` repo. */
	scm?: boolean;
	/** **Terminal Here** applies: this machine. */
	terminal?: boolean;
}

export interface GroupNode {
	type: 'group';
	/** `changes`: Uncommitted; `commits`: Commits. */
	group: 'changes' | 'commits' | 'files';
	id: string;
	label: string;
	description?: string;
}

/** A commit in Commits; its files load on expand. */
export interface CommitNode {
	type: 'commit';
	/** `<root uri>|commit|<sha>`. */
	id: string;
	label: string;
	description: string;
	tooltip: string;
	commit: Commit;
}

/** A file a commit changed, against its first parent. */
export interface CommitFileNode {
	type: 'commitFile';
	id: string;
	label: string;
	description: string;
	path: string;
	status: TreeStatus;
	sha: string;
	/** The file at the first parent (the empty tree for a root commit). */
	leftUri: vscode.Uri;
	/** The file at the commit. */
	rightUri: vscode.Uri;
	/** The working tree file. */
	fileUri: vscode.Uri;
}

export interface ChangeNode {
	type: 'change';
	id: string;
	label: string;
	description: string;
	uri: vscode.Uri;
	/** The same path as HEAD has it. */
	headUri: vscode.Uri;
	/** Nothing to open in the working tree: deleted. */
	deleted: boolean;
	/** `git status` lists a wholly untracked directory as one path, ending in `/`. */
	directory: boolean;
}

export interface EntryNode {
	type: 'entry';
	id: string;
	name: string;
	uri: vscode.Uri;
	directory: boolean;
	parent: GroupNode | EntryNode;
}

/** A directory that could not be read, a snapshot that failed (warning); or plain text (`plain`). */
export interface NoteNode {
	type: 'note';
	id: string;
	label: string;
	plain?: boolean;
}

export type PaneContextNode = PaneRowNode | RootNode | GroupNode | ChangeNode | CommitNode | CommitFileNode | EntryNode | NoteNode;

/** The Repo row's context value, which the inline actions' `when` clauses read. */
export function rootContextValue(node: Pick<RootNode, 'canAdd' | 'scm' | 'terminal'>): string {
	return `herdr.paneContext.root${node.canAdd ? ' addable' : ''}${node.scm ? ' scm' : ''}${node.terminal ? ' terminal' : ''}`;
}

/** The pane row's context value: Show Pane applies when it is ` hidden`. */
export function paneRowContextValue(node: Pick<PaneRowNode, 'shown'>): string {
	return `herdr.paneContext.pane${node.shown ? '' : ' hidden'}`;
}

/** A commit row's description: `<sha7> · <time>`. */
export function commitDescription(commit: Pick<Commit, 'sha' | 'at'>, now: number = Date.now()): string {
	return `${commit.sha.slice(0, 7)} · ${shortTime(commit.at, now)}`;
}

/** A commit row's tooltip: the full SHA, author and date, and the message. */
export function commitTooltip(commit: Commit): string {
	return `${commit.sha}\n${commit.author} · ${isoLocal(commit.at)}\n\n${commit.body.trim()}`;
}

/** Whether a change row's path (`dir/` for an untracked directory) is among the touched paths. */
export function touchedChange(changePath: string, touched: ReadonlySet<string>): boolean {
	if (!changePath.endsWith('/')) {
		return touched.has(changePath);
	}
	for (const p of touched) {
		if (p.startsWith(changePath)) {
			return true;
		}
	}
	return false;
}

/** `<marker> · <description>`, or the marker alone; unchanged without one. */
export function markedDescription(marker: string | undefined, description: string | undefined): string | undefined {
	if (!marker) {
		return description;
	}
	return description ? `${marker} · ${description}` : marker;
}

export function paneContextItem(node: PaneContextNode): vscode.TreeItem {
	switch (node.type) {
		case 'pane': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.description = node.description;
			const agent = hasAgent(node.pane);
			item.iconPath = agentIcon(node.pane);
			item.tooltip = agent ? agentTooltip(node.pane) : node.pane.pane_id;
			item.contextValue = paneRowContextValue(node);
			item.command = paneClickCommand(node.ref);
			return item;
		}
		case 'root': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.description = node.description;
			item.iconPath = new vscode.ThemeIcon(node.isRepo ? 'repo' : 'folder');
			item.contextValue = rootContextValue(node);
			return item;
		}
		case 'group': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.id = node.id;
			item.description = node.description;
			item.contextValue = `herdr.paneContext.${node.group}`;
			return item;
		}
		case 'commit': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = node.id;
			item.description = node.description;
			item.tooltip = node.tooltip;
			item.iconPath = new vscode.ThemeIcon('git-commit');
			item.contextValue = 'herdr.paneContext.commit';
			return item;
		}
		case 'commitFile': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.description = node.description;
			item.tooltip = node.path;
			item.iconPath = vscode.ThemeIcon.File;
			item.contextValue = 'herdr.paneContext.commitFile';
			item.command = { command: OPEN_CHANGES_COMMAND, title: 'Open Changes', arguments: [node] };
			return item;
		}
		case 'change': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.description = node.description;
			item.resourceUri = node.uri;
			item.iconPath = node.directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
			item.tooltip = node.uri.path;
			if (!node.directory) {
				item.contextValue = 'herdr.paneContext.change';
				item.command = { command: OPEN_CHANGES_COMMAND, title: 'Open Changes', arguments: [node] };
			}
			return item;
		}
		case 'entry': {
			const item = new vscode.TreeItem(node.name, node.directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.resourceUri = node.uri;
			item.iconPath = node.directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
			item.contextValue = node.directory ? 'herdr.paneContext.folder' : 'herdr.paneContext.file';
			if (!node.directory) {
				item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
			}
			return item;
		}
		case 'note': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			if (!node.plain) {
				item.iconPath = new vscode.ThemeIcon('warning');
			}
			return item;
		}
	}
}

// ── The view ────────────────────────────────────────────────────────────────

/** The parts of a `TreeView` used here. */
export type PaneContextHost = Pick<vscode.TreeView<PaneContextNode>, 'message' | 'visible' | 'onDidChangeVisibility' | 'reveal' | 'dispose'>;

export interface PaneContextDeps {
	model: Pick<SessionModel, 'connection' | 'onDidChange' | 'onDidEvent' | 'request'>;
	focus: Pick<FocusTracker, 'lastFocused' | 'onDidChangeLastFocused' | 'herdrFocused'>;
	sessions: Pick<SessionsView, 'selected' | 'onDidChangeSelected'>;
	panels: Pick<TilesPanels, 'showsPane' | 'onDidChangeTiles' | 'onDidRequestLink'>;
	paths: Pick<EnvironmentPaths, 'mounts' | 'uriFor' | 'home'>;
	createHost(provider: vscode.TreeDataProvider<PaneContextNode>): PaneContextHost;
	log(line: string): void;
	/** The files each pane's agent touched (recorded by `TouchedRecorder`); in memory when absent. */
	touched?: TouchedStore;
	/** Whether the change sections start out showing only the pane's files. */
	paneFilesOnly?: boolean;
	/** The git markers of the followed repo. */
	decorations?: Pick<PaneDecorations, 'set'>;
	/** The clock, for tests. */
	now?: () => number;
}

/** How the change sections are filtered: not at all, a shell pane in pane mode, or to the touched paths. */
type SectionFilter = { kind: 'all' } | { kind: 'shell' } | { kind: 'pane'; touched: ReadonlySet<string> };

/** What the tree shows now: a pane's directory, resolved in its environment. */
interface Loaded {
	paneKey: string;
	env: Environment;
	dir: string;
	/** The toplevel when in a repo, else the directory. */
	rootPath: string;
	rootUri: vscode.Uri;
	toplevel?: string;
	git?: GitInfo;
	/** Commits: undefined when there is no HEAD (or no repo). */
	commits?: CommitList;
	mounts: Awaited<ReturnType<EnvironmentPaths['mounts']>>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The Active Pane view: the repo, changes and files of the followed pane. */
export class PaneContextView implements vscode.TreeDataProvider<PaneContextNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<PaneContextNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly host: PaneContextHost;
	private readonly disposables: vscode.Disposable[] = [];
	private pinnedKey: string | undefined;
	private loaded: Loaded | undefined;
	/** `<pane key>\n<dir>` of the load under way or done. */
	private loadedFor: string | undefined;
	private loadGen = 0;
	/** Entry nodes of the current root: `reveal` needs its parents to be the tree's own. */
	private readonly entries = new Map<string, EntryNode>();
	private filesGroup: GroupNode | undefined;
	/** The pane row, while a pane is followed and found. */
	private paneRow: PaneRowNode | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private watchedRoot: string | undefined;
	private watchTimer: NodeJS.Timeout | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private disposed = false;
	private readonly store: TouchedStore;
	private readonly now: () => number;
	private paneFilesOnlyNow: boolean;
	/** `<env key>\n<toplevel>\n<sha>` → the commit's files, for the view's lifetime. */
	private readonly commitFiles = new Map<string, Promise<TreeChange[] | undefined>>();

	constructor(private readonly deps: PaneContextDeps) {
		this.store = deps.touched ?? new TouchedStore(memoryMemento());
		if (!deps.touched) {
			this.disposables.push(this.store);
		}
		this.now = deps.now ?? Date.now;
		this.paneFilesOnlyNow = deps.paneFilesOnly ?? false;
		this.host = deps.createHost(this);
		this.disposables.push(
			this.emitter,
			this.host,
			deps.model.onDidChange(() => this.update()),
			this.store.onDidChange(() => {
				if (this.paneFilesOnlyNow && this.loaded) {
					this.emitter.fire();
				}
			}),
			deps.model.onDidEvent((e) => {
				if (e.event.event === 'pane.moved') {
					const moved = parsePaneMoved(e.event.data);
					if (moved && this.pinnedKey === makePaneKey(e.sessionKey, moved.from)) {
						this.pinnedKey = makePaneKey(e.sessionKey, moved.to);
						this.update();
					}
				} else if (e.event.event === 'pane.updated' && this.loaded?.paneKey === makePaneKey(e.sessionKey, String(e.event.data.pane_id ?? (e.event.data.pane as { pane_id?: unknown } | undefined)?.pane_id))) {
					this.scheduleReload();
				}
			}),
			deps.focus.onDidChangeLastFocused(() => this.update()),
			deps.sessions.onDidChangeSelected(() => this.update()),
			deps.panels.onDidChangeTiles(() => this.tilesChanged()),
			deps.panels.onDidRequestLink((link) => void this.openLink(link.paneKey, link.text)),
			this.host.onDidChangeVisibility(() => this.visibilityChanged()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()),
		);
		void vscode.commands.executeCommand('setContext', PANE_CONTEXT_PINNED_KEY, false);
		this.update();
		this.visibilityChanged();
	}

	// ── Following ───────────────────────────────────────────────────────────

	/** The followed pane's key, found or not. */
	get followed(): string | undefined {
		const selectedSession = this.deps.sessions.selected;
		return followedPaneKey({
			pinned: this.pinnedKey,
			lastFocused: this.deps.focus.lastFocused,
			selectedSession,
			herdrFocused: selectedSession ? this.deps.focus.herdrFocused(selectedSession) : undefined,
		});
	}

	get pinned(): boolean {
		return this.pinnedKey !== undefined;
	}

	/** Whether the change sections show only the followed pane's files. */
	get paneFilesOnly(): boolean {
		return this.paneFilesOnlyNow;
	}

	setPaneFilesOnly(on: boolean): void {
		if (on !== this.paneFilesOnlyNow) {
			this.paneFilesOnlyNow = on;
			this.emitter.fire();
		}
	}

	pin(): void {
		const key = this.followed;
		if (key) {
			this.setPinned(key);
		}
	}

	unpin(): void {
		this.setPinned(undefined);
	}

	private setPinned(key: string | undefined): void {
		this.pinnedKey = key;
		void vscode.commands.executeCommand('setContext', PANE_CONTEXT_PINNED_KEY, key !== undefined);
		this.update();
	}

	/** The followed pane in its session's latest snapshot. */
	private find(key: string): { pane: SnapshotPane; snapshot: Snapshot; env: Environment; ref: PaneRef } | undefined {
		const ref = splitPaneKey(key);
		const conn = this.deps.model.connection(ref.sessionKey);
		const snapshot = conn?.state === 'connected' ? conn.snapshot : undefined;
		const pane = snapshot?.panes.find((p) => p.pane_id === ref.paneId);
		return conn && snapshot && pane && { pane, snapshot, env: conn.env, ref };
	}

	/** Brings the header and the loaded directory in line with the followed pane. */
	private update(): void {
		if (this.disposed) {
			return;
		}
		const key = this.followed;
		const found = key ? this.find(key) : undefined;
		this.host.message = found ? undefined : paneContextMessage(this.pinned);
		this.updatePaneRow(key, found);
		const dir = found?.pane.foreground_cwd ?? found?.pane.cwd;
		if (!key || !found || !dir) {
			this.clear();
			return;
		}
		// The tree of a hidden view is not looked at: it loads when it is shown.
		if (this.host.visible && this.loadedFor !== `${key}\n${dir}`) {
			void this.load(key, found.env, dir);
		}
	}

	/**
	 * Brings the pane row in line with the snapshot: its name and status change
	 * constantly, so a change of the same pane fires that row alone.
	 */
	private updatePaneRow(key: string | undefined, found: ReturnType<PaneContextView['find']>): void {
		const previous = this.paneRow;
		if (!key || !found) {
			if (previous) {
				this.paneRow = undefined;
				this.emitter.fire();
			}
			return;
		}
		const { pane, snapshot, ref } = found;
		const shown = this.deps.panels.showsPane(ref.sessionKey, ref.paneId);
		const space = snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label ?? pane.workspace_id;
		const tab = snapshot.tabs.find((t) => t.tab_id === pane.tab_id)?.label ?? pane.tab_id;
		const next: PaneRowNode = {
			type: 'pane',
			id: `${key}|pane`,
			label: paneLabel(pane, snapshot),
			description: paneRowDescription(space, tab, shown),
			pane,
			ref,
			shown,
		};
		if (!previous || previous.id !== next.id) {
			this.paneRow = next;
			this.emitter.fire();
			return;
		}
		const same =
			previous.label === next.label &&
			previous.description === next.description &&
			previous.shown === next.shown &&
			previous.pane.agent === pane.agent &&
			previous.pane.agent_status === pane.agent_status &&
			previous.pane.state_since === pane.state_since;
		const agentChanged = hasAgent(previous.pane) !== hasAgent(pane);
		// The tree holds the node it was given: update it in place and fire it.
		Object.assign(previous, next);
		if (agentChanged && this.paneFilesOnlyNow) {
			this.emitter.fire(); // The sections' filter depends on it.
		} else if (!same) {
			this.emitter.fire(previous);
		}
	}

	private clear(): void {
		this.loadGen++;
		this.loadedFor = undefined;
		if (this.loaded) {
			this.loaded = undefined;
			this.deps.decorations?.set(undefined);
			this.setWatchedRoot(undefined);
			this.entries.clear();
			this.filesGroup = undefined;
			this.emitter.fire();
		}
	}

	private tilesChanged(): void {
		this.update(); // The pane row's `not open in a tile` and Show Pane.
	}

	private async load(paneKey: string, env: Environment, dir: string): Promise<void> {
		this.loadedFor = `${paneKey}\n${dir}`;
		const gen = ++this.loadGen;
		let toplevel: string | undefined;
		let git: GitInfo | undefined;
		let commits: CommitList | undefined;
		try {
			toplevel = await readToplevel(env.shell, dir);
			git = toplevel ? await readStatus(env.shell, toplevel) : undefined;
			commits = toplevel && git ? await readCommits(env.shell, toplevel) : undefined;
		} catch (err) {
			this.deps.log(`pane context: git in ${dir}: ${errorText(err)}`);
		}
		const mounts = await this.deps.paths.mounts(env);
		if (gen !== this.loadGen || this.disposed) {
			return;
		}
		const rootPath = toplevel ?? dir;
		const rootUri = environmentUri(env, rootPath, mounts);
		if (this.loaded?.rootUri.toString() !== rootUri.toString()) {
			this.entries.clear();
			this.filesGroup = undefined;
		}
		this.loaded = { paneKey, env, dir, rootPath, rootUri, toplevel, git, commits, mounts };
		this.setWatchedRoot(rootUri);
		this.pushDecorations();
		this.emitter.fire();
	}

	/** The followed repo's markers, for the decoration provider. */
	private pushDecorations(): void {
		const decorations = this.deps.decorations;
		const loaded = this.loaded;
		if (!decorations) {
			return;
		}
		const toplevel = loaded?.toplevel;
		if (!loaded || !toplevel || !loaded.git) {
			decorations.set(undefined);
			return;
		}
		const uriOf = (file: string) => environmentUri(loaded.env, `${toplevel}/${file.replace(/\/+$/, '')}`, loaded.mounts);
		decorations.set({
			status: loaded.git.changes.map((c) => ({ uri: uriOf(c.path), xy: c.xy })),
			untrackedDirs: loaded.git.changes.filter((c) => c.xy === '??' && c.path.endsWith('/')).map((c) => uriOf(c.path)),
		});
	}

	/** Reads everything again for the same pane. */
	private reload(): void {
		this.loadedFor = undefined;
		this.update();
	}

	private scheduleReload(): void {
		clearTimeout(this.watchTimer);
		this.watchTimer = setTimeout(() => this.reload(), WATCH_DEBOUNCE_MS);
	}

	/** **Refresh**: the pane's directory, status and tree. */
	refresh(): void {
		const key = this.followed;
		const conn = key ? this.deps.model.connection(splitPaneKey(key).sessionKey) : undefined;
		if (conn?.state === 'connected') {
			conn.refresh();
		}
		this.reload();
	}

	/** Plain files can be watched; other roots have the 5 s status poll. */
	private setWatchedRoot(root: vscode.Uri | undefined): void {
		const wanted = root?.scheme === 'file' ? root.toString() : undefined;
		if (wanted === this.watchedRoot) {
			return;
		}
		this.watchedRoot = wanted;
		this.watcher?.dispose();
		this.watcher = undefined;
		if (root && wanted) {
			this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
			const changed = () => this.scheduleReload();
			this.watcher.onDidCreate(changed);
			this.watcher.onDidChange(changed);
			this.watcher.onDidDelete(changed);
		}
	}

	private visibilityChanged(): void {
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.host.visible) {
			this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
			this.update();
			this.emitter.fire();
			void this.poll();
		}
	}

	/**
	 * The 5 s pass while the view is visible. herdr 0.9.5 reports a `cd` with no
	 * event at all, so besides git status this asks for the pane's directory.
	 */
	async poll(): Promise<void> {
		const loaded = this.loaded;
		if (this.polling || !loaded) {
			return;
		}
		this.polling = true;
		try {
			await this.checkDirectory(loaded);
			if (this.loaded === loaded && loaded.toplevel) {
				const git = await readStatus(loaded.env.shell, loaded.toplevel);
				if (this.loaded !== loaded) {
					return;
				}
				if (!git) {
					this.reload(); // The repo went away, or git refuses it now.
					return;
				}
				// Commits are read again only when HEAD moved.
				const head = await readHeadSha(loaded.env.shell, loaded.toplevel);
				const commits = head === loaded.commits?.head ? loaded.commits : await readCommits(loaded.env.shell, loaded.toplevel);
				if (this.loaded !== loaded) {
					return;
				}
				const gitChanged = JSON.stringify(git) !== JSON.stringify(loaded.git);
				const commitsChanged = commits !== loaded.commits;
				if (gitChanged || commitsChanged) {
					loaded.git = git;
					loaded.commits = commits;
					this.pushDecorations();
					this.emitter.fire();
				}
			}
		} catch (err) {
			this.deps.log(`pane context: poll: ${errorText(err)}`);
		} finally {
			this.polling = false;
		}
	}

	private async checkDirectory(loaded: Loaded): Promise<void> {
		const { sessionKey, paneId } = splitPaneKey(loaded.paneKey);
		const result = (await this.deps.model.request(sessionKey, 'pane.get', { pane_id: paneId })) as { pane?: { foreground_cwd?: unknown; cwd?: unknown } } | undefined;
		const dir = result?.pane?.foreground_cwd ?? result?.pane?.cwd;
		const conn = this.deps.model.connection(sessionKey);
		if (typeof dir === 'string' && dir !== loaded.dir && conn?.state === 'connected') {
			conn.refresh(); // The new snapshot has the new directory, and `update` follows it.
		}
	}

	// ── Tree ────────────────────────────────────────────────────────────────

	getTreeItem(node: PaneContextNode): vscode.TreeItem {
		return paneContextItem(node);
	}

	getParent(node: PaneContextNode): PaneContextNode | undefined {
		return node.type === 'entry' ? node.parent : undefined;
	}

	async getChildren(node?: PaneContextNode): Promise<PaneContextNode[]> {
		const loaded = this.loaded;
		if (!node) {
			const pane = this.paneRow ? [this.paneRow] : [];
			return loaded ? [...pane, ...this.topLevel(loaded)] : pane;
		}
		if (!loaded) {
			return [];
		}
		if (node.type === 'group') {
			switch (node.group) {
				case 'changes':
					return this.changeRows(loaded);
				case 'commits':
					return this.commitRows(loaded);
				case 'files':
					return this.entryRows(loaded.rootUri, node);
			}
		}
		if (node.type === 'commit') {
			return this.commitFileRows(loaded, node.commit);
		}
		return node.type === 'entry' && node.directory ? this.entryRows(node.uri, node) : [];
	}

	private topLevel(loaded: Loaded): PaneContextNode[] {
		const prefix = `${loaded.rootUri.toString()}|`;
		const root: RootNode = {
			type: 'root',
			id: `${prefix}root`,
			label: path.posix.basename(loaded.rootPath) || loaded.rootPath,
			description: loaded.git && repoDescription(loaded.git),
			isRepo: loaded.toplevel !== undefined,
			canAdd: canAddToWorkspace(loaded.rootUri, vscode.workspace.workspaceFolders),
			scm: loaded.rootUri.scheme === 'file' && loaded.toplevel !== undefined,
			terminal: loaded.env.kind === 'host',
		};
		const rows: PaneContextNode[] = [root];
		const filter = this.filterFor(loaded);
		const changes = loaded.git?.changes ?? [];
		if (loaded.toplevel && loaded.git && (changes.length > 0 || filter.kind === 'pane')) {
			const description =
				filter.kind === 'pane' ? `${changes.filter((c) => touchedChange(c.path, filter.touched)).length} of ${changes.length}` : String(changes.length);
			rows.push({ type: 'group', group: 'changes', id: `${prefix}changes`, label: 'Uncommitted', description });
		}
		if (loaded.toplevel && loaded.commits) {
			const description = `${loaded.commits.description}${filter.kind === 'pane' ? ' · this pane' : ''}`;
			rows.push({ type: 'group', group: 'commits', id: `${prefix}commits`, label: 'Commits', description });
		}
		rows.push(this.files(loaded));
		return rows;
	}

	/** Pane mode filters an agent pane's sections to its touched paths; a shell pane's stay whole. */
	private filterFor(loaded: Loaded): SectionFilter {
		if (!this.paneFilesOnlyNow || !loaded.toplevel) {
			return { kind: 'all' };
		}
		const pane = this.find(loaded.paneKey)?.pane;
		if (!pane || !hasAgent(pane)) {
			return { kind: 'shell' };
		}
		return { kind: 'pane', touched: new Set(this.store.get(loaded.paneKey, loaded.toplevel)?.paths ?? []) };
	}

	private note(id: string, label: string): NoteNode {
		return { type: 'note', id, label, plain: true };
	}

	private files(loaded: Loaded): GroupNode {
		this.filesGroup ??= { type: 'group', group: 'files', id: `${loaded.rootUri.toString()}|files`, label: 'Files' };
		return this.filesGroup;
	}

	private changeRows(loaded: Loaded): (ChangeNode | NoteNode)[] {
		const toplevel = loaded.toplevel;
		if (!toplevel || !loaded.git) {
			return [];
		}
		const prefix = `${loaded.rootUri.toString()}|changes`;
		const filter = this.filterFor(loaded);
		const changes = filter.kind === 'pane' ? loaded.git.changes.filter((c) => touchedChange(c.path, filter.touched)) : loaded.git.changes;
		if (filter.kind === 'pane' && changes.length === 0) {
			return [this.note(`${prefix}|none`, NOTHING_RECORDED)];
		}
		const head: NoteNode[] = filter.kind === 'shell' ? [this.note(`${prefix}|shell`, NO_AGENT_NOTE)] : [];
		return [...head, ...changes.map((change): ChangeNode => {
			const directory = change.path.endsWith('/');
			const file = change.path.replace(/\/+$/, '');
			const dir = path.posix.dirname(file);
			const xy = change.xy.trim();
			return {
				type: 'change',
				id: `${loaded.rootUri.toString()}|change|${change.path}`,
				label: path.posix.basename(file),
				description: dir === '.' ? xy : `${dir} · ${xy}`,
				uri: environmentUri(loaded.env, `${toplevel}/${file}`, loaded.mounts),
				headUri: gitHeadUri(loaded.env.key, toplevel, file),
				deleted: change.xy.includes('D'),
				directory,
			};
		})];
	}

	/** A commit's files, loaded once per view. */
	private filesOf(loaded: Loaded, commit: Commit): Promise<TreeChange[] | undefined> {
		const key = `${loaded.env.key}\n${loaded.toplevel}\n${commit.sha}`;
		let files = this.commitFiles.get(key);
		if (!files) {
			files = readCommitFiles(loaded.env.shell, loaded.toplevel!, commit).catch((err) => {
				this.deps.log(`pane context: files of ${commit.sha}: ${errorText(err)}`);
				return undefined;
			});
			this.commitFiles.set(key, files);
			// A failure is not kept: the next expand asks again.
			void files.then((f) => f === undefined && this.commitFiles.get(key) === files && this.commitFiles.delete(key));
		}
		return files;
	}

	private commitNode(loaded: Loaded, commit: Commit): CommitNode {
		return {
			type: 'commit',
			id: `${loaded.rootUri.toString()}|commit|${commit.sha}`,
			label: commitSubject(commit),
			description: commitDescription(commit, this.now()),
			tooltip: commitTooltip(commit),
			commit,
		};
	}

	private async commitRows(loaded: Loaded): Promise<(CommitNode | NoteNode)[]> {
		const commits = loaded.commits?.commits ?? [];
		const prefix = `${loaded.rootUri.toString()}|commits`;
		const filter = this.filterFor(loaded);
		if (filter.kind !== 'pane') {
			const head: NoteNode[] = filter.kind === 'shell' ? [this.note(`${prefix}|shell`, NO_AGENT_NOTE)] : [];
			return [...head, ...commits.map((c) => this.commitNode(loaded, c))];
		}
		// Whether a commit has any touched file is known only once its files load: load them all, a few at a time.
		const files: (TreeChange[] | undefined)[] = new Array(commits.length);
		let next = 0;
		const worker = async () => {
			while (next < commits.length) {
				const i = next++;
				files[i] = await this.filesOf(loaded, commits[i]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(COMMIT_FILES_PARALLEL, commits.length) }, worker));
		const kept = commits.filter((_c, i) => (files[i] ?? []).some((f) => filter.touched.has(f.path)));
		return kept.length > 0 ? kept.map((c) => this.commitNode(loaded, c)) : [this.note(`${prefix}|none`, NOTHING_RECORDED)];
	}

	private async commitFileRows(loaded: Loaded, commit: Commit): Promise<(CommitFileNode | NoteNode)[]> {
		const toplevel = loaded.toplevel;
		if (!toplevel) {
			return [];
		}
		const prefix = `${loaded.rootUri.toString()}|commit|${commit.sha}`;
		const files = await this.filesOf(loaded, commit);
		if (!files) {
			return [{ type: 'note', id: `${prefix}|note`, label: "Could not read the commit's files" }];
		}
		const filter = this.filterFor(loaded);
		const shown = filter.kind === 'pane' ? files.filter((f) => filter.touched.has(f.path)) : files;
		const parent = commit.parents[0] ?? EMPTY_TREE;
		return shown.map((f) => {
			const dir = path.posix.dirname(f.path);
			return {
				type: 'commitFile',
				id: `${prefix}|${f.path}`,
				label: path.posix.basename(f.path),
				description: dir === '.' ? f.status : `${dir} · ${f.status}`,
				path: f.path,
				status: f.status,
				sha: commit.sha,
				leftUri: gitRevisionUri(loaded.env.key, toplevel, f.path, parent),
				rightUri: gitRevisionUri(loaded.env.key, toplevel, f.path, commit.sha),
				fileUri: environmentUri(loaded.env, `${toplevel}/${f.path}`, loaded.mounts),
			};
		});
	}

	private async entryRows(dir: vscode.Uri, parent: GroupNode | EntryNode): Promise<(EntryNode | NoteNode)[]> {
		let listed: [string, vscode.FileType][];
		try {
			listed = await vscode.workspace.fs.readDirectory(dir);
		} catch (err) {
			return [{ type: 'note', id: `${parent.id}|note`, label: errorText(err) }];
		}
		return sortEntries(listed).map(([name, type]) => this.entry(parent, name, (type & vscode.FileType.Directory) !== 0));
	}

	private entry(parent: GroupNode | EntryNode, name: string, directory: boolean): EntryNode {
		const id = `${parent.id}/${name}`;
		let node = this.entries.get(id);
		if (!node) {
			const base = parent.type === 'entry' ? parent.uri : this.loaded!.rootUri;
			node = { type: 'entry', id, name, uri: vscode.Uri.joinPath(base, name), directory, parent };
			this.entries.set(id, node);
		}
		node.directory = directory;
		return node;
	}

	// ── Actions ─────────────────────────────────────────────────────────────

	/** Never automatic: workspace folders change only here. */
	addToWorkspace(): void {
		const root = this.loaded?.rootUri;
		if (root && canAddToWorkspace(root, vscode.workspace.workspaceFolders)) {
			vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root });
		}
	}

	async splitPane(): Promise<void> {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		const { sessionKey, paneId } = splitPaneKey(loaded.paneKey);
		try {
			await this.deps.model.request(sessionKey, 'pane.split', { target_pane_id: paneId, direction: 'down', cwd: loaded.rootPath, focus: false });
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${errorText(err)}`);
		}
	}

	async showPane(): Promise<void> {
		const key = this.followed;
		if (key) {
			const target = paneClickCommand(splitPaneKey(key));
			await vscode.commands.executeCommand(target.command, ...(target.arguments ?? []));
		}
	}

	async openChanges(node?: ChangeNode | CommitFileNode): Promise<void> {
		if (!node) {
			return;
		}
		if (node.type === 'commitFile') {
			if (node.status === 'D') {
				await vscode.commands.executeCommand('vscode.open', node.leftUri);
				return;
			}
			await vscode.commands.executeCommand('vscode.diff', node.leftUri, node.rightUri, `${node.label} (${node.sha.slice(0, 7)})`);
			return;
		}
		if (node.deleted) {
			await vscode.commands.executeCommand('vscode.open', node.headUri);
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', node.headUri, node.uri, `${node.label} (HEAD ↔ working tree)`);
	}

	/**
	 * **Open File** on a change row: the file as it is now; a deleted one as it
	 * was. On a commit's file: the working tree file while it exists, else the
	 * commit's version (the parent's for a deletion).
	 */
	async openFile(node?: ChangeNode | CommitFileNode): Promise<void> {
		if (!node) {
			return;
		}
		if (node.type === 'commitFile') {
			const exists = await this.exists(node.fileUri);
			await vscode.commands.executeCommand('vscode.open', exists ? node.fileUri : node.status === 'D' ? node.leftUri : node.rightUri);
			return;
		}
		await vscode.commands.executeCommand('vscode.open', node.deleted ? node.headUri : node.uri);
	}

	/** **Open in Source Control**: VS Code's Git opens the repo (for this window session), and its view shows. */
	async openSourceControl(): Promise<void> {
		const root = this.loaded?.rootUri;
		if (!root || root.scheme !== 'file' || !this.loaded?.toplevel) {
			return;
		}
		let api: GitApiLike | undefined;
		try {
			const ext = vscode.extensions.getExtension<GitExtensionLike>(GIT_EXTENSION_ID);
			const exports = ext && (ext.isActive ? ext.exports : await ext.activate());
			api = exports?.enabled ? exports.getAPI(1) : undefined;
		} catch {
			api = undefined;
		}
		if (!api) {
			void vscode.window.showWarningMessage("herdr: VS Code's Git extension is not available.");
			return;
		}
		const repo = api.getRepository(root) ?? (await api.openRepository?.(root)) ?? null;
		if (repo === null) {
			void vscode.window.showWarningMessage(`herdr: VS Code's Git did not open ${root.fsPath}. See Output › Git.`);
			return;
		}
		await vscode.commands.executeCommand('workbench.view.scm');
	}

	/** **Terminal Here** (this machine only): VS Code's terminal, in the editor area, in the root. */
	openTerminal(): vscode.Terminal | undefined {
		const loaded = this.loaded;
		if (!loaded || loaded.env.kind !== 'host') {
			return undefined;
		}
		const terminal = vscode.window.createTerminal({
			name: path.posix.basename(loaded.rootPath) || loaded.rootPath,
			cwd: loaded.rootPath,
			location: vscode.TerminalLocation.Editor,
		});
		terminal.show();
		return terminal;
	}

	/** Where a new file goes: into a folder row, beside a file row, else at the root. */
	private parentOf(node: PaneContextNode | undefined): vscode.Uri | undefined {
		if (node?.type === 'entry') {
			return node.directory ? node.uri : vscode.Uri.joinPath(node.uri, '..');
		}
		return this.loaded?.rootUri;
	}

	private async guard(what: string, run: () => Thenable<unknown>): Promise<boolean> {
		try {
			await run();
			this.emitter.fire();
			return true;
		} catch (err) {
			void vscode.window.showErrorMessage(`herdr: could not ${what}: ${errorText(err)}`);
			return false;
		}
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		return vscode.workspace.fs.stat(uri).then(
			() => true,
			() => false,
		);
	}

	async createEntry(parent: vscode.Uri, name: string, kind: 'file' | 'folder'): Promise<vscode.Uri | undefined> {
		const uri = vscode.Uri.joinPath(parent, name);
		if (await this.exists(uri)) {
			void vscode.window.showWarningMessage(`herdr: ${name} already exists.`);
			return undefined;
		}
		const made = await this.guard(`create ${name}`, () =>
			kind === 'file' ? vscode.workspace.fs.writeFile(uri, new Uint8Array()) : vscode.workspace.fs.createDirectory(uri),
		);
		return made ? uri : undefined;
	}

	async renameEntry(uri: vscode.Uri, name: string): Promise<boolean> {
		return this.guard(`rename ${path.posix.basename(uri.path)}`, () => vscode.workspace.fs.rename(uri, vscode.Uri.joinPath(uri, '..', name), { overwrite: false }));
	}

	async deleteEntry(uri: vscode.Uri): Promise<boolean> {
		return this.guard(`delete ${path.posix.basename(uri.path)}`, () => vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }));
	}

	async promptNew(node: PaneContextNode | undefined, kind: 'file' | 'folder'): Promise<void> {
		const parent = this.parentOf(node);
		const name = parent && (await vscode.window.showInputBox({ prompt: `New ${kind} in ${path.posix.basename(parent.path) || parent.path}`, validateInput: validName }));
		if (!parent || !name) {
			return;
		}
		const uri = await this.createEntry(parent, name, kind);
		if (uri && kind === 'file') {
			await vscode.commands.executeCommand('vscode.open', uri);
		}
	}

	async promptRename(node?: PaneContextNode): Promise<void> {
		if (node?.type !== 'entry') {
			return;
		}
		const name = await vscode.window.showInputBox({ prompt: `New name of "${node.name}"`, value: node.name, validateInput: validName });
		if (name && name !== node.name) {
			await this.renameEntry(node.uri, name);
		}
	}

	async promptDelete(node?: PaneContextNode): Promise<void> {
		if (node?.type !== 'entry') {
			return;
		}
		const answer = await vscode.window.showWarningMessage(`Delete "${node.name}"${node.directory ? ' and everything in it' : ''}? This cannot be undone.`, { modal: true }, 'Delete');
		if (answer === 'Delete') {
			await this.deleteEntry(node.uri);
		}
	}

	// ── Terminal links ──────────────────────────────────────────────────────

	/** A path printed in a tile: resolved where the pane runs, opened beside the tiles. */
	async openLink(paneKey: string, text: string): Promise<void> {
		const found = this.find(paneKey);
		if (!found) {
			return;
		}
		const { env, pane } = found;
		const { file, line, col } = parseLinkText(text);
		try {
			const home = file.startsWith('~/') ? await this.deps.paths.home(env) : undefined;
			const target = resolveLinkPath(file, pane.foreground_cwd ?? pane.cwd, home);
			if (!target || (await env.shell.run(['test', '-e', target], { timeoutMs: 15000 })).exitCode !== 0) {
				return;
			}
			if ((await env.shell.run(['test', '-d', target], { timeoutMs: 15000 })).exitCode === 0) {
				await this.revealDirectory(target);
				return;
			}
			const at = line !== undefined ? new vscode.Position(Math.max(line - 1, 0), Math.max((col ?? 1) - 1, 0)) : undefined;
			await vscode.commands.executeCommand('vscode.open', await this.deps.paths.uriFor(env, target), {
				viewColumn: vscode.ViewColumn.Beside,
				selection: at && new vscode.Range(at, at),
			});
		} catch (err) {
			this.deps.log(`pane context: link ${text}: ${errorText(err)}`);
		}
	}

	/** Shows a directory in Files, when it is under the followed pane's root. */
	async revealDirectory(dir: string): Promise<void> {
		// A hidden view has not followed anything yet.
		const key = this.followed;
		const found = key ? this.find(key) : undefined;
		const current = found?.pane.foreground_cwd ?? found?.pane.cwd;
		if (key && found && current && this.loadedFor !== `${key}\n${current}`) {
			await this.load(key, found.env, current);
		}
		const loaded = this.loaded;
		if (!loaded || !isUnder(dir, loaded.rootPath)) {
			return;
		}
		let node: GroupNode | EntryNode = this.files(loaded);
		for (const name of dir.slice(loaded.rootPath.replace(/\/+$/, '').length).split('/').filter(Boolean)) {
			node = this.entry(node, name, true);
		}
		await this.host.reveal(node, { expand: true, select: true, focus: false });
	}

	dispose(): void {
		this.disposed = true;
		this.deps.decorations?.set(undefined);
		clearInterval(this.pollTimer);
		clearTimeout(this.watchTimer);
		this.watcher?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

/** A name for a new or renamed file: one path segment. */
function validName(name: string): string | undefined {
	return !name.trim() || name.includes('/') || name === '.' || name === '..' ? 'Enter a name, without a /.' : undefined;
}
