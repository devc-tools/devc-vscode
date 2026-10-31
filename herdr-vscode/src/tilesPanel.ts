import * as vscode from 'vscode';
import { BridgeError, HerdrEvent } from './bridge';
import { FocusTracker } from './focus';
import { layoutPaneIds, layoutShape, mirrorConfig, parseLayoutExport, StoredLayoutConfig } from './layoutMapping';
import { asLayoutConfig, copyLayoutName, layoutPaneKeys, LayoutStore, nextLayoutName, parsePaneMoved, rewritePane, SavedLayout, selectLayoutTarget } from './layouts';
import { hasAgent, paneLabel, SessionModel, SessionConnection, Snapshot } from './sessions';
import { PaneFrame, PaneStreams, PaneViewer } from './streams';
import {
	HostMessage,
	makePaneKey,
	PanelState,
	ProbeAction,
	splitPaneKey,
	TileMeta,
	TileProbe,
	TileStreamState,
	WebviewMessage,
} from './tilesProtocol';
import { wrapPaste } from './webview/input';

export const TILES_VIEW_TYPE = 'herdr.tiles';

const REEXPORT_DEBOUNCE_MS = 100;
/** How long a panel waits for its session before saying the tab is gone. */
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

/** `<tab label> · <space label>`. */
export function panelTitle(snapshot: Snapshot, tabId: string): string | undefined {
	const tab = snapshot.tabs.find((t) => t.tab_id === tabId);
	if (!tab) {
		return undefined;
	}
	const space = snapshot.workspaces.find((w) => w.workspace_id === tab.workspace_id);
	return `${tab.label} · ${space?.label ?? tab.workspace_id}`;
}

/** The tile headers of a tab's panes. */
export function tileMetas(snapshot: Snapshot, sessionKey: string, tabId: string): TileMeta[] {
	return snapshot.panes
		.filter((p) => p.tab_id === tabId)
		.map((p) => ({
			paneKey: makePaneKey(sessionKey, p.pane_id),
			label: paneLabel(p, snapshot),
			detail: hasAgent(p) ? p.terminal_title_stripped : undefined,
			status: hasAgent(p) ? p.agent_status : 'shell',
		}));
}

/**
 * A Layout tab's tile headers: the pane's space faded, with the session's row
 * label too when the layout spans sessions. Panes not in a snapshot have none.
 */
export function layoutTileMetas(
	paneKeys: readonly string[],
	snapshotOf: (sessionKey: string) => Snapshot | undefined,
	rowLabel: (sessionKey: string) => string | undefined,
): TileMeta[] {
	const refs = paneKeys.map(splitPaneKey);
	const spansSessions = new Set(refs.map((r) => r.sessionKey)).size > 1;
	const metas: TileMeta[] = [];
	for (const { sessionKey, paneId } of refs) {
		const snapshot = snapshotOf(sessionKey);
		const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
		if (!snapshot || !pane) {
			continue;
		}
		const space = snapshot.workspaces.find((w) => w.workspace_id === pane.workspace_id)?.label ?? pane.workspace_id;
		metas.push({
			paneKey: makePaneKey(sessionKey, paneId),
			label: paneLabel(pane, snapshot),
			detail: spansSessions ? `${space} · ${rowLabel(sessionKey) ?? sessionKey}` : space,
			status: hasAgent(pane) ? pane.agent_status : 'shell',
		});
	}
	return metas;
}

/** Whether a Layout tile can show its pane; `undefined` from a session that has not connected counts as waiting. */
export function paneAvailability(conn: Pick<SessionConnection, 'state' | 'snapshot'> | undefined, paneId: string): 'live' | 'waiting' | 'gone' {
	if (conn?.state !== 'connected' || !conn.snapshot) {
		return 'waiting';
	}
	return conn.snapshot.panes.some((p) => p.pane_id === paneId) ? 'live' : 'gone';
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
<span id="breadcrumb"></span>
<button id="copy-layout" class="mirror-only">Copy as Layout</button>
<button id="split-right" class="mirror-only">Split Right</button>
<button id="split-down" class="mirror-only">Split Down</button>
<button id="rename-layout" class="layout-only">Rename</button>
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
	layouts: LayoutStore;
	rowLabel(sessionKey: string): string | undefined;
	log(line: string): void;
}

/** Which panel last had a tile focused, across every panel of the window. */
let focusClock = 0;

const WEBVIEW_OPTIONS = (extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions => ({
	enableScripts: true,
	retainContextWhenHidden: true,
	localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
});

type ProbeResult = { tiles: TileProbe[]; breadcrumb: string; message: string; config: StoredLayoutConfig | undefined };

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
			return Promise.resolve({ tiles: [], breadcrumb: '', message: '', config: undefined });
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

/** One editor tab mirroring one herdr tab. */
export class MirrorPanel extends TilesPanel {
	/** The split tree in `view`; undefined when none is loaded. */
	private shape: string | undefined;
	private paneIds = new Set<string>();
	private focusedPane: string | undefined;
	private herdrFocusedPane: string | undefined;
	private exportTimer: NodeJS.Timeout | undefined;
	private exporting = false;
	private exportDirty = false;
	private connectTimer: NodeJS.Timeout | undefined;
	private tabClosed = false;
	private focusOnReady: string | undefined;

	constructor(
		panel: vscode.WebviewPanel,
		readonly sessionKey: string,
		readonly tabId: string,
		deps: TilesDeps,
		private readonly copyAsLayout: (config: StoredLayoutConfig, tabLabel: string, spaceLabel: string) => void,
	) {
		super(panel, deps, 'herdr.svg');
		this.disposables.push(
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

	/** Brings the panel forward, optionally focusing a pane's tile. */
	reveal(paneId?: string): void {
		this.panel.reveal(undefined, false);
		if (paneId && this.ready) {
			this.post({ type: 'focusTile', paneKey: makePaneKey(this.sessionKey, paneId) });
		} else if (paneId) {
			this.focusOnReady = paneId;
		}
	}

	private get snapshot(): Snapshot | undefined {
		const conn = this.deps.model.connection(this.sessionKey);
		return conn?.state === 'connected' ? conn.snapshot : undefined;
	}

	private showEmpty(text: string): void {
		clearTimeout(this.exportTimer);
		this.exportTimer = undefined;
		this.shape = undefined;
		this.paneIds = new Set();
		this.focusedPane = undefined;
		if (this.view?.type !== 'empty' || this.view.text !== text) {
			this.setView({ type: 'empty', text });
		}
	}

	private showClosed(): void {
		this.tabClosed = true;
		this.showEmpty('This herdr tab was closed.');
	}

	/** Brings the panel in line with the session model. */
	private sync(): void {
		if (this.disposedFlag) {
			return;
		}
		const snapshot = this.snapshot;
		if (!snapshot) {
			if (this.connectTimer === undefined && !this.tabClosed) {
				this.connectTimer = setTimeout(() => this.showClosed(), CONNECT_WAIT_MS);
				this.showEmpty(`Connecting to ${this.deps.rowLabel(this.sessionKey) ?? this.sessionKey.split('/').pop()}…`);
			}
			return;
		}
		clearTimeout(this.connectTimer);
		this.connectTimer = undefined;
		if (!snapshot.tabs.some((t) => t.tab_id === this.tabId)) {
			this.showClosed();
			return;
		}
		this.tabClosed = false;
		const title = panelTitle(snapshot, this.tabId);
		if (title && this.panel.title !== title) {
			this.panel.title = title;
		}
		this.sendMeta(snapshot);
		// Whatever the events said: a tab whose panes are not the ones on screen needs a new layout.
		const panes = snapshot.panes.filter((p) => p.tab_id === this.tabId).map((p) => p.pane_id);
		if (this.shape === undefined || panes.length !== this.paneIds.size || panes.some((id) => !this.paneIds.has(id))) {
			this.scheduleExport();
		}
	}

	private sendMeta(snapshot: Snapshot): void {
		const tab = snapshot.tabs.find((t) => t.tab_id === this.tabId);
		const space = snapshot.workspaces.find((w) => w.workspace_id === tab?.workspace_id);
		const row = this.deps.rowLabel(this.sessionKey) ?? this.sessionKey;
		this.post({
			type: 'meta',
			breadcrumb: `${row} › ${space?.label ?? ''} › ${tab?.label ?? ''}`,
			tiles: tileMetas(snapshot, this.sessionKey, this.tabId),
		});
	}

	private onEvent(ev: HerdrEvent): void {
		if (ev.event === 'tab.closed' && ev.data.tab_id === this.tabId) {
			this.showClosed();
			return;
		}
		const snapshot = this.snapshot;
		const tabOfPane = (id: string) => snapshot?.panes.find((p) => p.pane_id === id)?.tab_id;
		if (ev.event === 'events_lost' || eventTouchesTab(ev, this.tabId, tabOfPane)) {
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
		this.exporting = true;
		try {
			const result = await this.deps.model.request(
				this.sessionKey,
				'layout.export',
				{ tab_id: this.tabId },
			);
			if (!this.disposedFlag) {
				this.applyExport(result);
			}
		} catch (err) {
			if (this.disposedFlag) {
				return;
			}
			if (err instanceof BridgeError && err.code === 'layout_not_found') {
				this.showClosed();
			} else {
				this.deps.log(`${this.sessionKey}: layout.export ${this.tabId} failed: ${(err as Error).message}`);
			}
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
		this.tabClosed = false;
		this.herdrFocusedPane = layout.focused_pane_id;
		this.paneIds = new Set(layoutPaneIds(layout.root));
		const shape = layoutShape(layout.root);
		if (shape === this.shape) {
			return; // Nothing moved: keep local splitter drags and maximise.
		}
		this.shape = shape;
		const snapshot = this.snapshot;
		const title = (paneId: string) => {
			const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
			return pane && snapshot ? paneLabel(pane, snapshot) : 'shell';
		};
		this.setView({ type: 'layout', config: mirrorConfig(layout.root, this.sessionKey, title) });
		if (snapshot) {
			this.sendMeta(snapshot);
		}
	}

	/** The tile the toolbar acts on: the panel's focused tile, else herdr's focused pane if shown here. */
	private actionPane(): string | undefined {
		if (this.focusedPane && this.paneIds.has(this.focusedPane)) {
			return this.focusedPane;
		}
		if (this.herdrFocusedPane && this.paneIds.has(this.herdrFocusedPane)) {
			return this.herdrFocusedPane;
		}
		return this.paneIds.values().next().value;
	}

	private async split(direction: 'right' | 'down'): Promise<void> {
		const paneId = this.actionPane();
		if (!paneId) {
			return;
		}
		const pane = this.snapshot?.panes.find((p) => p.pane_id === paneId);
		const cwd = pane?.foreground_cwd ?? pane?.cwd;
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

	private async closePane(paneKey: string): Promise<void> {
		const { paneId } = splitPaneKey(paneKey);
		const snapshot = this.snapshot;
		const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
		const label = pane && snapshot ? paneLabel(pane, snapshot) : 'this pane';
		try {
			const answer = await vscode.window.showWarningMessage(
				`Close "${label}" in herdr? Its process ends.`,
				{ modal: true },
				'Close Pane',
			);
			if (answer !== 'Close Pane') {
				return;
			}
			await this.deps.model.request(this.sessionKey, 'pane.close', { pane_id: paneId });
		} catch (err) {
			void vscode.window.showWarningMessage(`herdr: ${(err as Error).message}`);
		}
	}

	protected panelState(): PanelState {
		return { kind: 'mirror', sessionKey: this.sessionKey, tabId: this.tabId };
	}

	protected onReady(): void {
		const snapshot = this.snapshot;
		if (snapshot) {
			this.sendMeta(snapshot);
		}
		if (this.focusOnReady) {
			this.post({ type: 'focusTile', paneKey: makePaneKey(this.sessionKey, this.focusOnReady) });
			this.focusOnReady = undefined;
		}
	}

	protected tileFocused(paneId: string): void {
		this.focusedPane = paneId;
	}

	protected onPanelMessage(msg: WebviewMessage): void {
		switch (msg.type) {
			case 'split':
				void this.split(msg.direction);
				break;
			case 'closePane':
				void this.closePane(msg.paneKey);
				break;
			case 'copyAsLayout': {
				const snapshot = this.snapshot;
				const tab = snapshot?.tabs.find((t) => t.tab_id === this.tabId);
				if (tab) {
					const space = snapshot?.workspaces.find((w) => w.workspace_id === tab.workspace_id);
					this.copyAsLayout(msg.config, tab.label, space?.label ?? tab.workspace_id);
				}
				break;
			}
		}
	}

	protected onDispose(): void {
		clearTimeout(this.exportTimer);
		clearTimeout(this.connectTimer);
	}
}

/** What a Layout tile knows about its pane. */
interface LayoutTile {
	cols: number;
	rows: number;
	availability: ReturnType<typeof paneAvailability> | undefined;
}

/** One editor tab holding a saved layout: any panes, arranged by the user. Nothing here changes herdr's layout. */
export class LayoutPanel extends TilesPanel {
	/** The panes in the webview's layout, from its last report plus what was added since. */
	private paneKeys = new Set<string>();
	/** The tiles the webview has announced, which have a size. */
	private readonly tiles = new Map<string, LayoutTile>();
	private pendingAdds: Extract<HostMessage, { type: 'addTile' }>[] = [];

	constructor(
		panel: vscode.WebviewPanel,
		readonly layoutId: string,
		deps: TilesDeps,
		private readonly rename: (layoutId: string) => void,
	) {
		super(panel, deps, 'layout.svg');
		const saved = deps.layouts.get(layoutId);
		if (saved) {
			this.paneKeys = new Set(layoutPaneKeys(saved.config));
			this.view = { type: 'layout', config: saved.config };
		}
		this.disposables.push(deps.model.onDidChange(() => this.sync()));
		this.sync();
	}

	showsPane(sessionKey: string, paneId: string): boolean {
		return this.paneKeys.has(makePaneKey(sessionKey, paneId));
	}

	revealPane(sessionKey: string, paneId: string): void {
		this.panel.reveal(undefined, false);
		this.addPane(sessionKey, paneId, '');
	}

	/** Adds the pane, or focuses its tile if it is there: the webview's layout decides which. */
	addPane(sessionKey: string, paneId: string, title: string): void {
		const add = { type: 'addTile', sessionKey, paneId, title } as const;
		this.paneKeys.add(makePaneKey(sessionKey, paneId));
		if (this.ready) {
			this.sync();
			this.post(add);
		} else {
			this.pendingAdds.push(add);
		}
	}

	/** A pane got a new id: the store has it already, the webview's layout follows. */
	paneMoved(sessionKey: string, from: string, to: string): void {
		if (this.paneKeys.delete(makePaneKey(sessionKey, from))) {
			this.paneKeys.add(makePaneKey(sessionKey, to));
			const saved = this.deps.layouts.get(this.layoutId);
			if (saved) {
				this.view = { type: 'layout', config: saved.config };
			}
			this.post({ type: 'paneMoved', sessionKey, from, to });
		}
	}

	/** Brings the panel in line with the store and the session model. */
	sync(): void {
		if (this.disposedFlag) {
			return;
		}
		const saved = this.deps.layouts.get(this.layoutId);
		if (!saved) {
			return;
		}
		if (this.panel.title !== saved.name) {
			this.panel.title = saved.name;
		}
		this.post({
			type: 'meta',
			breadcrumb: `"${saved.name}" · layout`,
			tiles: layoutTileMetas(
				[...this.paneKeys],
				(key) => {
					const conn = this.deps.model.connection(key);
					return conn?.state === 'connected' ? conn.snapshot : undefined;
				},
				this.deps.rowLabel,
			),
		});
		for (const paneKey of this.tiles.keys()) {
			this.applyAvailability(paneKey);
		}
	}

	/** A tile's stream runs while its pane can be reached; otherwise the tile says why not. */
	private applyAvailability(paneKey: string): void {
		const tile = this.tiles.get(paneKey);
		if (!tile) {
			return;
		}
		const { sessionKey, paneId } = splitPaneKey(paneKey);
		const conn = this.deps.model.connection(sessionKey);
		const availability = paneAvailability(conn, paneId);
		if (availability === tile.availability) {
			return;
		}
		tile.availability = availability;
		if (availability === 'live') {
			super.state(paneKey, { kind: 'live' });
			super.tileOpened(paneKey, tile.cols, tile.rows);
			return;
		}
		super.tileClosed(paneKey);
		super.state(
			paneKey,
			availability === 'gone'
				? { kind: 'gone' }
				: { kind: 'waiting', label: this.deps.rowLabel(sessionKey) ?? conn?.name ?? sessionKey.split('/').pop() ?? sessionKey },
		);
	}

	// A stream winding down must not cover the tile's own state.

	state(paneKey: string, state: TileStreamState): void {
		if (this.tiles.get(paneKey)?.availability === 'live') {
			super.state(paneKey, state);
		}
	}

	protected tileOpened(paneKey: string, cols: number, rows: number): void {
		this.tiles.set(paneKey, { cols, rows, availability: undefined });
		this.applyAvailability(paneKey);
	}

	protected tileResized(paneKey: string, cols: number, rows: number): void {
		const tile = this.tiles.get(paneKey);
		if (tile) {
			tile.cols = cols;
			tile.rows = rows;
			if (tile.availability === 'live') {
				super.tileResized(paneKey, cols, rows);
			}
		}
	}

	protected tileClosed(paneKey: string): void {
		this.tiles.delete(paneKey);
		super.tileClosed(paneKey);
	}

	protected panelState(): PanelState {
		return { kind: 'layout', layoutId: this.layoutId };
	}

	protected onReady(): void {
		this.sync();
		for (const add of this.pendingAdds) {
			this.post(add);
		}
		this.pendingAdds = [];
	}

	protected onPanelMessage(msg: WebviewMessage): void {
		switch (msg.type) {
			case 'layoutChanged':
				this.deps.layouts.setConfig(this.layoutId, msg.config);
				this.paneKeys = new Set(layoutPaneKeys(msg.config));
				this.sync();
				break;
			case 'renameLayout':
				this.rename(this.layoutId);
				break;
		}
	}
}

/** Every `herdr.tiles` panel of the window. */
export class TilesPanels implements vscode.Disposable, vscode.WebviewPanelSerializer {
	private readonly panels = new Map<string, MirrorPanel>();
	private readonly layoutPanels = new Map<string, LayoutPanel>();
	/** Open Layout panels, most recently active first. */
	private recentLayouts: string[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly deps: TilesDeps) {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fontFamily') || e.affectsConfiguration('editor.fontSize')) {
					for (const panel of this.allPanels()) {
						panel.sendFont();
					}
				}
			}),
			deps.model.onDidEvent((e) => {
				if (e.event.event === 'pane.moved') {
					const moved = parsePaneMoved(e.event.data);
					if (moved) {
						this.onPaneMoved(e.sessionKey, moved.from, moved.to);
					}
				}
			}),
		);
	}

	private allPanels(): (MirrorPanel | LayoutPanel)[] {
		return [...this.panels.values(), ...this.layoutPanels.values()];
	}

	private track(panel: vscode.WebviewPanel, sessionKey: string, tabId: string): MirrorPanel {
		const mirror = new MirrorPanel(panel, sessionKey, tabId, this.deps, (config, tabLabel, spaceLabel) =>
			this.copyAsLayout(config, tabLabel, spaceLabel),
		);
		const key = `${sessionKey}|${tabId}`;
		this.panels.set(key, mirror);
		mirror.onDidDispose(() => {
			if (this.panels.get(key) === mirror) {
				this.panels.delete(key);
			}
		});
		return mirror;
	}

	private trackLayout(panel: vscode.WebviewPanel, layoutId: string): LayoutPanel {
		const layoutPanel = new LayoutPanel(panel, layoutId, this.deps, (id) => {
			void vscode.commands.executeCommand('herdr.renameLayout', id);
		});
		this.layoutPanels.set(layoutId, layoutPanel);
		this.touchLayout(layoutId);
		const viewState = panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active) {
				this.touchLayout(layoutId);
			}
		});
		layoutPanel.onDidDispose(() => {
			viewState.dispose();
			if (this.layoutPanels.get(layoutId) === layoutPanel) {
				this.layoutPanels.delete(layoutId);
				this.recentLayouts = this.recentLayouts.filter((id) => id !== layoutId);
			}
		});
		return layoutPanel;
	}

	private touchLayout(layoutId: string): void {
		this.recentLayouts = [layoutId, ...this.recentLayouts.filter((id) => id !== layoutId)];
	}

	private createPanel(title: string): vscode.WebviewPanel {
		return vscode.window.createWebviewPanel(TILES_VIEW_TYPE, title, vscode.ViewColumn.Active, WEBVIEW_OPTIONS(this.deps.extensionUri));
	}

	/** Reveals the panel showing (session, tab), else creates one in the active column. */
	openTab(sessionKey: string, tabId: string): MirrorPanel {
		const existing = this.panels.get(`${sessionKey}|${tabId}`);
		if (existing) {
			existing.reveal();
			return existing;
		}
		const snapshot = this.deps.model.connection(sessionKey)?.snapshot;
		const panel = this.createPanel((snapshot && panelTitle(snapshot, tabId)) ?? 'herdr');
		return this.track(panel, sessionKey, tabId);
	}

	/** Opens the pane's tab, then focuses the pane's tile. */
	openPaneTab(sessionKey: string, paneId: string): MirrorPanel | undefined {
		const tabId = this.deps.model.connection(sessionKey)?.snapshot?.panes.find((p) => p.pane_id === paneId)?.tab_id;
		if (!tabId) {
			void vscode.window.showWarningMessage('herdr: that pane is not available.');
			return undefined;
		}
		const panel = this.openTab(sessionKey, tabId);
		panel.reveal(paneId);
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

	// ── Layouts ─────────────────────────────────────────────────────────────

	/** Opens a saved layout, or reveals its panel. */
	openLayout(layoutId: string): LayoutPanel | undefined {
		const existing = this.layoutPanels.get(layoutId);
		if (existing) {
			existing.panel.reveal(undefined, false);
			return existing;
		}
		const saved = this.deps.layouts.get(layoutId);
		return saved && this.trackLayout(this.createPanel(saved.name), layoutId);
	}

	/** A new empty layout, opened. */
	newLayout(name: string): LayoutPanel {
		return this.openLayoutOf(this.deps.layouts.create(name));
	}

	private openLayoutOf(saved: SavedLayout): LayoutPanel {
		return this.trackLayout(this.createPanel(saved.name), saved.id);
	}

	/** The active Layout panel, else the most recently active open one, else a new layout. */
	private targetLayout(): LayoutPanel {
		const active = [...this.layoutPanels.values()].find((p) => p.panel.active)?.layoutId;
		const target = selectLayoutTarget(active, this.recentLayouts, new Set(this.layoutPanels.keys()));
		const panel = target !== undefined ? this.layoutPanels.get(target) : undefined;
		return panel ?? this.newLayout(nextLayoutName(this.deps.layouts.names()));
	}

	/** Adds a pane to the target Layout panel, or reveals its tile there. */
	addToLayout(sessionKey: string, paneId: string): LayoutPanel | undefined {
		const snapshot = this.deps.model.connection(sessionKey)?.snapshot;
		const pane = snapshot?.panes.find((p) => p.pane_id === paneId);
		if (!snapshot || !pane) {
			void vscode.window.showWarningMessage('herdr: that pane is not available.');
			return undefined;
		}
		const panel = this.targetLayout();
		panel.panel.reveal(undefined, false);
		panel.addPane(sessionKey, paneId, paneLabel(pane, snapshot));
		return panel;
	}

	renameLayout(layoutId: string, name: string): boolean {
		const renamed = this.deps.layouts.rename(layoutId, name);
		if (renamed) {
			this.layoutPanels.get(layoutId)?.sync();
		}
		return renamed;
	}

	deleteLayout(layoutId: string): void {
		this.deps.layouts.delete(layoutId);
		this.layoutPanels.get(layoutId)?.panel.dispose();
	}

	private copyAsLayout(config: StoredLayoutConfig, tabLabel: string, spaceLabel: string): LayoutPanel {
		const name = copyLayoutName(tabLabel, spaceLabel, this.deps.layouts.names());
		return this.openLayoutOf(this.deps.layouts.create(name, asLayoutConfig(config)));
	}

	/** Saved layouts follow a pane whose id changed, open or not. */
	private onPaneMoved(sessionKey: string, from: string, to: string): void {
		for (const layout of this.deps.layouts.list()) {
			const config = rewritePane(layout.config, sessionKey, from, to);
			if (config !== layout.config) {
				this.deps.layouts.setConfig(layout.id, config);
			}
			this.layoutPanels.get(layout.id)?.paneMoved(sessionKey, from, to);
		}
	}

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
		const s = state as Partial<PanelState> | undefined;
		if (s?.kind === 'mirror' && s.sessionKey && s.tabId) {
			this.track(panel, s.sessionKey, s.tabId);
		} else if (s?.kind === 'layout' && s.layoutId && this.deps.layouts.get(s.layoutId)) {
			this.trackLayout(panel, s.layoutId);
		} else {
			// Unknown state, or a layout deleted meanwhile.
			panel.dispose();
		}
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		for (const panel of this.allPanels()) {
			panel.dispose();
		}
	}
}
