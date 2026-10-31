import { ComponentItem, ContentItem, GoldenLayout, ItemConfig, JsonValue, ResolvedItemConfig, Stack } from 'golden-layout';
import { PaneComponentState } from '../layoutMapping';

/**
 * Golden Layout 2.6.0's own drop logic, as its drag proxy uses it: the drop
 * areas, the indicator and `onDrop`. These are `@internal` (in the JS, not in
 * the `.d.ts`), so they are reached here only, through one cast; `golden-layout`
 * is pinned at exactly 2.6.0, and the layout panel tests fail if they change.
 */

/** A drop area: a stack, its header, or a band along an edge of the whole layout (`side` set). */
interface GlArea {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	surface: number;
	side?: string;
	contentItem: ContentItem & GlDropTarget;
}

interface GlDropTarget {
	/** Shows the indicator, and records the segment and tab index `onDrop` will use. */
	highlightDropZone(x: number, y: number, area: GlArea): void;
	onDrop(item: ContentItem, area: GlArea): void;
}

interface GlInternals {
	calculateItemAreas(): void;
	getArea(x: number, y: number): GlArea | null;
	readonly dropTargetIndicator: { hide(): void } | null;
	readonly tabDropPlaceholder: HTMLElement;
}

interface ItemConfigInternals {
	resolve(config: ItemConfig, rowAndColumnChildLegacySizeDefault: boolean): ResolvedItemConfig;
}

/** What a drop at a point did. */
export type DropResult =
	/** A new tile, or an existing one moved there. */
	| { kind: 'placed'; item: ComponentItem }
	/** The pane was there already and stays where it is (rule 1). */
	| { kind: 'focused'; item: ComponentItem }
	/** No drop area under the point. */
	| { kind: 'none' };

/** Whether an item is still in the layout's tree: a removed one keeps its parent. */
function attached(item: ContentItem): boolean {
	let child = item;
	for (let parent = child.parent; parent; parent = child.parent) {
		if (!parent.contentItems.includes(child)) {
			return false;
		}
		child = parent;
	}
	return child.type === 'ground';
}

export class GlDrop {
	private readonly gl: GlInternals;

	constructor(private readonly layout: GoldenLayout) {
		this.gl = layout as unknown as GlInternals;
	}

	/** Before the first hit test, and after any re-layout. */
	calculateAreas(): void {
		this.gl.calculateItemAreas();
	}

	/** Highlights the drop zone under the point, as a tab drag does; none there hides the indicator. */
	highlight(x: number, y: number): GlArea | undefined {
		const area = this.gl.getArea(x, y) ?? undefined;
		if (area) {
			area.contentItem.highlightDropZone(x, y, area);
		} else {
			this.clear();
		}
		return area;
	}

	/** After any drop or cancel. The header placeholder is otherwise left in the tab strip. */
	clear(): void {
		this.gl.dropTargetIndicator?.hide();
		this.gl.tabDropPlaceholder.remove();
	}

	/**
	 * Puts a pane at the point. `existing` is its component when the layout has
	 * it: it stays put (only focused) when the point is its own stack's header,
	 * or any zone of a stack holding only it; otherwise it moves there.
	 */
	dropAt(x: number, y: number, state: PaneComponentState, title: string, existing: ComponentItem | undefined, fallback: () => Stack | undefined): DropResult {
		const area = this.gl.getArea(x, y);
		if (!area) {
			this.clear();
			return { kind: 'none' };
		}
		if (existing) {
			return this.moveTo(x, y, area, existing, fallback);
		}
		// Right before onDrop: this is what records where the drop goes.
		area.contentItem.highlightDropZone(x, y, area);
		const config = (ItemConfig as unknown as ItemConfigInternals).resolve(
			{ type: 'component', componentType: 'pane', componentState: state as unknown as JsonValue, title } as ItemConfig,
			false,
		);
		const item = this.layout.createAndInitContentItem(config, area.contentItem) as ComponentItem;
		area.contentItem.onDrop(item, area);
		this.clear();
		return { kind: 'placed', item };
	}

	// Removal and onDrop must run in the same task: the webview's own handlers of the removal
	// are deferred, and must find the component back in the tree.
	private moveTo(x: number, y: number, area: GlArea, item: ComponentItem, fallback: () => Stack | undefined): DropResult {
		const stack = item.parentItem;
		if (!(stack instanceof Stack)) {
			this.clear();
			return { kind: 'none' };
		}
		const header = stack.header.element.getBoundingClientRect();
		const inHeader = x >= header.left && x < header.right && y >= header.top && y < header.bottom;
		if (area.contentItem === (stack as unknown) && (inHeader || stack.contentItems.length === 1)) {
			this.clear();
			return { kind: 'focused', item };
		}
		stack.removeChild(item, true);
		this.gl.calculateItemAreas();
		const after = this.gl.getArea(x, y);
		if (after) {
			after.contentItem.highlightDropZone(x, y, after);
			after.contentItem.onDrop(item, after);
		} else if (attached(stack)) {
			stack.addChild(item);
		} else {
			fallback()?.addChild(item);
		}
		this.clear();
		return { kind: 'placed', item };
	}
}
