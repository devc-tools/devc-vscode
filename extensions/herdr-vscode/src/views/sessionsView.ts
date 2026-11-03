import * as vscode from 'vscode';
import { Environment, HOST_KEY } from '../environments';
import { EnvState, SessionConnection, SessionModel, sessionKey, Snapshot, hasAgent } from '../sessions';
import { AgentStatus, countsDescription, countStatuses, statusIcon, worstStatus } from '../status';

/** The session the Spaces view shows, by session key. */
export const SELECTED_SESSION_STATE = 'herdr.selectedSession';

/** The session name devc gives a container's session; not repeated in its row. */
const DEVC_SESSION = 'devc';

export interface GroupNode {
	type: 'group';
	id: string;
	label: string;
}

export interface SessionRowNode {
	type: 'session';
	/** Session key, or `<env key>/` for an environment-level row (no session). */
	key: string;
	envKey: string;
	/** Undefined on an environment-level row. */
	session?: string;
	label: string;
	description: string;
	contextValue: 'herdr.session.running' | 'herdr.session.stopped' | 'herdr.session.absent';
	tooltip: string;
	snapshot?: Snapshot;
	groupId: string;
	/** A listed session other than herdr's default one: it can be deleted. */
	deletable?: boolean;
	/** The environment's kind and, on SSH, its alias. */
	envKind: Environment['kind'];
	alias?: string;
	/** The status alone, without the container session name: agent counts, `stopped`, `connecting…`, `herdr not running`, … */
	statusText: string;
	/** An environment-level row (no listed session): why, as {@link EnvState.status}; `ok` is herdr not running. */
	envStatus?: EnvState['status'];
}

export type SessionsNode = GroupNode | SessionRowNode;

/** A session's row label: its name on this machine and SSH hosts, the folder name in a container. */
export function sessionRowLabel(env: Pick<Environment, 'kind' | 'label'>, session: string): string {
	return env.kind === 'container' ? env.label : session;
}

/** The group an environment's rows go under. */
export function groupOf(env: Pick<Environment, 'kind' | 'key' | 'alias'>): GroupNode {
	switch (env.kind) {
		case 'host':
			return { type: 'group', id: 'group:host', label: 'This machine' };
		case 'ssh':
			return { type: 'group', id: `group:${env.key}`, label: `SSH · ${env.alias}` };
		default:
			return { type: 'group', id: 'group:containers', label: 'Dev containers' };
	}
}

/** A connected session's agent status counts, as the row description. */
/** A session row's icon status: connected, the worst agent status (idle with none); not connected, off (undefined). */
export function sessionRowStatus(snapshot: Snapshot | undefined): AgentStatus | undefined {
	return snapshot ? (worstStatus(snapshot.panes.filter(hasAgent).map((p) => p.agent_status)) ?? 'idle') : undefined;
}

export function snapshotDescription(snapshot: Snapshot): string {
	return countsDescription(countStatuses(snapshot.panes.filter(hasAgent).map((p) => p.agent_status)));
}

const ENV_DESCRIPTION: Record<Exclude<EnvState['status'], 'ok'>, string> = {
	pending: 'checking…',
	notInstalled: 'herdr not installed',
	unreachable: 'unreachable',
	error: 'error',
};

/** The rows for one environment. */
export function sessionRows(
	state: EnvState,
	connection: (key: string) => SessionConnection | undefined,
	showStopped: boolean,
): SessionRowNode[] {
	const env = state.env;
	const groupId = groupOf(env).id;
	const absent = (description: string, tooltip?: string): SessionRowNode => ({
		type: 'session',
		key: `${env.key}/`,
		envKey: env.key,
		label: env.label,
		description,
		contextValue: 'herdr.session.absent',
		tooltip: tooltip ?? env.key,
		groupId,
		envKind: env.kind,
		alias: env.alias,
		statusText: description,
		envStatus: state.status,
	});
	if (state.status !== 'ok') {
		return [absent(ENV_DESCRIPTION[state.status], state.message ? `${env.key}\n${state.message}` : undefined)];
	}
	const rows: SessionRowNode[] = [];
	for (const s of state.sessions) {
		// This machine's stopped sessions are always listed: they can be started from here.
		if (!s.running && !showStopped && env.kind !== 'host') {
			continue;
		}
		const key = sessionKey(env.key, s.name);
		const conn = s.running ? connection(key) : undefined;
		let statusText: string;
		if (!s.running) {
			statusText = 'stopped';
		} else if (conn?.state === 'connected' && conn.snapshot) {
			statusText = snapshotDescription(conn.snapshot);
		} else if (conn?.state === 'unsupported') {
			statusText = 'needs herdr 0.9.5 or later';
		} else if (conn?.state === 'disconnected') {
			statusText = 'disconnected';
		} else {
			statusText = 'connecting…';
		}
		const description = env.kind === 'container' && s.name !== DEVC_SESSION ? `${s.name} · ${statusText}` : statusText;
		const version = conn?.snapshot?.version;
		rows.push({
			type: 'session',
			key,
			envKey: env.key,
			session: s.name,
			label: sessionRowLabel(env, s.name),
			description,
			contextValue: s.running ? 'herdr.session.running' : 'herdr.session.stopped',
			tooltip: version ? `${key}\nherdr ${version}` : key,
			snapshot: conn?.state === 'connected' ? conn.snapshot : undefined,
			groupId,
			deletable: !s.default,
			envKind: env.kind,
			alias: env.alias,
			statusText,
		});
	}
	if (rows.length > 0) {
		return rows;
	}
	// A container's herdr can be started from here: the row starts devc's session.
	return env.kind === 'container'
		? [{ ...absent('herdr not running'), session: DEVC_SESSION, contextValue: 'herdr.session.stopped' }]
		: [absent('herdr not running')];
}

/** The Sessions tree section a row goes under. */
export function sessionTreeSection(row: Pick<SessionRowNode, 'contextValue'>): 'running' | 'stopped' {
	return row.contextValue === 'herdr.session.running' ? 'running' : 'stopped';
}

/**
 * A Sessions tree row's description: where it runs (nothing for this machine,
 * `ssh <alias>`, `dev container`), a container's session name unless `devc`,
 * then its status; the parts that are non-empty, joined with ` · `.
 */
export function sessionTreeDescription(
	row: Pick<SessionRowNode, 'key' | 'envKey' | 'session' | 'contextValue' | 'envKind' | 'alias' | 'statusText'>,
): string {
	const envLevel = row.key === `${row.envKey}/`;
	let where: string | undefined;
	if (row.envKind === 'ssh') {
		where = envLevel ? 'ssh' : `ssh ${row.alias ?? ''}`.trim();
	} else if (row.envKind === 'container') {
		where = 'dev container';
	}
	const name = !envLevel && row.envKind === 'container' && row.session !== DEVC_SESSION ? row.session : undefined;
	let status: string | undefined = row.statusText;
	if (!envLevel && row.contextValue === 'herdr.session.stopped') {
		status = row.envKind === 'ssh' ? 'start not supported' : undefined;
	}
	return [where, name, status].filter((x): x is string => !!x).join(' · ');
}

/** A Sessions tree row's context value: `herdr.session.<state> <kind>[ deletable]`. */
export function sessionTreeContextValue(row: Pick<SessionRowNode, 'contextValue' | 'envKind' | 'deletable'>): string {
	const deletable = row.deletable && row.contextValue !== 'herdr.session.absent' ? ' deletable' : '';
	return `${row.contextValue} ${row.envKind}${deletable}`;
}

/**
 * The selected session: the stored one while it runs and is connected or
 * connecting, else this machine's default session, else the first running one.
 */
export function effectiveSelection(
	preferred: string | undefined,
	states: EnvState[],
	connection: (key: string) => SessionConnection | undefined,
): string | undefined {
	if (preferred && connection(preferred)) {
		return preferred;
	}
	const host = states.find((s) => s.env.key === HOST_KEY);
	const hostDefault = host?.sessions.find((s) => s.default && s.running);
	if (hostDefault && connection(sessionKey(HOST_KEY, hostDefault.name))) {
		return sessionKey(HOST_KEY, hostDefault.name);
	}
	for (const state of states) {
		for (const s of state.sessions) {
			if (s.running && connection(sessionKey(state.env.key, s.name))) {
				return sessionKey(state.env.key, s.name);
			}
		}
	}
	return undefined;
}

export const SWITCH_SESSION_COMMAND = 'herdr.sessions.switch';

/** What accepting a picker row does. */
export type SessionPickAction = 'select' | 'start' | 'unsupported' | 'none';

/** An item button on a picker row. */
export type SessionPickButton = 'stop' | 'delete';

/** A Switch Session entry: a group separator or a session row. */
export type SessionPickEntry =
	| { kind: 'separator'; label: string }
	| {
			kind: 'session';
			label: string;
			description: string;
			/** The icon's status: undefined is the empty circle (not running). */
			status: AgentStatus | undefined;
			buttons: SessionPickButton[];
			action: SessionPickAction;
			row: SessionRowNode;
	  };

/**
 * What accepting a row does: a running session is selected, a stopped one on
 * this machine or in a dev container is started, a stopped SSH one is not
 * supported yet, and a row with no session (unreachable, not installed) does nothing.
 */
export function sessionPickAction(row: Pick<SessionRowNode, 'contextValue' | 'session'>, kind: Environment['kind'] | undefined): SessionPickAction {
	switch (row.contextValue) {
		case 'herdr.session.running':
			return 'select';
		case 'herdr.session.stopped':
			if (!row.session) {
				return 'none';
			}
			return kind === 'host' || kind === 'container' ? 'start' : 'unsupported';
		default:
			return 'none';
	}
}

/** A row's buttons: Stop on this machine's running sessions, Delete on any session but herdr's default one. */
export function sessionPickButtons(row: Pick<SessionRowNode, 'contextValue' | 'envKey' | 'deletable'>): SessionPickButton[] {
	const buttons: SessionPickButton[] = [];
	if (row.contextValue === 'herdr.session.running' && row.envKey === HOST_KEY) {
		buttons.push('stop');
	}
	if (row.deletable && row.contextValue !== 'herdr.session.absent') {
		buttons.push('delete');
	}
	return buttons;
}

/** Switch Session's entries, in environment order: a separator per group, then its rows. */
export function sessionPickEntries(
	groups: readonly GroupNode[],
	rows: ReadonlyMap<string, readonly SessionRowNode[]>,
	kindOf: (envKey: string) => Environment['kind'] | undefined,
): SessionPickEntry[] {
	const entries: SessionPickEntry[] = [];
	for (const group of groups) {
		const list = rows.get(group.id) ?? [];
		if (list.length === 0) {
			continue;
		}
		entries.push({ kind: 'separator', label: group.label });
		for (const row of list) {
			entries.push({
				kind: 'session',
				label: row.label,
				description: row.description,
				status: row.contextValue === 'herdr.session.running' ? sessionRowStatus(row.snapshot) : undefined,
				buttons: sessionPickButtons(row),
				action: sessionPickAction(row, kindOf(row.envKey)),
				row,
			});
		}
	}
	return entries;
}

/** A place New Session can start a session in. */
export interface NewSessionPlace {
	label: string;
	description?: string;
	envKey: string;
}

/** New Session's places: this machine, then each dev container whose herdr is reachable. No SSH hosts. */
export function newSessionPlaces(states: readonly Pick<EnvState, 'env' | 'status'>[]): NewSessionPlace[] {
	const places: NewSessionPlace[] = [{ label: 'This machine', envKey: HOST_KEY }];
	for (const s of states) {
		if (s.env.kind === 'container' && s.status === 'ok') {
			places.push({ label: s.env.label, description: 'Dev container', envKey: s.env.key });
		}
	}
	return places;
}

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** New Session's name check: undefined when `name` can be used in a place with `existing` sessions. */
export function validateSessionName(name: string, existing: readonly string[]): string | undefined {
	if (name.trim() === '') {
		return 'Enter a name.';
	}
	if (!SESSION_NAME.test(name)) {
		return 'Use letters, digits, ".", "_" or "-".';
	}
	if (existing.includes(name)) {
		return `A session named "${name}" already exists there.`;
	}
	return undefined;
}

/** The sessions of every environment as rows, and which one is selected. */
export class SessionList implements vscode.Disposable {
	private readonly selectionEmitter = new vscode.EventEmitter<void>();
	/** Fires when {@link selected} may have changed. */
	readonly onDidChangeSelected = this.selectionEmitter.event;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	/** Fires when the rows were rebuilt. */
	readonly onDidChange = this.changeEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private groups: GroupNode[] = [];
	private rows = new Map<string, SessionRowNode[]>();
	private lastSelected: string | undefined;

	constructor(
		private readonly model: SessionModel,
		private readonly state: vscode.Memento,
	) {
		this.disposables.push(
			this.selectionEmitter,
			this.changeEmitter,
			model.onDidChange(() => this.update()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('herdr.showStoppedSessions')) {
					this.update();
				}
			}),
		);
		this.rebuild();
		this.lastSelected = this.selected;
	}

	/** The selected session's key, if any. */
	get selected(): string | undefined {
		return effectiveSelection(this.state.get<string>(SELECTED_SESSION_STATE), this.model.states(), (k) =>
			this.model.connection(k),
		);
	}

	/** Makes a running session the selected one. */
	select(key: string): void {
		void this.state.update(SELECTED_SESSION_STATE, key);
		this.update();
	}

	/** The row for a session key. */
	row(key: string): SessionRowNode | undefined {
		for (const rows of this.rows.values()) {
			const row = rows.find((r) => r.key === key);
			if (row) {
				return row;
			}
		}
		return undefined;
	}

	/** Every row, in environment order. */
	allRows(): SessionRowNode[] {
		return this.groups.flatMap((g) => this.rows.get(g.id) ?? []);
	}

	/** Switch Session's entries now. */
	pickEntries(): SessionPickEntry[] {
		return sessionPickEntries(this.groups, this.rows, (k) => this.model.environments.get(k)?.kind);
	}

	private rebuild(): void {
		const showStopped = vscode.workspace.getConfiguration('herdr').get<boolean>('showStoppedSessions') === true;
		const groups = new Map<string, GroupNode>();
		const rows = new Map<string, SessionRowNode[]>();
		for (const state of this.model.states()) {
			const group = groupOf(state.env);
			groups.set(group.id, group);
			const list = rows.get(group.id) ?? [];
			list.push(...sessionRows(state, (k) => this.model.connection(k), showStopped));
			rows.set(group.id, list);
		}
		this.groups = [...groups.values()];
		this.rows = rows;
	}

	private update(): void {
		this.rebuild();
		this.changeEmitter.fire();
		const selected = this.selected;
		if (selected !== this.lastSelected) {
			this.lastSelected = selected;
			this.selectionEmitter.fire();
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
