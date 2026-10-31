import * as cp from 'child_process';
import * as os from 'os';
import { herdrArgv } from './bridge';
import { execDocker } from './docker';
import { Environment, HOST_KEY } from './environments';
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

/** Re-lists an environment until the session runs (20 tries, 500 ms apart). */
export async function waitForSession(model: Pick<SessionModel, 'relist' | 'states'>, envKey: string, session: string): Promise<boolean> {
	for (let i = 0; i < START_TRIES; i++) {
		await model.relist(envKey);
		if (model.states().find((s) => s.env.key === envKey)?.sessions.find((s) => s.name === session)?.running) {
			return true;
		}
		await new Promise((r) => setTimeout(r, START_WAIT_MS));
	}
	return false;
}

/** Starts a session on this machine and waits for the listing to show it running. */
export async function startHostSession(model: SessionModel, session: string, start: typeof startDetached = startDetached): Promise<boolean> {
	await start(sessionServerArgv(session));
	return waitForSession(model, HOST_KEY, session);
}

/**
 * `docker exec -d` arguments starting a container's herdr server in the user's
 * home. Not through `DockerShell`, whose `run` adds `-i` (`-d` and `-i` do not
 * combine). `export SHELL`: bash sets it without exporting under `docker exec`,
 * and herdr's panes start `$SHELL`.
 */
export function containerStartArgs(containerId: string, user: string | undefined, session: string): string[] {
	return [
		'exec',
		'-d',
		...(user ? ['-u', user] : []),
		containerId,
		'/bin/bash',
		'-lc',
		'cd; PATH="$HOME/.local/bin:$PATH"; export SHELL; exec "$0" "$@"',
		'herdr',
		'--session',
		session,
		'server',
	];
}

export const CONTAINER_START_TIMEOUT_MS = 15000;

/** Starts a session in a dev container and waits for the listing to show it running. */
export async function startContainerSession(
	model: Pick<SessionModel, 'relist' | 'states'>,
	env: Pick<Environment, 'key' | 'containerId' | 'user'>,
	session: string,
	dockerPath: string,
	exec: typeof execDocker = execDocker,
): Promise<boolean> {
	if (!env.containerId) {
		throw new Error('not a dev container.');
	}
	const res = await exec(containerStartArgs(env.containerId, env.user, session), undefined, dockerPath, CONTAINER_START_TIMEOUT_MS);
	if (res.exitCode !== 0) {
		throw new Error(res.stderr.toString('utf8').trim() || `docker exec exited with ${res.exitCode}`);
	}
	return waitForSession(model, env.key, session);
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
