import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ComponentContainer, ComponentItem, GoldenLayout, JsonValue, LayoutConfig, ResolvedLayoutConfig, Stack } from 'golden-layout';
import 'golden-layout/dist/css/goldenlayout-base.css';
import '@xterm/xterm/css/xterm.css';
import './tiles.css';
import { componentStates, PaneComponentState, StoredLayoutConfig } from '../layoutMapping';
import { addPaneAtRoot, addPlacement, layoutPaneKeys, rewritePane } from '../layouts';
import { HostMessage, makePaneKey, PanelState, ProbeAction, TileMeta, TileProbe, TileStreamState, WebviewMessage } from '../tilesProtocol';
import { createWheelAccumulator, wrapPaste } from './input';

/**
 * The `herdr.tiles` webview: a toolbar, and a Golden Layout area of xterm tiles,
 * mirroring a herdr tab or holding a saved layout (`init` says which, as a class
 * on <body>). herdr's frames are complete screen paints with no terminal modes in them, so
 * each xterm is a plain screen painter: no scrollback (herdr owns it, and the
 * wheel scrolls it), and input goes out as typed.
 */

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage) => vscode.postMessage(msg);

const RESIZE_DEBOUNCE_MS = 100;
/** A Layout panel's Golden Layout config goes to the host this long after it last changed. */
const SAVE_DEBOUNCE_MS = 500;
/** Below this a tile is hidden or being laid out, not really that small. */
const MIN_FIT_PX = 20;

interface Tile {
	paneKey: string;
	serial: number;
	/** Moved into each new Golden Layout component: `loadLayout` destroys those, not this. */
	host: HTMLElement;
	termEl: HTMLElement;
	overlay: HTMLElement;
	term: Terminal;
	fit: FitAddon;
	/** The size last sent; undefined until the tile has been announced with `tileOpen`. */
	reported: { cols: number; rows: number } | undefined;
	resizeTimer: ReturnType<typeof setTimeout> | undefined;
	observer: ResizeObserver;
}

const tiles = new Map<string, Tile>();
const containers = new Map<string, ComponentContainer>();
const tabs = new Map<string, HTMLElement>();
const metas = new Map<string, TileMeta>();
let focusedKey: string | undefined;
let pendingFocus: string | undefined;
let nextSerial = 0;
let font: { fontFamily: string; fontSize: number } | undefined;
let kind: PanelState['kind'] | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const breadcrumbEl = document.getElementById('breadcrumb') as HTMLElement;
const messageEl = document.getElementById('message') as HTMLElement;
const rootEl = document.getElementById('tiles') as HTMLElement;

// ── Theme ───────────────────────────────────────────────────────────────────

function cssVar(...names: string[]): string | undefined {
	const style = getComputedStyle(document.documentElement);
	for (const name of names) {
		const value = style.getPropertyValue(name).trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function terminalTheme() {
	const background = cssVar('--vscode-terminal-background', '--vscode-panel-background', '--vscode-editor-background');
	const foreground = cssVar('--vscode-terminal-foreground', '--vscode-editor-foreground');
	return {
		background,
		foreground,
		cursor: cssVar('--vscode-terminalCursor-foreground') ?? foreground,
		selectionBackground: cssVar('--vscode-terminal-selectionBackground', '--vscode-editor-selectionBackground'),
	};
}

// VS Code changes the variables on <html> when the color theme changes.
new MutationObserver(() => {
	const theme = terminalTheme();
	for (const tile of tiles.values()) {
		tile.term.options.theme = theme;
	}
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// ── Tiles ───────────────────────────────────────────────────────────────────

const IS_MAC = /Mac/.test(navigator.platform);

function createTile(paneKey: string): Tile {
	const termEl = document.createElement('div');
	termEl.className = 'tile-term';
	const overlay = document.createElement('div');
	overlay.className = 'tile-overlay';
	overlay.hidden = true;
	const host = document.createElement('div');
	host.className = 'tile-host';
	host.dataset.paneKey = paneKey;
	host.append(termEl, overlay);

	const term = new Terminal({
		scrollback: 0,
		cursorBlink: false,
		allowProposedApi: false,
		fontFamily: font?.fontFamily,
		fontSize: font?.fontSize,
		theme: terminalTheme(),
	});
	const fit = new FitAddon();
	term.loadAddon(fit);

	const tile: Tile = {
		paneKey,
		serial: ++nextSerial,
		host,
		termEl,
		overlay,
		term,
		fit,
		reported: undefined,
		resizeTimer: undefined,
		observer: new ResizeObserver(() => {
			clearTimeout(tile.resizeTimer);
			tile.resizeTimer = setTimeout(() => fitTile(tile), RESIZE_DEBOUNCE_MS);
		}),
	};
	tile.observer.observe(host);

	term.onData((text) => post({ type: 'input', paneKey, text }));

	const wheelToScroll = createWheelAccumulator();
	term.attachCustomWheelEventHandler((ev) => {
		ev.preventDefault();
		const screen = termEl.querySelector('.xterm-screen');
		const cellHeight = screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0;
		const scroll = wheelToScroll(ev.deltaY, cellHeight, ev.deltaMode);
		if (scroll) {
			post({ type: 'scroll', paneKey, ...scroll });
		}
		return false;
	});

	// Paste is intercepted before xterm sees it: a multi-line paste goes as one bracketed input.
	host.addEventListener(
		'paste',
		(ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const text = ev.clipboardData?.getData('text/plain');
			if (text) {
				post({ type: 'input', paneKey, text: wrapPaste(text) });
			}
		},
		true,
	);

	// Ctrl+Shift+C/V off the Mac, where plain Ctrl+C/V belong to the app. VS Code keeps the browser
	// from pasting by itself, and has other uses for the keys, so they end here.
	term.attachCustomKeyEventHandler((ev) => {
		if (IS_MAC || !ev.ctrlKey || !ev.shiftKey || ev.altKey || (ev.code !== 'KeyC' && ev.code !== 'KeyV')) {
			return true;
		}
		if (ev.type === 'keydown') {
			if (ev.code === 'KeyV') {
				post({ type: 'clipboardPaste', paneKey });
			} else if (term.hasSelection()) {
				post({ type: 'clipboardCopy', text: term.getSelection() });
			}
		}
		ev.preventDefault();
		ev.stopPropagation();
		return false;
	});

	tiles.set(paneKey, tile);
	return tile;
}

/** Fits a tile to its element and tells the host; the first time, that opens its stream. */
function fitTile(tile: Tile): void {
	// While dragged, a tile is in Golden Layout's small proxy: the pane keeps its size until the drop.
	if (!tile.term.element || isDragging()) {
		return;
	}
	const box = tile.host.getBoundingClientRect();
	if (box.width < MIN_FIT_PX || box.height < MIN_FIT_PX) {
		return;
	}
	const dims = tile.fit.proposeDimensions();
	if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
		return;
	}
	const cols = Math.max(2, dims.cols);
	const rows = Math.max(1, dims.rows);
	if (cols !== tile.term.cols || rows !== tile.term.rows) {
		tile.term.resize(cols, rows);
	}
	if (!tile.reported) {
		tile.reported = { cols, rows };
		post({ type: 'tileOpen', paneKey: tile.paneKey, cols, rows });
	} else if (tile.reported.cols !== cols || tile.reported.rows !== rows) {
		tile.reported = { cols, rows };
		post({ type: 'tileResize', paneKey: tile.paneKey, cols, rows });
	}
}

function disposeTile(tile: Tile): void {
	clearTimeout(tile.resizeTimer);
	tile.observer.disconnect();
	tile.term.dispose();
	tile.host.remove();
	tiles.delete(tile.paneKey);
	containers.delete(tile.paneKey);
	tabs.delete(tile.paneKey);
	if (tile.reported) {
		post({ type: 'tileClose', paneKey: tile.paneKey });
	}
	if (focusedKey === tile.paneKey) {
		focusedKey = undefined;
	}
}

function setFocused(paneKey: string): void {
	focusedKey = paneKey;
	for (const tile of tiles.values()) {
		tile.host.classList.toggle('tile-focused', tile.paneKey === paneKey);
	}
	post({ type: 'focus', paneKey });
}

/** First paint of a tile whose element is now in the document, then a fit. */
function settleTile(tile: Tile): void {
	if (!tile.term.element) {
		tile.term.open(tile.termEl);
		tile.term.textarea?.addEventListener('focus', () => setFocused(tile.paneKey));
	}
	fitTile(tile);
	// Re-parenting leaves the renderer's rows as they were; repaint them.
	tile.term.refresh(0, tile.term.rows - 1);
}

function focusTile(paneKey: string): void {
	const tile = tiles.get(paneKey);
	if (tile?.term.element) {
		pendingFocus = undefined;
		// A tile behind another tab in its stack comes to the front first.
		const item = containers.get(paneKey)?.parent;
		const stack = item?.parentItem;
		if (item && stack instanceof Stack && stack.getActiveComponentItem() !== item) {
			stack.setActiveComponentItem(item, false);
		}
		tile.term.focus();
	} else {
		pendingFocus = paneKey;
	}
}

function showStreamState(paneKey: string, state: TileStreamState): void {
	const tile = tiles.get(paneKey);
	if (!tile) {
		return;
	}
	tile.overlay.replaceChildren();
	tile.overlay.hidden = state.kind === 'live';
	if (state.kind === 'live') {
		return;
	}
	const text = document.createElement('div');
	const action = (label: string, run: () => void) => {
		const button = document.createElement('button');
		button.textContent = label;
		button.addEventListener('click', run);
		tile.overlay.append(text, button);
	};
	switch (state.kind) {
		case 'takenOver':
			text.textContent = 'Opened in another viewer.';
			action('Reconnect', () => post({ type: 'reconnect', paneKey }));
			break;
		case 'ended':
			text.textContent = `Disconnected: ${state.reason}.`;
			action('Reconnect', () => post({ type: 'reconnect', paneKey }));
			break;
		case 'waiting':
			text.textContent = `Waiting for ${state.label}…`;
			tile.overlay.append(text);
			tile.term.reset();
			break;
		case 'gone':
			text.textContent = 'This pane is gone.';
			action('Remove', () => containers.get(paneKey)?.close());
			tile.term.reset();
			break;
	}
}

function showFrame(msg: Extract<HostMessage, { type: 'frame' }>): void {
	const tile = tiles.get(msg.paneKey);
	if (!tile?.term.element) {
		return;
	}
	// A tile that is not the pane's size owner shows the size the pane really has.
	if (msg.cols > 0 && msg.rows > 0 && (msg.cols !== tile.term.cols || msg.rows !== tile.term.rows)) {
		tile.term.resize(msg.cols, msg.rows);
	}
	if (msg.full) {
		tile.term.reset();
	}
	const binary = atob(msg.bytes);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	tile.term.write(bytes);
}

// ── Golden Layout ───────────────────────────────────────────────────────────

const layout = new GoldenLayout(rootEl);
layout.resizeWithContainerAutomatically = true;

layout.registerComponentFactoryFunction('pane', (container: ComponentContainer, state: JsonValue | undefined) => {
	const { sessionKey, paneId } = state as unknown as PaneComponentState;
	const paneKey = makePaneKey(sessionKey, paneId);
	// One Terminal per pane in a panel: `loadLayout` destroyed the component, not the tile.
	const tile = tiles.get(paneKey) ?? createTile(paneKey);
	container.element.append(tile.host);
	containers.set(paneKey, container);
	return undefined;
});

layout.on('tabCreated', (tab) => {
	const state = tab.componentItem.container.state as unknown as PaneComponentState | undefined;
	if (!state) {
		return;
	}
	const paneKey = makePaneKey(state.sessionKey, state.paneId);
	tabs.set(paneKey, tab.element);
	applyTileMeta(paneKey);
});

/** Whether a tile is being dragged. Golden Layout then has it out of the tree, which is not a close. */
function isDragging(): boolean {
	return document.querySelector('.lm_dragProxy') !== null;
}

/** The pane a Golden Layout header or close control belongs to: a tab's, else its stack's visible tile. */
function paneKeyAt(target: Element): string | undefined {
	const tab = target.closest('.lm_tab');
	if (tab) {
		for (const [paneKey, element] of tabs) {
			if (element === tab) {
				return paneKey;
			}
		}
	}
	const hosts = [...(target.closest('.lm_stack')?.querySelectorAll<HTMLElement>('.tile-host') ?? [])];
	return (hosts.find((host) => host.offsetParent !== null) ?? hosts[0])?.dataset.paneKey;
}

// In a mirrored tab close goes to herdr: Golden Layout's own handlers must not run, or the tile would
// go before the user has answered. The layout changes when herdr says so. Capture phase, so this
// comes first. In a Layout tab Golden Layout's close is what it should be: the tile leaves the layout.
function interceptClose(ev: Event): void {
	const target = ev.target as Element;
	if (kind === 'layout' || !target.closest('.lm_close, .lm_close_tab')) {
		return;
	}
	ev.stopPropagation();
	const paneKey = paneKeyAt(target);
	if (paneKey && ev.type === 'click') {
		post({ type: 'closePane', paneKey });
	}
}
rootEl.addEventListener('click', interceptClose, true);
rootEl.addEventListener('touchstart', interceptClose, { capture: true, passive: true });
rootEl.addEventListener(
	'mousedown',
	(ev) => {
		const target = ev.target as Element;
		if (!target.closest('.lm_header')) {
			return;
		}
		// Middle click on a tab is Golden Layout's close: in a mirrored tab, not without asking.
		if (ev.button === 1 && kind !== 'layout') {
			ev.stopPropagation();
			return;
		}
		// A click on a tile's header focuses the tile, once the click is over.
		const paneKey = paneKeyAt(target);
		if (paneKey && !target.closest('.lm_controls, .lm_close_tab')) {
			setTimeout(() => focusTile(paneKey));
		}
	},
	true,
);

function applyLayout(config: StoredLayoutConfig | LayoutConfig): void {
	messageEl.hidden = true;
	rootEl.hidden = false;
	const focused = focusedKey ? tiles.get(focusedKey) : undefined;
	const hadFocus = focused?.term.textarea !== undefined && focused.term.textarea === document.activeElement;
	containers.clear();
	tabs.clear();
	const stored = config as StoredLayoutConfig;
	layout.loadLayout(stored.resolved ? LayoutConfig.fromResolved(config as unknown as ResolvedLayoutConfig) : (config as unknown as LayoutConfig));
	const wanted = new Set(stored.root ? componentStates(stored.root).map((s) => makePaneKey(s.sessionKey, s.paneId)) : []);
	for (const tile of [...tiles.values()]) {
		if (!wanted.has(tile.paneKey)) {
			disposeTile(tile);
		}
	}
	for (const tile of tiles.values()) {
		settleTile(tile);
	}
	for (const paneKey of wanted) {
		applyTileMeta(paneKey);
	}
	if (pendingFocus) {
		focusTile(pendingFocus);
	} else if (hadFocus && focusedKey) {
		// Re-parenting the terminal drops the keyboard focus; typing must not notice a re-layout.
		focusTile(focusedKey);
	}
}

// ── Layout tabs ─────────────────────────────────────────────────────────────

/** The stack holding the panel's focused tile. */
function focusedStack(): Stack | undefined {
	const item: ComponentItem | undefined = focusedKey ? containers.get(focusedKey)?.parent : undefined;
	const stack = item?.parentItem;
	return stack instanceof Stack ? stack : undefined;
}

/** Adds a pane in the focused stack, else in a new stack on the right; a pane already here is only focused. */
function addOrReveal(msg: Extract<HostMessage, { type: 'addTile' }>): void {
	const state: PaneComponentState = { sessionKey: msg.sessionKey, paneId: msg.paneId };
	const paneKey = makePaneKey(msg.sessionKey, msg.paneId);
	const stack = focusedStack();
	const placement = addPlacement(layout.saveLayout() as unknown as StoredLayoutConfig, state, stack !== undefined);
	if (placement === 'focusedStack' && stack) {
		stack.addComponent('pane', state as unknown as JsonValue, msg.title);
		const tile = tiles.get(paneKey);
		if (tile) {
			settleTile(tile);
		}
	} else if (placement === 'root') {
		const current = LayoutConfig.fromResolved(layout.saveLayout());
		applyLayout(addPaneAtRoot(current as unknown as StoredLayoutConfig, state, msg.title));
	}
	focusTile(paneKey);
	// The webview may not have the keyboard yet, so xterm's focus event may not come.
	setFocused(paneKey);
}

/** A pane got a new id: the tile follows, on a new stream, and the old stream is released. */
function movePane(msg: Extract<HostMessage, { type: 'paneMoved' }>): void {
	if (isDragging()) {
		setTimeout(() => movePane(msg), 200);
		return;
	}
	const from = makePaneKey(msg.sessionKey, msg.from);
	const current = LayoutConfig.fromResolved(layout.saveLayout()) as unknown as StoredLayoutConfig;
	const moved = rewritePane(current, msg.sessionKey, msg.from, msg.to);
	if (moved === current) {
		return;
	}
	const wasFocused = focusedKey === from;
	applyLayout(moved);
	if (wasFocused) {
		focusTile(makePaneKey(msg.sessionKey, msg.to));
		setFocused(makePaneKey(msg.sessionKey, msg.to));
	}
}

function saveNow(): void {
	saveTimer = undefined;
	post({ type: 'layoutChanged', config: layout.saveLayout() as unknown as StoredLayoutConfig });
}

// Golden Layout throttles this to an animation frame, so a drag's proxy is in the document by the
// time its first `stateChanged` arrives; the drop sends another.
function onLayoutChanged(): void {
	if (kind !== 'layout' || isDragging()) {
		return;
	}
	const wanted = new Set(layoutPaneKeys(layout.saveLayout() as unknown as StoredLayoutConfig));
	document.body.classList.toggle('layout-empty', wanted.size === 0);
	// A tile closed in Golden Layout: its pane stays in herdr, only the terminal and stream go.
	for (const tile of [...tiles.values()]) {
		if (!wanted.has(tile.paneKey)) {
			disposeTile(tile);
		}
	}
	clearTimeout(saveTimer);
	saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}
layout.on('stateChanged', onLayoutChanged);
// Closing the only stack changes state without saying so: only the destroyed item tells.
layout.on('itemDestroyed', () => setTimeout(onLayoutChanged));

// The panel closing or the window reloading must not lose the last half second.
window.addEventListener('pagehide', () => {
	if (saveTimer !== undefined) {
		clearTimeout(saveTimer);
		saveNow();
	}
});

function showEmpty(text: string): void {
	for (const tile of [...tiles.values()]) {
		disposeTile(tile);
	}
	containers.clear();
	tabs.clear();
	layout.clear();
	rootEl.hidden = true;
	messageEl.textContent = text;
	messageEl.hidden = false;
}

// ── Tile headers ────────────────────────────────────────────────────────────

/** The tab's status dot and faded detail, kept beside Golden Layout's own title element. */
function applyTileMeta(paneKey: string): void {
	const meta = metas.get(paneKey);
	const tab = tabs.get(paneKey);
	if (!meta) {
		return;
	}
	const container = containers.get(paneKey);
	if (container && container.title !== meta.label) {
		container.setTitle(meta.label);
	}
	if (!tab) {
		return;
	}
	let dot = tab.querySelector<HTMLElement>('.tile-dot');
	if (!dot) {
		dot = document.createElement('span');
		tab.prepend(dot);
	}
	dot.className = `tile-dot tile-dot-${meta.status}`;
	let detail = tab.querySelector<HTMLElement>('.tile-detail');
	if (!detail) {
		detail = document.createElement('span');
		detail.className = 'tile-detail';
		tab.querySelector('.lm_title')?.after(detail);
	}
	detail.textContent = meta.detail ?? '';
	detail.hidden = !meta.detail;
}

// ── Messages ────────────────────────────────────────────────────────────────

function probeTile(tile: Tile): TileProbe {
	const buffer = tile.term.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < buffer.length; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
	}
	const box = tile.host.getBoundingClientRect();
	return {
		paneKey: tile.paneKey,
		serial: tile.serial,
		text: lines.join('\n').trimEnd(),
		cols: tile.term.cols,
		rows: tile.term.rows,
		width: Math.round(box.width),
		height: Math.round(box.height),
		x: Math.round(box.x),
		y: Math.round(box.y),
		title: tabs.get(tile.paneKey)?.textContent ?? '',
		overlay: tile.overlay.hidden ? '' : (tile.overlay.textContent ?? ''),
	};
}

function runProbeAction(action: ProbeAction): void {
	const tile = tiles.get(action.paneKey);
	if (action.kind === 'press') {
		const init = { key: action.key, keyCode: action.keyCode, bubbles: true, cancelable: true } as KeyboardEventInit;
		tile?.term.textarea?.dispatchEvent(new KeyboardEvent('keydown', init));
	} else if (action.kind === 'clickClose') {
		tile?.host.closest('.lm_stack')?.querySelector<HTMLElement>('.lm_controls .lm_close')?.click();
	} else if (action.kind === 'clickTabClose') {
		tabs.get(action.paneKey)?.querySelector<HTMLElement>('.lm_close_tab')?.click();
	} else if (action.kind === 'clickRemove') {
		tile?.overlay.querySelector('button')?.click();
	} else {
		dragToRightEdge(action.paneKey);
	}
}

function dragToRightEdge(paneKey: string): void {
	const tab = tabs.get(paneKey);
	if (!tab) {
		return;
	}
	const start = tab.getBoundingClientRect();
	const area = rootEl.getBoundingClientRect();
	const pointer = (type: string, target: EventTarget, x: number, y: number) =>
		target.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }));
	const [x, y] = [start.x + 5, start.y + 5];
	const [endX, endY] = [area.right - 5, area.y + area.height / 2];
	pointer('pointerdown', tab, x, y);
	pointer('pointermove', document, x + 15, y + 15);
	pointer('pointermove', document, endX, endY);
	pointer('pointerup', document, endX, endY);
}

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
	const msg = ev.data;
	switch (msg.type) {
		case 'init':
			kind = msg.state.kind;
			document.body.classList.add(`kind-${kind}`);
			vscode.setState(msg.state);
			break;
		case 'font':
			font = { fontFamily: msg.fontFamily, fontSize: msg.fontSize };
			for (const tile of tiles.values()) {
				tile.term.options.fontFamily = msg.fontFamily;
				tile.term.options.fontSize = msg.fontSize;
				fitTile(tile);
			}
			break;
		case 'layout':
			applyLayout(msg.config);
			document.body.classList.toggle('layout-empty', kind === 'layout' && !msg.config.root);
			break;
		case 'addTile':
			addOrReveal(msg);
			break;
		case 'paneMoved':
			movePane(msg);
			break;
		case 'empty':
			showEmpty(msg.text);
			break;
		case 'meta':
			breadcrumbEl.textContent = msg.breadcrumb;
			metas.clear();
			for (const meta of msg.tiles) {
				metas.set(meta.paneKey, meta);
				applyTileMeta(meta.paneKey);
			}
			break;
		case 'frame':
			showFrame(msg);
			break;
		case 'tileState':
			showStreamState(msg.paneKey, msg.state);
			break;
		case 'focusTile':
			focusTile(msg.paneKey);
			break;
		case 'probe':
			if (msg.action) {
				runProbeAction(msg.action);
			}
			post({
				type: 'probeResult',
				id: msg.id,
				tiles: [...tiles.values()].map(probeTile),
				breadcrumb: breadcrumbEl.textContent ?? '',
				message: messageEl.hidden ? '' : (messageEl.textContent ?? ''),
				config: layout.saveLayout() as unknown as StoredLayoutConfig,
			});
			break;
	}
});

for (const [id, direction] of [
	['split-right', 'right'],
	['split-down', 'down'],
] as const) {
	const button = document.getElementById(id) as HTMLElement;
	// Keeps the keyboard focus in the tile.
	button.addEventListener('mousedown', (ev) => ev.preventDefault());
	button.addEventListener('click', () => post({ type: 'split', direction }));
}

for (const [id, send] of [
	['copy-layout', () => layout.rootItem && post({ type: 'copyAsLayout', config: layout.saveLayout() as unknown as StoredLayoutConfig })],
	['rename-layout', () => post({ type: 'renameLayout' })],
] as const) {
	const button = document.getElementById(id) as HTMLElement;
	button.addEventListener('mousedown', (ev) => ev.preventDefault());
	button.addEventListener('click', () => send());
}

post({ type: 'ready' });
