import { componentStates, GlItem, GlLayoutConfig, PaneComponentState, StoredLayoutConfig } from './layoutMapping';
import { makePaneKey } from './tilesProtocol';

/**
 * Layout tabs: the store and the decisions around it. The webview bundle imports
 * this file too, so nothing here may need `vscode`, Node or the DOM at runtime.
 */

/** Workspace state key of the saved layouts. */
export const LAYOUTS_KEY = 'herdr.layouts';

/** Layout panels: everything but popouts is the user's to arrange. */
export const LAYOUT_SETTINGS: GlLayoutConfig['settings'] = {
	reorderEnabled: true,
	popoutWholeStack: false,
	showPopoutIcon: false,
	showMaximiseIcon: true,
	showCloseIcon: true,
};

export interface SavedLayout {
	id: string;
	name: string;
	config: StoredLayoutConfig;
}

/** What the store needs from `vscode.Memento`. */
export interface LayoutState {
	get(key: string): unknown;
	update(key: string, value: unknown): PromiseLike<void>;
}

/** A layout with nothing in it yet. */
export function emptyLayoutConfig(): StoredLayoutConfig {
	return { settings: LAYOUT_SETTINGS, header: { popout: false }, dimensions: { borderWidth: 3, headerHeight: 26 } };
}

/** The saved layouts of a workspace. */
export class LayoutStore {
	constructor(private readonly state: LayoutState) {}

	list(): SavedLayout[] {
		const raw = this.state.get(LAYOUTS_KEY);
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter(
			(l): l is SavedLayout =>
				typeof l === 'object' && l !== null && typeof l.id === 'string' && typeof l.name === 'string' && typeof l.config === 'object' && l.config !== null,
		);
	}

	get(id: string): SavedLayout | undefined {
		return this.list().find((l) => l.id === id);
	}

	names(): string[] {
		return this.list().map((l) => l.name);
	}

	/** `name` must be free: see {@link nextLayoutName} and {@link uniqueLayoutName}. */
	create(name: string, config: StoredLayoutConfig = emptyLayoutConfig()): SavedLayout {
		const layout: SavedLayout = { id: globalThis.crypto.randomUUID(), name, config };
		void this.state.update(LAYOUTS_KEY, [...this.list(), layout]);
		return layout;
	}

	/** False when the name is taken by another layout, or the layout is gone. */
	rename(id: string, name: string): boolean {
		const list = this.list();
		const layout = list.find((l) => l.id === id);
		if (!layout || list.some((l) => l.id !== id && l.name === name)) {
			return false;
		}
		void this.state.update(LAYOUTS_KEY, list.map((l) => (l.id === id ? { ...l, name } : l)));
		return true;
	}

	/** Does nothing for a layout that was deleted meanwhile. */
	setConfig(id: string, config: StoredLayoutConfig): void {
		const list = this.list();
		const layout = list.find((l) => l.id === id);
		if (layout && JSON.stringify(layout.config) !== JSON.stringify(config)) {
			void this.state.update(LAYOUTS_KEY, list.map((l) => (l.id === id ? { ...l, config } : l)));
		}
	}

	delete(id: string): void {
		void this.state.update(LAYOUTS_KEY, this.list().filter((l) => l.id !== id));
	}
}

// ── Naming ──────────────────────────────────────────────────────────────────

/** `Layout <n>` with the lowest free `n`. */
export function nextLayoutName(names: readonly string[]): string {
	const taken = new Set(names);
	let n = 1;
	while (taken.has(`Layout ${n}`)) {
		n++;
	}
	return `Layout ${n}`;
}

/** `base`, or `base 2`, `base 3`… when taken. */
export function uniqueLayoutName(base: string, names: readonly string[]): string {
	const taken = new Set(names);
	if (!taken.has(base)) {
		return base;
	}
	let n = 2;
	while (taken.has(`${base} ${n}`)) {
		n++;
	}
	return `${base} ${n}`;
}

/** The name of a mirrored tab's Copy as Layout. */
export function copyLayoutName(tabLabel: string, spaceLabel: string, names: readonly string[]): string {
	return uniqueLayoutName(`${tabLabel} (${spaceLabel})`, names);
}

// ── Adding a pane ───────────────────────────────────────────────────────────

/**
 * The Layout panel a new pane goes to: the active one, else the most recently
 * active one still open. Undefined means a new layout: a saved layout is never
 * reopened for this. `recent` is most recent first.
 */
export function selectLayoutTarget(active: string | undefined, recent: readonly string[], open: ReadonlySet<string>): string | undefined {
	if (active !== undefined && open.has(active)) {
		return active;
	}
	return recent.find((id) => open.has(id));
}

/** Where a pane goes in a layout: nowhere new if it is there already. */
export function addPlacement(config: Pick<StoredLayoutConfig, 'root'>, pane: PaneComponentState, hasFocusedStack: boolean): 'reveal' | 'focusedStack' | 'root' {
	if (layoutPaneKeys(config).includes(makePaneKey(pane.sessionKey, pane.paneId))) {
		return 'reveal';
	}
	return hasFocusedStack ? 'focusedStack' : 'root';
}

/** The pane keys in a config, in tree order. */
export function layoutPaneKeys(config: Pick<StoredLayoutConfig, 'root'>): string[] {
	return config.root ? componentStates(config.root).map((s) => makePaneKey(s.sessionKey, s.paneId)) : [];
}

function percentOf(item: GlItem): number | undefined {
	const match = typeof item.size === 'string' ? /^([\d.]+)%$/.exec(item.size) : undefined;
	return match ? Number(match[1]) : undefined;
}

/**
 * A copy of `config` (the unresolved `LayoutConfig` shape, sizes as `"50%"`) with
 * the pane in a new stack on the right of the root: a row gains a column of
 * `100/(n+1)`%, anything else is wrapped in a row with it.
 */
export function addPaneAtRoot<T extends Pick<StoredLayoutConfig, 'root'>>(config: T, pane: PaneComponentState, title: string): T {
	const stack = (size?: string): GlItem => ({
		type: 'stack',
		...(size ? { size } : {}),
		content: [{ type: 'component', componentType: 'pane', componentState: pane, title }],
	});
	const root = config.root;
	if (!root) {
		return { ...config, root: stack() };
	}
	if (root.type !== 'row') {
		return { ...config, root: { type: 'row', content: [{ ...root, size: '50%' }, stack('50%')] } };
	}
	const n = root.content.length;
	const total = root.content.reduce((sum, item) => sum + (percentOf(item) ?? 0), 0);
	const scale = (item: GlItem): string => {
		const share = percentOf(item);
		return `${total > 0 && share !== undefined ? (share / total) * (100 * n) / (n + 1) : 100 / (n + 1)}%`;
	};
	return {
		...config,
		root: { ...root, content: [...root.content.map((item) => ({ ...item, size: scale(item) })), stack(`${100 / (n + 1)}%`)] },
	};
}

function mapComponents(item: GlItem, change: (c: { componentState: PaneComponentState; reorderEnabled?: boolean }) => object): GlItem {
	const raw = item as unknown as { type: string; content?: GlItem[] };
	if (raw.type === 'component') {
		return change(raw as never) as GlItem;
	}
	return { ...item, content: (raw.content ?? []).map((child) => mapComponents(child, change)) } as GlItem;
}

/** The same config with a pane's id changed; `config` itself when it does not hold the pane. */
export function rewritePane<T extends Pick<StoredLayoutConfig, 'root'>>(config: T, sessionKey: string, from: string, to: string): T {
	if (!config.root || !layoutPaneKeys(config).includes(makePaneKey(sessionKey, from))) {
		return config;
	}
	return {
		...config,
		root: mapComponents(config.root, (c) =>
			c.componentState.sessionKey === sessionKey && c.componentState.paneId === from
				? { ...c, componentState: { sessionKey, paneId: to } }
				: c,
		),
	};
}

/** A mirrored panel's saved config as a Layout's: every tile draggable, nothing maximised. */
export function asLayoutConfig(config: StoredLayoutConfig): StoredLayoutConfig {
	return {
		...config,
		settings: { ...config.settings, ...LAYOUT_SETTINGS },
		...(config.root ? { root: mapComponents(config.root, (c) => ({ ...c, reorderEnabled: true })) } : {}),
	};
}

/** `pane.moved` data, when it gave the pane a new id (a move to another workspace). */
export function parsePaneMoved(data: Record<string, unknown>): { from: string; to: string } | undefined {
	const from = data.previous_pane_id;
	const to = (data.pane as { pane_id?: unknown } | undefined)?.pane_id;
	return typeof from === 'string' && typeof to === 'string' && from !== '' && to !== '' && from !== to ? { from, to } : undefined;
}
