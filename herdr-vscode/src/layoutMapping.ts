/**
 * `layout.export` as Golden Layout config. herdr's split tree and the Golden
 * Layout tree stay 1:1: a split is a row or column of exactly two children
 * (same-direction splits stay nested), a pane is a stack holding one component.
 */

export type LayoutNode =
	| { type: 'pane'; pane_id: string }
	| { type: 'split'; direction: 'right' | 'down'; ratio: number; first: LayoutNode; second: LayoutNode };

export interface LayoutExport {
	tab_id: string;
	workspace_id: string;
	focused_pane_id?: string;
	zoomed: boolean;
	root: LayoutNode;
}

/** A pane tile's Golden Layout component state. */
export interface PaneComponentState {
	sessionKey: string;
	paneId: string;
}

export interface GlComponentItem {
	type: 'component';
	componentType: 'pane';
	componentState: PaneComponentState;
	title: string;
	/** Per component: a tab takes this before the settings' `reorderEnabled`, and it defaults to true. */
	reorderEnabled?: boolean;
}

export interface GlStackItem {
	type: 'stack';
	size?: string;
	/** In a saved (resolved) config: whether the stack was maximised. */
	maximised?: boolean;
	content: GlComponentItem[];
}

export interface GlSplitItem {
	type: 'row' | 'column';
	/** Mirrored tabs: `split:<path key>`, the split's place in herdr's tree. */
	id?: string;
	size?: string;
	content: GlItem[];
}

export type GlItem = GlStackItem | GlSplitItem;

/** The JSON shape of a Golden Layout `LayoutConfig`, as far as mirrored tabs use it. */
export interface GlLayoutConfig {
	root: GlItem;
	settings: {
		reorderEnabled: boolean;
		popoutWholeStack: boolean;
		showPopoutIcon: boolean;
		showMaximiseIcon: boolean;
		showCloseIcon: boolean;
	};
	header: { popout: false };
	dimensions: { borderWidth: number; headerHeight: number };
}

/**
 * A Layout tab's config as stored: `saveLayout()`'s `ResolvedLayoutConfig` (with
 * `resolved: true`), or a new layout's short form, which has no `root` yet.
 */
export type StoredLayoutConfig = Omit<GlLayoutConfig, 'root'> & { root?: GlItem; resolved?: boolean };

/** Mirrored tabs: no Golden Layout drag, no popouts; maximise is herdr's zoom, close goes to herdr. */
export const MIRROR_SETTINGS: GlLayoutConfig['settings'] = {
	reorderEnabled: false,
	popoutWholeStack: false,
	showPopoutIcon: false,
	showMaximiseIcon: true,
	showCloseIcon: true,
};

function parseNode(raw: unknown): LayoutNode | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const n = raw as Record<string, unknown>;
	if (n.type === 'pane') {
		return typeof n.pane_id === 'string' && n.pane_id !== '' ? { type: 'pane', pane_id: n.pane_id } : undefined;
	}
	if (n.type === 'split' && (n.direction === 'right' || n.direction === 'down') && typeof n.ratio === 'number') {
		const first = parseNode(n.first);
		const second = parseNode(n.second);
		return first && second ? { type: 'split', direction: n.direction, ratio: n.ratio, first, second } : undefined;
	}
	return undefined;
}

/** The result of `layout.export` (`{"type":"layout_export","layout":{…}}`), typed; undefined when malformed. */
export function parseLayoutExport(raw: unknown): LayoutExport | undefined {
	const layout = (raw as { layout?: unknown } | null | undefined)?.layout;
	if (typeof layout !== 'object' || layout === null) {
		return undefined;
	}
	const l = layout as Record<string, unknown>;
	const root = parseNode(l.root);
	if (!root || typeof l.tab_id !== 'string' || typeof l.workspace_id !== 'string') {
		return undefined;
	}
	return {
		tab_id: l.tab_id,
		workspace_id: l.workspace_id,
		focused_pane_id: typeof l.focused_pane_id === 'string' ? l.focused_pane_id : undefined,
		zoomed: l.zoomed === true,
		root,
	};
}

/** A share of 0..1 as a Golden Layout size. */
function percent(share: number): string {
	return `${Math.round(share * 10000) / 100}%`;
}

/** The Golden Layout id of a mirrored split: `split:` and its path key (`0` first, `1` second; the root `""`). */
export const SPLIT_ID_PREFIX = 'split:';

export function splitId(pathKey: string): string {
	return SPLIT_ID_PREFIX + pathKey;
}

function toItem(node: LayoutNode, sessionKey: string, title: (paneId: string) => string, size?: string, path = ''): GlItem {
	if (node.type === 'pane') {
		return {
			type: 'stack',
			...(size ? { size } : {}),
			content: [
				{
					type: 'component',
					componentType: 'pane',
					componentState: { sessionKey, paneId: node.pane_id },
					title: title(node.pane_id),
					reorderEnabled: false,
				},
			],
		};
	}
	return {
		type: node.direction === 'right' ? 'row' : 'column',
		id: splitId(path),
		...(size ? { size } : {}),
		content: [
			toItem(node.first, sessionKey, title, percent(node.ratio), path + '0'),
			toItem(node.second, sessionKey, title, percent(1 - node.ratio), path + '1'),
		],
	};
}

/** The Golden Layout config mirroring a herdr tab's split tree. */
export function mirrorConfig(root: LayoutNode, sessionKey: string, title: (paneId: string) => string): GlLayoutConfig {
	return {
		root: toItem(root, sessionKey, title),
		settings: MIRROR_SETTINGS,
		header: { popout: false },
		dimensions: { borderWidth: 3, headerHeight: 26 },
	};
}

/** The pane ids in a split tree, first to last. */
export function layoutPaneIds(node: LayoutNode): string[] {
	return node.type === 'pane' ? [node.pane_id] : [...layoutPaneIds(node.first), ...layoutPaneIds(node.second)];
}

function withoutRatios(node: LayoutNode): unknown {
	return node.type === 'pane'
		? { type: 'pane', pane_id: node.pane_id }
		: { type: 'split', direction: node.direction, first: withoutRatios(node.first), second: withoutRatios(node.second) };
}

/**
 * Compares split trees by structure: panes, their places and the directions;
 * not ratios (those are resized in place), nor the `cwd` export nodes carry.
 */
export function structureKey(node: LayoutNode): string {
	return JSON.stringify(withoutRatios(node));
}

/** Every split's ratio (the `first` child's share), by path key. */
export function ratiosByPath(node: LayoutNode, path = '', out: Record<string, number> = {}): Record<string, number> {
	if (node.type === 'split') {
		out[path] = node.ratio;
		ratiosByPath(node.first, path + '0', out);
		ratiosByPath(node.second, path + '1', out);
	}
	return out;
}

/** The component states in a Golden Layout item tree. */
export function componentStates(item: GlItem | GlComponentItem): PaneComponentState[] {
	return item.type === 'component' ? [item.componentState] : item.content.flatMap(componentStates);
}
