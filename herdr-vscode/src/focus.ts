import * as vscode from 'vscode';
import { Snapshot, paneLabel, hasAgent, parsePaneMoved, SessionModel } from './sessions';
import { hasAgentMark } from './status';
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
	const icon = !hasAgent(pane) ? 'terminal' : hasAgentMark(pane.agent) ? `herdr-agent-${pane.agent}` : 'circle-filled';
	return {
		text: `$(${icon}) ${paneLabel(pane, snapshot)} · ${hasAgent(pane) ? pane.agent_status : 'shell'}`,
		tooltip: `${rowLabel} › ${space?.label ?? pane.workspace_id} › ${tab?.label ?? pane.tab_id}`,
	};
}

/** How long a tab switch waits for the snapshot to show the tab active. */
export const FOLLOW_TAB_MS = 2000;

/** Whether the snapshot shows the tab as its space's active tab. */
export function tabIsActive(snapshot: Snapshot, tabId: string): boolean {
	const tab = snapshot.tabs.find((t) => t.tab_id === tabId);
	return !!tab && snapshot.workspaces.find((w) => w.workspace_id === tab.workspace_id)?.activeTabId === tabId;
}

/** The pane a switch to the tab follows: herdr's focused pane when it is in the tab, else the tab's first pane. */
export function tabFollowPane(snapshot: Snapshot, tabId: string): string | undefined {
	const panes = snapshot.panes.filter((p) => p.tab_id === tabId);
	return panes.find((p) => p.pane_id === snapshot.focusedPaneId)?.pane_id ?? panes[0]?.pane_id;
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
	/** A tab switch waiting for its snapshot. */
	private following: vscode.Disposable | undefined;

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

	/**
	 * A tab switch made from this window: once the snapshot shows the tab
	 * active (within {@link FOLLOW_TAB_MS}), the last focused pane becomes its
	 * pane ({@link tabFollowPane}). A newer switch replaces a waiting one.
	 */
	followTab(sessionKey: string, tabId: string, timeoutMs = FOLLOW_TAB_MS): void {
		this.following?.dispose();
		this.following = undefined;
		const attempt = (): boolean => {
			const snapshot = this.model.connection(sessionKey)?.snapshot;
			if (!snapshot || !tabIsActive(snapshot, tabId)) {
				return false;
			}
			const paneId = tabFollowPane(snapshot, tabId);
			if (paneId) {
				this.set(sessionKey, paneId);
			}
			return true;
		};
		if (attempt()) {
			return;
		}
		const timer = setTimeout(() => done.dispose(), timeoutMs);
		const listener = this.model.onDidChange(() => {
			if (attempt()) {
				done.dispose();
			}
		});
		const done = new vscode.Disposable(() => {
			clearTimeout(timer);
			listener.dispose();
			if (this.following === done) {
				this.following = undefined;
			}
		});
		this.following = done;
	}

	dispose(): void {
		for (const listener of this.listeners) {
			listener.dispose();
		}
		this.following?.dispose();
		this.emitter.dispose();
		this.reportEmitter.dispose();
		this.item.dispose();
	}
}
