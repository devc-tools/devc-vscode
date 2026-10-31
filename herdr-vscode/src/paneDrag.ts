import * as vscode from 'vscode';
import { PANE_MIME } from './layouts';
import { paneLabel, Snapshot } from './sessions';
import { PaneRef } from './views/spacesView';

/**
 * Dragging a pane row into a Layout tab. A tree drag never reaches a webview
 * (measured: VS Code's webviews are other renderer processes), so a drag only
 * **arms** a placement here; the Layout panel under the pointer completes it on
 * release or click. See docs/how-it-works.md, "Dragging panes in".
 */

/** Context key: a placement is armed. */
export const PLACING_PANE_KEY = 'herdr.placingPane';
export const CANCEL_PLACEMENT_COMMAND = 'herdr.cancelPlacement';
/** With no pointer in an armed panel by then, the placement goes. */
export const PLACEMENT_TIMEOUT_MS = 15000;

/** A Layout panel, as a placement sees it. */
export interface PlacementPanel {
	/** Whether the panel is on screen. */
	isVisible(): boolean;
	/** Arms the webview's placing mode. */
	placePane(sessionKey: string, paneId: string, title: string): void;
	/** Ends the webview's placing mode silently. */
	placeEnd(): void;
}

export interface PlacementTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface PlacementDeps {
	/** The open Layout panels. */
	panels(): PlacementPanel[];
	setContext(placing: boolean): void;
	timers?: PlacementTimers;
}

const REAL_TIMERS: PlacementTimers = {
	set: (run, ms) => setTimeout(run, ms),
	clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The armed placement of the window: at most one. */
export class PanePlacement implements vscode.Disposable {
	private armed: PlacementPanel[] = [];
	private owner: PlacementPanel | undefined;
	private pane: PaneRef | undefined;
	private timer: unknown;
	private readonly timers: PlacementTimers;

	constructor(private readonly deps: PlacementDeps) {
		this.timers = deps.timers ?? REAL_TIMERS;
	}

	/** The pane being placed, if armed. */
	get placing(): PaneRef | undefined {
		return this.pane;
	}

	/** Arms every visible Layout panel; false, and nothing armed, when none is visible. */
	arm(ref: PaneRef, title: string): boolean {
		this.disarm();
		const visible = this.deps.panels().filter((p) => p.isVisible());
		if (visible.length === 0) {
			return false;
		}
		this.armed = visible;
		this.pane = ref;
		for (const panel of visible) {
			panel.placePane(ref.sessionKey, ref.paneId, title);
		}
		this.deps.setContext(true);
		this.timer = this.timers.set(() => {
			this.timer = undefined;
			this.disarm();
		}, PLACEMENT_TIMEOUT_MS);
		return true;
	}

	/** The pointer reached an armed panel: it owns the placement now. */
	hover(panel: PlacementPanel): void {
		if (!this.armed.includes(panel)) {
			return;
		}
		this.stopTimer();
		this.owner = panel;
		for (const other of this.armed) {
			if (other !== panel) {
				other.placeEnd();
			}
		}
		this.armed = [panel];
	}

	/** An armed panel placed the pane, or cancelled. Its webview has ended placing already; `placeEnd` is harmless there. */
	ended(panel: PlacementPanel): void {
		if (this.armed.includes(panel)) {
			this.disarm();
		}
	}

	/** A panel closed. */
	panelDisposed(panel: PlacementPanel): void {
		if (!this.armed.includes(panel)) {
			return;
		}
		this.armed = this.armed.filter((p) => p !== panel);
		if (this.owner === panel || this.armed.length === 0) {
			this.disarm();
		}
	}

	/** `herdr.cancelPlacement`, a drag of anything else. */
	cancel(): void {
		this.disarm();
	}

	private stopTimer(): void {
		if (this.timer !== undefined) {
			this.timers.clear(this.timer);
			this.timer = undefined;
		}
	}

	private disarm(): void {
		this.stopTimer();
		if (!this.pane) {
			return;
		}
		const armed = this.armed;
		this.armed = [];
		this.owner = undefined;
		this.pane = undefined;
		for (const panel of armed) {
			panel.placeEnd();
		}
		this.deps.setContext(false);
	}

	dispose(): void {
		this.disarm();
	}
}

/** A connected session's snapshot, else undefined. */
export type ConnectedSnapshot = (sessionKey: string) => Snapshot | undefined;

/**
 * The drag source of `herdr.spaces`, `herdr.agents` and `herdr.paneContext`: a
 * pane row arms a placement; any other row disarms one. Nothing is dropped here.
 */
export class PaneDragController<T> implements vscode.TreeDragAndDropController<T> {
	readonly dragMimeTypes = [PANE_MIME];
	readonly dropMimeTypes: string[] = [];

	constructor(
		private readonly placement: Pick<PanePlacement, 'arm' | 'cancel'>,
		/** The pane of a pane row, else undefined. */
		private readonly paneOf: (node: T) => PaneRef | undefined,
		private readonly snapshotOf: ConnectedSnapshot,
	) {}

	handleDrag(source: readonly T[], dataTransfer: vscode.DataTransfer): void {
		const ref = source.length === 1 ? this.paneOf(source[0]) : undefined;
		this.placement.cancel();
		if (!ref) {
			return;
		}
		dataTransfer.set(PANE_MIME, new vscode.DataTransferItem(JSON.stringify([{ sessionKey: ref.sessionKey, paneId: ref.paneId }])));
		const snapshot = this.snapshotOf(ref.sessionKey);
		const pane = snapshot?.panes.find((p) => p.pane_id === ref.paneId);
		if (snapshot && pane) {
			this.placement.arm({ sessionKey: ref.sessionKey, paneId: ref.paneId }, paneLabel(pane, snapshot));
		}
	}
}

/** The pane of a Spaces or Pane Context row. */
export function paneRowRef(node: { type: string; ref?: PaneRef }): PaneRef | undefined {
	return node.type === 'pane' ? node.ref : undefined;
}
