import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ComponentContainer, ComponentItem, ContentItem, GoldenLayout, JsonValue, LayoutConfig, ResolvedLayoutConfig, Stack } from 'golden-layout';
import 'golden-layout/dist/css/goldenlayout-base.css';
import '@xterm/xterm/css/xterm.css';
import './tiles.css';
import { componentStates, PaneComponentState, SPLIT_ID_PREFIX, StoredLayoutConfig } from '../layoutMapping';
import { changedRatios, dropZone, DropZone, offeredZone, sameRatio } from '../mirrorEdit';
import { HostMessage, makePaneKey, ProbeAction, StripTab, TileMeta, TileProbe, TileStreamState, WebviewMessage } from '../tilesProtocol';
import { createWheelAccumulator, wrapPaste } from './input';
import { findPathLinks } from './links';

/**
 * The `herdr.tiles` webview: a tab strip of the space's herdr tabs, and a Golden
 * Layout area of xterm tiles mirroring the shown tab. herdr's frames are complete screen paints with no terminal modes in them, so
 * each xterm is a plain screen painter: no scrollback (herdr owns it, and the
 * wheel scrolls it), and input goes out as typed.
 */

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const post = (msg: WebviewMessage) => vscode.postMessage(msg);

const RESIZE_DEBOUNCE_MS = 100;
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
/** Whether {@link pendingFocus} came from the host. */
let pendingAnnounce = false;
let nextSerial = 0;
let font: { fontFamily: string; fontSize: number } | undefined;

const messageEl = document.getElementById('message') as HTMLElement;
const stripEl = document.getElementById('strip') as HTMLElement;
const toolbarEl = document.getElementById('toolbar') as HTMLElement;
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
	setMenuContext(host, paneKey);

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

	term.registerLinkProvider({
		provideLinks(y, callback) {
			const line = term.buffer.active.getLine(y - 1);
			if (!line) {
				callback(undefined);
				return;
			}
			// Text and, per UTF-16 unit of it, its cell: a wide character takes two cells and one unit.
			let text = '';
			const cells: number[] = [];
			for (let x = 0; x < line.length; x++) {
				const cell = line.getCell(x);
				if (cell && cell.getWidth() === 0) {
					continue;
				}
				const chars = cell?.getChars() || ' ';
				text += chars;
				cells.push(...Array.from({ length: chars.length }, () => x));
			}
			const links = findPathLinks(text).map((link) => ({
				text: link.text,
				range: {
					start: { x: cells[link.start] + 1, y },
					end: { x: cells[link.start + link.text.length - 1] + 1, y },
				},
				activate: () => post({ type: 'openLink', paneKey, text: link.text }),
			}));
			callback(links.length ? links : undefined);
		},
	});

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

/**
 * A tile's right-click menu (`webview/context` in package.json): VS Code reads
 * `data-vscode-context` up from the clicked element. `zoomed` picks Zoom or Unzoom.
 */
function setMenuContext(el: HTMLElement, paneKey: string): void {
	el.dataset.vscodeContext = JSON.stringify({
		webviewSection: 'tile',
		paneKey,
		zoomed: appliedZoom === paneKey,
		preventDefaultContextMenuItems: true,
	});
}

function updateMenuContexts(): void {
	for (const tile of tiles.values()) {
		setMenuContext(tile.host, tile.paneKey);
	}
	for (const [paneKey, tab] of tabs) {
		setMenuContext(tab, paneKey);
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

/** `announce`: the host asked, so the panel's focused tile changes even if the keyboard stays elsewhere. */
function focusTile(paneKey: string, announce = false): void {
	const tile = tiles.get(paneKey);
	if (tile?.term.element) {
		const wanted = pendingFocus === paneKey && pendingAnnounce;
		pendingFocus = undefined;
		pendingAnnounce = false;
		// A tile behind another tab in its stack comes to the front first.
		const item = containers.get(paneKey)?.parent;
		const stack = item?.parentItem;
		if (item && stack instanceof Stack && stack.getActiveComponentItem() !== item) {
			stack.setActiveComponentItem(item, false);
		}
		tile.term.focus();
		if (announce || wanted) {
			setFocused(paneKey);
		}
	} else {
		pendingFocus = paneKey;
		pendingAnnounce = announce;
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
	setMenuContext(tab.element, paneKey);
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

// Close goes to herdr: Golden Layout's own handlers must not run, or the tile would go before the
// user has answered. The layout changes when herdr says so. Capture phase, so this comes first.
function interceptClose(ev: Event): void {
	const target = ev.target as Element;
	if (!target.closest('.lm_close, .lm_close_tab')) {
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
		// Middle click on a tab is Golden Layout's close: not without asking.
		if (ev.button === 1) {
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
	updateMenuContexts();
	if (pendingFocus) {
		focusTile(pendingFocus);
	} else if (hadFocus && focusedKey) {
		// Re-parenting the terminal drops the keyboard focus; typing must not notice a re-layout.
		focusTile(focusedKey);
	}
}

/** Every stack in the layout, in tree order. */
function allStacks(item: ContentItem | undefined = layout.rootItem): Stack[] {
	if (!item) {
		return [];
	}
	return item instanceof Stack ? [item] : item.contentItems.flatMap((child) => allStacks(child));
}

// Golden Layout throttles this to an animation frame, so a drag's proxy is in the document by the
// time its first `stateChanged` arrives; the drop sends another.
layout.on('stateChanged', () => onMirrorStateChanged());

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

// ── Editing herdr's layout ───────────────────────────────────

/** A Golden Layout row or column, with the members its `.d.ts` leaves out. */
type SplitItem = ContentItem & { updateSize(force: boolean): void };
type SizedItem = ContentItem & { size: number };

/** The ratios the webview last applied or reported, by path key: a splitter drag reports only what differs. */
let appliedRatios: Record<string, number> = {};
/** herdr's zoom as applied here (a tile's pane key, or null): maximising reports only a change. */
let appliedZoom: string | null = null;
/** {@link applyZoom} is changing Golden Layout's maximised stack. */
let applyingZoom = false;
/** A splitter is pressed. */
let splitterDown = false;
/** Set from a splitter's release until the `stateChanged` that applies its sizes (or a second). */
let splitterReleased: ReturnType<typeof setTimeout> | undefined;
/** herdr's ratios that came in during a drag: applied once it is over. */
let pendingRatios: Record<string, number> = {};
const SPLITTER_REPORT_MS = 150;
const MIRROR_HEADER_HEIGHT = 26;
const MIRROR_DRAG_START_PX = 10;

/** Every `split:` item of the live layout, by path key. */
function splitItems(item: ContentItem | undefined = layout.rootItem, out = new Map<string, SplitItem>()): Map<string, SplitItem> {
	if (!item) {
		return out;
	}
	if (item.id?.startsWith(SPLIT_ID_PREFIX) && item.contentItems.length === 2) {
		out.set(item.id.slice(SPLIT_ID_PREFIX.length), item as SplitItem);
	}
	for (const child of item.contentItems) {
		splitItems(child, out);
	}
	return out;
}

function itemRatio(item: ContentItem): number {
	const [a, b] = item.contentItems.map((c) => (c as SizedItem).size);
	return a + b > 0 ? a / (a + b) : 0.5;
}

/** The live Golden Layout ratios, by path key. */
function liveRatios(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, item] of splitItems()) {
		out[key] = itemRatio(item);
	}
	return out;
}

/** Whether a drag is running: Golden Layout's (splitter), or our own tile drag. */
function mirrorBusy(): boolean {
	return document.body.classList.contains('lm_dragging') || splitterDown || mirrorDrag?.active === true;
}

/** Sets splits to herdr's ratios in place: no `loadLayout`, so terminals, focus and screens stay. */
function applyRatios(ratios: Record<string, number>): void {
	const items = splitItems();
	for (const [key, ratio] of Object.entries(ratios)) {
		const item = items.get(key);
		if (!item) {
			continue;
		}
		appliedRatios[key] = ratio;
		if (sameRatio(itemRatio(item), ratio)) {
			continue;
		}
		const [first, second] = item.contentItems as SizedItem[];
		first.size = ratio * 100;
		second.size = (1 - ratio) * 100;
		item.updateSize(false);
	}
}

function receiveRatios(ratios: Record<string, number>): void {
	if (mirrorBusy()) {
		pendingRatios = { ...pendingRatios, ...ratios };
	} else {
		applyRatios(ratios);
	}
}

function flushPendingRatios(): void {
	if (mirrorBusy() || Object.keys(pendingRatios).length === 0) {
		return;
	}
	const ratios = pendingRatios;
	pendingRatios = {};
	applyRatios(ratios);
}

/** herdr's zoom: that pane's stack maximised, or none. Recorded first, so the `stateChanged` posts nothing. */
function applyZoom(paneKey: string | null): void {
	appliedZoom = paneKey;
	updateMenuContexts();
	const item = paneKey === null ? undefined : containers.get(paneKey)?.parent.parentItem;
	const stack = item instanceof Stack ? item : undefined;
	if (stack?.isMaximised) {
		return;
	}
	// Moving the maximise minimises first, with a `stateChanged` of its own: not a change to report.
	applyingZoom = true;
	try {
		layout.maximisedStack?.minimise();
		stack?.maximise();
	} finally {
		applyingZoom = false;
	}
}

function onMirrorStateChanged(): void {
	if (applyingZoom) {
		return;
	}
	const max = layout.maximisedStack;
	const zoom = max ? (paneKeyAt(max.element) ?? null) : null;
	if (zoom !== appliedZoom) {
		appliedZoom = zoom;
		updateMenuContexts();
		post({ type: 'setZoom', paneKey: zoom });
	}
	if (splitterReleased === undefined) {
		return;
	}
	clearTimeout(splitterReleased);
	splitterReleased = undefined;
	const changed = changedRatios(appliedRatios, liveRatios());
	if (Object.keys(changed).length === 0) {
		return;
	}
	appliedRatios = { ...appliedRatios, ...changed };
	setTimeout(() => post({ type: 'setRatios', ratios: changed }), SPLITTER_REPORT_MS);
}

window.addEventListener(
	'pointerdown',
	(ev) => {
		if (ev.button === 0 && (ev.target as Element | null)?.closest?.('.lm_splitter')) {
			splitterDown = true;
		}
	},
	true,
);
window.addEventListener(
	'pointerup',
	() => {
		if (!splitterDown) {
			return;
		}
		splitterDown = false;
		// Golden Layout sets the sizes an animation frame after its drag stops; that `stateChanged` reports them.
		clearTimeout(splitterReleased);
		splitterReleased = setTimeout(() => (splitterReleased = undefined), 1000);
		setTimeout(flushPendingRatios, 100);
	},
	true,
);

/** Our own tile drag: Golden Layout's would build stacks herdr cannot hold. */
let mirrorDrag:
	| { paneKey: string; x: number; y: number; active: boolean; ghost?: HTMLElement; indicator?: HTMLElement; stripTarget?: HTMLElement }
	| undefined;

/**
 * The strip entry (another tab's) or + under a point, with the tab it stands
 * for (null: a new tab). The shown tab's own entry is no target. The toolbar's
 * blank area right of the + counts as the +.
 */
function stripDropTarget(x: number, y: number): { el: HTMLElement; tabId: string | null } | undefined {
	const add = document.getElementById('strip-new');
	const bar = toolbarEl.getBoundingClientRect();
	if (add && y >= bar.top && y < bar.bottom && x >= add.getBoundingClientRect().left && x < bar.right) {
		return { el: add, tabId: null };
	}
	const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.strip-tab, #strip-new');
	if (!el || !stripEl.contains(el)) {
		return undefined;
	}
	if (el.id === 'strip-new') {
		return { el, tabId: null };
	}
	return el.dataset.tabId && !el.classList.contains('strip-active') ? { el, tabId: el.dataset.tabId } : undefined;
}

/** The tile under a point, other than the dragged one, with its stack's rectangle. */
function mirrorDropTarget(x: number, y: number, dragged: string): { paneKey: string; rect: DOMRect } | undefined {
	for (const stack of allStacks()) {
		const rect = stack.element.getBoundingClientRect();
		if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
			continue;
		}
		const paneKey = paneKeyAt(stack.element);
		return paneKey && paneKey !== dragged ? { paneKey, rect } : undefined;
	}
	return undefined;
}

function mirrorZone(target: { rect: DOMRect }, x: number, y: number): DropZone {
	return offeredZone(dropZone(target.rect, MIRROR_HEADER_HEIGHT, x, y));
}

function startMirrorDrag(drag: NonNullable<typeof mirrorDrag>): void {
	drag.active = true;
	document.body.classList.add('mirror-moving');
	const ghost = document.createElement('div');
	ghost.className = 'mirror-ghost';
	ghost.textContent = containers.get(drag.paneKey)?.title ?? '';
	const indicator = document.createElement('div');
	indicator.className = 'mirror-drop-indicator';
	indicator.hidden = true;
	document.body.append(ghost, indicator);
	drag.ghost = ghost;
	drag.indicator = indicator;
}

function endMirrorDrag(): void {
	const wasActive = mirrorDrag?.active;
	mirrorDrag?.stripTarget?.classList.remove('strip-drop');
	mirrorDrag?.ghost?.remove();
	mirrorDrag?.indicator?.remove();
	mirrorDrag = undefined;
	document.body.classList.remove('mirror-moving');
	if (wasActive) {
		setTimeout(flushPendingRatios);
	}
}

function moveMirrorDrag(x: number, y: number): void {
	const drag = mirrorDrag;
	if (!drag?.ghost || !drag.indicator) {
		return;
	}
	drag.ghost.style.left = `${x + 12}px`;
	drag.ghost.style.top = `${y + 12}px`;
	const strip = stripDropTarget(x, y);
	if (strip?.el !== drag.stripTarget) {
		drag.stripTarget?.classList.remove('strip-drop');
		strip?.el.classList.add('strip-drop');
		drag.stripTarget = strip?.el;
	}
	const target = strip ? undefined : mirrorDropTarget(x, y, drag.paneKey);
	drag.indicator.hidden = !target;
	if (!target) {
		return;
	}
	const r = target.rect;
	const box = {
		center: [r.left, r.top, r.width, r.height],
		left: [r.left, r.top, r.width / 2, r.height],
		right: [r.left + r.width / 2, r.top, r.width / 2, r.height],
		top: [r.left, r.top, r.width, r.height / 2],
		bottom: [r.left, r.top + r.height / 2, r.width, r.height / 2],
	}[mirrorZone(target, x, y)];
	Object.assign(drag.indicator.style, { left: `${box[0]}px`, top: `${box[1]}px`, width: `${box[2]}px`, height: `${box[3]}px` });
}

window.addEventListener(
	'pointerdown',
	(ev) => {
		const target = ev.target as Element | null;
		if (ev.button !== 0 || !target?.closest?.('.lm_tab') || target.closest('.lm_close_tab, .lm_controls')) {
			return;
		}
		const paneKey = paneKeyAt(target);
		mirrorDrag = paneKey ? { paneKey, x: ev.clientX, y: ev.clientY, active: false } : undefined;
	},
	true,
);
window.addEventListener(
	'pointermove',
	(ev) => {
		const drag = mirrorDrag;
		if (!drag) {
			return;
		}
		if (!drag.active) {
			if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) <= MIRROR_DRAG_START_PX) {
				return;
			}
			// herdr refuses moves in a zoomed tab.
			if (layout.maximisedStack) {
				mirrorDrag = undefined;
				return;
			}
			startMirrorDrag(drag);
		}
		ev.preventDefault();
		moveMirrorDrag(ev.clientX, ev.clientY);
	},
	true,
);
window.addEventListener(
	'pointerup',
	(ev) => {
		const drag = mirrorDrag;
		if (!drag) {
			return;
		}
		if (drag.active) {
			const strip = stripDropTarget(ev.clientX, ev.clientY);
			const target = strip ? undefined : mirrorDropTarget(ev.clientX, ev.clientY, drag.paneKey);
			if (strip) {
				post({ type: 'movePaneToTab', paneKey: drag.paneKey, tabId: strip.tabId });
			} else if (target) {
				post({ type: 'movePane', paneKey: drag.paneKey, targetPaneKey: target.paneKey, zone: mirrorZone(target, ev.clientX, ev.clientY) });
			}
		}
		endMirrorDrag();
	},
	true,
);
window.addEventListener('pointercancel', () => endMirrorDrag(), true);
window.addEventListener(
	'keydown',
	(ev) => {
		if (mirrorDrag?.active && ev.key === 'Escape') {
			ev.preventDefault();
			ev.stopPropagation();
			endMirrorDrag();
		}
	},
	true,
);

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
	setDot(tab, meta.status, (dot) => tab.prepend(dot));
	let detail = tab.querySelector<HTMLElement>('.tile-detail');
	if (!detail) {
		detail = document.createElement('span');
		detail.className = 'tile-detail';
		tab.querySelector('.lm_title')?.after(detail);
	}
	detail.textContent = meta.detail ?? '';
	detail.hidden = !meta.detail;
}

/** A tab's (or strip entry's) status dot; a shell has none. */
function setDot(parent: HTMLElement, status: TileMeta['status'], insert: (dot: HTMLElement) => void): void {
	let dot = parent.querySelector<HTMLElement>(':scope > .tile-dot');
	if (status === 'shell') {
		dot?.remove();
		return;
	}
	if (!dot) {
		dot = document.createElement('span');
		insert(dot);
	}
	dot.className = `tile-dot tile-dot-${status}`;
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
		overLink: tile.termEl.querySelector('.xterm-cursor-pointer') !== null,
		dot: tabs.get(tile.paneKey)?.querySelector(':scope > .tile-dot')?.className ?? '',
		context: tile.host.dataset.vscodeContext ?? '',
	};
}

function runProbeAction(action: ProbeAction): void {
	const tile = 'paneKey' in action ? tiles.get(action.paneKey) : undefined;
	if (action.kind === 'press') {
		const init = { key: action.key, keyCode: action.keyCode, bubbles: true, cancelable: true } as KeyboardEventInit;
		tile?.term.textarea?.dispatchEvent(new KeyboardEvent('keydown', init));
	} else if (action.kind === 'clickClose') {
		tile?.host.closest('.lm_stack')?.querySelector<HTMLElement>('.lm_controls .lm_close')?.click();
	} else if (action.kind === 'clickTabClose') {
		tabs.get(action.paneKey)?.querySelector<HTMLElement>('.lm_close_tab')?.click();
	} else if (action.kind === 'hoverCell' || action.kind === 'clickCell') {
		const screen = tile?.termEl.querySelector('.xterm-screen');
		if (tile && screen) {
			const box = screen.getBoundingClientRect();
			const at = { clientX: box.x + ((action.col + 0.5) * box.width) / tile.term.cols, clientY: box.y + ((action.row + 0.5) * box.height) / tile.term.rows };
			const mouse = (type: string) => screen.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...at }));
			if (action.kind === 'hoverCell') {
				mouse('mousemove');
			} else {
				mouse('mousedown');
				mouse('mouseup');
			}
		}
	} else if (action.kind === 'dragSplitter') {
		dragSplitter(action.splitId, action.fraction);
	} else if (action.kind === 'dragTile') {
		dragTile(action.paneKey, action.targetPaneKey, action.zone);
	} else if (action.kind === 'dragTileToStrip') {
		const el = action.tabId === null ? document.getElementById('strip-new') : stripEntry(action.tabId);
		const r = el?.getBoundingClientRect();
		if (r && action.blank) {
			// The toolbar's blank area, near its right edge.
			const bar = toolbarEl.getBoundingClientRect();
			dragTabTo(action.paneKey, { x: bar.right - 4, y: bar.top + bar.height / 2 });
		} else if (r) {
			dragTabTo(action.paneKey, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
		}
	} else if (action.kind === 'clickStrip') {
		const entry = stripEntry(action.tabId);
		if (action.part === 'close') {
			entry?.querySelector<HTMLElement>('.strip-close')?.click();
		} else if (action.part === 'double') {
			entry?.click();
			entry?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
		} else {
			entry?.click();
		}
	} else if (action.kind === 'clickNewTab') {
		document.getElementById('strip-new')?.click();
	} else if (action.kind === 'clickMaximise') {
		tile?.host.closest('.lm_stack')?.querySelector<HTMLElement>('.lm_controls .lm_maximise')?.click();
	}
}

const synthetic = (type: string, target: EventTarget, x: number, y: number) =>
	target.dispatchEvent(
		new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }),
	);

/** Drags the splitter of a split item to `fraction` of the item's width (row) or height (column). */
function dragSplitter(id: string, fraction: number): void {
	const item = splitItems().get(id.startsWith(SPLIT_ID_PREFIX) ? id.slice(SPLIT_ID_PREFIX.length) : id);
	const splitter = item?.element.querySelector<HTMLElement>(':scope > .lm_splitter');
	if (!item || !splitter) {
		return;
	}
	const handle = splitter.querySelector<HTMLElement>('.lm_drag_handle') ?? splitter;
	const s = splitter.getBoundingClientRect();
	const box = item.element.getBoundingClientRect();
	const [x, y] = [s.left + s.width / 2, s.top + s.height / 2];
	const row = item.isRow;
	const [endX, endY] = row ? [box.left + box.width * fraction, y] : [x, box.top + box.height * fraction];
	synthetic('pointerdown', handle, x, y);
	// Past Golden Layout's 10 px first, away from the end, so the drag starts whatever the target.
	const away = (row ? endX < x : endY < y) ? 15 : -15;
	synthetic('pointermove', document, row ? x + away : x, row ? y : y + away);
	synthetic('pointermove', document, endX, endY);
	synthetic('pointerup', document, endX, endY);
}

/** Drags a tile's tab into a zone of another tile: its body's centre, or 10% in from an edge. */
function dragTile(paneKey: string, targetPaneKey: string, zone: DropZone): void {
	const tab = tabs.get(paneKey);
	if (!tab) {
		return;
	}
	const start = tab.getBoundingClientRect();
	let end = { x: start.x + 45, y: start.y + 45 };
	const stack = containers.get(targetPaneKey)?.parent.parentItem;
	if (stack instanceof Stack) {
		const r = stack.element.getBoundingClientRect();
		const [top, height] = [r.top + MIRROR_HEADER_HEIGHT, r.height - MIRROR_HEADER_HEIGHT];
		const [fx, fy] = { center: [0.5, 0.5], left: [0.1, 0.5], right: [0.9, 0.5], top: [0.5, 0.1], bottom: [0.5, 0.9] }[zone];
		end = { x: r.left + r.width * fx, y: top + height * fy };
	}
	dragTabTo(paneKey, end);
}

/** Drags a tile's tab to a point with synthetic pointer events. */
function dragTabTo(paneKey: string, end: { x: number; y: number }): void {
	const tab = tabs.get(paneKey);
	if (!tab) {
		return;
	}
	const start = tab.getBoundingClientRect();
	const [x, y] = [start.x + 5, start.y + 5];
	synthetic('pointerdown', tab, x, y);
	synthetic('pointermove', document, x + 15, y + 15);
	synthetic('pointermove', document, end.x, end.y);
	synthetic('pointerup', document, end.x, end.y);
}

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
	const msg = ev.data;
	switch (msg.type) {
		case 'init':
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
			// A new tree is never maximised, and saying so to herdr would unzoom it: `zoom` follows.
			appliedZoom = null;
			applyLayout(msg.config);
			appliedRatios = liveRatios();
			break;
		case 'empty':
			endMirrorDrag();
			showEmpty(msg.text);
			appliedRatios = {};
			appliedZoom = null;
			break;
		case 'ratios':
			receiveRatios(msg.ratios);
			break;
		case 'zoom':
			applyZoom(msg.paneKey);
			break;
		case 'meta':
			if (msg.strip) {
				renderStrip(msg.strip);
			}
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
			// The webview may not have the keyboard yet, so xterm's focus event may not come: say it here.
			focusTile(msg.paneKey, true);
			break;
		case 'probe':
			if (msg.action) {
				runProbeAction(msg.action);
			}
			post({
				type: 'probeResult',
				id: msg.id,
				tiles: [...tiles.values()].map(probeTile),
				toolbar: [...(document.getElementById('toolbar')?.children ?? [])].map((el) => el.id),
				strip: [...stripEl.querySelectorAll<HTMLElement>('.strip-tab')].map(
					(el) => `${el.classList.contains('strip-active') ? '*' : ''}${el.querySelector('.strip-label')?.textContent ?? ''}`,
				),
				message: messageEl.hidden ? '' : (messageEl.textContent ?? ''),
				config: layout.saveLayout() as unknown as StoredLayoutConfig,
				dragging: isDragging(),
				ratios: liveRatios(),
				maximised: layout.maximisedStack ? (paneKeyAt(layout.maximisedStack.element) ?? null) : null,
			});
			break;
	}
});

// ── Tab strip ─────────────────────────────────────────────────

function stripEntry(tabId: string): HTMLElement | undefined {
	return [...stripEl.querySelectorAll<HTMLElement>('.strip-tab')].find((el) => el.dataset.tabId === tabId);
}

/**
 * The space's herdr tabs. Entries are updated in place when the tabs are the
 * same, so a double-click is not split across two elements by a re-render.
 */
function renderStrip(entries: StripTab[]): void {
	const current = [...stripEl.querySelectorAll<HTMLElement>('.strip-tab')];
	const same = current.length === entries.length && current.every((el, i) => el.dataset.tabId === entries[i].tabId);
	if (!same) {
		stripEl.replaceChildren();
		for (const entry of entries) {
			const el = document.createElement('span');
			el.className = 'strip-tab';
			el.dataset.tabId = entry.tabId;
			const label = document.createElement('span');
			label.className = 'strip-label';
			const close = document.createElement('span');
			close.className = 'strip-close';
			close.textContent = '×';
			close.title = 'Close Tab';
			el.append(label, close);
			stripEl.append(el);
		}
		const add = document.createElement('span');
		add.id = 'strip-new';
		add.textContent = '+';
		add.title = 'New Tab';
		stripEl.append(add);
	}
	const els = [...stripEl.querySelectorAll<HTMLElement>('.strip-tab')];
	entries.forEach((entry, i) => {
		const el = els[i];
		el.classList.toggle('strip-active', entry.active);
		el.title = entry.label;
		setDot(el, entry.status, (dot) => el.prepend(dot));
		const label = el.querySelector('.strip-label') as HTMLElement;
		if (label.textContent !== entry.label) {
			label.textContent = entry.label;
		}
	});
	stripEl.querySelector<HTMLElement>('.strip-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Keeps the keyboard focus in the tile, and a double-click from selecting text.
stripEl.addEventListener('mousedown', (ev) => ev.preventDefault());
stripEl.addEventListener('click', (ev) => {
	const target = ev.target as Element;
	if (target.closest('#strip-new')) {
		post({ type: 'newTab' });
		return;
	}
	const entry = target.closest<HTMLElement>('.strip-tab');
	const tabId = entry?.dataset.tabId;
	if (!entry || !tabId) {
		return;
	}
	if (target.closest('.strip-close')) {
		post({ type: 'closeTab', tabId });
	} else if (!entry.classList.contains('strip-active')) {
		post({ type: 'focusTab', tabId });
	}
});
stripEl.addEventListener('dblclick', (ev) => {
	const target = ev.target as Element;
	const tabId = target.closest<HTMLElement>('.strip-tab')?.dataset.tabId;
	if (tabId && !target.closest('.strip-close')) {
		post({ type: 'renameTab', tabId });
	}
});
// A vertical wheel scrolls the strip sideways.
stripEl.addEventListener(
	'wheel',
	(ev) => {
		if (ev.deltaY !== 0 && ev.deltaX === 0) {
			stripEl.scrollLeft += ev.deltaY;
			ev.preventDefault();
		}
	},
	{ passive: false },
);

post({ type: 'ready' });
