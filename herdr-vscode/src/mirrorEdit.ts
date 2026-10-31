/**
 * Editing herdr's layout from a mirrored tab: split paths, ratio diffs, the drop
 * zone of a tile drag, and the herdr requests for a drop and for a zoom change.
 * Imported by the host and the webview, so nothing here may need `vscode`, Node
 * or the DOM at runtime.
 */

/** Ratios closer than this are the same ratio: herdr keeps them as `f32`. */
export const RATIO_TOLERANCE = 0.005;
/** The range a ratio is clamped to before it goes to herdr (which clamps again, to [0.1, 0.9]). */
export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;

/**
 * Whether a tile dropped near an edge of another tile moves the pane there. herdr
 * 0.9.5 refuses `pane.move` within a tab (`same_tab`) and its `layout.apply`
 * replaces the tab with new panes, so a mirrored tab offers only the centre:
 * a swap. Measured in the plan's step 1.
 */
export const EDGE_ZONES_OFFERED = false;

/** herdr's `path` param for a path key: one boolean per step, `true` = `second`. */
export function herdrPath(pathKey: string): boolean[] {
	return [...pathKey].map((c) => c === '1');
}

/** The path key of herdr's `path`: `0` = `first`, `1` = `second`, the root `""`. */
export function pathKeyOf(path: readonly boolean[]): string {
	return path.map((second) => (second ? '1' : '0')).join('');
}

export function sameRatio(a: number, b: number): boolean {
	return Math.abs(a - b) <= RATIO_TOLERANCE;
}

/**
 * The ratios of `next` that differ from `stored` (or are new), leaving out the
 * paths with a `set_split_ratio` in flight.
 */
export function changedRatios(
	stored: Readonly<Record<string, number>>,
	next: Readonly<Record<string, number>>,
	inFlight: ReadonlySet<string> = new Set(),
): Record<string, number> {
	const changed: Record<string, number> = {};
	for (const [key, ratio] of Object.entries(next)) {
		if (inFlight.has(key)) {
			continue;
		}
		const before = stored[key];
		if (before === undefined || !sameRatio(before, ratio)) {
			changed[key] = ratio;
		}
	}
	return changed;
}

/** A ratio as sent to herdr: clamped to [0.05, 0.95], rounded to 3 decimals. */
export function clampRatio(ratio: number): number {
	const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) ? ratio : 0.5));
	return Math.round(clamped * 1000) / 1000;
}

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Where in a tile a point is: its header strip is the centre; in the body, a
 * point at least a quarter of the way in from every edge is the centre, else
 * the nearest edge (ties: left, right, top, bottom).
 */
export function dropZone(stack: Rect, headerHeight: number, x: number, y: number): DropZone {
	if (y < stack.top + headerHeight) {
		return 'center';
	}
	const bodyHeight = stack.height - headerHeight;
	const rx = stack.width > 0 ? (x - stack.left) / stack.width : 0.5;
	const ry = bodyHeight > 0 ? (y - stack.top - headerHeight) / bodyHeight : 0.5;
	const edges: [DropZone, number][] = [
		['left', rx],
		['right', 1 - rx],
		['top', ry],
		['bottom', 1 - ry],
	];
	const d = Math.min(...edges.map(([, v]) => v));
	if (d >= 0.25) {
		return 'center';
	}
	return edges.find(([, v]) => v === d)![0];
}

/** The zone a mirrored tab acts on: an edge only when herdr can move panes within a tab. */
export function offeredZone(zone: DropZone): DropZone {
	return EDGE_ZONES_OFFERED ? zone : 'center';
}

export interface HerdrRequest {
	method: string;
	params: Record<string, unknown>;
}

/**
 * The requests for dropping pane `source` on `target` in `tabId`, in order. The
 * centre swaps the two panes. Edge zones are not offered (see
 * {@link EDGE_ZONES_OFFERED}), so they have no requests.
 */
export function dropRequests(zone: DropZone, source: string, target: string, _tabId: string): HerdrRequest[] {
	if (source === target) {
		return [];
	}
	if (zone === 'center') {
		return [{ method: 'pane.swap', params: { source_pane_id: source, target_pane_id: target } }];
	}
	return [];
}

/**
 * The `pane.zoom` requests that take herdr from `zoomed` (its zoomed pane, if
 * any) to `wanted` (null: none). Another pane's zoom is turned off first: herdr
 * answers `on` for a second pane with `already_zoomed`.
 */
export function zoomRequests(zoomed: string | undefined, wanted: string | null): HerdrRequest[] {
	if (wanted === null) {
		return zoomed ? [{ method: 'pane.zoom', params: { pane_id: zoomed, mode: 'off' } }] : [];
	}
	if (zoomed === wanted) {
		return [];
	}
	return [
		...(zoomed ? [{ method: 'pane.zoom', params: { pane_id: zoomed, mode: 'off' } }] : []),
		{ method: 'pane.zoom', params: { pane_id: wanted, mode: 'on' } },
	];
}

/** `changed:false` in a `pane.swap` / `pane.move` / `pane.zoom` answer, as the reason; undefined when it changed. */
export function refusal(result: unknown): string | undefined {
	const r = result as Record<string, unknown> | null | undefined;
	const inner = (r?.swap ?? r?.move_result) as Record<string, unknown> | undefined;
	if (!inner || inner.changed !== false) {
		return undefined;
	}
	return typeof inner.reason === 'string' ? inner.reason : 'not changed';
}

/** herdr's zoomed pane after a `pane.zoom` answer: `zoom.zoomed ? zoom.pane_id : null`; undefined when malformed. */
export function zoomedAfter(result: unknown): string | null | undefined {
	const zoom = (result as { zoom?: Record<string, unknown> } | null | undefined)?.zoom;
	if (!zoom || typeof zoom.zoomed !== 'boolean') {
		return undefined;
	}
	return zoom.zoomed && typeof zoom.pane_id === 'string' ? zoom.pane_id : null;
}
