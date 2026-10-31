import * as cp from 'child_process';
import * as readline from 'readline';
import { endConnection, herdrArgv } from './bridge';
import { RemoteShell } from './remoteShell';
import { splitPaneKey, TileStreamState } from './tilesProtocol';

/**
 * Pane streams: at most one `herdr terminal session control <pane> --takeover`
 * per pane in the window, shared by every tile showing that pane. herdr allows
 * one controller per terminal, so another window taking the pane over closes
 * ours. See docs/how-it-works.md.
 */

export type TerminalRecord =
	| { type: 'frame'; seq: number; full: boolean; width: number; height: number; bytes: string }
	| { type: 'closed'; reason: string };

/** One stdout line of `terminal session control`; undefined for anything else. */
export function parseTerminalRecord(line: string): TerminalRecord | undefined {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof msg !== 'object' || msg === null) {
		return undefined;
	}
	const r = msg as Record<string, unknown>;
	if (r.type === 'terminal.closed') {
		return { type: 'closed', reason: typeof r.reason === 'string' ? r.reason : 'closed' };
	}
	if (
		r.type === 'terminal.frame' &&
		typeof r.bytes === 'string' &&
		typeof r.width === 'number' &&
		typeof r.height === 'number'
	) {
		return {
			type: 'frame',
			seq: typeof r.seq === 'number' ? r.seq : 0,
			full: r.full === true,
			width: r.width,
			height: r.height,
			bytes: r.bytes,
		};
	}
	return undefined;
}

/** What a `terminal.closed` reason means for the tiles showing the pane. */
export function closedState(reason: string): TileStreamState {
	return reason.includes('taken over') ? { kind: 'takenOver' } : { kind: 'ended', reason };
}

/** The argv of a pane's controller. */
export function controlArgv(session: string, paneId: string, cols: number, rows: number): string[] {
	return herdrArgv([
		'--session',
		session,
		'terminal',
		'session',
		'control',
		paneId,
		'--takeover',
		'--cols',
		String(cols),
		'--rows',
		String(rows),
	]);
}

export interface PaneFrame {
	full: boolean;
	cols: number;
	rows: number;
	bytes: string;
}

/** A panel, as the stream manager sees it: it holds at most one tile per pane. */
export interface PaneViewer {
	frame(paneKey: string, frame: PaneFrame): void;
	state(paneKey: string, state: TileStreamState): void;
}

interface Size {
	cols: number;
	rows: number;
}

interface Controller {
	paneKey: string;
	child: cp.ChildProcess | undefined;
	/** Every tile showing the pane, with the size it fits. */
	viewers: Map<PaneViewer, Size>;
	/** The tile whose size the pane takes: the most recently focused one. */
	owner: PaneViewer;
	/** The size last given to herdr. */
	size: Size;
}

/** Resolves a session key to where its herdr runs; undefined when it is not connected. */
export type SessionResolver = (sessionKey: string) => { shell: RemoteShell; name: string } | undefined;

const RELEASE_GRACE_MS = 2000;

export class PaneStreams {
	private readonly controllers = new Map<string, Controller>();

	constructor(
		private readonly resolve: SessionResolver,
		private readonly log: (line: string) => void,
		private readonly releaseGraceMs = RELEASE_GRACE_MS,
	) {}

	/**
	 * A tile now shows `paneKey`. Starts the pane's controller, or joins it; a
	 * same-size `terminal.resize` makes herdr repaint in full for the newcomer.
	 */
	open(paneKey: string, viewer: PaneViewer, cols: number, rows: number): void {
		const size = { cols, rows };
		const ctl = this.controllers.get(paneKey);
		if (!ctl) {
			const created: Controller = {
				paneKey,
				child: undefined,
				viewers: new Map([[viewer, size]]),
				owner: viewer,
				size,
			};
			this.controllers.set(paneKey, created);
			this.start(created);
			return;
		}
		ctl.viewers.set(viewer, size);
		if (ctl.child) {
			this.write(ctl, { type: 'terminal.resize', cols: ctl.size.cols, rows: ctl.size.rows });
		} else {
			// The stream had ended: a new tile on the pane is the user asking for it again.
			ctl.owner = viewer;
			ctl.size = size;
			this.start(ctl);
		}
	}

	/** A tile no longer shows `paneKey`; the last one out releases the pane. */
	close(paneKey: string, viewer: PaneViewer): void {
		const ctl = this.controllers.get(paneKey);
		if (!ctl || !ctl.viewers.delete(viewer)) {
			return;
		}
		if (ctl.viewers.size === 0) {
			this.controllers.delete(paneKey);
			this.release(ctl);
			return;
		}
		if (ctl.owner === viewer) {
			const [next, size] = ctl.viewers.entries().next().value as [PaneViewer, Size];
			ctl.owner = next;
			this.applySize(ctl, size);
		}
	}

	/** Closes everything `viewer` shows (its panel went away). */
	closeAll(viewer: PaneViewer): void {
		for (const ctl of [...this.controllers.values()]) {
			if (ctl.viewers.has(viewer)) {
				this.close(ctl.paneKey, viewer);
			}
		}
	}

	/** A tile's fit changed. It reaches herdr only from the most recently focused tile. */
	resize(paneKey: string, viewer: PaneViewer, cols: number, rows: number): void {
		const ctl = this.controllers.get(paneKey);
		if (!ctl || !ctl.viewers.has(viewer)) {
			return;
		}
		const size = { cols, rows };
		ctl.viewers.set(viewer, size);
		if (ctl.owner === viewer) {
			this.applySize(ctl, size);
		}
	}

	/** A tile gained focus: the pane takes its size from now on. */
	focus(paneKey: string, viewer: PaneViewer): void {
		const ctl = this.controllers.get(paneKey);
		const size = ctl?.viewers.get(viewer);
		if (!ctl || !size) {
			return;
		}
		ctl.owner = viewer;
		this.applySize(ctl, size);
	}

	input(paneKey: string, text: string): void {
		const ctl = this.controllers.get(paneKey);
		if (ctl) {
			this.write(ctl, { type: 'terminal.input', text });
		}
	}

	scroll(paneKey: string, direction: 'up' | 'down', lines: number): void {
		const ctl = this.controllers.get(paneKey);
		if (ctl) {
			this.write(ctl, { type: 'terminal.scroll', direction, lines });
		}
	}

	/** Takes the pane back with a new `--takeover` controller. */
	reconnect(paneKey: string): void {
		const ctl = this.controllers.get(paneKey);
		if (!ctl) {
			return;
		}
		const old = ctl.child;
		ctl.child = undefined;
		if (old) {
			endConnection(old);
		}
		this.start(ctl);
	}

	/** Releases every pane (deactivate). */
	dispose(): void {
		for (const ctl of this.controllers.values()) {
			const child = ctl.child;
			ctl.child = undefined;
			if (child) {
				// No 2 s wait here: the host is going away, and ending stdin is what stops a controller in a container.
				child.stdin?.write(JSON.stringify({ type: 'terminal.release' }) + '\n');
				endConnection(child);
			}
		}
		this.controllers.clear();
	}

	private applySize(ctl: Controller, size: Size): void {
		if (size.cols > 0 && size.rows > 0 && (size.cols !== ctl.size.cols || size.rows !== ctl.size.rows)) {
			ctl.size = size;
			this.write(ctl, { type: 'terminal.resize', cols: size.cols, rows: size.rows });
		}
	}

	private write(ctl: Controller, command: unknown): void {
		ctl.child?.stdin?.write(JSON.stringify(command) + '\n');
	}

	private release(ctl: Controller): void {
		const child = ctl.child;
		ctl.child = undefined;
		if (!child) {
			return;
		}
		child.stdin?.write(JSON.stringify({ type: 'terminal.release' }) + '\n');
		const timer = setTimeout(() => endConnection(child), this.releaseGraceMs);
		timer.unref?.();
		child.once('close', () => clearTimeout(timer));
	}

	private notify(ctl: Controller, state: TileStreamState): void {
		for (const viewer of ctl.viewers.keys()) {
			viewer.state(ctl.paneKey, state);
		}
	}

	private start(ctl: Controller): void {
		const { sessionKey, paneId } = splitPaneKey(ctl.paneKey);
		const session = this.resolve(sessionKey);
		if (!session) {
			this.notify(ctl, { kind: 'ended', reason: `session ${sessionKey} is not connected` });
			return;
		}
		let child: cp.ChildProcess;
		try {
			child = session.shell.spawn(controlArgv(session.name, paneId, ctl.size.cols, ctl.size.rows));
		} catch (err) {
			this.notify(ctl, { kind: 'ended', reason: (err as Error).message });
			return;
		}
		ctl.child = child;
		child.stdin?.on('error', () => {
			/* the controller already ended */
		});
		const isCurrent = () => ctl.child === child;
		let live = false;
		let closed = false;
		const ended = (state: TileStreamState) => {
			if (isCurrent()) {
				ctl.child = undefined;
				endConnection(child);
				this.notify(ctl, state);
			}
		};
		const rl = child.stdout ? readline.createInterface({ input: child.stdout }) : undefined;
		rl?.on('line', (line) => {
			if (!isCurrent()) {
				return;
			}
			const record = parseTerminalRecord(line);
			if (record?.type === 'frame') {
				if (!live) {
					live = true;
					this.notify(ctl, { kind: 'live' });
				}
				const frame = { full: record.full, cols: record.width, rows: record.height, bytes: record.bytes };
				for (const viewer of ctl.viewers.keys()) {
					viewer.frame(ctl.paneKey, frame);
				}
			} else if (record?.type === 'closed') {
				closed = true;
				this.log(`${ctl.paneKey}: stream closed: ${record.reason}`);
				ended(closedState(record.reason));
			}
		});
		child.on('error', (err) => ended({ kind: 'ended', reason: err.message }));
		child.on('close', () => {
			rl?.close();
			if (!closed) {
				ended({ kind: 'ended', reason: 'the terminal stream ended' });
			}
		});
	}
}
