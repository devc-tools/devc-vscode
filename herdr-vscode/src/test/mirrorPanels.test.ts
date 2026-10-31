import * as assert from 'assert';
import * as vscode from 'vscode';
import { HerdrEvent } from '../bridge';
import { FocusTracker } from '../focus';
import { GlItem, LayoutNode } from '../layoutMapping';
import { LayoutStore } from '../layouts';
import { SessionConnection, SessionModel, Snapshot } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TilesPanels } from '../tilesPanel';
import { HostMessage, makePaneKey, TileProbe } from '../tilesProtocol';
import { RAW_SNAPSHOT, snapshot } from './fixtures';

/**
 * Mirrored panels editing herdr's layout, in a real webview (Golden Layout and
 * xterm running) over a model made up here, which records each request's method
 * and params and answers as herdr 0.9.5 does. Nothing is spawned. Needs `npm run build`.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, get: () => T | undefined | false | Promise<T | undefined | false>, ms = 15000): Promise<T> {
	const start = Date.now();
	let last: unknown;
	while (Date.now() - start < ms) {
		last = await get();
		if (last) {
			return last as T;
		}
		await sleep(25);
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const S = 'host/a';
const TAB = 'w2:t1';
const [P1, P2, P3] = ['w2:p1', 'w2:p2', 'w2:p3'];
const pk = (id: string) => makePaneKey(S, id);

const pane = (id: string): LayoutNode => ({ type: 'pane', pane_id: id });
const split = (direction: 'right' | 'down', ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({ type: 'split', direction, ratio, first, second });

/** The fixture's snapshot with a third pane in `w2:t1`. */
function threePaneSnapshot(): Snapshot {
	const raw = JSON.parse(JSON.stringify(RAW_SNAPSHOT)) as typeof RAW_SNAPSHOT;
	raw.panes.push({ pane_id: P3, tab_id: TAB, workspace_id: 'w2', agent_status: 'unknown', cwd: '/src/api', foreground_cwd: '/src/api', terminal_title_stripped: 'zsh', focused: false });
	return snapshot(raw);
}

class FakeHerdr {
	readonly changed = new vscode.EventEmitter<void>();
	readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	readonly onDidChange = this.changed.event;
	readonly onDidEvent = this.events.event;
	readonly snap = threePaneSnapshot();
	readonly requests: { method: string; params: Record<string, unknown> }[] = [];
	tree: LayoutNode = split('right', 0.6, pane(P1), split('down', 0.5, pane(P2), pane(P3)));
	zoomed = false;
	focused = P1;
	/** What `set_split_ratio` stores instead of the requested ratio (herdr clamps). */
	ratioOverride: number | undefined;

	connection(key: string): SessionConnection | undefined {
		return key === S ? ({ state: 'connected', snapshot: this.snap, name: 'a' } as unknown as SessionConnection) : undefined;
	}

	private exported() {
		return { tab_id: TAB, workspace_id: 'w2', zoomed: this.zoomed, focused_pane_id: this.focused, root: JSON.parse(JSON.stringify(this.tree)) };
	}

	/** Others' requests: the methods besides `layout.export`. */
	edits(): { method: string; params: Record<string, unknown> }[] {
		return this.requests.filter((r) => r.method !== 'layout.export');
	}

	/** herdr's `layout.updated` for the tab: the panel re-exports. */
	updated(): void {
		this.events.fire({ sessionKey: S, event: { event: 'layout.updated', data: { layout: { tab_id: TAB } } } });
	}

	request(_key: string, method: string, params: Record<string, unknown>): Promise<unknown> {
		this.requests.push({ method, params });
		switch (method) {
			case 'layout.export':
				return Promise.resolve({ type: 'layout_export', layout: this.exported() });
			case 'layout.set_split_ratio': {
				let node = this.tree;
				for (const second of params.path as boolean[]) {
					node = node.type === 'split' ? (second ? node.second : node.first) : node;
				}
				if (node.type === 'split') {
					node.ratio = this.ratioOverride ?? (params.ratio as number);
				}
				return Promise.resolve({ type: 'layout_split_ratio_set', layout: this.exported() });
			}
			case 'pane.swap':
				return Promise.resolve({ type: 'pane_swap', swap: { changed: true, source_pane_id: params.source_pane_id, target_pane_id: params.target_pane_id } });
			case 'pane.zoom': {
				const on = params.mode === 'on';
				this.zoomed = on;
				this.focused = params.pane_id as string;
				return Promise.resolve({ type: 'pane_zoom', zoom: { changed: true, zoomed: on, pane_id: params.pane_id, focused_pane_id: params.pane_id } });
			}
		}
		return Promise.reject(new Error(`unexpected ${method}`));
	}
}

function shape(item: GlItem | undefined): unknown {
	if (!item) {
		return null;
	}
	if (item.type === 'stack') {
		return item.content.map((c) => c.componentState.paneId);
	}
	return { [item.type]: item.content.map(shape) };
}

suite('mirrored panels edit herdr', function () {
	this.timeout(30000);
	let herdr: FakeHerdr;
	let focus: FocusTracker;
	let streams: PaneStreams;
	let panels: TilesPanels;
	let mirror: MirrorPanel;
	let posted: HostMessage[];
	const tile = (tiles: TileProbe[], id: string) => tiles.find((t) => t.paneKey === pk(id))!;

	setup(async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		herdr = new FakeHerdr();
		const fake = herdr as unknown as SessionModel;
		focus = new FocusTracker(fake, () => 'row');
		streams = new PaneStreams(() => undefined, () => undefined);
		const noLayouts = new LayoutStore({ get: () => undefined, update: () => Promise.resolve() });
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model: fake, streams, focus, layouts: noLayouts, rowLabel: (k) => `row ${k}`, log: () => undefined });
		mirror = panels.openTab(S, TAB);
		posted = [];
		const webview = mirror.panel.webview;
		const postMessage = webview.postMessage.bind(webview);
		webview.postMessage = (msg: HostMessage) => {
			posted.push(msg);
			return postMessage(msg);
		};
		await waitFor('three tiles', async () => {
			const p = await mirror.probe();
			return p.tiles.length === 3 && p.tiles.every((t) => t.width > 50) && p;
		});
		posted.length = 0;
		herdr.requests.length = 0;
	});

	teardown(async () => {
		panels.dispose();
		mirror.panel.dispose();
		streams.dispose();
		focus.dispose();
		await sleep(50);
	});

	test('a re-export with only a new ratio resizes the tiles in place', async () => {
		const before = await mirror.probe();
		assert.ok(Math.abs(before.ratios![''] - 0.6) < 0.01, JSON.stringify(before.ratios));
		assert.deepStrictEqual(before.ratios!['1'] !== undefined, true, 'the column is split:1');
		(herdr.tree as Extract<LayoutNode, { type: 'split' }>).ratio = 0.3;
		herdr.updated();
		const after = await waitFor('p1 at 30%', async () => {
			const p = await mirror.probe();
			const [a, b] = [tile(p.tiles, P1), tile(p.tiles, P2)];
			return Math.abs(a.width / (a.width + b.width) - 0.3) < 0.02 && p;
		}, 1000);
		for (const id of [P1, P2, P3]) {
			assert.strictEqual(tile(after.tiles, id).serial, tile(before.tiles, id).serial, `${id} kept its terminal`);
		}
		assert.deepStrictEqual(posted.filter((m) => m.type === 'layout'), [], 'no loadLayout');
		assert.deepStrictEqual(posted.filter((m) => m.type === 'ratios').map((m) => (m as { ratios: unknown }).ratios), [{ '': 0.3 }]);
	});

	test('a splitter drag sets herdr\'s ratio; herdr\'s answer moves nothing back', async () => {
		await mirror.probe({ kind: 'dragSplitter', splitId: 'split:', fraction: 0.25 });
		await waitFor('set_split_ratio', () => herdr.edits().length > 0);
		await sleep(400);
		const sets = herdr.edits();
		assert.strictEqual(sets.length, 1, JSON.stringify(sets));
		assert.strictEqual(sets[0].method, 'layout.set_split_ratio');
		assert.strictEqual(sets[0].params.tab_id, TAB);
		assert.deepStrictEqual(sets[0].params.path, []);
		assert.ok(Math.abs((sets[0].params.ratio as number) - 0.25) <= 0.01, `ratio ${sets[0].params.ratio}`);
		const dragged = (await mirror.probe()).ratios![''];
		posted.length = 0;
		herdr.updated();
		await waitFor('re-exported', () => herdr.requests.some((r) => r.method === 'layout.export'));
		await sleep(300);
		assert.deepStrictEqual(posted.filter((m) => m.type === 'ratios' || m.type === 'layout'), [], 'nothing posted');
		assert.ok(Math.abs((await mirror.probe()).ratios![''] - dragged) < 0.001, 'the splitter stays');
		assert.strictEqual(herdr.edits().length, 1, 'no second request');
	});

	test('herdr clamps the ratio: the split shows herdr\'s', async () => {
		herdr.ratioOverride = 0.3;
		await mirror.probe({ kind: 'dragSplitter', splitId: 'split:', fraction: 0.25 });
		await waitFor('the split at 0.3', async () => Math.abs((await mirror.probe()).ratios![''] - 0.3) < 0.005);
		assert.strictEqual(herdr.edits().filter((r) => r.method === 'layout.set_split_ratio').length, 1);
	});

	test('a column\'s splitter is path [true]', async () => {
		await mirror.probe({ kind: 'dragSplitter', splitId: 'split:1', fraction: 0.7 });
		await waitFor('set_split_ratio', () => herdr.edits().length > 0);
		assert.deepStrictEqual(herdr.edits()[0].params.path, [true]);
		assert.ok(Math.abs((herdr.edits()[0].params.ratio as number) - 0.7) <= 0.01, `ratio ${herdr.edits()[0].params.ratio}`);
	});

	test('a tile dropped on another swaps them in herdr (edges too: herdr refuses same-tab moves); nothing moves locally', async () => {
		const before = shape((await mirror.probe()).config?.root);
		await mirror.probe({ kind: 'dragTile', paneKey: pk(P1), targetPaneKey: pk(P2), zone: 'right' });
		await waitFor('a request', () => herdr.edits().length > 0);
		assert.deepStrictEqual(herdr.edits(), [{ method: 'pane.swap', params: { source_pane_id: P1, target_pane_id: P2 } }]);
		assert.ok(!herdr.edits().some((r) => r.method === 'pane.move'));
		herdr.requests.length = 0;
		await mirror.probe({ kind: 'dragTile', paneKey: pk(P3), targetPaneKey: pk(P1), zone: 'center' });
		await waitFor('a request', () => herdr.edits().length > 0);
		assert.deepStrictEqual(herdr.edits(), [{ method: 'pane.swap', params: { source_pane_id: P3, target_pane_id: P1 } }]);
		assert.deepStrictEqual(shape((await mirror.probe()).config?.root), before, 'the tiles wait for the export');
	});

	test('no drop onto itself, and no drag while a tile is maximised', async () => {
		await mirror.probe({ kind: 'dragTile', paneKey: pk(P1), targetPaneKey: pk(P1), zone: 'center' });
		await sleep(300);
		assert.deepStrictEqual(herdr.edits(), []);
		herdr.zoomed = true;
		herdr.focused = P2;
		herdr.updated();
		await waitFor('p2 maximised', async () => (await mirror.probe()).maximised === pk(P2));
		await mirror.probe({ kind: 'dragTile', paneKey: pk(P2), targetPaneKey: pk(P1), zone: 'center' });
		await sleep(300);
		assert.deepStrictEqual(herdr.edits(), [], 'nothing, and no pane.zoom back either');
	});

	test('maximise is herdr\'s zoom, both ways', async () => {
		await mirror.probe({ kind: 'clickMaximise', paneKey: pk(P2) });
		await waitFor('pane.zoom', () => herdr.edits().length > 0);
		assert.deepStrictEqual(herdr.edits(), [{ method: 'pane.zoom', params: { pane_id: P2, mode: 'on' } }]);
		assert.strictEqual((await mirror.probe()).maximised, pk(P2));
		herdr.requests.length = 0;
		// Zoomed on p3 from herdr's side (it shows the focused pane).
		herdr.focused = P3;
		herdr.updated();
		await waitFor('p3 maximised', async () => (await mirror.probe()).maximised === pk(P3));
		await sleep(300);
		assert.deepStrictEqual(herdr.edits(), [], 'no pane.zoom sent back: ' + JSON.stringify(herdr.edits()));
		herdr.zoomed = false;
		herdr.updated();
		await waitFor('nothing maximised', async () => (await mirror.probe()).maximised === null);
		await sleep(300);
		assert.deepStrictEqual(herdr.edits(), [], 'still nothing sent');
		// The maximise control again: restore is `off`.
		await mirror.probe({ kind: 'clickMaximise', paneKey: pk(P1) });
		await waitFor('on', () => herdr.edits().length === 1);
		await mirror.probe({ kind: 'clickMaximise', paneKey: pk(P1) });
		await waitFor('off', () => herdr.edits().length === 2);
		assert.deepStrictEqual(herdr.edits()[1], { method: 'pane.zoom', params: { pane_id: P1, mode: 'off' } });
	});
});
