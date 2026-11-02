import * as os from 'os';
import * as vscode from 'vscode';
import { AgentReviewController } from './agentReview';
import { AgentStates } from './agentState';
import { PaneDecorations } from './decorations';
import { containerKey, Environments, HOST_KEY, readSettings, sshKey } from './environments';
import { FocusTracker, REVEAL_FOCUSED_COMMAND } from './focus';
import { GIT_SCHEME, GitHeadContentProvider } from './git';
import { applyPaneFilesOnly, ChangeNode, CommitFileNode, PANE_CONTEXT_VIEW, PANE_FILES_ONLY_KEY, PaneContextNode, PaneContextView, storedPaneFilesOnly } from './paneContext';
import { CONTAINER_SCHEME, EnvironmentPaths, SSH_SCHEME } from './paths';
import { ChangePoller, ContainerFileSystemProvider, PolledProvider, SshFileSystemProvider } from './remoteFs';
import { createdTabId, sessionDeleteArgv, sessionStopArgv, spaceCwd, splitTarget, startContainerSession, startHostSession, whenTabKnown } from './sessionControl';
import { SessionModel, sessionKey } from './sessions';
import { SidebarConfigSource, sidebarConfigPath } from './sidebarConfig';
import { SpaceGit } from './spaceGit';
import { BlockedStatusBar, REVEAL_BLOCKED_COMMAND, SessionStatusBar } from './status';
import { PaneStreams } from './streams';
import { activeTabOf, TILES_VIEW_TYPE, TilesPanels } from './tilesPanel';
import { splitPaneKey } from './tilesProtocol';
import { TouchedRecorder, TouchedStore } from './touched';
import { AgentSource, AgentsView } from './views/agentsView';
import {
	DONE_MANAGING_COMMAND,
	firstSpaceId,
	MANAGE_SESSIONS_COMMAND,
	NO_RUNNING_SESSIONS,
	OPEN_SESSION_COMMAND,
	SessionRowNode,
	SessionsView,
	SWITCH_SESSION_COMMAND,
	SwitchSessionItem,
} from './views/sessionsView';
import { FOCUS_PANE_COMMAND, OPEN_PANE_TAB_COMMAND, OPEN_SPACE_COMMAND, OPEN_TAB_COMMAND, PaneNode, PaneRef, SpaceNode, SpacesView, TabNode } from './views/spacesView';

let model: SessionModel | undefined;
let streams: PaneStreams | undefined;

/**
 * Set by the test run (`.vscode-test.mjs`) so the extension host never
 * discovers or connects to the real herdr sessions on the machine running the
 * tests; views and commands are still registered.
 */
const NO_DISCOVERY = process.env.HERDR_VSCODE_NO_DISCOVERY === '1';

/** A pane command's arguments: the row from a context menu, or (sessionKey, paneId) from code. */
function paneArg(arg?: string | { ref?: PaneRef }, paneId?: string): PaneRef | undefined {
	return typeof arg === 'object' ? arg.ref : arg && paneId ? { sessionKey: arg, paneId } : undefined;
}

/** What a tile's `data-vscode-context` gives a `webview/context` command (see the webview's `setMenuContext`). */
interface TileMenuContext {
	paneKey?: string;
}

/** Saved Layout tabs of earlier builds (Layout tabs are gone). */
export const OLD_LAYOUTS_KEY = 'herdr.layouts';
/** Changed in This Pane's baselines of earlier builds (the section is gone). */
export const OLD_BASELINES_KEY = 'herdr.paneContext.baselines';

/** workspaceState of earlier builds' features, cleared on activation. */
export function clearRetiredState(memento: Pick<vscode.Memento, 'get' | 'update'>): void {
	for (const key of [OLD_LAYOUTS_KEY, OLD_BASELINES_KEY]) {
		if (memento.get(key) !== undefined) {
			void memento.update(key, undefined);
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('herdr');
	context.subscriptions.push(output);
	output.appendLine('herdr-vscode activated');
	const log = (line: string) => output.appendLine(`${new Date().toISOString()} ${line}`);

	const environments = new Environments(log);
	// Loaded before the model starts: time in state and done survive a reload.
	const agentStates = new AgentStates({ store: context.workspaceState });
	model = new SessionModel(environments, log, agentStates);
	const m = model;
	context.subscriptions.push(m, agentStates);

	const sessions = new SessionsView(m, context.workspaceState);
	const rowLabel = (key: string) => sessions.row(key)?.label;
	const focus = new FocusTracker(m, rowLabel);
	streams = new PaneStreams((key) => {
		const conn = m.connection(key);
		return conn && { shell: conn.env.shell, name: conn.name };
	}, log);
	const panels = new TilesPanels({ extensionUri: context.extensionUri, model: m, streams, focus, rowLabel, log });
	context.subscriptions.push(sessions, focus, panels, vscode.window.registerWebviewPanelSerializer(TILES_VIEW_TYPE, panels));
	clearRetiredState(context.workspaceState);
	// Rows from this machine's herdr config.toml; the test host never reads the real one.
	const sidebarConfig = new SidebarConfigSource(NO_DISCOVERY ? undefined : sidebarConfigPath(process.env, os.homedir()), log);
	const useSidebarConfig = () => vscode.workspace.getConfiguration('herdr').get<boolean>('useHerdrSidebarConfig', true);
	void sidebarConfig.setEnabled(useSidebarConfig());
	context.subscriptions.push(
		sidebarConfig,
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('herdr.useHerdrSidebarConfig')) {
				void sidebarConfig.setEnabled(useSidebarConfig());
			}
		}),
	);
	const spaceGit = new SpaceGit((key) => m.connection(key)?.env.shell);
	const spaces = new SpacesView(
		sessions,
		(key) => m.connection(key)?.snapshot,
		m.onDidChange,
		spaceGit,
		sidebarConfig,
	);
	const agentSources = (): AgentSource[] =>
		m
			.connections()
			.filter((c) => c.state === 'connected' && c.snapshot)
			.map((c) => ({
				sessionKey: c.key,
				rowLabel: sessions.row(c.key)?.label ?? c.name,
				snapshot: c.snapshot!,
				envKind: c.env.kind,
				envLabel: c.env.label,
			}));
	const agents = new AgentsView(
		agentSources,
		m.onDidChange,
		context.workspaceState,
		sessions,
		sidebarConfig,
	);
	const statusBar = new BlockedStatusBar();
	const sessionBar = new SessionStatusBar();
	const updateSessionBar = () => {
		const key = sessions.selected;
		const conn = key ? m.connection(key) : undefined;
		sessionBar.update(
			key && conn
				? {
						sessionKey: key,
						rowLabel: sessions.row(key)?.label ?? conn.name,
						envKind: conn.env.kind,
						alias: conn.env.alias,
						session: conn.name,
						snapshot: conn.state === 'connected' ? conn.snapshot : undefined,
					}
				: undefined,
		);
	};
	updateSessionBar();
	context.subscriptions.push(
		spaceGit,
		spaces,
		agents,
		statusBar,
		sessionBar,
		agents.onDidChangeBlocked((n) => statusBar.update(n)),
		sessions.onDidChangeSelected(updateSessionBar),
		m.onDidChange(updateSessionBar),
		// Looking at a pane ends its done.
		focus.onDidReportFocus(({ sessionKey, paneId }) => m.markSeen(sessionKey, paneId)),
	);

	const paths = new EnvironmentPaths(environments);
	const containerFs = new ContainerFileSystemProvider(
		(id) => environments.find(containerKey(id))?.shell,
		() => environments.containersSettled(),
	);
	const sshFs = new SshFileSystemProvider((alias) => environments.find(sshKey(alias))?.shell);
	const decorations = new PaneDecorations();
	// Files each agent touched while working: recorded whether or not Active Pane is visible.
	const touched = new TouchedStore(context.workspaceState);
	const recorder = new TouchedRecorder({ model: m, store: touched, log });
	context.subscriptions.push(touched, recorder);
	const paneFilesOnly = storedPaneFilesOnly(context.workspaceState);
	void vscode.commands.executeCommand('setContext', PANE_FILES_ONLY_KEY, paneFilesOnly);
	const paneContext = new PaneContextView({
		model: m,
		focus,
		sessions,
		panels,
		paths,
		createHost: (treeDataProvider) => vscode.window.createTreeView(PANE_CONTEXT_VIEW, { treeDataProvider }),
		log,
		touched,
		paneFilesOnly,
		decorations,
	});
	context.subscriptions.push(
		paths,
		paneContext,
		decorations,
		vscode.window.registerFileDecorationProvider(decorations),
		vscode.workspace.registerFileSystemProvider(CONTAINER_SCHEME, containerFs, { isCaseSensitive: true }),
		vscode.workspace.registerFileSystemProvider(SSH_SCHEME, sshFs, { isCaseSensitive: true }),
		new ChangePoller(
			new Map<string, PolledProvider>([
				[CONTAINER_SCHEME, containerFs],
				[SSH_SCHEME, sshFs],
			]),
		),
		vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitHeadContentProvider((key) => environments.find(key))),
	);

	// Ask Agent: comment threads answered by a herdr agent in any environment that can see the file.
	const agentReview = new AgentReviewController({
		model: m,
		environments,
		mounts: (env) => paths.mounts(env),
		rowLabel,
		followed: () => paneContext.followed,
		log,
	});
	context.subscriptions.push(agentReview, ...agentReview.registerCommands());

	const warn = (err: unknown) => void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
	/** Opens a tab that was just created, once the snapshot has it. */
	const openCreatedTab = async (key: string, result: unknown) => {
		const tabId = createdTabId(result);
		if (!tabId || !(await whenTabKnown(m, key, tabId))) {
			throw new Error('the new tab did not appear.');
		}
		panels.openTab(key, tabId);
	};
	/** Splits a pane in herdr and shows its tab, where the new tile arrives. */
	const splitPane = async (key: string, tabId: string, paneId: string | undefined, direction: 'right' | 'down') => {
		if (!paneId) {
			return;
		}
		const pane = m.connection(key)?.snapshot?.panes.find((p) => p.pane_id === paneId);
		const cwd = pane?.foreground_cwd ?? pane?.cwd;
		try {
			await m.request(key, 'pane.split', { target_pane_id: paneId, direction, ...(cwd ? { cwd } : {}), focus: false });
			panels.openTab(key, tabId);
		} catch (err) {
			warn(err);
		}
	};
	const splitRow = (node: TabNode | PaneNode | undefined, direction: 'right' | 'down') => {
		if (node?.type === 'tab') {
			const snapshot = m.connection(node.sessionKey)?.snapshot;
			return splitPane(node.sessionKey, node.tabId, snapshot && splitTarget(snapshot, node.tabId), direction);
		}
		return node && splitPane(node.ref.sessionKey, node.pane.tab_id, node.ref.paneId, direction);
	};

	const tileCommand = async (
		ctx: TileMenuContext | undefined,
		run: (panel: NonNullable<ReturnType<TilesPanels['panelOfPane']>>, paneId: string, paneKey: string) => Promise<void>,
	): Promise<void> => {
		const paneKey = ctx?.paneKey;
		const panel = paneKey ? panels.panelOfPane(paneKey) : undefined;
		if (paneKey && panel) {
			await run(panel, splitPaneKey(paneKey).paneId, paneKey);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('herdr.refresh', () => m.refresh()),
		vscode.commands.registerCommand('herdr.startSession', async (row?: SessionRowNode) => {
			const session = row?.session;
			const env = row && environments.get(row.envKey);
			if (!session || !env || (env.kind !== 'host' && env.kind !== 'container')) {
				return;
			}
			try {
				const started = await vscode.window.withProgress({ location: { viewId: 'herdr.sessions' } }, () =>
					env.kind === 'host' ? startHostSession(m, session) : startContainerSession(m, env, session, readSettings().dockerPath),
				);
				if (started) {
					sessions.select(sessionKey(env.key, session));
				} else {
					const where = env.kind === 'container' ? ` in ${env.label}` : '';
					void vscode.window.showWarningMessage(`herdr: session "${session}" did not start${where}. Its herdr-server.log says why.`);
				}
			} catch (err) {
				warn(err);
			}
		}),
		vscode.commands.registerCommand('herdr.stopSession', async (row?: SessionRowNode) => {
			const session = row?.session;
			const shell = environments.get(HOST_KEY)?.shell;
			if (!session || row.envKey !== HOST_KEY || !shell) {
				return;
			}
			const stop = 'Stop Session';
			const answer = await vscode.window.showWarningMessage(
				`Stop herdr session "${session}"?`,
				{ modal: true, detail: 'Every pane in it closes, and the agents and programs running there end.' },
				stop,
			);
			if (answer !== stop) {
				return;
			}
			try {
				const res = await shell.run(sessionStopArgv(session), { timeoutMs: 15000 });
				if (res.exitCode !== 0) {
					throw new Error(res.stderr.toString().trim() || `could not stop session "${session}".`);
				}
			} catch (err) {
				warn(err);
			}
			await m.relist(HOST_KEY);
		}),
		vscode.commands.registerCommand(SWITCH_SESSION_COMMAND, async () => {
			const picked = await pickSession(sessions.switchItems(), sessions.selected);
			if (picked?.manage) {
				await vscode.commands.executeCommand(MANAGE_SESSIONS_COMMAND);
			} else if (picked?.key) {
				sessions.select(picked.key);
			}
		}),
		vscode.commands.registerCommand(MANAGE_SESSIONS_COMMAND, async () => {
			sessions.setManaging(true);
			await vscode.commands.executeCommand('herdr.sessions.focus');
		}),
		vscode.commands.registerCommand(DONE_MANAGING_COMMAND, () => sessions.setManaging(false)),
		vscode.commands.registerCommand(OPEN_SESSION_COMMAND, async (key?: string) => {
			if (!key) {
				return;
			}
			sessions.select(key);
			const snapshot = () => m.connection(key)?.snapshot;
			if (!snapshot()) {
				// Still connecting: the first snapshot takes an event to arrive.
				await new Promise<void>((resolve) => {
					const finish = () => {
						clearTimeout(timer);
						sub.dispose();
						resolve();
					};
					const timer = setTimeout(finish, 3000);
					const sub = m.onDidChange(() => snapshot() && finish());
				});
			}
			const workspaceId = firstSpaceId(snapshot());
			if (workspaceId) {
				panels.openSpace(key, workspaceId);
			}
		}),
		vscode.commands.registerCommand('herdr.deleteSession', async (row?: SessionRowNode) => {
			const session = row?.session;
			const env = row && environments.get(row.envKey);
			if (!session || !env || !row.deletable) {
				return;
			}
			const running = row.contextValue === 'herdr.session.running';
			const del = 'Delete Session';
			const answer = await vscode.window.showWarningMessage(
				`Delete herdr session "${session}"?`,
				{
					modal: true,
					detail: running
						? 'The session is stopped first: every pane in it closes, and the agents and programs running there end. Its spaces and layout are then deleted.'
						: 'Its spaces and layout are deleted.',
				},
				del,
			);
			if (answer !== del) {
				return;
			}
			try {
				await vscode.window.withProgress({ location: { viewId: 'herdr.sessions' } }, async () => {
					if (running) {
						const stopped = await env.shell.run(sessionStopArgv(session), { timeoutMs: 15000 });
						if (stopped.exitCode !== 0) {
							throw new Error(stopped.stderr.toString().trim() || `could not stop session "${session}".`);
						}
					}
					const res = await env.shell.run(sessionDeleteArgv(session), { timeoutMs: 15000 });
					if (res.exitCode !== 0) {
						throw new Error(res.stderr.toString().trim() || `could not delete session "${session}".`);
					}
				});
			} catch (err) {
				warn(err);
			}
			await m.relist(env.key);
		}),
		vscode.commands.registerCommand('herdr.newSpace', async () => {
			const key = sessions.selected;
			if (!key) {
				return;
			}
			try {
				await openCreatedTab(key, await m.request(key, 'workspace.create', { focus: false }));
			} catch (err) {
				warn(err);
			}
		}),
		vscode.commands.registerCommand('herdr.newTab', async (node?: SpaceNode) => {
			if (!node) {
				return;
			}
			const snapshot = m.connection(node.sessionKey)?.snapshot;
			const cwd = snapshot && spaceCwd(snapshot, node.workspaceId);
			try {
				const result = await m.request(node.sessionKey, 'tab.create', { workspace_id: node.workspaceId, ...(cwd ? { cwd } : {}), focus: false });
				await openCreatedTab(node.sessionKey, result);
			} catch (err) {
				warn(err);
			}
		}),
		vscode.commands.registerCommand('herdr.splitRight', (node?: TabNode | PaneNode) => splitRow(node, 'right')),
		vscode.commands.registerCommand('herdr.splitDown', (node?: TabNode | PaneNode) => splitRow(node, 'down')),
		vscode.commands.registerCommand(FOCUS_PANE_COMMAND, async (arg?: PaneRef | { ref?: PaneRef }) => {
			const ref = arg && 'ref' in arg ? arg.ref : (arg as PaneRef | undefined);
			if (!ref?.sessionKey || !ref.paneId) {
				return;
			}
			m.markSeen(ref.sessionKey, ref.paneId);
			try {
				await m.request(ref.sessionKey, 'pane.focus', { pane_id: ref.paneId });
			} catch (err) {
				void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
			}
		}),
		vscode.commands.registerCommand(OPEN_SPACE_COMMAND, (sessionKey?: string, workspaceId?: string) => {
			if (sessionKey && workspaceId) {
				panels.openSpace(sessionKey, workspaceId);
				const snapshot = m.connection(sessionKey)?.snapshot;
				const tabId = snapshot && activeTabOf(snapshot, workspaceId);
				if (tabId) {
					focus.followTab(sessionKey, tabId);
				}
			}
		}),
		vscode.commands.registerCommand(OPEN_TAB_COMMAND, (sessionKey?: string, tabId?: string) => {
			if (sessionKey && tabId && panels.openTab(sessionKey, tabId)) {
				focus.followTab(sessionKey, tabId);
			}
		}),
		vscode.commands.registerCommand(OPEN_PANE_TAB_COMMAND, (arg?: string | { ref?: PaneRef }, paneId?: string) => {
			const ref = paneArg(arg, paneId);
			if (ref) {
				m.markSeen(ref.sessionKey, ref.paneId);
				panels.openPaneTab(ref.sessionKey, ref.paneId);
			}
		}),
		// A tile's right-click menu: the pane is whatever tile was clicked, in whichever panel shows it.
		vscode.commands.registerCommand('herdr.tile.splitRight', (ctx?: TileMenuContext) => tileCommand(ctx, (panel, paneId) => panel.split(paneId, 'right'))),
		vscode.commands.registerCommand('herdr.tile.splitDown', (ctx?: TileMenuContext) => tileCommand(ctx, (panel, paneId) => panel.split(paneId, 'down'))),
		vscode.commands.registerCommand('herdr.tile.zoom', (ctx?: TileMenuContext) => tileCommand(ctx, (panel, paneId) => panel.zoomFromMenu(paneId))),
		vscode.commands.registerCommand('herdr.tile.unzoom', (ctx?: TileMenuContext) => tileCommand(ctx, (panel) => panel.zoomFromMenu(null))),
		vscode.commands.registerCommand('herdr.tile.close', (ctx?: TileMenuContext, confirm?: boolean) =>
			tileCommand(ctx, (panel, _paneId, paneKey) => panel.closePane(paneKey, confirm !== false)),
		),
		vscode.commands.registerCommand(REVEAL_FOCUSED_COMMAND, () => {
			if (focus.lastFocused) {
				const { sessionKey, paneId } = splitPaneKey(focus.lastFocused);
				panels.revealPane(sessionKey, paneId);
			}
		}),
		vscode.commands.registerCommand('herdr.paneContext.pin', () => paneContext.pin()),
		vscode.commands.registerCommand('herdr.paneContext.unpin', () => paneContext.unpin()),
		vscode.commands.registerCommand('herdr.paneContext.refresh', () => paneContext.refresh()),
		vscode.commands.registerCommand('herdr.paneContext.addToWorkspace', () => paneContext.addToWorkspace()),
		vscode.commands.registerCommand('herdr.paneContext.splitPane', () => paneContext.splitPane()),
		vscode.commands.registerCommand('herdr.paneContext.showPane', () => paneContext.showPane()),
		vscode.commands.registerCommand('herdr.paneContext.openChanges', (node?: ChangeNode | CommitFileNode) => paneContext.openChanges(node)),
		vscode.commands.registerCommand('herdr.paneContext.openFile', (node?: ChangeNode | CommitFileNode) => paneContext.openFile(node)),
		vscode.commands.registerCommand('herdr.paneContext.showPaneFiles', () => applyPaneFilesOnly(true, paneContext, context.workspaceState)),
		vscode.commands.registerCommand('herdr.paneContext.showAllFiles', () => applyPaneFilesOnly(false, paneContext, context.workspaceState)),
		vscode.commands.registerCommand('herdr.paneContext.openSourceControl', () => paneContext.openSourceControl()),
		vscode.commands.registerCommand('herdr.paneContext.openTerminal', () => paneContext.openTerminal()),
		vscode.commands.registerCommand('herdr.paneContext.newFile', (node?: PaneContextNode) => paneContext.promptNew(node, 'file')),
		vscode.commands.registerCommand('herdr.paneContext.newFolder', (node?: PaneContextNode) => paneContext.promptNew(node, 'folder')),
		vscode.commands.registerCommand('herdr.paneContext.rename', (node?: PaneContextNode) => paneContext.promptRename(node)),
		vscode.commands.registerCommand('herdr.paneContext.delete', (node?: PaneContextNode) => paneContext.promptDelete(node)),
		vscode.commands.registerCommand('herdr.agents.showAll', () => agents.setFilter('all')),
		vscode.commands.registerCommand('herdr.agents.showBlocked', () => agents.setFilter('blocked')),
		vscode.commands.registerCommand('herdr.agents.showWorking', () => agents.setFilter('working')),
		vscode.commands.registerCommand('herdr.agents.showDone', () => agents.setFilter('done')),
		vscode.commands.registerCommand('herdr.agents.filter', () => agents.pickFilter()),
		vscode.commands.registerCommand('herdr.agents.scopeSession', () => agents.setScope('session')),
		vscode.commands.registerCommand('herdr.agents.scopeAll', () => agents.setScope('all')),
		vscode.commands.registerCommand(REVEAL_BLOCKED_COMMAND, async () => {
			await agents.setScope('all');
			await vscode.commands.executeCommand('herdr.agents.showBlocked');
			await vscode.commands.executeCommand('workbench.view.extension.herdr');
		}),
	);

	if (NO_DISCOVERY) {
		log('discovery disabled (HERDR_VSCODE_NO_DISCOVERY=1)');
	} else {
		m.start();
	}
}

export function deactivate(): void {
	// Ends every stream's and bridge's stdin: inside a container they only stop that way.
	streams?.dispose();
	streams = undefined;
	model?.dispose();
	model = undefined;
}

/** Switch Session's quick pick; the chosen entry, or undefined on Escape. */
async function pickSession(entries: SwitchSessionItem[], selected: string | undefined): Promise<SwitchSessionItem | undefined> {
	type Item = vscode.QuickPickItem & { entry: SwitchSessionItem };
	const items: Item[] = entries.map((e) => ({
		label: e.label,
		description: e.description,
		kind: e.kind === 'separator' ? vscode.QuickPickItemKind.Separator : vscode.QuickPickItemKind.Default,
		entry: e,
	}));
	const qp = vscode.window.createQuickPick<Item>();
	qp.title = 'Switch herdr Session';
	qp.items = items;
	qp.placeholder = entries.some((e) => e.key) ? 'Select a session to show in Spaces' : NO_RUNNING_SESSIONS;
	const current = items.find((i) => i.entry.key !== undefined && i.entry.key === selected);
	if (current) {
		qp.activeItems = [current];
	}
	return new Promise((resolve) => {
		let result: SwitchSessionItem | undefined;
		qp.onDidAccept(() => {
			result = qp.selectedItems[0]?.entry;
			qp.hide();
		});
		qp.onDidHide(() => {
			qp.dispose();
			resolve(result);
		});
		qp.show();
	});
}
