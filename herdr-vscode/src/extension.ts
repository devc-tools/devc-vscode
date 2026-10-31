import * as vscode from 'vscode';
import { AgentStates } from './agentState';
import { BaselineStore } from './baselines';
import { PaneDecorations } from './decorations';
import { containerKey, Environments, HOST_KEY, readSettings, sshKey } from './environments';
import { FocusTracker, REVEAL_FOCUSED_COMMAND } from './focus';
import { GIT_SCHEME, GitHeadContentProvider } from './git';
import { LayoutStore, nextLayoutName, SavedLayout } from './layouts';
import { ChangeNode, PANE_CONTEXT_VIEW, PaneContextNode, PaneContextView, SinceNode } from './paneContext';
import { CANCEL_PLACEMENT_COMMAND, PaneDragController, paneRowRef } from './paneDrag';
import { CONTAINER_SCHEME, EnvironmentPaths, SSH_SCHEME } from './paths';
import { ChangePoller, ContainerFileSystemProvider, PolledProvider, SshFileSystemProvider } from './remoteFs';
import { createdTabId, sessionStopArgv, spaceCwd, splitTarget, startContainerSession, startHostSession, whenTabKnown } from './sessionControl';
import { SessionModel, sessionKey, Snapshot } from './sessions';
import { SpaceGit } from './spaceGit';
import { BlockedStatusBar, REVEAL_BLOCKED_COMMAND, SessionStatusBar } from './status';
import { PaneStreams } from './streams';
import { TILES_VIEW_TYPE, TilesPanels } from './tilesPanel';
import { splitPaneKey } from './tilesProtocol';
import { AgentRow, AgentSource, AgentsView } from './views/agentsView';
import { SessionRowNode, SessionsView } from './views/sessionsView';
import { ADD_TO_LAYOUT_COMMAND, FOCUS_PANE_COMMAND, OPEN_PANE_TAB_COMMAND, OPEN_TAB_COMMAND, PaneNode, PaneRef, SpaceNode, SpacesNode, SpacesView, TabNode } from './views/spacesView';

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
	const layouts = new LayoutStore(context.workspaceState);
	const panels = new TilesPanels({ extensionUri: context.extensionUri, model: m, streams, focus, layouts, rowLabel, log });
	context.subscriptions.push(sessions, focus, panels, vscode.window.registerWebviewPanelSerializer(TILES_VIEW_TYPE, panels));

	// Pane rows drag into Layout tabs.
	const connectedSnapshot = (key: string): Snapshot | undefined => {
		const conn = m.connection(key);
		return conn?.state === 'connected' ? conn.snapshot : undefined;
	};
	const spaceGit = new SpaceGit((key) => m.connection(key)?.env.shell);
	const spaces = new SpacesView(
		sessions,
		(key) => m.connection(key)?.snapshot,
		m.onDidChange,
		spaceGit,
		new PaneDragController<SpacesNode>(panels.placement, paneRowRef, connectedSnapshot),
	);
	const agentSources = (): AgentSource[] =>
		m
			.connections()
			.filter((c) => c.state === 'connected' && c.snapshot)
			.map((c) => ({ sessionKey: c.key, rowLabel: sessions.row(c.key)?.label ?? c.name, snapshot: c.snapshot! }));
	const agents = new AgentsView(
		agentSources,
		m.onDidChange,
		context.workspaceState,
		sessions,
		new PaneDragController<AgentRow>(panels.placement, (row) => row.ref, connectedSnapshot),
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
	const paneContext = new PaneContextView({
		model: m,
		focus,
		sessions,
		panels,
		paths,
		createHost: (treeDataProvider) =>
			vscode.window.createTreeView(PANE_CONTEXT_VIEW, {
				treeDataProvider,
				dragAndDropController: new PaneDragController<PaneContextNode>(panels.placement, paneRowRef, connectedSnapshot),
			}),
		log,
		baselines: new BaselineStore(context.workspaceState),
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

	const pickLayout = async (placeHolder: string): Promise<SavedLayout | undefined> => {
		const saved = layouts.list();
		if (saved.length === 0) {
			void vscode.window.showInformationMessage('herdr: there are no saved layouts.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			saved.map((layout) => ({ label: layout.name, layout })),
			{ placeHolder },
		);
		return picked?.layout;
	};
	const askLayoutName = (value: string, prompt: string, own?: string) =>
		vscode.window.showInputBox({
			prompt,
			value,
			validateInput: (name) => {
				if (!name.trim()) {
					return 'Enter a name.';
				}
				return name.trim() !== own && layouts.names().includes(name.trim()) ? 'There is a layout with this name.' : undefined;
			},
		});

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

	context.subscriptions.push(
		vscode.commands.registerCommand('herdr.refresh', () => m.refresh()),
		vscode.commands.registerCommand(CANCEL_PLACEMENT_COMMAND, () => panels.placement.cancel()),
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
		vscode.commands.registerCommand(OPEN_TAB_COMMAND, (sessionKey?: string, tabId?: string) => {
			if (sessionKey && tabId) {
				panels.openTab(sessionKey, tabId);
			}
		}),
		vscode.commands.registerCommand(OPEN_PANE_TAB_COMMAND, (arg?: string | { ref?: PaneRef }, paneId?: string) => {
			const ref = paneArg(arg, paneId);
			if (ref) {
				m.markSeen(ref.sessionKey, ref.paneId);
				panels.openPaneTab(ref.sessionKey, ref.paneId);
			}
		}),
		vscode.commands.registerCommand(ADD_TO_LAYOUT_COMMAND, (arg?: string | { ref?: PaneRef }, paneId?: string) => {
			const ref = paneArg(arg, paneId);
			if (ref) {
				m.markSeen(ref.sessionKey, ref.paneId);
				panels.addToLayout(ref.sessionKey, ref.paneId);
			}
		}),
		vscode.commands.registerCommand('herdr.newLayout', async () => {
			const name = await askLayoutName(nextLayoutName(layouts.names()), 'Name of the new layout');
			if (name) {
				panels.newLayout(name.trim());
			}
		}),
		vscode.commands.registerCommand('herdr.openLayout', async () => {
			const layout = await pickLayout('Layout to open');
			if (layout) {
				panels.openLayout(layout.id);
			}
		}),
		// The Layout panel's toolbar passes its layout; the command palette asks.
		vscode.commands.registerCommand('herdr.renameLayout', async (layoutId?: string) => {
			const layout = layoutId ? layouts.get(layoutId) : await pickLayout('Layout to rename');
			if (!layout) {
				return;
			}
			const name = await askLayoutName(layout.name, `New name of "${layout.name}"`, layout.name);
			if (name) {
				panels.renameLayout(layout.id, name.trim());
			}
		}),
		vscode.commands.registerCommand('herdr.deleteLayout', async () => {
			const layout = await pickLayout('Layout to delete');
			if (!layout) {
				return;
			}
			const answer = await vscode.window.showWarningMessage(
				`Delete layout "${layout.name}"? Its panes stay in herdr.`,
				{ modal: true },
				'Delete Layout',
			);
			if (answer === 'Delete Layout') {
				panels.deleteLayout(layout.id);
			}
		}),
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
		vscode.commands.registerCommand('herdr.paneContext.openChanges', (node?: ChangeNode | SinceNode) => paneContext.openChanges(node)),
		vscode.commands.registerCommand('herdr.paneContext.resetBaseline', () => paneContext.resetBaseline()),
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
