import * as vscode from 'vscode';
import { Environments } from './environments';
import { FocusTracker, REVEAL_FOCUSED_COMMAND } from './focus';
import { LayoutStore, nextLayoutName, SavedLayout } from './layouts';
import { SessionModel } from './sessions';
import { BlockedStatusBar, REVEAL_BLOCKED_COMMAND } from './status';
import { PaneStreams } from './streams';
import { TILES_VIEW_TYPE, TilesPanels } from './tilesPanel';
import { splitPaneKey } from './tilesProtocol';
import { AgentSource, AgentsView } from './views/agentsView';
import { SessionsView } from './views/sessionsView';
import { ADD_TO_LAYOUT_COMMAND, FOCUS_PANE_COMMAND, OPEN_PANE_TAB_COMMAND, OPEN_TAB_COMMAND, PaneRef, SpacesView } from './views/spacesView';

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
	model = new SessionModel(environments, log);
	const m = model;
	context.subscriptions.push(m);

	const sessions = new SessionsView(m, context.workspaceState);
	const spaces = new SpacesView(sessions, (key) => m.connection(key)?.snapshot, m.onDidChange);
	const agentSources = (): AgentSource[] =>
		m
			.connections()
			.filter((c) => c.state === 'connected' && c.snapshot)
			.map((c) => ({ sessionKey: c.key, rowLabel: sessions.row(c.key)?.label ?? c.name, snapshot: c.snapshot! }));
	const agents = new AgentsView(agentSources, m.onDidChange, context.workspaceState);
	const statusBar = new BlockedStatusBar();
	context.subscriptions.push(sessions, spaces, agents, statusBar, agents.onDidChangeBlocked((n) => statusBar.update(n)));

	const rowLabel = (key: string) => sessions.row(key)?.label;
	const focus = new FocusTracker(m, rowLabel);
	streams = new PaneStreams((key) => {
		const conn = m.connection(key);
		return conn && { shell: conn.env.shell, name: conn.name };
	}, log);
	const layouts = new LayoutStore(context.workspaceState);
	const panels = new TilesPanels({ extensionUri: context.extensionUri, model: m, streams, focus, layouts, rowLabel, log });
	context.subscriptions.push(focus, panels, vscode.window.registerWebviewPanelSerializer(TILES_VIEW_TYPE, panels));

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

	context.subscriptions.push(
		vscode.commands.registerCommand('herdr.refresh', () => m.refresh()),
		vscode.commands.registerCommand(FOCUS_PANE_COMMAND, async (arg?: PaneRef | { ref?: PaneRef }) => {
			const ref = arg && 'ref' in arg ? arg.ref : (arg as PaneRef | undefined);
			if (!ref?.sessionKey || !ref.paneId) {
				return;
			}
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
				panels.openPaneTab(ref.sessionKey, ref.paneId);
			}
		}),
		vscode.commands.registerCommand(ADD_TO_LAYOUT_COMMAND, (arg?: string | { ref?: PaneRef }, paneId?: string) => {
			const ref = paneArg(arg, paneId);
			if (ref) {
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
		vscode.commands.registerCommand('herdr.agents.showAll', () => agents.setFilter('all')),
		vscode.commands.registerCommand('herdr.agents.showBlocked', () => agents.setFilter('blocked')),
		vscode.commands.registerCommand('herdr.agents.showWorking', () => agents.setFilter('working')),
		vscode.commands.registerCommand(REVEAL_BLOCKED_COMMAND, async () => {
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
