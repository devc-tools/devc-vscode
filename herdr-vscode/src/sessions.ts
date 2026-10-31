import * as path from 'path';
import * as vscode from 'vscode';
import { bridgeRequest, checkBridge, herdrArgv, HerdrEvent, subscribe, Subscription, subscriptionList } from './bridge';
import { Environment, Environments } from './environments';
import { SSH_FAILURE_EXIT, ShellResult } from './remoteShell';
import { AgentStatus, toStatus } from './status';

// ── Session list ────────────────────────────────────────────────────────────

/** One entry of `herdr session list --json`. */
export interface SessionInfo {
	name: string;
	default: boolean;
	running: boolean;
}

/** What listing an environment's sessions came to. */
export type ListResult =
	| { status: 'ok'; sessions: SessionInfo[] }
	| { status: 'notInstalled' }
	| { status: 'unreachable' }
	| { status: 'error'; message: string };

/** `{"sessions":[…]}` as sessions; malformed JSON or entries give none. */
export function parseSessionList(stdout: string): SessionInfo[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const list = (parsed as { sessions?: unknown } | null)?.sessions;
	if (!Array.isArray(list)) {
		return [];
	}
	const out: SessionInfo[] = [];
	for (const s of list) {
		if (typeof s !== 'object' || s === null || typeof s.name !== 'string' || s.name === '') {
			continue;
		}
		out.push({ name: s.name, default: s.default === true, running: s.running === true });
	}
	return out;
}

/** A `herdr session list --json` run, as a {@link ListResult}. */
export function interpretSessionList(res: ShellResult, isSsh: boolean): ListResult {
	if (res.exitCode === 0) {
		return { status: 'ok', sessions: parseSessionList(res.stdout.toString('utf8')) };
	}
	if (isSsh && res.exitCode === SSH_FAILURE_EXIT) {
		return { status: 'unreachable' };
	}
	if (res.exitCode === 127) {
		return { status: 'notInstalled' };
	}
	const stderr = res.stderr.toString('utf8').trim();
	return { status: 'error', message: stderr.split('\n')[0] || `herdr exited with ${res.exitCode}` };
}

/** `<environment key>/<session name>`. */
export function sessionKey(envKey: string, name: string): string {
	return `${envKey}/${name}`;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface SnapshotWorkspace {
	workspace_id: string;
	label: string;
	number: number;
	focused: boolean;
	repoName?: string;
}

export interface SnapshotTab {
	tab_id: string;
	workspace_id: string;
	label: string;
	number: number;
	focused: boolean;
}

export interface SnapshotPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	label?: string;
	agent?: string;
	display_agent?: string;
	agent_status: AgentStatus;
	cwd?: string;
	foreground_cwd?: string;
	terminal_title_stripped?: string;
	focused: boolean;
}

export interface Snapshot {
	workspaces: SnapshotWorkspace[];
	tabs: SnapshotTab[];
	panes: SnapshotPane[];
	/** `name` from `agents[]`, by pane id, where it is a string. */
	agentNames: Map<string, string>;
	/** The pane herdr itself has focused, whatever VS Code's tiles are doing. */
	focusedPaneId?: string;
	version?: string;
}

function objects(value: unknown): Record<string, unknown>[] {
	const list = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.values(value) : [];
	return list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number {
	return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER;
}

/** `result.snapshot` of `session.snapshot`, typed; undefined when it is not an object. */
export function parseSnapshot(raw: unknown): Snapshot | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const s = raw as Record<string, unknown>;
	const workspaces: SnapshotWorkspace[] = [];
	for (const w of objects(s.workspaces)) {
		const id = str(w.workspace_id);
		if (!id) {
			continue;
		}
		const worktree = typeof w.worktree === 'object' && w.worktree !== null ? (w.worktree as Record<string, unknown>) : undefined;
		workspaces.push({
			workspace_id: id,
			label: str(w.label) ?? id,
			number: num(w.number),
			focused: w.focused === true,
			repoName: str(worktree?.repo_name),
		});
	}
	const tabs: SnapshotTab[] = [];
	for (const t of objects(s.tabs)) {
		const id = str(t.tab_id);
		const ws = str(t.workspace_id);
		if (!id || !ws) {
			continue;
		}
		tabs.push({ tab_id: id, workspace_id: ws, label: str(t.label) ?? id, number: num(t.number), focused: t.focused === true });
	}
	const panes: SnapshotPane[] = [];
	for (const p of objects(s.panes)) {
		const id = str(p.pane_id);
		const tab = str(p.tab_id);
		const ws = str(p.workspace_id);
		if (!id || !tab || !ws) {
			continue;
		}
		panes.push({
			pane_id: id,
			tab_id: tab,
			workspace_id: ws,
			label: str(p.label),
			agent: str(p.agent),
			display_agent: str(p.display_agent),
			agent_status: toStatus(p.agent_status),
			cwd: str(p.cwd),
			foreground_cwd: str(p.foreground_cwd),
			terminal_title_stripped: str(p.terminal_title_stripped),
			focused: p.focused === true,
		});
	}
	const agentNames = new Map<string, string>();
	for (const a of objects(s.agents)) {
		const id = str(a.pane_id);
		const name = str(a.name);
		if (id && name) {
			agentNames.set(id, name);
		}
	}
	return { workspaces, tabs, panes, agentNames, focusedPaneId: str(s.focused_pane_id), version: str(s.version) };
}

/** Whether a pane runs an agent. */
export function hasAgent(pane: SnapshotPane): boolean {
	return pane.agent !== undefined;
}

/**
 * A pane's row label: its live agent name, else `display_agent`, `agent`,
 * `label`, the basename of `foreground_cwd ?? cwd`, else `shell`.
 */
export function paneLabel(pane: SnapshotPane, snapshot: Pick<Snapshot, 'agentNames'>): string {
	const dir = pane.foreground_cwd ?? pane.cwd;
	const base = dir ? path.posix.basename(dir.replace(/\/+$/, '')) : undefined;
	return snapshot.agentNames.get(pane.pane_id) ?? pane.display_agent ?? pane.agent ?? pane.label ?? (base || undefined) ?? 'shell';
}

/** The sorted pane ids of a snapshot, as one comparable string. */
function paneSetKey(ids: readonly string[]): string {
	return [...ids].sort().join('\n');
}

// ── Model ───────────────────────────────────────────────────────────────────

export type EnvStatus = 'pending' | 'ok' | 'notInstalled' | 'unreachable' | 'error';

export interface EnvState {
	env: Environment;
	status: EnvStatus;
	message?: string;
	sessions: SessionInfo[];
}

export type ConnectionState = 'connecting' | 'connected' | 'unsupported' | 'disconnected';

const SNAPSHOT_DEBOUNCE_MS = 150;
/** Reconnect delays after a subscription ends on its own; the last repeats. */
export const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000];
const RELIST_INTERVAL_MS = 10000;
const LIST_TIMEOUT_MS = 20000;
const CHANGE_COALESCE_MS = 30;

/** One running session's bridge: a subscription plus the latest snapshot. */
export class SessionConnection {
	state: ConnectionState = 'connecting';
	snapshot: Snapshot | undefined;

	private gen = 0;
	private sub: Subscription | undefined;
	private subPanes = '';
	private snapshotTimer: NodeJS.Timeout | undefined;
	private snapshotRunning = false;
	private snapshotDirty = false;
	private retryTimer: NodeJS.Timeout | undefined;
	private attempts = 0;
	private disposed = false;

	constructor(
		readonly key: string,
		readonly env: Environment,
		readonly name: string,
		private readonly hooks: {
			changed(): void;
			/** Every event of this session, as it arrives. */
			event(ev: HerdrEvent): void;
			log(line: string): void;
			/** Re-lists the environment; this connection is disposed if the session is gone. */
			relist(): Promise<void>;
		},
	) {}

	get isDisposed(): boolean {
		return this.disposed;
	}

	private setState(state: ConnectionState): void {
		this.state = state;
		if (state !== 'connected') {
			this.snapshot = undefined;
		}
		this.hooks.changed();
	}

	/** Check the bridge, subscribe, then snapshot. Safe to call again: the old run is dropped. */
	async connect(): Promise<void> {
		const gen = this.reset();
		this.setState('connecting');
		const shell = this.env.shell;
		if (!(await checkBridge(shell, this.name))) {
			if (gen === this.gen) {
				this.hooks.log(`${this.key}: remote-api-bridge --check failed`);
				this.setState('unsupported');
			}
			return;
		}
		if (gen !== this.gen) {
			return;
		}
		let sub: Subscription;
		try {
			sub = await subscribe(shell, this.name, subscriptionList([]), (ev) => this.onEvent(gen, ev));
		} catch (err) {
			if (gen === this.gen) {
				this.hooks.log(`${this.key}: subscribe failed: ${(err as Error).message}`);
				this.lost(gen);
			}
			return;
		}
		if (gen !== this.gen) {
			sub.close();
			return;
		}
		this.attach(gen, sub, '');
		await this.takeSnapshot(gen);
	}

	/** Refresh: a new snapshot when connected, else connect again now. */
	refresh(): void {
		if (this.state === 'connected') {
			this.scheduleSnapshot(this.gen, 0);
		} else {
			this.attempts = 0;
			void this.connect();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
	}

	/** Drops the current run: timers cleared, subscription ended. Returns the new generation. */
	private reset(): number {
		const gen = ++this.gen;
		clearTimeout(this.snapshotTimer);
		clearTimeout(this.retryTimer);
		this.snapshotTimer = undefined;
		this.retryTimer = undefined;
		this.snapshotDirty = false;
		const sub = this.sub;
		this.sub = undefined;
		this.subPanes = '';
		sub?.close();
		return gen;
	}

	/** Makes `sub` the live subscription, then closes the one it replaces. */
	private attach(gen: number, sub: Subscription, panes: string): void {
		const old = this.sub;
		this.sub = sub;
		this.subPanes = panes;
		void sub.ended.then(() => {
			if (this.sub === sub && gen === this.gen) {
				this.hooks.log(`${this.key}: subscription ended`);
				this.lost(gen);
			}
		});
		old?.close();
	}

	/** The subscription ended on its own: disconnected, and a retry after a backoff. */
	private lost(gen: number): void {
		if (this.disposed || gen !== this.gen) {
			return;
		}
		const sub = this.sub;
		this.sub = undefined;
		this.subPanes = '';
		sub?.close();
		clearTimeout(this.snapshotTimer);
		this.snapshotTimer = undefined;
		this.setState('disconnected');
		const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)];
		this.attempts++;
		this.retryTimer = setTimeout(async () => {
			if (gen !== this.gen || this.disposed) {
				return;
			}
			// Re-list first: the session may have stopped, which disposes this connection.
			await this.hooks.relist();
			if (gen === this.gen && !this.disposed) {
				void this.connect();
			}
		}, delay);
	}

	private onEvent(gen: number, ev: HerdrEvent): void {
		if (gen === this.gen) {
			this.scheduleSnapshot(gen, SNAPSHOT_DEBOUNCE_MS);
			this.hooks.event(ev);
		}
	}

	private scheduleSnapshot(gen: number, delay: number): void {
		if (this.snapshotTimer !== undefined) {
			return;
		}
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.takeSnapshot(gen);
		}, delay);
	}

	private async takeSnapshot(gen: number): Promise<void> {
		if (this.snapshotRunning) {
			this.snapshotDirty = true;
			return;
		}
		this.snapshotRunning = true;
		try {
			let snapshot: Snapshot | undefined;
			try {
				const result = (await bridgeRequest(this.env.shell, this.name, 'session.snapshot', {})) as
					| { snapshot?: unknown }
					| undefined;
				snapshot = parseSnapshot(result?.snapshot);
			} catch (err) {
				this.hooks.log(`${this.key}: session.snapshot failed: ${(err as Error).message}`);
			}
			if (gen !== this.gen) {
				return;
			}
			if (!snapshot) {
				// Before the first snapshot this is the connection failing; later, the next event retries.
				if (this.state !== 'connected') {
					this.lost(gen);
				}
				return;
			}
			const paneIds = snapshot.panes.map((p) => p.pane_id);
			const panesKey = paneSetKey(paneIds);
			if (panesKey !== this.subPanes) {
				try {
					const next = await subscribe(this.env.shell, this.name, subscriptionList(paneIds), (ev) =>
						this.onEvent(gen, ev),
					);
					if (gen !== this.gen) {
						next.close();
						return;
					}
					this.attach(gen, next, panesKey);
				} catch (err) {
					// Status changes go unseen until the next structural event retries.
					this.hooks.log(`${this.key}: resubscribe failed: ${(err as Error).message}`);
				}
			}
			if (gen !== this.gen) {
				return;
			}
			this.snapshot = snapshot;
			this.state = 'connected';
			this.attempts = 0;
			this.hooks.changed();
		} finally {
			this.snapshotRunning = false;
			if (this.snapshotDirty) {
				this.snapshotDirty = false;
				this.scheduleSnapshot(this.gen, SNAPSHOT_DEBOUNCE_MS);
			}
		}
	}
}

/**
 * Every environment's sessions, and a {@link SessionConnection} per running
 * session. Sessions are re-listed every 10 s per reachable environment
 * (unreachable SSH hosts wait for the 30 s SSH pass) and on Refresh.
 */
export class SessionModel implements vscode.Disposable {
	private readonly envStates = new Map<string, EnvState>();
	private readonly conns = new Map<string, SessionConnection>();
	private readonly listing = new Map<string, Promise<void>>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	/** Every event of every connected session, as it arrives (`onDidChange` follows the snapshot). */
	readonly onDidEvent = this.events.event;
	private changeTimer: NodeJS.Timeout | undefined;
	private readonly ticker: NodeJS.Timeout;
	private readonly envListener: vscode.Disposable;
	private disposed = false;

	constructor(
		readonly environments: Environments,
		private readonly log: (line: string) => void,
	) {
		this.envListener = environments.onDidChange((change) => {
			for (const env of change.removed) {
				this.envStates.delete(env.key);
				this.reconcile(env.key, []);
			}
			for (const env of change.added) {
				this.envStates.set(env.key, { env, status: 'pending', sessions: [] });
				void this.relist(env.key);
			}
			for (const env of change.recheck) {
				void this.relist(env.key);
			}
			this.fireChanged();
		});
		this.ticker = setInterval(() => {
			for (const state of this.envStates.values()) {
				if (!(state.env.kind === 'ssh' && state.status === 'unreachable')) {
					void this.relist(state.env.key);
				}
			}
		}, RELIST_INTERVAL_MS);
	}

	start(): void {
		this.environments.start();
	}

	/** Environments in display order, with their listing state. */
	states(): EnvState[] {
		return this.environments
			.list()
			.map((env) => this.envStates.get(env.key))
			.filter((s): s is EnvState => s !== undefined);
	}

	connection(key: string): SessionConnection | undefined {
		return this.conns.get(key);
	}

	connections(): SessionConnection[] {
		return [...this.conns.values()];
	}

	/** Refresh: rediscover environments, re-list every one, re-snapshot every session. */
	async refresh(): Promise<void> {
		await this.environments.rediscover();
		await Promise.all([...this.envStates.keys()].map((k) => this.relist(k)));
		for (const conn of this.conns.values()) {
			conn.refresh();
		}
	}

	/** One bridge request to a connected session. */
	request(key: string, method: string, params: unknown): Promise<unknown> {
		const conn = this.conns.get(key);
		if (!conn) {
			return Promise.reject(new Error(`session ${key} is not connected`));
		}
		return bridgeRequest(conn.env.shell, conn.name, method, params);
	}

	/** Lists an environment's sessions; a call during a run shares it. */
	relist(envKey: string): Promise<void> {
		let run = this.listing.get(envKey);
		if (!run) {
			run = this.list(envKey).finally(() => this.listing.delete(envKey));
			this.listing.set(envKey, run);
		}
		return run;
	}

	private async list(envKey: string): Promise<void> {
		const state = this.envStates.get(envKey);
		if (!state || this.disposed) {
			return;
		}
		let result: ListResult;
		try {
			const res = await state.env.shell.run(herdrArgv(['session', 'list', '--json']), { timeoutMs: LIST_TIMEOUT_MS });
			result = interpretSessionList(res, state.env.kind === 'ssh');
		} catch (err) {
			result =
				state.env.kind === 'ssh'
					? { status: 'unreachable' }
					: { status: 'error', message: (err as Error).message };
		}
		if (this.envStates.get(envKey) !== state || this.disposed) {
			return;
		}
		const before = JSON.stringify([state.status, state.message, state.sessions]);
		const prevStatus = state.status;
		state.status = result.status;
		state.message = result.status === 'error' ? result.message : undefined;
		state.sessions = result.status === 'ok' ? result.sessions : [];
		if (result.status !== 'ok' && result.status !== prevStatus) {
			this.log(`${envKey}: ${result.status}${state.message ? `: ${state.message}` : ''}`);
		}
		this.reconcile(
			envKey,
			state.sessions.filter((s) => s.running).map((s) => s.name),
		);
		if (JSON.stringify([state.status, state.message, state.sessions]) !== before) {
			this.fireChanged();
		}
	}

	/** Connections for exactly `running` in `envKey`: new ones started, gone ones disposed. */
	private reconcile(envKey: string, running: string[]): void {
		const env = this.environments.get(envKey);
		const wanted = new Set(running.map((name) => sessionKey(envKey, name)));
		for (const [key, conn] of this.conns) {
			if (conn.env.key === envKey && (!wanted.has(key) || conn.env !== env)) {
				conn.dispose();
				this.conns.delete(key);
				this.fireChanged();
			}
		}
		if (!env || this.disposed) {
			return;
		}
		for (const name of running) {
			const key = sessionKey(envKey, name);
			if (this.conns.has(key)) {
				continue;
			}
			const conn = new SessionConnection(key, env, name, {
				changed: () => this.fireChanged(),
				event: (event) => this.events.fire({ sessionKey: key, event }),
				log: this.log,
				relist: () => this.relist(envKey),
			});
			this.conns.set(key, conn);
			void conn.connect();
		}
	}

	private fireChanged(): void {
		if (this.changeTimer !== undefined || this.disposed) {
			return;
		}
		this.changeTimer = setTimeout(() => {
			this.changeTimer = undefined;
			if (!this.disposed) {
				this.changed.fire();
			}
		}, CHANGE_COALESCE_MS);
	}

	/** Ends every connection (stdin closed, so bridges inside containers stop too). */
	dispose(): void {
		this.disposed = true;
		clearInterval(this.ticker);
		clearTimeout(this.changeTimer);
		this.envListener.dispose();
		for (const conn of this.conns.values()) {
			conn.dispose();
		}
		this.conns.clear();
		this.environments.dispose();
		this.changed.dispose();
		this.events.dispose();
	}
}
