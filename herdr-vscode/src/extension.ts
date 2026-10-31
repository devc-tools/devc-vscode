import * as vscode from 'vscode';
import { HERDR_WRAPPER } from './bridge';
import { Environments } from './environments';
import { containerTerminalCommand, shQuote, sshTerminalCommand } from './remoteShell';
import { SessionModel } from './sessions';
import { BlockedStatusBar, REVEAL_BLOCKED_COMMAND } from './status';
import { AgentSource, AgentsView } from './views/agentsView';
import { SessionRowNode, SessionsView } from './views/sessionsView';
import { FOCUS_PANE_COMMAND, PaneRef, SpacesView } from './views/spacesView';

let model: SessionModel | undefined;

/**
 * Set by the test run (`.vscode-test.mjs`) so the extension host never
 * discovers or connects to the real herdr sessions on the machine running the
 * tests; views and commands are still registered.
 */
const NO_DISCOVERY = process.env.HERDR_VSCODE_NO_DISCOVERY === '1';

/** The shell command line that attaches a terminal to a session row's herdr session. */
export function attachCommand(
	row: Pick<SessionRowNode, 'session'>,
	env: { kind: string; containerId?: string; user?: string; alias?: string },
	settings: { dockerPath: string; sshPath: string; controlDir: string | undefined },
): string | undefined {
	const session = row.session;
	if (session === undefined) {
		return undefined;
	}
	switch (env.kind) {
		case 'host':
			return `sh -c ${shQuote(HERDR_WRAPPER)} herdr --session ${shQuote(session)}`;
		case 'container':
			return containerTerminalCommand(settings.dockerPath, env.containerId!, env.user, undefined, session);
		case 'ssh':
			return sshTerminalCommand(settings.sshPath, env.alias!, undefined, session, settings.controlDir);
		default:
			return undefined;
	}
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

	context.subscriptions.push(
		vscode.commands.registerCommand('herdr.refresh', () => m.refresh()),
		vscode.commands.registerCommand('herdr.attachSession', (row?: SessionRowNode) => {
			const node = row?.type === 'session' ? row : sessions.treeView.selection[0];
			if (!node || node.type !== 'session' || node.session === undefined) {
				return;
			}
			const env = environments.get(node.envKey);
			if (!env) {
				return;
			}
			const command = attachCommand(node, env, {
				dockerPath: environments.dockerPath,
				sshPath: environments.sshPath,
				controlDir: environments.sshControlDir,
			});
			if (!command) {
				return;
			}
			const terminal = vscode.window.createTerminal({
				name: `herdr: ${node.label}`,
				shellPath: '/bin/sh',
				shellArgs: ['-c', `exec ${command}`],
				// A VS Code started from a herdr pane passes that pane's HERDR_* on; herdr must not see them.
				env: Object.fromEntries(
					Object.keys(process.env)
						.filter((k) => k.startsWith('HERDR_'))
						.map((k) => [k, null]),
				),
			});
			terminal.show();
		}),
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
	// Ends every bridge's stdin: a bridge inside a container only stops that way.
	model?.dispose();
	model = undefined;
}
