import * as vscode from 'vscode';
import { parsePaneMoved } from './layouts';
import { Snapshot, paneLabel, hasAgent, SessionModel } from './sessions';
import { makePaneKey, splitPaneKey } from './tilesProtocol';

/** Internal command behind the status bar item. */
export const REVEAL_FOCUSED_COMMAND = 'herdr.revealFocusedPane';

/** The status bar text and tooltip for a pane; undefined when the snapshot does not have it. */
export function focusedPaneStatus(
	snapshot: Snapshot,
	paneId: string,
	rowLabel: string,
): { text: string; tooltip: string } | undefined {
	const pane = snapshot.panes.find((p) => p.pane_id === paneId);
	if (!pane) {
		return undefined;
	}
	const space = snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id);
	const tab = snapshot.tabs.find((t) => t.tab_id === pane.tab_id);
	return {
		text: `$(circle-filled) ${paneLabel(pane, snapshot)} · ${hasAgent(pane) ? pane.agent_status : 'shell'}`,
		tooltip: `${rowLabel} › ${space?.label ?? pane.workspace_id} › ${tab?.label ?? pane.tab_id}`,
	};
}

/**
 * The window's last focused pane (the tile whose xterm last gained focus) and
 * its status bar item. Focusing a tile does not move herdr's own focus.
 */
export class FocusTracker implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('herdr.focusedPane', vscode.StatusBarAlignment.Left, 100);
	private readonly emitter = new vscode.EventEmitter<string | undefined>();
	/** The last focused pane's key, whenever it changes. */
	readonly onDidChangeLastFocused = this.emitter.event;
	private readonly reportEmitter = new vscode.EventEmitter<{ sessionKey: string; paneId: string }>();
	/**
	 * Every focus report of a tile, including one of the tile already last
	 * focused ({@link onDidChangeLastFocused} fires only when the key changes).
	 */
	readonly onDidReportFocus = this.reportEmitter.event;
	private readonly listeners: vscode.Disposable[];
	private last: string | undefined;

	constructor(
		private readonly model: SessionModel,
		private readonly rowLabel: (sessionKey: string) => string | undefined,
	) {
		this.item.name = 'herdr focused pane';
		this.item.command = REVEAL_FOCUSED_COMMAND;
		this.listeners = [
			model.onDidChange(() => this.update()),
			model.onDidEvent((e) => {
				const moved = e.event.event === 'pane.moved' ? parsePaneMoved(e.event.data) : undefined;
				if (moved && this.last === makePaneKey(e.sessionKey, moved.from)) {
					this.set(e.sessionKey, moved.to);
				}
			}),
		];
	}

	get lastFocused(): string | undefined {
		return this.last;
	}

	/**
	 * The pane herdr's own focus is on in a session, from its latest snapshot:
	 * `pane.focused` takes a new snapshot like any event.
	 */
	herdrFocused(sessionKey: string): string | undefined {
		return this.model.connection(sessionKey)?.snapshot?.focusedPaneId;
	}

	set(sessionKey: string, paneId: string): void {
		const paneKey = makePaneKey(sessionKey, paneId);
		if (paneKey !== this.last) {
			this.last = paneKey;
			this.emitter.fire(paneKey);
		}
		this.reportEmitter.fire({ sessionKey, paneId });
		this.update();
	}

	private update(): void {
		const { sessionKey, paneId } = this.last ? splitPaneKey(this.last) : { sessionKey: '', paneId: '' };
		const conn = this.model.connection(sessionKey);
		const status = conn?.snapshot && focusedPaneStatus(conn.snapshot, paneId, this.rowLabel(sessionKey) ?? conn.name);
		if (status) {
			this.item.text = status.text;
			this.item.tooltip = status.tooltip;
			this.item.show();
		} else {
			this.item.hide();
		}
	}

	dispose(): void {
		for (const listener of this.listeners) {
			listener.dispose();
		}
		this.emitter.dispose();
		this.reportEmitter.dispose();
		this.item.dispose();
	}
}
