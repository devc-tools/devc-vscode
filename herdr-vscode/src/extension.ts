import * as vscode from 'vscode';
import { Environments } from './environments';
import { FocusTracker, REVEAL_FOCUSED_COMMAND } from './focus';
import { SessionModel } from './sessions';
import { BlockedStatusBar, REVEAL_BLOCKED_COMMAND } from './status';
import { PaneStreams } from './streams';
import { TILES_VIEW_TYPE, TilesPanels } from './tilesPanel';
import { splitPaneKey } from './tilesProtocol';
import { AgentSource, AgentsView } from './views/agentsView';
import { SessionsView } from './views/sessionsView';
import { FOCUS_PANE_COMMAND, OPEN_TAB_COMMAND, PaneRef, SpacesView } from './views/spacesView';

let model: SessionModel | undefined;
let streams: PaneStreams | undefined;

/**
 * Set by the test run (`.vscode-test.mjs`) so the extension host never
 * discovers or connects to the real herdr sessions on the machine running the
 * tests; views and commands are still registered.
 */
const NO_DISCOVERY = process.env.HERDR_VSCODE_NO_DISCOVERY === '1';

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
	const panels = new TilesPanels({ extensionUri: context.extensionUri, model: m, streams, focus, rowLabel, log });
	context.subscriptions.push(focus, panels, vscode.window.registerWebviewPanelSerializer(TILES_VIEW_TYPE, panels));

	context.subscriptions.push(
		vscode.commands.registerCommand('herdr.refresh', () => m.refresh()),
		vscode.commands.registerCommand(FOCUS_PANE_COMMAND, async (ref?: PaneRef) => {
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
		// From a context menu the argument is the row; from code, (sessionKey, paneId).
		vscode.commands.registerCommand('herdr.openPaneTab', (arg?: string | { ref?: PaneRef }, paneId?: string) => {
			const ref = typeof arg === 'object' ? arg.ref : arg && paneId ? { sessionKey: arg, paneId } : undefined;
			if (ref) {
				panels.openPaneTab(ref.sessionKey, ref.paneId);
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
