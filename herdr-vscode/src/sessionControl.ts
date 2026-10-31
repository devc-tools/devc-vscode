import * as cp from 'child_process';
import * as os from 'os';
import { herdrArgv } from './bridge';
import { HOST_KEY } from './environments';
import { localEnv } from './remoteShell';
import { Snapshot, SessionModel } from './sessions';

/** Starting and stopping this machine's sessions, and creating spaces, tabs and panes in a session. */

export const START_TRIES = 20;
export const START_WAIT_MS = 500;
const TAB_WAIT_MS = 3000;

/** The server, with no TUI attached: `herdr --session <S>` would need a terminal. */
export function sessionServerArgv(session: string): string[] {
	return herdrArgv(['--session', session, 'server']);
}

export function sessionStopArgv(session: string): string[] {
	return herdrArgv(['session', 'stop', session]);
}

/** Runs `argv` on this machine in its own process group, so it outlives this window. */
export function startDetached(argv: string[], spawnFn: typeof cp.spawn = cp.spawn): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawnFn(argv[0], argv.slice(1), {
			detached: true,
			stdio: 'ignore',
			env: localEnv(),
			cwd: os.homedir(),
		});
		child.once('error', reject);
		child.once('spawn', () => {
			child.unref();
			resolve();
		});
	});
}

/** Starts a session on this machine and waits for the listing to show it running. */
export async function startHostSession(model: SessionModel, session: string, start: typeof startDetached = startDetached): Promise<boolean> {
	await start(sessionServerArgv(session));
	for (let i = 0; i < START_TRIES; i++) {
		await model.relist(HOST_KEY);
		if (model.states().find((s) => s.env.key === HOST_KEY)?.sessions.find((s) => s.name === session)?.running) {
			return true;
		}
		await new Promise((r) => setTimeout(r, START_WAIT_MS));
	}
	return false;
}

/** The pane a tab's split starts from: the tab's focused pane, else its first. */
export function splitTarget(snapshot: Snapshot, tabId: string): string | undefined {
	const panes = snapshot.panes.filter((p) => p.tab_id === tabId);
	return (panes.find((p) => p.focused) ?? panes[0])?.pane_id;
}

/** A new tab starts where the space is working: its focused pane's directory, else its first pane's. */
export function spaceCwd(snapshot: Snapshot, workspaceId: string): string | undefined {
	const panes = snapshot.panes.filter((p) => p.workspace_id === workspaceId);
	const pane = panes.find((p) => p.focused) ?? panes[0];
	return pane?.foreground_cwd ?? pane?.cwd;
}

/** The tab in a `tab.create` or `workspace.create` result. */
export function createdTabId(result: unknown): string | undefined {
	const id = (result as { tab?: { tab_id?: unknown } } | undefined)?.tab?.tab_id;
	return typeof id === 'string' ? id : undefined;
}

/** Waits for the session's snapshot to hold a tab; a new one takes an event and a snapshot to arrive. */
export function whenTabKnown(model: Pick<SessionModel, 'connection' | 'onDidChange'>, sessionKey: string, tabId: string, ms = TAB_WAIT_MS): Promise<boolean> {
	const known = () => model.connection(sessionKey)?.snapshot?.tabs.some((t) => t.tab_id === tabId) === true;
	if (known()) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const finish = (found: boolean) => {
			clearTimeout(timer);
			sub.dispose();
			resolve(found);
		};
		const timer = setTimeout(() => finish(false), ms);
		const sub = model.onDidChange(() => {
			if (known()) {
				finish(true);
			}
		});
	});
}
