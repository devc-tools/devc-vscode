import * as path from 'path';
import * as vscode from 'vscode';
import { containerKey, Environment, sshKey } from './environments';
import { FocusTracker } from './focus';
import { GIT_SCHEME, parseGitHeadUri, readRepo, RepoInfo } from './git';
import { CONTAINER_SCHEME, SSH_SCHEME } from './paths';
import { RemoteShell } from './remoteShell';
import { hasAgent, SessionModel, SnapshotPane } from './sessions';
import { TilesPanels } from './tilesPanel';

export const WINDOW_TITLE_SETTING = 'windowTitle';
/** What this extension last wrote to `window.title`, to tell it from yours. */
export const TITLE_WRITTEN_KEY = 'herdr.windowTitle.written';
/** The workspace's own `window.title` (`{}` when unset), restored on clear. */
export const TITLE_ORIGINAL_KEY = 'herdr.windowTitle.original';
export const TITLE_DEBOUNCE_MS = 300;
export const TITLE_REFRESH_MS = 15000;
export const TITLE_STARTUP_MS = 5000;

/**
 * `template` with `${project}`, `${branch}`, `${folder}`, `${space}` and
 * `${title}` filled in for a repo; anything else in it is left as written.
 * `branch` is the folder's name for a detached HEAD. A `$` in a filled-in value
 * becomes `＄`: VS Code reads any `$` in `window.title` as the start of a
 * variable and drops the text after it. Trimmed.
 */
export function expandTitle(template: string, repo: RepoInfo, space?: string, title?: string): string {
	const folder = path.posix.basename(repo.toplevel);
	const values: Record<string, string> = {
		project: path.posix.basename(repo.main),
		branch: repo.branch ?? folder,
		folder,
		space: space ?? '',
		title: title ?? '',
	};
	return template
		.replace(/\$\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? values[name].replace(/\$/g, '＄') : match))
		.trim();
}

/**
 * The terminal title a pane's program set, as devc web shows it after the
 * pane's name: empty when it only repeats that name (its label, else its
 * folder) or, outside an agent, one of its folders — what a shell's prompt
 * usually sets.
 */
export function paneTitle(pane: Pick<SnapshotPane, 'terminal_title_stripped' | 'label' | 'cwd' | 'foreground_cwd' | 'agent'>): string {
	const title = pane.terminal_title_stripped?.trim() ?? '';
	const folders = [pane.cwd, pane.foreground_cwd].map((dir) => (dir ? path.posix.basename(dir) : ''));
	const name = pane.label?.trim() || folders[1] || folders[0];
	if (!title || !name || title === name || (!hasAgent(pane as SnapshotPane) && folders.includes(title))) {
		return '';
	}
	return title;
}

/** What the active editor tab points at. */
export type TitleSource =
	/** Leave the title as it is. */
	| { kind: 'keep' }
	/** No repo: back to the workspace's own title. */
	| { kind: 'restore' }
	/** A folder in an environment, and the pane's values when it is a pane's. */
	| { kind: 'dir'; shell: RemoteShell; dir: string; space?: string; title?: string; pane?: { sessionKey: string; paneId: string } };

/** The file a tab shows: a text editor's, a diff's modified side, a custom editor's or a notebook's. */
export function tabUri(input: unknown): vscode.Uri | undefined {
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return input.modified;
	}
	return undefined;
}

/** A file's folder in the environment that has it; `keep` for a URI no environment has. */
export function fileSource(uri: vscode.Uri, findEnv: (key: string) => Pick<Environment, 'shell'> | undefined, hostShell: RemoteShell): TitleSource {
	let shell: RemoteShell | undefined;
	let file: string | undefined;
	switch (uri.scheme) {
		case 'file':
			shell = hostShell;
			file = uri.fsPath;
			break;
		case 'git':
			shell = hostShell;
			file = uri.path;
			break;
		case CONTAINER_SCHEME:
			shell = findEnv(containerKey(uri.authority))?.shell;
			file = uri.path;
			break;
		case SSH_SCHEME:
			shell = findEnv(sshKey(uri.authority))?.shell;
			file = uri.path;
			break;
		case GIT_SCHEME: {
			const parsed = parseGitHeadUri(uri);
			shell = parsed && findEnv(parsed.envKey)?.shell;
			file = parsed && `${parsed.toplevel}/${parsed.file}`;
			break;
		}
	}
	return shell && file ? { kind: 'dir', shell, dir: path.posix.dirname(file) } : { kind: 'keep' };
}

/** Reads and writes the workspace's `window.title` and what this extension remembers of it. */
export interface TitleStore {
	/** `window.title`'s workspace value. */
	current(): string | undefined;
	/** Sets (or, `undefined`, removes) `window.title`'s workspace value. */
	write(value: string | undefined): Thenable<void>;
	state: Pick<vscode.Memento, 'get' | 'update'>;
}

/**
 * Puts `title` in `window.title`, or with `''` restores the workspace's own
 * title — but only when what is there is still what this extension wrote.
 */
export async function applyTitle(title: string, store: TitleStore): Promise<void> {
	const current = store.current();
	const written = store.state.get<string>(TITLE_WRITTEN_KEY);
	let original = store.state.get<{ value?: string }>(TITLE_ORIGINAL_KEY)?.value;
	if (current !== written) {
		// Set, changed or removed by hand since: that is the title to restore.
		original = current;
		await store.state.update(TITLE_ORIGINAL_KEY, { value: current });
	}
	if (!title) {
		if (written !== undefined) {
			if (current === written) {
				await store.write(original);
			}
			await store.state.update(TITLE_WRITTEN_KEY, undefined);
		}
		return;
	}
	if (title !== written) {
		await store.state.update(TITLE_WRITTEN_KEY, title);
	}
	if (title !== current) {
		await store.write(title);
	}
}

export interface WindowTitleDeps {
	model: Pick<SessionModel, 'connection' | 'onDidChange' | 'request'>;
	focus: Pick<FocusTracker, 'onDidReportFocus'>;
	panels: Pick<TilesPanels, 'activeSpacePanel' | 'onDidChangeTiles'>;
	findEnv(key: string): Pick<Environment, 'shell'> | undefined;
	hostShell: RemoteShell;
	state: Pick<vscode.Memento, 'get' | 'update'>;
	log(line: string): void;
	/** `herdr.windowTitle`, trimmed; `''` when off. Injected for tests. */
	template?: () => string;
	/** Whether the window has a saved `.code-workspace`. Injected for tests. */
	savedWorkspace?: () => boolean;
	/** The active editor tab's input. Injected for tests. */
	activeTabInput?: () => unknown;
	/** `window.title`'s workspace value. Injected for tests. */
	store?: Omit<TitleStore, 'state'>;
	/** The startup run's delay; 0 skips it. */
	startupMs?: number;
}

/**
 * Makes the window title name the repo or worktree of the active editor tab:
 * a herdr space tab's active pane's folder, else the tab's file. VS Code has
 * no API for the title, only the `window.title` setting, and only its
 * workspace value is this window's alone — so this is done only for a saved
 * workspace, where that value lives in the `.code-workspace` file.
 */
export class WindowTitleController implements vscode.Disposable {
	private readonly listeners: vscode.Disposable[];
	private timer: NodeJS.Timeout | undefined;
	private readonly refreshTimer: NodeJS.Timeout;
	private runs = 0;
	private lastPane: { sessionKey: string; paneId: string; dir: string } | undefined;
	private readonly store: TitleStore;

	constructor(private readonly deps: WindowTitleDeps) {
		const io = deps.store ?? {
			current: () => vscode.workspace.getConfiguration('window').inspect<string>('title')?.workspaceValue,
			write: (value: string | undefined) => vscode.workspace.getConfiguration('window').update('title', value, vscode.ConfigurationTarget.Workspace),
		};
		this.store = { ...io, state: deps.state };
		const schedule = () => this.schedule();
		this.listeners = [
			vscode.window.tabGroups.onDidChangeTabs(schedule),
			vscode.window.tabGroups.onDidChangeTabGroups(schedule),
			deps.focus.onDidReportFocus(schedule),
			deps.panels.onDidChangeTiles(schedule),
			deps.model.onDidChange(schedule),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration(`herdr.${WINDOW_TITLE_SETTING}`) || e.affectsConfiguration('window.title')) {
					schedule();
				}
			}),
		];
		this.refreshTimer = setInterval(() => void this.refresh(), TITLE_REFRESH_MS);
		const startup = deps.startupMs ?? TITLE_STARTUP_MS;
		if (startup > 0) {
			this.schedule(startup);
		}
	}

	private template(): string {
		return this.deps.template
			? this.deps.template()
			: (vscode.workspace.getConfiguration('herdr').get<string | null>(WINDOW_TITLE_SETTING)?.trim() ?? '');
	}

	private savedWorkspace(): boolean {
		return this.deps.savedWorkspace ? this.deps.savedWorkspace() : vscode.workspace.workspaceFile?.scheme === 'file';
	}

	schedule(delayMs = TITLE_DEBOUNCE_MS): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.update().catch((err) => this.deps.log(`window title: ${err instanceof Error ? err.message : String(err)}`));
		}, delayMs);
	}

	/** What the active editor tab points at. */
	source(): TitleSource {
		const panel = this.deps.panels.activeSpacePanel();
		if (panel) {
			const paneId = panel.activePaneId;
			const conn = this.deps.model.connection(panel.sessionKey);
			const snapshot = conn?.snapshot;
			const pane = paneId === undefined ? undefined : snapshot?.panes.find((p) => p.pane_id === paneId);
			if (!conn || !snapshot || !pane) {
				return { kind: 'keep' };
			}
			const dir = pane.foreground_cwd ?? pane.cwd;
			if (!dir) {
				return { kind: 'restore' };
			}
			return {
				kind: 'dir',
				shell: conn.env.shell,
				dir,
				space: snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label ?? '',
				title: paneTitle(pane),
				pane: { sessionKey: panel.sessionKey, paneId: pane.pane_id },
			};
		}
		const input = this.deps.activeTabInput ? this.deps.activeTabInput() : vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const uri = tabUri(input);
		return uri ? fileSource(uri, (key) => this.deps.findEnv(key), this.deps.hostShell) : { kind: 'keep' };
	}

	/** One pass: work out the title and write or restore it. */
	async update(): Promise<void> {
		const run = ++this.runs;
		if (!this.savedWorkspace()) {
			return;
		}
		const template = this.template();
		let title = '';
		if (template) {
			const source = this.source();
			this.lastPane = source.kind === 'dir' && source.pane ? { ...source.pane, dir: source.dir } : undefined;
			if (source.kind === 'keep') {
				return;
			}
			if (source.kind === 'dir') {
				const repo = await readRepo(source.shell, source.dir);
				title = repo ? expandTitle(template, repo, source.space, source.title) : '';
			}
		}
		if (run !== this.runs) {
			return;
		}
		await applyTitle(title, this.store);
	}

	/**
	 * The 15 s pass while the setting is on: catches a `git switch` in the same
	 * folder, and asks a pane for its directory — herdr 0.9.5 reports a `cd`
	 * with no event at all.
	 */
	private async refresh(): Promise<void> {
		if (!this.template()) {
			return;
		}
		const pane = this.lastPane;
		if (pane) {
			try {
				const result = (await this.deps.model.request(pane.sessionKey, 'pane.get', { pane_id: pane.paneId })) as
					| { pane?: { foreground_cwd?: unknown; cwd?: unknown } }
					| undefined;
				const dir = result?.pane?.foreground_cwd ?? result?.pane?.cwd;
				const conn = this.deps.model.connection(pane.sessionKey);
				if (typeof dir === 'string' && dir !== pane.dir && conn?.state === 'connected') {
					conn.refresh(); // The new snapshot has the new directory.
				}
			} catch (err) {
				this.deps.log(`window title: pane.get: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this.schedule();
	}

	dispose(): void {
		clearTimeout(this.timer);
		clearInterval(this.refreshTimer);
		for (const listener of this.listeners) {
			listener.dispose();
		}
	}
}
