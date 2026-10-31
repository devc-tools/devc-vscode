import { splitPaneKey } from './tilesProtocol';

/**
 * Where "changed in this pane" starts: a snapshot of the pane's worktree taken
 * the first time the view loads that pane in that repo. Kept in
 * `workspaceState`, so a reload keeps the time.
 */

export const BASELINES_KEY = 'herdr.paneContext.baselines';
/** Entries older than this go. */
export const BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Baseline {
	/** The tree of the whole working state. */
	tree: string;
	/** HEAD's full SHA; empty in a repo with no commits. */
	head: string;
	/** ms since epoch. */
	at: number;
}

/** The parts of a `Memento` used here. */
export interface BaselineMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export function baselineKey(paneKey: string, toplevel: string): string {
	return `${paneKey}\n${toplevel}`;
}

function paneKeyOf(key: string): string {
	return key.slice(0, key.indexOf('\n'));
}

function isBaseline(value: unknown): value is Baseline {
	const b = value as Baseline | undefined;
	return typeof b?.tree === 'string' && typeof b.head === 'string' && typeof b.at === 'number';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` today, else `Mon D HH:MM`, local time; no locale formatting. */
export function baselineTime(at: number, now: number = Date.now()): string {
	const then = new Date(at);
	const today = new Date(now);
	const time = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
	const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
	return sameDay ? time : `${MONTHS[then.getMonth()]} ${then.getDate()} ${time}`;
}

/** `since 10:31`, `since Oct 30 09:05`. */
export function sinceLabel(at: number, now: number = Date.now()): string {
	return `since ${baselineTime(at, now)}`;
}

/** What a pane is, as pruning sees it. */
export type PaneState = 'present' | 'closed' | 'unknown';

/** The baselines of every (pane, toplevel), in a memento. */
export class BaselineStore {
	constructor(private readonly memento: BaselineMemento) {}

	private all(): Record<string, Baseline> {
		const stored = this.memento.get<Record<string, unknown>>(BASELINES_KEY);
		const out: Record<string, Baseline> = {};
		for (const [key, value] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
			if (isBaseline(value)) {
				out[key] = value;
			}
		}
		return out;
	}

	private save(all: Record<string, Baseline>): Thenable<void> {
		return this.memento.update(BASELINES_KEY, all);
	}

	get(paneKey: string, toplevel: string): Baseline | undefined {
		return this.all()[baselineKey(paneKey, toplevel)];
	}

	set(paneKey: string, toplevel: string, baseline: Baseline): Thenable<void> {
		const all = this.all();
		all[baselineKey(paneKey, toplevel)] = baseline;
		return this.save(all);
	}

	delete(paneKey: string, toplevel: string): Thenable<void> {
		const all = this.all();
		delete all[baselineKey(paneKey, toplevel)];
		return this.save(all);
	}

	/** Every stored key, for tests and logs. */
	keys(): string[] {
		return Object.keys(this.all());
	}

	/**
	 * Drops entries older than {@link BASELINE_MAX_AGE_MS}, and every entry of a
	 * pane that is `closed` (its session connected, and the pane not in it). A
	 * pane whose session is not connected is `unknown` and keeps its entries.
	 */
	prune(paneState: (paneKey: string) => PaneState, now: number = Date.now()): Thenable<void> | undefined {
		const all = this.all();
		let dropped = false;
		for (const [key, baseline] of Object.entries(all)) {
			if (now - baseline.at > BASELINE_MAX_AGE_MS || paneState(paneKeyOf(key)) === 'closed') {
				delete all[key];
				dropped = true;
			}
		}
		return dropped ? this.save(all) : undefined;
	}

	/** A pane moved to another workspace has a new id: its entries go with it. */
	move(fromPaneKey: string, toPaneKey: string): Thenable<void> | undefined {
		const all = this.all();
		let moved = false;
		for (const [key, baseline] of Object.entries(all)) {
			if (paneKeyOf(key) === fromPaneKey) {
				delete all[key];
				all[`${toPaneKey}${key.slice(fromPaneKey.length)}`] = baseline;
				moved = true;
			}
		}
		return moved ? this.save(all) : undefined;
	}
}

/** A memento in memory, for views built without one (tests). */
export function memoryMemento(): BaselineMemento {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string) => values.get(key) as T | undefined,
		update: (key, value) => {
			values.set(key, JSON.parse(JSON.stringify(value)));
			return Promise.resolve();
		},
	};
}

/** Whether a pane key's session is connected and lacks the pane. */
export function paneStateIn(connection: (sessionKey: string) => { state: string; snapshot?: { panes: { pane_id: string }[] } } | undefined): (paneKey: string) => PaneState {
	return (paneKey) => {
		const { sessionKey, paneId } = splitPaneKey(paneKey);
		const conn = connection(sessionKey);
		if (conn?.state !== 'connected' || !conn.snapshot) {
			return 'unknown';
		}
		return conn.snapshot.panes.some((p) => p.pane_id === paneId) ? 'present' : 'closed';
	};
}
