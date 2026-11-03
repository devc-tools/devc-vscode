import * as vscode from 'vscode';
import type { Snapshot } from './sessions';
import { AgentStatus } from './status';
import { makePaneKey, splitPaneKey } from './tilesProtocol';

/**
 * Time in state and the derived **done** state of agent panes. herdr 0.9.5
 * sends no timestamps and reports no `done`: a state's start is when the
 * snapshot showing it was applied here, and done is an idle that completed
 * work (`completion_seq`, or a working → idle seen here) and has not been
 * looked at since.
 */

/** Workspace state key of the persisted records. */
export const AGENT_STATES_KEY = 'herdr.agentStates';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_MS = 1000;

export interface AgentRecord {
	/** herdr's raw status. */
	status: AgentStatus;
	/** `state_change_seq`, when herdr sent one. */
	seq?: number;
	/** Epoch ms the state was first seen. */
	since: number;
	/** Whether `since` is when the state began (not the first sight of a state already running). */
	observed: boolean;
	/** The last completion: `c:<completion_seq>` or `l:<seq or time>`. */
	token?: string;
	seen: boolean;
}

/** One agent pane of a snapshot, as the tracker reads it. */
export interface AgentObservation {
	paneId: string;
	status: AgentStatus;
	stateChangeSeq?: number;
	completionSeq?: number;
}

/** What a pane shows: the displayed status and, when known, when that state began. */
export interface DisplayedState {
	status: AgentStatus;
	since?: number;
}

/** The persisted value: plain JSON. */
interface Persisted {
	v: 1;
	panes: Record<string, AgentRecord>;
}

const STATUSES: readonly AgentStatus[] = ['blocked', 'working', 'done', 'idle', 'unknown'];

function isUint(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A stored record, or undefined when it is not one. */
function toRecord(value: unknown): AgentRecord | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const r = value as Record<string, unknown>;
	if (
		!STATUSES.includes(r.status as AgentStatus) ||
		typeof r.since !== 'number' ||
		!Number.isFinite(r.since) ||
		typeof r.observed !== 'boolean' ||
		typeof r.seen !== 'boolean' ||
		(r.seq !== undefined && !isUint(r.seq)) ||
		(r.token !== undefined && typeof r.token !== 'string')
	) {
		return undefined;
	}
	const record: AgentRecord = { status: r.status as AgentStatus, since: r.since, observed: r.observed, seen: r.seen };
	if (r.seq !== undefined) {
		record.seq = r.seq as number;
	}
	if (r.token !== undefined) {
		record.token = r.token as string;
	}
	return record;
}

/** The records in a stored value; none when it is missing, malformed or another version. */
export function parsePersisted(value: unknown): Map<string, AgentRecord> {
	const out = new Map<string, AgentRecord>();
	if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) {
		return out;
	}
	const panes = (value as { panes?: unknown }).panes;
	if (typeof panes !== 'object' || panes === null || Array.isArray(panes)) {
		return out;
	}
	for (const [key, raw] of Object.entries(panes)) {
		const record = toRecord(raw);
		if (record) {
			out.set(key, record);
		}
	}
	return out;
}

/** `<1m`, `<n>m`, `<n>h`, `<n>d`. */
export function formatElapsed(ms: number): string {
	if (ms < 60000) {
		return '<1m';
	}
	if (ms < 3600000) {
		return `${Math.floor(ms / 60000)}m`;
	}
	if (ms < 86400000) {
		return `${Math.floor(ms / 3600000)}h`;
	}
	return `${Math.floor(ms / 86400000)}d`;
}

/** The status a record displays for herdr's raw status. */
export function displayedStatus(raw: AgentStatus, record: AgentRecord | undefined): AgentStatus {
	return raw === 'idle' && record?.token !== undefined && !record.seen ? 'done' : raw;
}

/** The agent panes of a snapshot, as observations (on the raw status). */
export function observations(snapshot: Snapshot): AgentObservation[] {
	return snapshot.panes
		.filter((p) => p.agent !== undefined)
		.map((p) => ({
			paneId: p.pane_id,
			status: p.raw_status,
			stateChangeSeq: p.state_change_seq,
			completionSeq: p.completion_seq,
		}));
}

export interface AgentStatesOptions {
	now?: () => number;
	/** Where records persist (workspace state); in memory only without one. */
	store?: Pick<vscode.Memento, 'get' | 'update'>;
}

/** Per agent pane records, keyed by pane key. */
export class AgentStates implements vscode.Disposable {
	private readonly records: Map<string, AgentRecord>;
	/** herdr's focused pane per session, as last applied. */
	private readonly herdrFocus = new Map<string, string | undefined>();
	private readonly now: () => number;
	private readonly store: AgentStatesOptions['store'];
	private persistTimer: NodeJS.Timeout | undefined;
	private dirty = false;

	constructor(options: AgentStatesOptions = {}) {
		this.now = options.now ?? Date.now;
		this.store = options.store;
		this.records = parsePersisted(this.store?.get(AGENT_STATES_KEY));
	}

	record(paneKey: string): AgentRecord | undefined {
		return this.records.get(paneKey);
	}

	/** The displayed status for herdr's raw one, with `since` when it is observed. */
	displayed(paneKey: string, raw: AgentStatus): DisplayedState {
		const record = this.records.get(paneKey);
		const status = displayedStatus(raw, record);
		return record?.observed && record.status === raw ? { status, since: record.since } : { status };
	}

	/**
	 * A session's snapshot is being applied. `first`: the first since its
	 * connection was (re)established. `connected`: every connected session's key,
	 * for pruning.
	 */
	apply(sessionKey: string, snapshot: Snapshot, first: boolean, connected?: ReadonlySet<string>): void {
		this.update(sessionKey, observations(snapshot), first);
		const prevFocus = this.herdrFocus.get(sessionKey);
		const focus = snapshot.focusedPaneId;
		const knewFocus = this.herdrFocus.has(sessionKey) && prevFocus !== undefined;
		this.herdrFocus.set(sessionKey, focus);
		if (!first && knewFocus && focus !== undefined && focus !== prevFocus) {
			this.markSeen(makePaneKey(sessionKey, focus));
		}
		if (connected) {
			this.pruneStale(connected);
		}
	}

	/** Applies one session's agent panes; records of its other panes are deleted. */
	update(sessionKey: string, agents: AgentObservation[], first: boolean): void {
		const now = this.now();
		const keep = new Set<string>();
		let changed = false;
		for (const a of agents) {
			const key = makePaneKey(sessionKey, a.paneId);
			keep.add(key);
			const raw = a.status;
			const seq = isUint(a.stateChangeSeq) ? a.stateChangeSeq : undefined;
			const cseqToken = isUint(a.completionSeq) ? `c:${a.completionSeq}` : undefined;
			const record = this.records.get(key);
			if (!record) {
				const created: AgentRecord = { status: raw, since: now, observed: !first, seen: true };
				if (seq !== undefined) {
					created.seq = seq;
				}
				if (raw === 'idle' && cseqToken !== undefined) {
					created.token = cseqToken;
				}
				this.records.set(key, created);
				changed = true;
				continue;
			}
			if (raw !== record.status || (seq !== undefined && record.seq !== undefined && seq !== record.seq)) {
				const prev = record.status;
				record.status = raw;
				if (seq !== undefined) {
					record.seq = seq;
				} else {
					delete record.seq;
				}
				record.since = now;
				record.observed = !first;
				if (raw === 'idle') {
					const token = cseqToken ?? (prev === 'working' ? `l:${seq ?? now}` : undefined);
					if (token !== undefined && token !== record.token) {
						record.token = token;
						record.seen = false;
					}
				}
				changed = true;
			} else {
				if (seq !== undefined && record.seq === undefined) {
					record.seq = seq;
					changed = true;
				}
				if (raw === 'idle' && cseqToken !== undefined && cseqToken !== record.token) {
					record.token = cseqToken;
					record.seen = false;
					changed = true;
				}
			}
		}
		for (const key of [...this.records.keys()]) {
			if (!keep.has(key) && splitPaneKey(key).sessionKey === sessionKey) {
				this.records.delete(key);
				changed = true;
			}
		}
		if (changed) {
			this.changed();
		}
	}

	/** The pane was looked at: done ends. Returns whether anything changed. */
	markSeen(paneKey: string): boolean {
		const record = this.records.get(paneKey);
		if (!record || record.seen) {
			return false;
		}
		record.seen = true;
		this.changed();
		return true;
	}

	/** Deletes records of sessions not in `connected` whose state is older than 7 days. */
	pruneStale(connected: ReadonlySet<string>): void {
		const limit = this.now() - WEEK_MS;
		let changed = false;
		for (const [key, record] of this.records) {
			if (record.since < limit && !connected.has(splitPaneKey(key).sessionKey)) {
				this.records.delete(key);
				changed = true;
			}
		}
		if (changed) {
			this.changed();
		}
	}

	/** The value persisted under {@link AGENT_STATES_KEY}. */
	toJSON(): Persisted {
		const panes: Record<string, AgentRecord> = {};
		for (const [key, r] of this.records) {
			panes[key] = { ...r };
		}
		return { v: 1, panes };
	}

	private changed(): void {
		if (!this.store) {
			return;
		}
		this.dirty = true;
		if (this.persistTimer === undefined) {
			this.persistTimer = setTimeout(() => {
				this.persistTimer = undefined;
				this.flush();
			}, PERSIST_MS);
		}
	}

	/** Writes the records now, if anything changed. */
	flush(): Thenable<void> | undefined {
		if (!this.store || !this.dirty) {
			return undefined;
		}
		this.dirty = false;
		return this.store.update(AGENT_STATES_KEY, this.toJSON());
	}

	dispose(): void {
		clearTimeout(this.persistTimer);
		this.persistTimer = undefined;
		void this.flush();
	}
}
