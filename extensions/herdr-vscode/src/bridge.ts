import * as cp from 'child_process';
import * as readline from 'readline';
import { RemoteShell } from './remoteShell';

/**
 * herdr's socket API over stdio: `herdr --session <S> remote-api-bridge` run in
 * the environment. One JSON object per line each way; **one request per
 * connection** (a second request resets it), except `events.subscribe`, which
 * keeps streaming. See docs/how-it-works.md.
 */

/** `sh -c` script that finds `herdr` in `~/.local/bin` without a login shell. */
export const HERDR_WRAPPER = 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"';

/** The argv that runs `herdr <args…>` in any environment, through {@link HERDR_WRAPPER}. */
export function herdrArgv(args: string[]): string[] {
	return ['sh', '-c', HERDR_WRAPPER, 'herdr', ...args];
}

export const BRIDGE_CHECK_OUTPUT = 'herdr-api-bridge-v1';

/** How long a one-shot request may take before its connection is killed. */
export const REQUEST_TIMEOUT_MS = 15000;

/** How long an ended connection gets to exit on its own before it is killed. */
const CLOSE_GRACE_MS = 2000;

/** The global event types every subscription carries. */
export const GLOBAL_EVENT_TYPES = [
	'workspace.created',
	'workspace.updated',
	'workspace.metadata_updated',
	'workspace.renamed',
	'workspace.moved',
	'workspace.reordered',
	'workspace.closed',
	'workspace.focused',
	'tab.created',
	'tab.closed',
	'tab.focused',
	'tab.renamed',
	'tab.moved',
	'pane.created',
	'pane.closed',
	'pane.updated',
	'pane.focused',
	'pane.moved',
	'pane.exited',
	'pane.agent_detected',
	'layout.updated',
] as const;

/** The pseudo-event a subscription delivers for herdr's `events_lost` error. */
export const EVENTS_LOST = 'events_lost';

/**
 * herdr sends most event names with underscores (`pane_created`) but some
 * with dots (`pane.agent_status_changed`). A name with no `.` has its first
 * `_` turned into one.
 */
export function normalizeEventName(name: string): string {
	return name.includes('.') ? name : name.replace('_', '.');
}

/** The `subscriptions` param: every global type, plus agent status for each pane. */
export function subscriptionList(paneIds: readonly string[]): Record<string, string>[] {
	return [
		...GLOBAL_EVENT_TYPES.map((type) => ({ type })),
		...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
	];
}

/** A failed bridge call; `code` is herdr's error code, or `bridge_exited` / `timeout`. */
export class BridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Whether `remote-api-bridge --check` output means the bridge is there. */
export function bridgeCheckPassed(exitCode: number, stdout: string): boolean {
	return exitCode === 0 && stdout.replace(/\r?\n$/, '') === BRIDGE_CHECK_OUTPUT;
}

/** `herdr --session <S> remote-api-bridge --check`; false on any failure. */
export async function checkBridge(shell: RemoteShell, session: string): Promise<boolean> {
	try {
		const res = await shell.run(herdrArgv(['--session', session, 'remote-api-bridge', '--check']), {
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		return bridgeCheckPassed(res.exitCode, res.stdout.toString('utf8'));
	} catch {
		return false;
	}
}

/**
 * Ends a connection: closes stdin (what stops a bridge inside a container —
 * `docker exec`'s process outlives a killed client), then kills it if it has
 * not exited after a grace period.
 */
export function endConnection(child: cp.ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.stdin?.end();
	const timer = setTimeout(() => child.kill(), CLOSE_GRACE_MS);
	timer.unref?.();
	child.once('exit', () => clearTimeout(timer));
}

function spawnBridge(shell: RemoteShell, session: string): cp.ChildProcess {
	const child = shell.spawn(herdrArgv(['--session', session, 'remote-api-bridge']));
	child.stdin?.on('error', () => {
		/* the bridge already ended */
	});
	return child;
}

interface Reply {
	id?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
	event?: unknown;
	data?: unknown;
}

function parseLine(line: string): Reply | undefined {
	try {
		const msg: unknown = JSON.parse(line);
		return typeof msg === 'object' && msg !== null ? (msg as Reply) : undefined;
	} catch {
		return undefined;
	}
}

function replyError(err: Reply['error']): BridgeError {
	return new BridgeError(String(err?.code ?? 'herdr_error'), String(err?.message ?? 'herdr returned an error'));
}

let nextId = 0;

/**
 * One request on a fresh connection: spawn, write one line, read the reply,
 * end stdin. Resolves with `result`; rejects with a {@link BridgeError}.
 */
export function bridgeRequest(
	shell: RemoteShell,
	session: string,
	method: string,
	params: unknown,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let child: cp.ChildProcess;
		try {
			child = spawnBridge(shell, session);
		} catch (err) {
			reject(err);
			return;
		}
		const id = `herdr-vscode-${++nextId}`;
		let done = false;
		const finish = (fn: () => void) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			rl?.close();
			endConnection(child);
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new BridgeError('timeout', `${method} timed out`))),
			timeoutMs,
		);
		const rl = child.stdout ? readline.createInterface({ input: child.stdout }) : undefined;
		rl?.on('line', (line) => {
			const msg = parseLine(line);
			if (msg?.id !== id) {
				return;
			}
			if (msg.error !== undefined) {
				finish(() => reject(replyError(msg.error)));
			} else {
				finish(() => resolve(msg.result));
			}
		});
		child.on('error', (err) => finish(() => reject(new BridgeError('bridge_exited', err.message))));
		child.on('close', () => finish(() => reject(new BridgeError('bridge_exited', 'herdr bridge exited'))));
		child.stdin?.write(JSON.stringify({ id, method, params }) + '\n');
	});
}

/** A normalized event: its name and herdr's `data`. */
export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

/** An open `events.subscribe` connection. */
export interface Subscription {
	/** Settles when the connection ends, whether closed or on its own. */
	readonly ended: Promise<void>;
	/** Ends the connection; `ended` then settles but the caller asked for it. */
	close(): void;
}

export const SUBSCRIBE_ID = 's';

/**
 * Opens an `events.subscribe` connection for `subscriptions` and resolves once
 * herdr answers `subscription_started`; rejects when it errors or exits first.
 * Events reach `onEvent` with normalized names; an `events_lost` error is
 * delivered as the event {@link EVENTS_LOST}.
 */
export function subscribe(
	shell: RemoteShell,
	session: string,
	subscriptions: Record<string, string>[],
	onEvent: (ev: HerdrEvent) => void,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Subscription> {
	return new Promise((resolve, reject) => {
		let child: cp.ChildProcess;
		try {
			child = spawnBridge(shell, session);
		} catch (err) {
			reject(err);
			return;
		}
		let started = false;
		let settledStart = false;
		let endedResolve!: () => void;
		const ended = new Promise<void>((r) => (endedResolve = r));
		const close = () => endConnection(child);
		const failStart = (err: BridgeError) => {
			if (settledStart) {
				return;
			}
			settledStart = true;
			clearTimeout(timer);
			close();
			reject(err);
		};
		const timer = setTimeout(() => failStart(new BridgeError('timeout', 'events.subscribe timed out')), timeoutMs);
		const rl = child.stdout ? readline.createInterface({ input: child.stdout }) : undefined;
		rl?.on('line', (line) => {
			const msg = parseLine(line);
			if (!msg) {
				return;
			}
			if (msg.error !== undefined) {
				if (started && msg.error?.code === EVENTS_LOST) {
					onEvent({ event: EVENTS_LOST, data: {} });
				} else if (!started) {
					failStart(replyError(msg.error));
				}
				return;
			}
			if (!started) {
				const result = msg.result as { type?: unknown } | undefined;
				if (msg.id === SUBSCRIBE_ID && result?.type === 'subscription_started') {
					started = true;
					settledStart = true;
					clearTimeout(timer);
					resolve({ ended, close });
				}
				return;
			}
			if (typeof msg.event === 'string') {
				const data =
					typeof msg.data === 'object' && msg.data !== null ? (msg.data as Record<string, unknown>) : {};
				onEvent({ event: normalizeEventName(msg.event), data });
			}
		});
		child.on('error', (err) => failStart(new BridgeError('bridge_exited', err.message)));
		child.on('close', () => {
			rl?.close();
			failStart(new BridgeError('bridge_exited', 'herdr bridge exited'));
			endedResolve();
		});
		child.stdin?.write(
			JSON.stringify({ id: SUBSCRIBE_ID, method: 'events.subscribe', params: { subscriptions } }) + '\n',
		);
	});
}
