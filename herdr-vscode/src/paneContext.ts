import * as path from 'path';
import * as vscode from 'vscode';
import { Environment } from './environments';
import { FocusTracker } from './focus';
import { gitHeadUri, GitInfo, readStatus, readToplevel } from './git';
import { parsePaneMoved } from './layouts';
import { environmentUri, EnvironmentPaths, isUnder, parseLinkText, resolveLinkPath } from './paths';
import { paneLabel, SessionModel, Snapshot, SnapshotPane } from './sessions';
import { TilesPanels } from './tilesPanel';
import { makePaneKey, splitPaneKey } from './tilesProtocol';
import { SessionsView } from './views/sessionsView';
import { openPaneIn, paneClickCommand, paneDescription, paneTreeItem, PaneRef } from './views/spacesView';

export const PANE_CONTEXT_VIEW = 'herdr.paneContext';
/** Context key: whether the view is pinned. */
export const PANE_CONTEXT_PINNED_KEY = 'herdr.paneContextPinned';
export const NO_PANE_MESSAGE = 'Click into a herdr pane to see its files.';

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

/** The view's header. `pane` is undefined when the followed pane cannot be found. */
export function paneContextMessage(
	pane: { label: string; space: string; tab: string; shown: boolean } | undefined,
	pinned: boolean,
): string {
	if (!pane) {
		return pinned ? 'The pinned pane is not available. Unpin to follow panes again.' : NO_PANE_MESSAGE;
	}
	return `${pane.label} · ${pane.space} › ${pane.tab}${pinned ? ' · pinned' : ''}${pane.shown ? '' : ' · not open in a tile'}`;
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

// ── Tree nodes ──────────────────────────────────────────────────────────────

export interface RootNode {
	type: 'root';
	id: string;
	label: string;
	description?: string;
	isRepo: boolean;
	canAdd: boolean;
	showable: boolean;
}

export interface GroupNode {
	type: 'group';
	group: 'changes' | 'files' | 'panes';
	id: string;
	label: string;
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

export interface PaneRowNode {
	type: 'pane';
	id: string;
	label: string;
	description?: string;
	pane: SnapshotPane;
	ref: PaneRef;
}

/** A directory that could not be read. */
export interface NoteNode {
	type: 'note';
	id: string;
	label: string;
}

export type PaneContextNode = RootNode | GroupNode | ChangeNode | EntryNode | PaneRowNode | NoteNode;

/** The Repo row's context value, which the inline actions' `when` clauses read. */
export function rootContextValue(node: Pick<RootNode, 'canAdd' | 'showable'>): string {
	return `herdr.paneContext.root${node.canAdd ? ' addable' : ''}${node.showable ? ' showable' : ''}`;
}

export function paneContextItem(node: PaneContextNode): vscode.TreeItem {
	switch (node.type) {
		case 'root': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.description = node.description;
			item.iconPath = new vscode.ThemeIcon(node.isRepo ? 'repo' : 'folder');
			item.contextValue = rootContextValue(node);
			return item;
		}
		case 'group': {
			const expanded = node.group === 'panes' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
			const item = new vscode.TreeItem(node.label, expanded);
			item.id = node.id;
			item.contextValue = `herdr.paneContext.${node.group}`;
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
				item.command = { command: 'vscode.open', title: 'Open', arguments: [node.deleted ? node.headUri : node.uri] };
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
		case 'pane':
			return paneTreeItem(node.id, node.label, node.description, node.pane, node.ref);
		case 'note': {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = node.id;
			item.iconPath = new vscode.ThemeIcon('warning');
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
}

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
	mounts: Awaited<ReturnType<EnvironmentPaths['mounts']>>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The Pane Context view: the repo, changes and files of the followed pane. */
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
	private panesGroup: GroupNode | undefined;
	/** What Other Panes last showed, and whether the Repo row last offered Show Pane. */
	private otherPanesShown = '';
	private showableShown: boolean | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private watchedRoot: string | undefined;
	private watchTimer: NodeJS.Timeout | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private disposed = false;

	constructor(private readonly deps: PaneContextDeps) {
		this.host = deps.createHost(this);
		this.disposables.push(
			this.emitter,
			this.host,
			deps.model.onDidChange(() => this.update()),
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
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('herdr.openPaneIn')) {
					this.emitter.fire();
				}
			}),
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
		if (found) {
			const { pane, snapshot, ref } = found;
			this.host.message = paneContextMessage(
				{
					label: paneLabel(pane, snapshot),
					space: snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label ?? pane.workspace_id,
					tab: snapshot.tabs.find((t) => t.tab_id === pane.tab_id)?.label ?? pane.tab_id,
					shown: this.deps.panels.showsPane(ref.sessionKey, ref.paneId),
				},
				this.pinned,
			);
		} else {
			this.host.message = paneContextMessage(undefined, this.pinned);
		}
		const dir = found?.pane.foreground_cwd ?? found?.pane.cwd;
		if (!key || !found || !dir) {
			this.clear();
			return;
		}
		// The tree of a hidden view is not looked at: it loads when it is shown.
		if (this.host.visible && this.loadedFor !== `${key}\n${dir}`) {
			void this.load(key, found.env, dir);
		}
		this.refreshOtherPanes();
	}

	/** Only that section: terminal titles change all the time, and Files may be remote. */
	private refreshOtherPanes(): void {
		if (!this.loaded || !this.panesGroup) {
			return;
		}
		const shown = JSON.stringify(this.otherPanes(this.loaded).map((p) => [p.id, p.label, p.description, p.pane.agent_status]));
		if (shown !== this.otherPanesShown) {
			this.otherPanesShown = shown;
			this.emitter.fire(this.panesGroup);
		}
	}

	private clear(): void {
		this.loadGen++;
		this.loadedFor = undefined;
		if (this.loaded) {
			this.loaded = undefined;
			this.setWatchedRoot(undefined);
			this.entries.clear();
			this.filesGroup = undefined;
			this.panesGroup = undefined;
			this.emitter.fire();
		}
	}

	private tilesChanged(): void {
		this.update();
		const key = this.loaded?.paneKey;
		const showable = key !== undefined && !this.deps.panels.showsPane(splitPaneKey(key).sessionKey, splitPaneKey(key).paneId);
		if (key && showable !== this.showableShown) {
			this.emitter.fire(); // The Repo row's Show Pane.
		}
	}

	private async load(paneKey: string, env: Environment, dir: string): Promise<void> {
		this.loadedFor = `${paneKey}\n${dir}`;
		const gen = ++this.loadGen;
		let toplevel: string | undefined;
		let git: GitInfo | undefined;
		try {
			toplevel = await readToplevel(env.shell, dir);
			git = toplevel ? await readStatus(env.shell, toplevel) : undefined;
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
		this.loaded = { paneKey, env, dir, rootPath, rootUri, toplevel, git, mounts };
		this.setWatchedRoot(rootUri);
		this.emitter.fire();
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
				} else if (JSON.stringify(git) !== JSON.stringify(loaded.git)) {
					loaded.git = git;
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
		if (!loaded) {
			return [];
		}
		if (!node) {
			return this.topLevel(loaded);
		}
		if (node.type === 'group') {
			switch (node.group) {
				case 'changes':
					return this.changeRows(loaded);
				case 'files':
					return this.entryRows(loaded.rootUri, node);
				case 'panes':
					return this.otherPanes(loaded);
			}
		}
		return node.type === 'entry' && node.directory ? this.entryRows(node.uri, node) : [];
	}

	private topLevel(loaded: Loaded): PaneContextNode[] {
		const prefix = `${loaded.rootUri.toString()}|`;
		const { sessionKey, paneId } = splitPaneKey(loaded.paneKey);
		this.showableShown = !this.deps.panels.showsPane(sessionKey, paneId);
		const root: RootNode = {
			type: 'root',
			id: `${prefix}root`,
			label: path.posix.basename(loaded.rootPath) || loaded.rootPath,
			description: loaded.git && repoDescription(loaded.git),
			isRepo: loaded.toplevel !== undefined,
			canAdd: canAddToWorkspace(loaded.rootUri, vscode.workspace.workspaceFolders),
			showable: this.showableShown,
		};
		const rows: PaneContextNode[] = [root];
		if (loaded.git?.changes.length) {
			rows.push({ type: 'group', group: 'changes', id: `${prefix}changes`, label: 'Changes' });
		}
		const panesId = `${loaded.paneKey}|panes`;
		if (this.panesGroup?.id !== panesId) {
			this.panesGroup = { type: 'group', group: 'panes', id: panesId, label: 'Other Panes in This Space' };
		}
		rows.push(this.files(loaded), this.panesGroup);
		return rows;
	}

	private files(loaded: Loaded): GroupNode {
		this.filesGroup ??= { type: 'group', group: 'files', id: `${loaded.rootUri.toString()}|files`, label: 'Files' };
		return this.filesGroup;
	}

	private changeRows(loaded: Loaded): ChangeNode[] {
		const toplevel = loaded.toplevel;
		if (!toplevel || !loaded.git) {
			return [];
		}
		return loaded.git.changes.map((change) => {
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

	private otherPanes(loaded: Loaded): PaneRowNode[] {
		const found = this.find(loaded.paneKey);
		if (!found) {
			return [];
		}
		const { pane, snapshot, ref } = found;
		return snapshot.panes
			.filter((p) => p.workspace_id === pane.workspace_id && p.pane_id !== pane.pane_id)
			.map((p) => ({
				type: 'pane',
				id: `${ref.sessionKey}|pane|${p.pane_id}`,
				label: paneLabel(p, snapshot),
				description: paneDescription(p),
				pane: p,
				ref: { sessionKey: ref.sessionKey, paneId: p.pane_id },
			}));
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
			const target = paneClickCommand(openPaneIn(), splitPaneKey(key));
			await vscode.commands.executeCommand(target.command, ...(target.arguments ?? []));
		}
	}

	async openChanges(node?: ChangeNode): Promise<void> {
		if (!node) {
			return;
		}
		if (node.deleted) {
			await vscode.commands.executeCommand('vscode.open', node.headUri);
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', node.headUri, node.uri, `${node.label} (HEAD ↔ working tree)`);
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
