import * as vscode from 'vscode';
import { BridgeError, HerdrEvent } from './bridge';
import { FocusTracker } from './focus';
import { LayoutExport, layoutPaneIds, mirrorConfig, parseLayoutExport, ratiosByPath, StoredLayoutConfig, structureKey } from './layoutMapping';
import { changedRatios, clampRatio, dropRequests, herdrPath, HerdrRequest, refusal, sameRatio, stripDropRequest, zoomedAfter, zoomRequests } from './mirrorEdit';
import { hasAgent, paneFolder, paneLabel, SessionModel, Snapshot } from './sessions';
import { worstStatus } from './status';
import { PaneFrame, PaneStreams, PaneViewer } from './streams';
import {
	HostMessage,
	makePaneKey,
	PanelState,
	ProbeAction,
	splitPaneKey,
	StripTab,
	TileMeta,
	TileProbe,
	TileStreamState,
	WebviewMessage,
} from './tilesProtocol';
import { wrapPaste } from './webview/input';

export const TILES_VIEW_TYPE = 'herdr.tiles';

const REEXPORT_DEBOUNCE_MS = 100;
/** How long a panel waits for its session before saying the space is gone. */
const CONNECT_WAIT_MS = 10000;

/** The events that can change a tab's split tree or labels. */
const RELAYOUT_EVENTS = new Set([
	'layout.updated',
	'pane.created',
	'pane.closed',
	'pane.moved',
	'pane.exited',
	'tab.renamed',
]);

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/**
 * Whether an event calls for re-exporting `tabId`. herdr's event data names the
 * tab directly (`tab_id`, `layout.tab_id`, `pane.tab_id`) or only the pane
 * (`pane_id`, for `pane.closed` and `pane.exited`), whose tab comes from the
 * latest snapshot. A pane not in the snapshot might be in this tab: yes.
 */
export function eventTouchesTab(ev: HerdrEvent, tabId: string, tabOfPane: (paneId: string) => string | undefined): boolean {
	if (!RELAYOUT_EVENTS.has(ev.event)) {
		return false;
	}
	if (ev.event === 'pane.moved') {
		return true;
	}
	const layout = ev.data.layout as Record<string, unknown> | undefined;
	const pane = ev.data.pane as Record<string, unknown> | undefined;
	const direct = str(ev.data.tab_id) ?? str(layout?.tab_id) ?? str(pane?.tab_id);
	if (direct !== undefined) {
		return direct === tabId;
	}
	const paneId = str(ev.data.pane_id) ?? str(pane?.pane_id);
	const known = paneId !== undefined ? tabOfPane(paneId) : undefined;
	return known === undefined || known === tabId;
}

/**
 * The tab herdr shows in a space: its `active_tab_id`, else (missing, or not
 * one of the space's tabs) the space's first tab in snapshot order.
 */
export function activeTabOf(snapshot: Snapshot, workspaceId: string): string | undefined {
	const tabs = snapshot.tabs.filter((t) => t.workspace_id === workspaceId);
	const active = snapshot.workspaces.find((w) => w.workspace_id === workspaceId)?.activeTabId;
	return tabs.find((t) => t.tab_id === active)?.tab_id ?? tabs[0]?.tab_id;
}

/** A space panel's tab strip: the space's tabs in herdr's (snapshot) order, `shown` marked active. */
export function stripTabs(snapshot: Snapshot, workspaceId: string, shown: string | undefined): StripTab[] {
	return snapshot.tabs
		.filter((t) => t.workspace_id === workspaceId)
		.map((t) => {
			const agents = snapshot.panes.filter((p) => p.tab_id === t.tab_id && hasAgent(p)).map((p) => p.agent_status);
			return { tabId: t.tab_id, label: t.label, status: worstStatus(agents) ?? 'shell', active: t.tab_id === shown };
		});
}

/** The tile headers of a tab's panes. */
export function tileMetas(snapshot: Snapshot, sessionKey: string, tabId: string): TileMeta[] {
	return snapshot.panes
		.filter((p) => p.tab_id === tabId)
		.map((p): TileMeta => {
			const label = paneLabel(p, snapshot);
			const folder = hasAgent(p) ? paneFolder(p) : undefined;
			const meta: TileMeta = {
				paneKey: makePaneKey(sessionKey, p.pane_id),
				label,
				detail: folder !== label ? folder : undefined,
				status: hasAgent(p) ? p.agent_status : 'shell',
			};
			if (p.agent !== undefined) {
				meta.agent = p.agent;
			}
			return meta;
		});
}

function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name));
	const csp = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('tiles.css')}">
<title>herdr</title>
</head>
<body>
<div id="toolbar">
<div id="strip"></div>
</div>
<div id="tiles"></div>
<div id="message" hidden></div>
<script src="${asset('tiles.js')}"></script>
</body>
</html>`;
}

function terminalFont(): { fontFamily: string; fontSize: number } {
	const terminal = vscode.workspace.getConfiguration('terminal.integrated');
	const editor = vscode.workspace.getConfiguration('editor');
	return {
		fontFamily: terminal.get<string>('fontFamily') || editor.get<string>('fontFamily') || 'monospace',
		fontSize: terminal.get<number>('fontSize') || editor.get<number>('fontSize') || 14,
	};
}

/** What panels need from the rest of the extension. */
export interface TilesDeps {
	extensionUri: vscode.Uri;
	model: SessionModel;
	streams: PaneStreams;
	focus: FocusTracker;
	rowLabel(sessionKey: string): string | undefined;
	log(line: string): void;
	/** Which panes the tiles show may have changed. Set by {@link TilesPanels}. */
	tilesChanged?(): void;
	/** A path printed in a tile was clicked. Set by {@link TilesPanels}. */
	openLink?(paneKey: string, text: string): void;
}

/**
 * An editor tab's title: the space's label for herdr's `default` session, else
 * `<session> · <space>`.
 */
export function spaceTitle(sessionName: string, spaceLabel: string): string {
	return sessionName === 'default' ? spaceLabel : `${sessionName} · ${spaceLabel}`;
}

/** herdr's zoomed pane in an export: the focused pane of a zoomed tab. */
function zoomedPaneOf(layout: LayoutExport): string | undefined {
	return layout.zoomed ? layout.focused_pane_id : undefined;
}

/** Which panel last had a tile focused, across every panel of the window. */
let focusClock = 0;

const WEBVIEW_OPTIONS = (extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions => ({
	enableScripts: true,
	retainContextWhenHidden: true,
	localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
});

type ProbeResult = {
	tiles: TileProbe[];
	toolbar?: string[];
	message: string;
	/** The strip's entries, `*` before the active one. */
	strip: string[];
	config: StoredLayoutConfig | undefined;
	dragging?: boolean;
	ratios?: Record<string, number>;
	maximised?: string | null;
};

/** The webview plumbing every `herdr.tiles` panel shares: messages, streams, focus, replay when ready. */
abstract class TilesPanel implements PaneViewer {
	protected readonly disposables: vscode.Disposable[] = [];
	protected ready = false;
	protected disposedFlag = false;
	/** What the webview should be showing: replayed when it says it is ready. */
	protected view: { type: 'layout'; config: StoredLayoutConfig } | { type: 'empty'; text: string } | undefined;
	/** When a tile of this panel last gained focus. */
	lastFocus = 0;
	private nextProbe = 0;
	private readonly probes = new Map<number, (result: Extract<WebviewMessage, { type: 'probeResult' }>) => void>();
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposeEmitter.event;

	constructor(
		readonly panel: vscode.WebviewPanel,
		protected readonly deps: TilesDeps,
		icon: string,
	) {
		panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'resources', icon);
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'webview')],
		};
		this.disposables.push(
			panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
			panel.onDidDispose(() => this.dispose()),
		);
		panel.webview.html = panelHtml(panel.webview, deps.extensionUri);
	}

	/** What the webview keeps with `setState`. */
	protected abstract panelState(): PanelState;
	/** The webview is up, and has its state, font and view. */
	protected abstract onReady(): void;
	/** A message only this kind of panel takes. */
	protected abstract onPanelMessage(msg: WebviewMessage): void;
	/** Whether a tile of this panel shows the pane. */
	abstract showsPane(sessionKey: string, paneId: string): boolean;
	/** Brings the panel forward, optionally focusing a pane's tile. */
	abstract revealPane(sessionKey: string, paneId: string): void;

	protected tileOpened(paneKey: string, cols: number, rows: number): void {
		this.deps.streams.open(paneKey, this, cols, rows);
	}

	protected tileResized(paneKey: string, cols: number, rows: number): void {
		this.deps.streams.resize(paneKey, this, cols, rows);
	}

	protected tileClosed(paneKey: string): void {
		this.deps.streams.close(paneKey, this);
	}

	protected tileFocused(_paneId: string): void {}

	sendFont(): void {
		this.post({ type: 'font', ...terminalFont() });
	}

	/** Test support: what the webview shows, optionally after a key press or click in a tile. */
	probe(action?: ProbeAction): Promise<ProbeResult> {
		if (!this.ready) {
			return Promise.resolve({ tiles: [], message: '', strip: [], config: undefined });
		}
		const id = ++this.nextProbe;
		return new Promise((resolve) => {
			this.probes.set(id, resolve);
			this.post({ type: 'probe', id, action });
		});
	}

	// PaneViewer

	frame(paneKey: string, frame: PaneFrame): void {
		this.post({ type: 'frame', paneKey, ...frame });
	}

	state(paneKey: string, state: TileStreamState): void {
		this.post({ type: 'tileState', paneKey, state });
	}

	protected post(msg: HostMessage): void {
		if (this.ready && !this.disposedFlag) {
			void this.panel.webview.postMessage(msg);
		}
	}

	protected setView(view: NonNullable<TilesPanel['view']>): void {
		this.view = view;
		this.post(view);
	}

	/** Public for the opt-in live suite, which has no way to click a toolbar in a webview. */
	onMessage(msg: WebviewMessage): void {
		const streams = this.deps.streams;
		switch (msg.type) {
			case 'ready':
				this.ready = true;
				this.post({ type: 'init', state: this.panelState() });
				this.sendFont();
				if (this.view) {
					this.post(this.view);
				}
				this.onReady();
				break;
			case 'tileOpen':
				this.tileOpened(msg.paneKey, msg.cols, msg.rows);
				break;
			case 'tileResize':
				this.tileResized(msg.paneKey, msg.cols, msg.rows);
				break;
			case 'tileClose':
				this.tileClosed(msg.paneKey);
				break;
			case 'input':
				streams.input(msg.paneKey, msg.text);
				break;
			case 'scroll':
				streams.scroll(msg.paneKey, msg.direction, msg.lines);
				break;
			case 'focus': {
				const { sessionKey, paneId } = splitPaneKey(msg.paneKey);
				this.lastFocus = ++focusClock;
				this.tileFocused(paneId);
				streams.focus(msg.paneKey, this);
				this.deps.focus.set(sessionKey, paneId);
				break;
			}
			case 'reconnect':
				streams.reconnect(msg.paneKey);
				break;
			case 'clipboardPaste':
				void vscode.env.clipboard.readText().then((text) => {
					if (text) {
						streams.input(msg.paneKey, wrapPaste(text));
					}
				});
				break;
			case 'clipboardCopy':
				void vscode.env.clipboard.writeText(msg.text);
				break;
			case 'openLink':
				this.deps.openLink?.(msg.paneKey, msg.text);
				break;
			case 'probeResult':
				this.probes.get(msg.id)?.(msg);
				this.probes.delete(msg.id);
				break;
			default:
				this.onPanelMessage(msg);
		}
	}

	dispose(): void {
		if (this.disposedFlag) {
			return;
		}
		this.disposedFlag = true;
		this.onDispose();
		this.deps.streams.closeAll(this);
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}

	protected onDispose(): void {}
}

/** How long a strip click's tab stays shown while herdr's snapshot catches up with its `tab.focus`. */
const PENDING_TAB_MS = 2000;

/**
 * One editor tab mirroring one herdr space: the space's active tab as tiles,
 * and a strip of its tabs synced both ways with herdr's active tab.
 */
export class MirrorPanel extends TilesPanel {
	/** The tab whose tiles are shown: the space's active tab, or a strip click's while herdr catches up. */
	tabId: string | undefined;
	/** A strip click's tab, until the snapshot's `active_tab_id` agrees or `until` passes. */
	private pendingTab: { id: string; until: number } | undefined;
	private pendingTimer: NodeJS.Timeout | undefined;
	/** The structure of the split tree in `view` (no ratios); undefined when none is loaded. */
	private structure: string | undefined;
	/** herdr's split ratios by path key, from the last export or `set_split_ratio` answer. */
	private ratios: Record<string, number> = {};
	/** Paths with a `layout.set_split_ratio` in flight: a re-export does not move their splitters. */
	private readonly ratiosInFlight = new Set<string>();
	/** herdr's zoomed pane, from the last export or `pane.zoom` answer. */
	private zoomedPane: string | undefined;
	/** A `setZoom` is being carried out: re-exports leave the zoom to its answer. */
	private zoomBusy = false;
	private paneIds = new Set<string>();
	private focusedPane: string | undefined;
	private herdrFocusedPane: string | undefined;
	private exportTimer: NodeJS.Timeout | undefined;
	private exporting = false;
	private exportDirty = false;
	/** A drop's requests are under way: syncs and exports wait for the last of them. */
	private moveBusy = false;
	private afterMove = false;
	private connectTimer: NodeJS.Timeout | undefined;
	private spaceClosed = false;
	/** Whether a connected snapshot has had this panel's space: its going later closes the editor tab. */
	private spaceSeen = false;
	/** A pane to focus once its tile is on screen. */
	private focusWhenShown: string | undefined;
	private readonly resolveEmitter = new vscode.EventEmitter<void>();
	/** A panel restored from a tab's saved state found its space. */
	readonly onDidResolveSpace = this.resolveEmitter.event;

	/**
	 * `workspaceId` undefined: restored from an older build's state, which names
	 * only `legacyTabId`; the space is that tab's, once the session is connected.
	 */
	constructor(
		panel: vscode.WebviewPanel,
		readonly sessionKey: string,
		public workspaceId: string | undefined,
		deps: TilesDeps,
		private readonly legacyTabId?: string,
	) {
		super(panel, deps, 'herdr.svg');
		this.disposables.push(
			this.resolveEmitter,
			deps.model.onDidChange(() => this.sync()),
			deps.model.onDidEvent((e) => {
				if (e.sessionKey === sessionKey) {
					this.onEvent(e.event);
				}
			}),
		);
		this.sync();
	}

	/** Whether a tile of this panel shows `paneId`. */
	shows(paneId: string): boolean {
		return this.paneIds.has(paneId);
	}

	showsPane(sessionKey: string, paneId: string): boolean {
		return sessionKey === this.sessionKey && this.shows(paneId);
	}

	revealPane(_sessionKey: string, paneId: string): void {
		this.reveal(paneId);
	}

	/** Brings the panel forward, optionally focusing a pane's tile (once its tab is shown). */
	reveal(paneId?: string): void {
		this.panel.reveal(undefined, false);
		if (paneId && this.ready && this.paneIds.has(paneId)) {
			this.focusWhenShown = undefined;
			this.post({ type: 'focusTile', paneKey: makePaneKey(this.sessionKey, paneId) });
		} else if (paneId) {
			this.focusWhenShown = paneId;
		}
	}

	/** herdr's name for the panel's session. */
	get sessionName(): string {
		return this.deps.model.connection(this.sessionKey)?.name ?? this.sessionKey.split('/').pop() ?? this.sessionKey;
	}

	private get snapshot(): Snapshot | undefined {
		const conn = this.deps.model.connection(this.sessionKey);
		return conn?.state === 'connected' ? conn.snapshot : undefined;
	}

	private showEmpty(text: string): void {
		clearTimeout(this.exportTimer);
		this.exportTimer = undefined;
		this.structure = undefined;
		this.ratios = {};
		this.zoomedPane = undefined;
		this.tabId = undefined;
		this.paneIds = new Set();
		this.deps.tilesChanged?.();
		this.focusedPane = undefined;
		if (this.view?.type !== 'empty' || this.view.text !== text) {
			this.setView({ type: 'empty', text });
		}
	}

	private showClosed(): void {
		this.spaceClosed = true;
		this.showEmpty('This herdr space was closed.');
	}

	/** The space was closed in herdr (here or anywhere else): its editor tab goes too. */
	private closeForGoneSpace(): void {
		if (!this.disposedFlag) {
			this.panel.dispose();
		}
	}

	/** Brings the panel in line with the session model. */
	private sync(): void {
		if (this.disposedFlag) {
			return;
		}
		if (this.moveBusy) {
			// A drop's moves pass through intermediate layouts (and a passing tab): show only where they end.
			this.afterMove = true;
			return;
		}
		const snapshot = this.snapshot;
		if (!snapshot) {
			if (this.connectTimer === undefined && !this.spaceClosed) {
				this.connectTimer = setTimeout(() => this.showClosed(), CONNECT_WAIT_MS);
				this.showEmpty(`Connecting to ${this.deps.rowLabel(this.sessionKey) ?? this.sessionKey.split('/').pop()}…`);
			}
			return;
		}
		clearTimeout(this.connectTimer);
		this.connectTimer = undefined;
		if (this.workspaceId === undefined) {
			const tab = snapshot.tabs.find((t) => t.tab_id === this.legacyTabId);
			if (!tab) {
				this.showClosed();
				return;
			}
			this.workspaceId = tab.workspace_id;
			this.post({ type: 'init', state: this.panelState() });
			this.resolveEmitter.fire();
			if (this.disposedFlag) {
				return;
			}
		}
		const workspaceId = this.workspaceId;
		const space = snapshot.workspaces.find((w) => w.workspace_id === workspaceId);
		if (!space) {
			if (this.spaceSeen) {
				this.closeForGoneSpace();
			} else {
				this.showClosed(); // A restored tab whose space is not there (any more).
			}
			return;
		}
		this.spaceSeen = true;
		this.spaceClosed = false;
		const title = spaceTitle(this.sessionName, space.label);
		if (this.panel.title !== title) {
			this.panel.title = title;
		}
		const active = activeTabOf(snapshot, workspaceId);
		let shown = active;
		const pending = this.pendingTab;
		if (pending) {
			const stillThere = snapshot.tabs.some((t) => t.tab_id === pending.id && t.workspace_id === workspaceId);
			if (active === pending.id || !stillThere || Date.now() >= pending.until) {
				this.clearPending();
			} else {
				shown = pending.id;
			}
		}
		if (shown === undefined) {
			this.showClosed();
			return;
		}
		if (shown !== this.tabId) {
			this.switchTo(shown);
		}
		this.sendMeta(snapshot);
		// Whatever the events said: a tab whose panes are not the ones on screen needs a new layout.
		const panes = snapshot.panes.filter((p) => p.tab_id === shown).map((p) => p.pane_id);
		if (this.structure === undefined || panes.length !== this.paneIds.size || panes.some((id) => !this.paneIds.has(id))) {
			this.scheduleExport();
		}
	}

	/** Shows another of the space's tabs: its own split state, its tiles from a fresh export. */
	private switchTo(tabId: string): void {
		this.tabId = tabId;
		clearTimeout(this.exportTimer);
		this.exportTimer = undefined;
		this.structure = undefined;
		this.ratios = {};
		this.ratiosInFlight.clear();
		this.zoomedPane = undefined;
		this.focusedPane = undefined;
		this.herdrFocusedPane = undefined;
		this.paneIds = new Set();
		this.deps.tilesChanged?.();
		this.scheduleExport();
	}

	private clearPending(): void {
		this.pendingTab = undefined;
		clearTimeout(this.pendingTimer);
		this.pendingTimer = undefined;
	}

	/**
	 * Shows `tabId` at once and makes it herdr's active tab (`tab.focus`). The
	 * snapshot confirms it; on an error the panel goes back to herdr's.
	 */
	async selectTab(tabId: string): Promise<void> {
		const snapshot = this.snapshot;
		const workspaceId = this.workspaceId;
		if (!snapshot || workspaceId === undefined || this.pendingTab?.id === tabId) {
			return;
		}
		if (!snapshot.tabs.some((t) => t.tab_id === tabId && t.workspace_id === workspaceId)) {
			return;
		}
		if (activeTabOf(snapshot, workspaceId) === tabId) {
			this.clearPending();
			this.sync();
			return;
		}
		this.clearPending();
		this.pendingTab = { id: tabId, until: Date.now() + PENDING_TAB_MS };
		this.pendingTimer = setTimeout(() => this.sync(), PENDING_TAB_MS + 10);
		this.sync();
		try {
			await this.deps.model.request(this.sessionKey, 'tab.focus', { tab_id: tabId });
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
			if (this.pendingTab?.id === tabId) {
				this.clearPending();
				this.sync();
			}
		}
	}

	private sendMeta(snapshot: Snapshot): void {
		const workspaceId = this.workspaceId;
		this.post({
			type: 'meta',
			tiles: this.tabId ? tileMetas(snapshot, this.sessionKey, this.tabId) : [],
			strip: workspaceId !== undefined ? stripTabs(snapshot, workspaceId, this.tabId) : [],
		});
	}

	private onEvent(ev: HerdrEvent): void {
		if (ev.event === 'workspace.closed' && this.workspaceId !== undefined && ev.data.workspace_id === this.workspaceId) {
			this.closeForGoneSpace();
			return;
		}
		const tabId = this.tabId;
		if (tabId === undefined) {
			return;
		}
		const snapshot = this.snapshot;
		const tabOfPane = (id: string) => snapshot?.panes.find((p) => p.pane_id === id)?.tab_id;
		if (ev.event === 'events_lost' || eventTouchesTab(ev, tabId, tabOfPane)) {
			this.scheduleExport();
		}
	}

	private scheduleExport(): void {
		if (this.exportTimer === undefined) {
			this.exportTimer = setTimeout(() => {
				this.exportTimer = undefined;
				void this.runExport();
			}, REEXPORT_DEBOUNCE_MS);
		}
	}

	private async runExport(): Promise<void> {
		if (this.exporting) {
			this.exportDirty = true;
			return;
		}
		const tabId = this.tabId;
		if (tabId === undefined) {
			return;
		}
		if (this.moveBusy) {
			this.afterMove = true;
			return;
		}
		this.exporting = true;
		try {
			const result = await this.deps.model.request(this.sessionKey, 'layout.export', { tab_id: tabId });
			// The panel may have switched tabs meanwhile: an old tab's answer is not this tab's layout.
			if (!this.disposedFlag && tabId === this.tabId) {
				this.applyExport(result);
			}
		} catch (err) {
			if (this.disposedFlag) {
				return;
			}
			// `layout_not_found`: the tab closed; the snapshot will name the space's next active tab.
			this.deps.log(`${this.sessionKey}: layout.export ${tabId} failed: ${(err as Error).message}`);
		} finally {
			this.exporting = false;
			if (this.exportDirty) {
				this.exportDirty = false;
				this.scheduleExport();
			}
		}
	}

	private applyExport(result: unknown): void {
		const layout = parseLayoutExport(result);
		if (!layout) {
			this.deps.log(`${this.sessionKey}: layout.export ${this.tabId}: unexpected reply`);
			return;
		}
		if (layout.tab_id && layout.tab_id !== this.tabId) {
			return;
		}
		this.herdrFocusedPane = layout.focused_pane_id;
		this.paneIds = new Set(layoutPaneIds(layout.root));
		this.deps.tilesChanged?.();
		const structure = structureKey(layout.root);
		const ratios = ratiosByPath(layout.root);
		const snapshot = this.snapshot;
		const config = this.configOf(layout);
		if (structure !== this.structure) {
			// Panes added, removed, moved, swapped, or another tab: a new Golden Layout tree, then herdr's zoom on it.
			this.structure = structure;
			this.ratios = ratios;
			this.setView({ type: 'layout', config });
			if (!this.zoomBusy) {
				this.zoomedPane = zoomedPaneOf(layout);
			}
			this.postZoom();
			if (snapshot) {
				this.sendMeta(snapshot);
			}
			this.focusPending();
			return;
		}
		// The same tree: splitters move in place, terminals and focus stay.
		const changed = changedRatios(this.ratios, ratios, this.ratiosInFlight);
		for (const [key, ratio] of Object.entries(ratios)) {
			if (!this.ratiosInFlight.has(key)) {
				this.ratios[key] = ratio;
			}
		}
		this.view = { type: 'layout', config }; // replayed after a reload, not posted
		if (Object.keys(changed).length > 0) {
			this.post({ type: 'ratios', ratios: changed });
		}
		const zoomed = zoomedPaneOf(layout);
		if (!this.zoomBusy && zoomed !== this.zoomedPane) {
			this.zoomedPane = zoomed;
			this.postZoom();
		}
		this.focusPending();
	}

	/** Focuses the tile `reveal` asked for, once it is on screen. */
	private focusPending(): void {
		const paneId = this.focusWhenShown;
		if (paneId && this.ready && this.paneIds.has(paneId)) {
			this.focusWhenShown = undefined;
			this.post({ type: 'focusTile', paneKey: makePaneKey(this.sessionKey, paneId) });
		}
	}

	private configOf(layout: LayoutExport): StoredLayoutConfig {
		const snapshot = this.snapshot;
		const title = (paneId: string) => {
			const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
			return pane && snapshot ? paneLabel(pane, snapshot) : 'shell';
		};
		return mirrorConfig(layout.root, this.sessionKey, title);
	}

	private postZoom(): void {
		this.post({ type: 'zoom', paneKey: this.zoomedPane ? makePaneKey(this.sessionKey, this.zoomedPane) : null });
	}

	/** Splitter drags in the webview: each changed split to herdr, one request at a time. */
	private async setRatios(ratios: Record<string, number>): Promise<void> {
		const tabId = this.tabId;
		for (const [key, wanted] of Object.entries(ratios)) {
			if (tabId === undefined || tabId !== this.tabId) {
				return;
			}
			if (this.structure === undefined || this.ratios[key] === undefined || this.ratiosInFlight.has(key)) {
				continue;
			}
			const ratio = clampRatio(wanted);
			this.ratiosInFlight.add(key);
			try {
				const result = await this.deps.model.request(this.sessionKey, 'layout.set_split_ratio', {
					tab_id: tabId,
					path: herdrPath(key),
					ratio,
				});
				if (tabId !== this.tabId) {
					return;
				}
				const layout = parseLayoutExport(result);
				const got = layout ? ratiosByPath(layout.root)[key] : undefined;
				if (got !== undefined && !this.disposedFlag) {
					this.ratios[key] = got;
					// herdr clamps to [0.1, 0.9] (and we to [0.05, 0.95]): the splitter shows what herdr has.
					if (!sameRatio(got, wanted)) {
						this.post({ type: 'ratios', ratios: { [key]: got } });
					}
				}
			} catch (err) {
				this.deps.log(`${this.sessionKey}: layout.set_split_ratio ${tabId} ${key} failed: ${(err as Error).message}`);
				if (tabId !== this.tabId) {
					return;
				}
				const stored = this.ratios[key];
				if (stored !== undefined) {
					this.post({ type: 'ratios', ratios: { [key]: stored } });
				}
				this.scheduleExport();
			} finally {
				if (tabId === this.tabId) {
					this.ratiosInFlight.delete(key);
				}
			}
		}
	}

	/** A tile dropped on another tile of this tab: herdr swaps or moves the panes; the re-export shows it. */
	private async movePane(msg: Extract<WebviewMessage, { type: 'movePane' }>): Promise<void> {
		const source = splitPaneKey(msg.paneKey);
		const target = splitPaneKey(msg.targetPaneKey);
		const tabId = this.tabId;
		const workspaceId = this.workspaceId;
		if (
			tabId === undefined ||
			workspaceId === undefined ||
			source.sessionKey !== this.sessionKey ||
			target.sessionKey !== this.sessionKey ||
			!this.paneIds.has(source.paneId) ||
			!this.paneIds.has(target.paneId) ||
			this.zoomedPane !== undefined
		) {
			return;
		}
		const label = this.paneLabelOf(source.paneId);
		const requests = dropRequests(msg.zone, source.paneId, target.paneId, { tabId, workspaceId, label });
		// The second request of an edge drop brings the pane back from its passing tab.
		const stranded = requests.length > 1 && requests[0].method === 'pane.move' ? 1 : -1;
		await this.runMoves(requests, (index, reason) =>
			index === stranded ? `herdr: the pane could not be moved back (${reason}); it is in tab "${label}".` : `herdr: ${reason}`,
		);
	}

	/** A tile dropped on a strip entry or +: its pane moves to that herdr tab, or a new one. The shown tab stays. */
	private async movePaneToTab(paneKey: string, tabId: string | null): Promise<void> {
		const source = splitPaneKey(paneKey);
		const workspaceId = this.workspaceId;
		if (workspaceId === undefined || source.sessionKey !== this.sessionKey || !this.paneIds.has(source.paneId) || tabId === this.tabId) {
			return;
		}
		if (tabId !== null && !this.snapshot?.tabs.some((t) => t.tab_id === tabId && t.workspace_id === workspaceId)) {
			return;
		}
		await this.runMoves([stripDropRequest(source.paneId, workspaceId, tabId)], (_i, reason) => `herdr: ${reason}`);
	}

	/** Sends a drop's requests in order; the first refusal or error stops them, with a warning. Then one sync and re-export. */
	private async runMoves(requests: HerdrRequest[], warning: (index: number, reason: string) => string): Promise<void> {
		if (requests.length === 0 || this.moveBusy) {
			return;
		}
		this.moveBusy = true;
		try {
			for (const [index, { method, params }] of requests.entries()) {
				let reason: string | undefined;
				try {
					reason = refusal(await this.deps.model.request(this.sessionKey, method, params));
				} catch (err) {
					reason = (err as Error).message;
				}
				if (reason) {
					void vscode.window.showWarningMessage(warning(index, reason));
					break;
				}
			}
		} finally {
			this.moveBusy = false;
			this.afterMove = false;
			if (!this.disposedFlag) {
				this.sync();
				this.scheduleExport();
			}
		}
	}

	private paneLabelOf(paneId: string): string {
		const snapshot = this.snapshot;
		const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
		return pane && snapshot ? paneLabel(pane, snapshot) : 'shell';
	}

	/** Maximise in the webview is herdr's zoom; it also makes the pane herdr's focused pane. */
	private async setZoom(paneKey: string | null): Promise<void> {
		let wanted: string | null = null;
		if (paneKey !== null) {
			const { sessionKey, paneId } = splitPaneKey(paneKey);
			if (sessionKey !== this.sessionKey || !this.paneIds.has(paneId)) {
				return;
			}
			wanted = paneId;
		}
		const requests = zoomRequests(this.zoomedPane, wanted);
		if (requests.length === 0 || this.zoomBusy) {
			return;
		}
		const tabId = this.tabId;
		this.zoomBusy = true;
		let last: unknown;
		try {
			for (const { method, params } of requests) {
				last = await this.deps.model.request(this.sessionKey, method, params);
			}
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
			if (tabId === this.tabId) {
				this.postZoom();
			}
			return;
		} finally {
			this.zoomBusy = false;
		}
		if (tabId !== this.tabId || this.disposedFlag) {
			return;
		}
		const after = zoomedAfter(last);
		if (after === undefined) {
			this.scheduleExport();
			return;
		}
		this.zoomedPane = after ?? undefined;
		if (after !== wanted) {
			this.postZoom(); // e.g. `single_pane`: the tile goes back to how herdr has it
		}
	}

	/** A tile's context menu: Zoom (`paneId`) or Unzoom (null). The webview follows herdr's answer. */
	async zoomFromMenu(paneId: string | null): Promise<void> {
		if (paneId !== null && !this.paneIds.has(paneId)) {
			return;
		}
		await this.setZoom(paneId === null ? null : makePaneKey(this.sessionKey, paneId));
		this.postZoom();
	}

	/** The tile new tabs start from: the panel's focused tile, else herdr's focused pane if shown here. */
	private actionPane(): string | undefined {
		if (this.focusedPane && this.paneIds.has(this.focusedPane)) {
			return this.focusedPane;
		}
		if (this.herdrFocusedPane && this.paneIds.has(this.herdrFocusedPane)) {
			return this.herdrFocusedPane;
		}
		return this.paneIds.values().next().value;
	}

	/** The working directory a new pane or tab starts in: `paneId`'s, else the action pane's. */
	private actionCwd(paneId = this.actionPane()): string | undefined {
		const snapshot = this.snapshot;
		const pane =
			snapshot?.panes.find((p) => p.pane_id === paneId) ?? snapshot?.panes.find((p) => p.tab_id === this.tabId);
		return pane?.foreground_cwd ?? pane?.cwd;
	}

	/** A tile's context menu: a new shell pane split off `paneId`, starting in its directory. */
	async split(paneId: string, direction: 'right' | 'down'): Promise<void> {
		if (!this.paneIds.has(paneId)) {
			return;
		}
		const cwd = this.actionCwd(paneId);
		try {
			await this.deps.model.request(this.sessionKey, 'pane.split', {
				target_pane_id: paneId,
				direction,
				...(cwd ? { cwd } : {}),
				focus: false,
			});
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
		}
	}

	/** A tile's close control or context menu, after asking; `confirm` false skips the modal (tests). */
	async closePane(paneKey: string, confirm = true): Promise<void> {
		const { paneId } = splitPaneKey(paneKey);
		const snapshot = this.snapshot;
		const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
		const label = pane && snapshot ? paneLabel(pane, snapshot) : 'this pane';
		try {
			if (confirm) {
				const answer = await vscode.window.showWarningMessage(
					`Close "${label}" in herdr? Its process ends.`,
					{ modal: true },
					'Close Pane',
				);
				if (answer !== 'Close Pane') {
					return;
				}
			}
			await this.deps.model.request(this.sessionKey, 'pane.close', { pane_id: paneId });
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
		}
	}

	/** The strip's +: a new tab in this space, made herdr's active tab; the snapshot brings it here. */
	async newTab(): Promise<void> {
		if (this.workspaceId === undefined) {
			return;
		}
		const cwd = this.actionCwd();
		try {
			await this.deps.model.request(this.sessionKey, 'tab.create', {
				workspace_id: this.workspaceId,
				...(cwd ? { cwd } : {}),
				focus: true,
			});
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
		}
	}

	private tabLabel(tabId: string): string | undefined {
		return this.snapshot?.tabs.find((t) => t.tab_id === tabId)?.label;
	}

	/** A strip entry's ×, after asking. */
	async closeTab(tabId: string, confirm = true): Promise<void> {
		const label = this.tabLabel(tabId);
		if (label === undefined) {
			return;
		}
		try {
			if (confirm) {
				const answer = await vscode.window.showWarningMessage(
					`Close tab "${label}" in herdr? Its processes end.`,
					{ modal: true },
					'Close Tab',
				);
				if (answer !== 'Close Tab') {
					return;
				}
			}
			await this.deps.model.request(this.sessionKey, 'tab.close', { tab_id: tabId });
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
		}
	}

	/** A strip entry's double-click; `name` skips the input box (tests). */
	async renameTab(tabId: string, name?: string): Promise<void> {
		const label = this.tabLabel(tabId);
		if (label === undefined) {
			return;
		}
		const wanted =
			name ??
			(await vscode.window.showInputBox({
				prompt: 'Rename herdr tab',
				value: label,
				validateInput: (v) => (v.trim() ? undefined : 'Enter a name.'),
			}));
		if (wanted === undefined || !wanted.trim()) {
			return;
		}
		try {
			await this.deps.model.request(this.sessionKey, 'tab.rename', { tab_id: tabId, label: wanted.trim() });
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
		}
	}

	protected panelState(): PanelState {
		return this.workspaceId !== undefined
			? { kind: 'space', sessionKey: this.sessionKey, workspaceId: this.workspaceId }
			: { kind: 'mirror', sessionKey: this.sessionKey, tabId: this.legacyTabId ?? '' };
	}

	protected onReady(): void {
		const snapshot = this.snapshot;
		if (snapshot) {
			this.sendMeta(snapshot);
		}
		if (this.view?.type === 'layout') {
			this.postZoom();
		}
		this.focusPending();
	}

	protected tileFocused(paneId: string): void {
		this.focusedPane = paneId;
	}

	protected onPanelMessage(msg: WebviewMessage): void {
		switch (msg.type) {
			case 'closePane':
				void this.closePane(msg.paneKey);
				break;
			case 'setRatios':
				void this.setRatios(msg.ratios);
				break;
			case 'movePane':
				void this.movePane(msg);
				break;
			case 'movePaneToTab':
				void this.movePaneToTab(msg.paneKey, msg.tabId);
				break;
			case 'setZoom':
				void this.setZoom(msg.paneKey);
				break;
			case 'focusTab':
				void this.selectTab(msg.tabId);
				this.deps.focus.followTab(this.sessionKey, msg.tabId);
				break;
			case 'newTab':
				void this.newTab();
				break;
			case 'closeTab':
				void this.closeTab(msg.tabId);
				break;
			case 'renameTab':
				void this.renameTab(msg.tabId);
				break;
		}
	}

	protected onDispose(): void {
		clearTimeout(this.exportTimer);
		clearTimeout(this.connectTimer);
		clearTimeout(this.pendingTimer);
	}
}

/** Every `herdr.tiles` panel of the window. */
export class TilesPanels implements vscode.Disposable, vscode.WebviewPanelSerializer {
	private readonly panels = new Map<string, MirrorPanel>();
	/** Panels restored from a tab's state whose space is not known yet. */
	private readonly unresolved = new Set<MirrorPanel>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly deps: TilesDeps;
	private readonly tilesEmitter = new vscode.EventEmitter<void>();
	/** Which panes the tiles of this window show may have changed. */
	readonly onDidChangeTiles = this.tilesEmitter.event;
	private readonly linkEmitter = new vscode.EventEmitter<{ paneKey: string; text: string }>();
	/** A path printed in a tile was clicked. */
	readonly onDidRequestLink = this.linkEmitter.event;

	constructor(deps: TilesDeps) {
		this.deps = {
			...deps,
			tilesChanged: () => this.tilesEmitter.fire(),
			openLink: (paneKey, text) => this.linkEmitter.fire({ paneKey, text }),
		};
		this.disposables.push(
			this.tilesEmitter,
			this.linkEmitter,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fontFamily') || e.affectsConfiguration('editor.fontSize')) {
					for (const panel of this.allPanels()) {
						panel.sendFont();
					}
				}
			}),
		);
	}

	private allPanels(): MirrorPanel[] {
		return [...this.panels.values(), ...this.unresolved];
	}

	/** `workspaceId` undefined: an older build's state, resolved to `legacyTabId`'s space once connected. */
	private track(panel: vscode.WebviewPanel, sessionKey: string, workspaceId: string | undefined, legacyTabId?: string): MirrorPanel {
		const mirror = new MirrorPanel(panel, sessionKey, workspaceId, this.deps, legacyTabId);
		const keyOf = () => (mirror.workspaceId !== undefined ? `${sessionKey}|${mirror.workspaceId}` : undefined);
		const register = () => {
			const key = keyOf();
			if (key === undefined) {
				this.unresolved.add(mirror);
				return;
			}
			this.unresolved.delete(mirror);
			const other = this.panels.get(key);
			if (other && other !== mirror) {
				// A second restored panel of one space: the first one wins.
				mirror.panel.dispose();
				return;
			}
			this.panels.set(key, mirror);
		};
		register();
		mirror.onDidResolveSpace(register);
		mirror.onDidDispose(() => {
			this.unresolved.delete(mirror);
			const key = keyOf();
			if (key !== undefined && this.panels.get(key) === mirror) {
				this.panels.delete(key);
			}
			this.tilesEmitter.fire();
		});
		return mirror;
	}

	private createPanel(title: string): vscode.WebviewPanel {
		return vscode.window.createWebviewPanel(TILES_VIEW_TYPE, title, vscode.ViewColumn.Active, WEBVIEW_OPTIONS(this.deps.extensionUri));
	}

	/** Whether any tile of this window shows the pane. */
	showsPane(sessionKey: string, paneId: string): boolean {
		return this.allPanels().some((p) => p.showsPane(sessionKey, paneId));
	}

	/** Reveals the panel of (session, space), else creates one in the active column. Leaves herdr's active tab alone. */
	openSpace(sessionKey: string, workspaceId: string): MirrorPanel {
		const existing = this.panels.get(`${sessionKey}|${workspaceId}`);
		if (existing) {
			existing.reveal();
			return existing;
		}
		const conn = this.deps.model.connection(sessionKey);
		const label = conn?.snapshot?.workspaces.find((w) => w.workspace_id === workspaceId)?.label;
		const title = label !== undefined && conn ? spaceTitle(conn.name, label) : 'herdr';
		return this.track(this.createPanel(title), sessionKey, workspaceId);
	}

	/** Opens the tab's space, and makes the tab herdr's active tab there. */
	openTab(sessionKey: string, tabId: string): MirrorPanel | undefined {
		const tab = this.deps.model.connection(sessionKey)?.snapshot?.tabs.find((t) => t.tab_id === tabId);
		if (!tab) {
			void vscode.window.showWarningMessage('herdr: that tab is not available.');
			return undefined;
		}
		const panel = this.openSpace(sessionKey, tab.workspace_id);
		void panel.selectTab(tabId);
		return panel;
	}

	/** Opens the pane's tab, then focuses the pane's tile once it is shown. */
	openPaneTab(sessionKey: string, paneId: string): MirrorPanel | undefined {
		const tabId = this.deps.model.connection(sessionKey)?.snapshot?.panes.find((p) => p.pane_id === paneId)?.tab_id;
		if (!tabId) {
			void vscode.window.showWarningMessage('herdr: that pane is not available.');
			return undefined;
		}
		const panel = this.openTab(sessionKey, tabId);
		panel?.reveal(paneId);
		return panel;
	}

	/** Reveals the tile showing a pane, in the panel that last had focus; with none, opens the pane's tab. */
	revealPane(sessionKey: string, paneId: string): void {
		const showing = this.allPanels()
			.filter((p) => p.showsPane(sessionKey, paneId))
			.sort((a, b) => b.lastFocus - a.lastFocus);
		if (showing[0]) {
			showing[0].revealPane(sessionKey, paneId);
			return;
		}
		this.openPaneTab(sessionKey, paneId);
	}

	/** The panel whose shown tab has the pane (a tile's context menu); with none, a warning. */
	panelOfPane(paneKey: string): MirrorPanel | undefined {
		const { sessionKey, paneId } = splitPaneKey(paneKey);
		const panel = this.allPanels().find((p) => p.showsPane(sessionKey, paneId));
		if (!panel) {
			void vscode.window.showWarningMessage('herdr: that pane is not available.');
		}
		return panel;
	}

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
		const s = state as Partial<PanelState> | undefined;
		if (s?.kind === 'space' && s.sessionKey && s.workspaceId) {
			if (this.panels.has(`${s.sessionKey}|${s.workspaceId}`)) {
				panel.dispose(); // the first one wins
				return;
			}
			this.track(panel, s.sessionKey, s.workspaceId);
		} else if (s?.kind === 'mirror' && s.sessionKey && s.tabId) {
			this.track(panel, s.sessionKey, undefined, s.tabId);
		} else {
			// Unknown state, or a Layout tab saved by an earlier build (Layout tabs are gone).
			panel.dispose();
		}
	}

	dispose(): void {
		for (const panel of this.allPanels()) {
			panel.dispose();
		}
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
