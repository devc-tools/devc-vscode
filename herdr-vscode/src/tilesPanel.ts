import * as vscode from 'vscode';
import { BridgeError, HerdrEvent } from './bridge';
import { FocusTracker } from './focus';
import { GlLayoutConfig, layoutPaneIds, layoutShape, mirrorConfig, parseLayoutExport } from './layoutMapping';
import { hasAgent, paneLabel, SessionModel, Snapshot } from './sessions';
import { PaneFrame, PaneStreams, PaneViewer } from './streams';
import {
	HostMessage,
	makePaneKey,
	MirrorPanelState,
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
<button id="split-right">Split Right</button>
<button id="split-down">Split Down</button>
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
}

/** One editor tab mirroring one herdr tab. */
export class MirrorPanel implements PaneViewer {
	private readonly disposables: vscode.Disposable[] = [];
	private ready = false;
	private disposedFlag = false;
	/** What the webview should be showing: replayed when it says it is ready. */
	private view: { type: 'layout'; config: GlLayoutConfig } | { type: 'empty'; text: string } | undefined;
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
	private nextProbe = 0;
	private readonly probes = new Map<number, (result: Extract<WebviewMessage, { type: 'probeResult' }>) => void>();
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposeEmitter.event;

	constructor(
		readonly panel: vscode.WebviewPanel,
		readonly sessionKey: string,
		readonly tabId: string,
		private readonly deps: TilesDeps,
	) {
		panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'resources', 'herdr.svg');
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'webview')],
		};
		this.disposables.push(
			panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
			panel.onDidDispose(() => this.dispose()),
			deps.model.onDidChange(() => this.sync()),
			deps.model.onDidEvent((e) => {
				if (e.sessionKey === sessionKey) {
					this.onEvent(e.event);
				}
			}),
		);
		panel.webview.html = panelHtml(panel.webview, deps.extensionUri);
		this.sync();
	}

	/** Whether a tile of this panel shows `paneId`. */
	shows(paneId: string): boolean {
		return this.paneIds.has(paneId);
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

	sendFont(): void {
		this.post({ type: 'font', ...terminalFont() });
	}

	/** Test support: what the webview shows, optionally after a key press or click in a tile. */
	probe(action?: ProbeAction): Promise<{ tiles: TileProbe[]; breadcrumb: string; message: string }> {
		if (!this.ready) {
			return Promise.resolve({ tiles: [], breadcrumb: '', message: '' });
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

	private post(msg: HostMessage): void {
		if (this.ready && !this.disposedFlag) {
			void this.panel.webview.postMessage(msg);
		}
	}

	private get snapshot(): Snapshot | undefined {
		const conn = this.deps.model.connection(this.sessionKey);
		return conn?.state === 'connected' ? conn.snapshot : undefined;
	}

	private setView(view: NonNullable<MirrorPanel['view']>): void {
		this.view = view;
		this.post(view);
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

	/** Public for the opt-in live suite, which has no way to click a toolbar in a webview. */
	onMessage(msg: WebviewMessage): void {
		const streams = this.deps.streams;
		switch (msg.type) {
			case 'ready': {
				this.ready = true;
				const state: MirrorPanelState = { kind: 'mirror', sessionKey: this.sessionKey, tabId: this.tabId };
				this.post({ type: 'init', state });
				this.sendFont();
				if (this.view) {
					this.post(this.view);
				}
				const snapshot = this.snapshot;
				if (snapshot) {
					this.sendMeta(snapshot);
				}
				if (this.focusOnReady) {
					this.post({ type: 'focusTile', paneKey: makePaneKey(this.sessionKey, this.focusOnReady) });
					this.focusOnReady = undefined;
				}
				break;
			}
			case 'tileOpen':
				streams.open(msg.paneKey, this, msg.cols, msg.rows);
				break;
			case 'tileResize':
				streams.resize(msg.paneKey, this, msg.cols, msg.rows);
				break;
			case 'tileClose':
				streams.close(msg.paneKey, this);
				break;
			case 'input':
				streams.input(msg.paneKey, msg.text);
				break;
			case 'scroll':
				streams.scroll(msg.paneKey, msg.direction, msg.lines);
				break;
			case 'focus': {
				const { sessionKey, paneId } = splitPaneKey(msg.paneKey);
				this.focusedPane = paneId;
				streams.focus(msg.paneKey, this);
				this.deps.focus.set(sessionKey, paneId);
				break;
			}
			case 'split':
				void this.split(msg.direction);
				break;
			case 'closePane':
				void this.closePane(msg.paneKey);
				break;
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
		}
	}

	dispose(): void {
		if (this.disposedFlag) {
			return;
		}
		this.disposedFlag = true;
		clearTimeout(this.exportTimer);
		clearTimeout(this.connectTimer);
		this.deps.streams.closeAll(this);
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}
}

/** Every mirrored panel of the window. */
export class TilesPanels implements vscode.Disposable, vscode.WebviewPanelSerializer {
	private readonly panels = new Map<string, MirrorPanel>();
	private readonly config: vscode.Disposable;

	constructor(private readonly deps: TilesDeps) {
		this.config = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fontFamily') || e.affectsConfiguration('editor.fontSize')) {
				for (const panel of this.panels.values()) {
					panel.sendFont();
				}
			}
		});
	}

	private track(panel: vscode.WebviewPanel, sessionKey: string, tabId: string): MirrorPanel {
		const mirror = new MirrorPanel(panel, sessionKey, tabId, this.deps);
		const key = `${sessionKey}|${tabId}`;
		this.panels.set(key, mirror);
		mirror.onDidDispose(() => {
			if (this.panels.get(key) === mirror) {
				this.panels.delete(key);
			}
		});
		return mirror;
	}

	/** Reveals the panel showing (session, tab), else creates one in the active column. */
	openTab(sessionKey: string, tabId: string): MirrorPanel {
		const existing = this.panels.get(`${sessionKey}|${tabId}`);
		if (existing) {
			existing.reveal();
			return existing;
		}
		const snapshot = this.deps.model.connection(sessionKey)?.snapshot;
		const panel = vscode.window.createWebviewPanel(
			TILES_VIEW_TYPE,
			(snapshot && panelTitle(snapshot, tabId)) ?? 'herdr',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview')],
			},
		);
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

	/** Reveals the tile showing a pane; with none, opens the pane's tab. */
	revealPane(sessionKey: string, paneId: string): void {
		for (const panel of this.panels.values()) {
			if (panel.sessionKey === sessionKey && panel.shows(paneId)) {
				panel.reveal(paneId);
				return;
			}
		}
		this.openPaneTab(sessionKey, paneId);
	}

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
		const s = state as Partial<MirrorPanelState> | undefined;
		if (s?.kind !== 'mirror' || !s.sessionKey || !s.tabId) {
			panel.dispose();
			return;
		}
		this.track(panel, s.sessionKey, s.tabId);
	}

	dispose(): void {
		this.config.dispose();
		for (const panel of [...this.panels.values()]) {
			panel.dispose();
		}
	}
}
