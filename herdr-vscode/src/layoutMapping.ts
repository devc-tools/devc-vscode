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
}

export interface GlStackItem {
	type: 'stack';
	size?: string;
	content: GlComponentItem[];
}

export interface GlSplitItem {
	type: 'row' | 'column';
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

/** Mirrored tabs: no drag, no popouts; maximise is local, close goes to herdr. */
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

function toItem(node: LayoutNode, sessionKey: string, title: (paneId: string) => string, size?: string): GlItem {
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
				},
			],
		};
	}
	return {
		type: node.direction === 'right' ? 'row' : 'column',
		...(size ? { size } : {}),
		content: [
			toItem(node.first, sessionKey, title, percent(node.ratio)),
			toItem(node.second, sessionKey, title, percent(1 - node.ratio)),
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

/**
 * Compares split trees: panes, directions and ratios, nothing else (export
 * nodes also carry a `cwd`, and `layout.updated` fires for focus changes too).
 */
export function layoutShape(node: LayoutNode): string {
	return JSON.stringify(node);
}

/** The component states in a Golden Layout item tree. */
export function componentStates(item: GlItem): PaneComponentState[] {
	if (item.type === 'stack') {
		return item.content.map((c) => c.componentState);
	}
	return item.content.flatMap(componentStates);
}
