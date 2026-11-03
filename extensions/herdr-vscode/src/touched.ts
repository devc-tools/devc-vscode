import * as vscode from 'vscode';
import { cleanupSpanDirs, makeSpanDir, readToplevel, removeSpanDir, spanDiff, spanSnapshot, TreeChange } from './git';
import { RemoteShell } from './remoteShell';
import { hasAgent, parsePaneMoved, SessionConnection, SessionModel } from './sessions';
import { makePaneKey, splitPaneKey } from './tilesProtocol';

/**
 * "Files this pane touched": what changed in a pane's worktree while its agent
 * was `working`. Each working span snapshots the worktree at its start and end
 * into a temporary object directory outside the repo (see `SPAN_SNAPSHOT_SCRIPT`),
 * so nothing is written to the repo's `.git`. Two agents working in one
 * worktree at once see each other's files.
 */

export const TOUCHED_KEY = 'herdr.paneContext.touched';
/** Entries older than this go. */
export const TOUCHED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface TouchedEntry {
	/** Sorted, unique, relative to the toplevel. */
	paths: string[];
	/** ms since epoch of the last update. */
	at: number;
}

/** The parts of a `Memento` used here. */
export interface TouchedMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export function touchedKey(paneKey: string, toplevel: string): string {
	return `${paneKey}\n${toplevel}`;
}

function paneKeyOf(key: string): string {
	return key.slice(0, key.indexOf('\n'));
}

function isEntry(value: unknown): value is TouchedEntry {
	const e = value as TouchedEntry | undefined;
	return Array.isArray(e?.paths) && e.paths.every((p) => typeof p === 'string') && typeof e.at === 'number';
}

/** What a pane is, as pruning sees it. */
export type PaneState = 'present' | 'closed' | 'unknown';

/** The touched files of every (pane, toplevel), in a memento. */
export class TouchedStore implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	/** Fires after every change of what is stored. */
	readonly onDidChange = this.emitter.event;

	constructor(private readonly memento: TouchedMemento) {}

	private all(): Record<string, TouchedEntry> {
		const stored = this.memento.get<Record<string, unknown>>(TOUCHED_KEY);
		const out: Record<string, TouchedEntry> = {};
		for (const [key, value] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
			if (isEntry(value)) {
				out[key] = value;
			}
		}
		return out;
	}

	private async save(all: Record<string, TouchedEntry>): Promise<void> {
		await this.memento.update(TOUCHED_KEY, all);
		this.emitter.fire();
	}

	get(paneKey: string, toplevel: string): TouchedEntry | undefined {
		return this.all()[touchedKey(paneKey, toplevel)];
	}

	/** Adds paths to (pane, toplevel)'s set. */
	add(paneKey: string, toplevel: string, paths: string[], now: number = Date.now()): Promise<void> {
		const all = this.all();
		const key = touchedKey(paneKey, toplevel);
		const merged = [...new Set([...(all[key]?.paths ?? []), ...paths])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		all[key] = { paths: merged, at: now };
		return this.save(all);
	}

	/** Every stored key, for tests and logs. */
	keys(): string[] {
		return Object.keys(this.all());
	}

	/**
	 * Drops entries older than {@link TOUCHED_MAX_AGE_MS}, and every entry of a
	 * pane that is `closed` (its session connected, and the pane not in it). A
	 * pane whose session is not connected is `unknown` and keeps its entries.
	 */
	prune(paneState: (paneKey: string) => PaneState, now: number = Date.now()): Promise<void> | undefined {
		const all = this.all();
		let dropped = false;
		for (const [key, entry] of Object.entries(all)) {
			if (now - entry.at > TOUCHED_MAX_AGE_MS || paneState(paneKeyOf(key)) === 'closed') {
				delete all[key];
				dropped = true;
			}
		}
		return dropped ? this.save(all) : undefined;
	}

	/** A pane moved to another workspace has a new id: its entries go with it. */
	move(fromPaneKey: string, toPaneKey: string): Promise<void> | undefined {
		const all = this.all();
		let moved = false;
		for (const [key, entry] of Object.entries(all)) {
			if (paneKeyOf(key) === fromPaneKey) {
				delete all[key];
				all[`${toPaneKey}${key.slice(fromPaneKey.length)}`] = entry;
				moved = true;
			}
		}
		return moved ? this.save(all) : undefined;
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

/** A memento in memory, for stores built without one (tests). */
export function memoryMemento(): TouchedMemento {
	const values = new Map<string, unknown>();
	return {
		get: <T>(key: string) => values.get(key) as T | undefined,
		update: (key, value) => {
			values.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
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

// ── The recorder ────────────────────────────────────────────────────────────

/** The git a span needs; the real one is in `git.ts`, injected for tests. */
export interface SpanGit {
	toplevel(shell: RemoteShell, dir: string): Promise<string | undefined>;
	makeDir(shell: RemoteShell): Promise<string>;
	snapshot(shell: RemoteShell, toplevel: string, spanDir: string): Promise<string>;
	diff(shell: RemoteShell, toplevel: string, spanDir: string, from: string, to: string): Promise<TreeChange[]>;
	removeDir(shell: RemoteShell, spanDir: string): Promise<void>;
	cleanup(shell: RemoteShell): Promise<void>;
}

export const realSpanGit: SpanGit = {
	toplevel: readToplevel,
	makeDir: makeSpanDir,
	snapshot: spanSnapshot,
	diff: spanDiff,
	removeDir: removeSpanDir,
	cleanup: cleanupSpanDirs,
};

/** A span's start, once its snapshot is taken. */
interface Started {
	envKey: string;
	shell: RemoteShell;
	toplevel: string;
	spanDir: string;
	tree: string;
}

interface Span {
	paneKey: string;
	/** undefined: not a repo, or the start failed (then nothing is recorded). */
	started: Promise<Started | undefined>;
	/** Set when the span's end is under way: no checkpoint snapshots after that. */
	ended?: boolean;
	/** The tree of the last checkpoint (or the start), so an unchanged worktree records nothing again. */
	lastTree?: string;
	/** The checkpoint under way, if any. */
	checkpointing?: Promise<void>;
}

export interface TouchedRecorderDeps {
	model: Pick<SessionModel, 'connections' | 'onDidChange' | 'onDidEvent'>;
	store: TouchedStore;
	log(line: string): void;
	git?: SpanGit;
	/** The clock, for tests. */
	now?: () => number;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Watches every agent pane of every connected session: a span starts when a
 * pane is seen `working` with none open, and ends when it is anything else or
 * gone; the files changed in between go to the {@link TouchedStore}.
 */
export class TouchedRecorder implements vscode.Disposable {
	private readonly spans = new Map<string, Span>();
	/** `<env key>\n<dir>` → its toplevel (undefined: not a repo). */
	private readonly toplevels = new Map<string, Promise<string | undefined>>();
	/** `<env key>\n<toplevel>` → the tail of its snapshot queue. */
	private readonly queues = new Map<string, Promise<unknown>>();
	/** Environments whose leftover span directories were cleaned. */
	private readonly cleaned = new Set<string>();
	private readonly pending = new Set<Promise<unknown>>();
	private readonly git: SpanGit;
	private readonly now: () => number;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;

	constructor(private readonly deps: TouchedRecorderDeps) {
		this.git = deps.git ?? realSpanGit;
		this.now = deps.now ?? Date.now;
		this.disposables.push(
			deps.model.onDidChange(() => this.update()),
			deps.model.onDidEvent((e) => {
				if (e.event.event === 'pane.moved') {
					const moved = parsePaneMoved(e.event.data);
					if (moved) {
						this.moved(makePaneKey(e.sessionKey, moved.from), makePaneKey(e.sessionKey, moved.to));
					}
				}
			}),
		);
		this.update();
	}

	/** Every span still running its git, for tests. */
	async settled(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled([...this.pending]);
		}
	}

	/** Pane keys with an open span, for tests. */
	openSpans(): string[] {
		return [...this.spans.keys()];
	}

	private track<T>(work: Promise<T>): Promise<T> {
		this.pending.add(work);
		void work.finally(() => this.pending.delete(work)).catch(() => undefined);
		return work;
	}

	private moved(from: string, to: string): void {
		void this.deps.store.move(from, to);
		const span = this.spans.get(from);
		if (span) {
			this.spans.delete(from);
			span.paneKey = to;
			this.spans.set(to, span);
		}
	}

	/** Starts and ends spans to match the snapshots; prunes the store. */
	private update(): void {
		if (this.disposed) {
			return;
		}
		const connections = this.deps.model.connections();
		const working = new Map<string, { conn: SessionConnection; dir?: string }>();
		for (const conn of connections) {
			if (conn.state !== 'connected' || !conn.snapshot) {
				continue;
			}
			for (const pane of conn.snapshot.panes) {
				const key = makePaneKey(conn.key, pane.pane_id);
				if (hasAgent(pane) && pane.raw_status === 'working') {
					working.set(key, { conn, dir: pane.foreground_cwd ?? pane.cwd });
				}
			}
		}
		for (const [key, span] of [...this.spans]) {
			if (!working.has(key)) {
				this.spans.delete(key);
				span.ended = true;
				void this.track(this.end(span));
			}
		}
		for (const [key, { conn, dir }] of working) {
			if (!this.spans.has(key) && dir) {
				this.spans.set(key, { paneKey: key, started: this.track(this.start(conn, dir)) });
			}
		}
		void this.deps.store.prune(
			paneStateIn((sessionKey) => connections.find((c) => c.key === sessionKey)),
			this.now(),
		);
	}

	/** Runs `work` after every earlier snapshot of the same toplevel. */
	private queued<T>(envKey: string, toplevel: string, work: () => Promise<T>): Promise<T> {
		const key = `${envKey}\n${toplevel}`;
		const tail = this.queues.get(key) ?? Promise.resolve();
		const next = tail.then(work, work);
		const settled = next.catch(() => undefined);
		this.queues.set(key, settled);
		void settled.then(() => {
			if (this.queues.get(key) === settled) {
				this.queues.delete(key);
			}
		});
		return next;
	}

	private toplevelOf(conn: SessionConnection, dir: string): Promise<string | undefined> {
		const key = `${conn.env.key}\n${dir}`;
		let found = this.toplevels.get(key);
		if (!found) {
			found = this.git.toplevel(conn.env.shell, dir).catch(() => undefined);
			this.toplevels.set(key, found);
		}
		return found;
	}

	private async start(conn: SessionConnection, dir: string): Promise<Started | undefined> {
		const { shell, key: envKey } = conn.env;
		const toplevel = await this.toplevelOf(conn, dir);
		if (!toplevel) {
			return undefined;
		}
		return this.queued(envKey, toplevel, async () => {
			if (!this.cleaned.has(envKey)) {
				this.cleaned.add(envKey);
				await this.git.cleanup(shell).catch(() => undefined);
			}
			let spanDir: string | undefined;
			try {
				spanDir = await this.git.makeDir(shell);
				const tree = await this.git.snapshot(shell, toplevel, spanDir);
				return { envKey, shell, toplevel, spanDir, tree };
			} catch (err) {
				this.deps.log(`touched files: start snapshot in ${toplevel}: ${errorText(err)}`);
				if (spanDir) {
					await this.git.removeDir(shell, spanDir).catch(() => undefined);
				}
				return undefined;
			}
		});
	}

	/**
	 * Records what a working pane's agent has changed so far, without ending its
	 * span: the worktree now against the span's start. Nothing to do for a pane
	 * with no open span; a checkpoint already under way is shared.
	 */
	checkpoint(paneKey: string): Promise<void> {
		const span = this.spans.get(paneKey);
		if (!span || span.ended || this.disposed) {
			return Promise.resolve();
		}
		span.checkpointing ??= this.track(this.runCheckpoint(span)).finally(() => (span.checkpointing = undefined));
		return span.checkpointing;
	}

	private async runCheckpoint(span: Span): Promise<void> {
		const started = await span.started;
		if (!started || span.ended) {
			return;
		}
		const { envKey, shell, toplevel, spanDir, tree } = started;
		let changes: TreeChange[] | undefined;
		try {
			changes = await this.queued(envKey, toplevel, async () => {
				if (span.ended) {
					return undefined; // The end ran first and removed the span directory.
				}
				const now = await this.git.snapshot(shell, toplevel, spanDir);
				if (now === (span.lastTree ?? tree)) {
					return undefined;
				}
				span.lastTree = now;
				return now === tree ? [] : await this.git.diff(shell, toplevel, spanDir, tree, now);
			});
		} catch (err) {
			this.deps.log(`touched files: checkpoint in ${toplevel}: ${errorText(err)}`);
			return;
		}
		if (changes && changes.length > 0 && !this.disposed) {
			await this.deps.store.add(span.paneKey, toplevel, changes.map((c) => c.path), this.now());
		}
	}

	private async end(span: Span): Promise<void> {
		const started = await span.started;
		if (!started) {
			return;
		}
		const { envKey, shell, toplevel, spanDir, tree } = started;
		let changes: TreeChange[] | undefined;
		try {
			changes = await this.queued(envKey, toplevel, async () => {
				try {
					const end = await this.git.snapshot(shell, toplevel, spanDir);
					return end === tree ? [] : await this.git.diff(shell, toplevel, spanDir, tree, end);
				} finally {
					await this.git.removeDir(shell, spanDir).catch(() => undefined);
				}
			});
		} catch (err) {
			this.deps.log(`touched files: end snapshot in ${toplevel}: ${errorText(err)}`);
			return;
		}
		if (changes.length > 0 && !this.disposed) {
			// The span's pane key at its end: a move during the span carries it.
			await this.deps.store.add(span.paneKey, toplevel, changes.map((c) => c.path), this.now());
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.disposables) {
			d.dispose();
		}
		// Open spans' directories go; their files are lost, as with a reload.
		for (const span of this.spans.values()) {
			void span.started.then((s) => s && this.git.removeDir(s.shell, s.spanDir)).catch(() => undefined);
		}
		this.spans.clear();
	}
}
