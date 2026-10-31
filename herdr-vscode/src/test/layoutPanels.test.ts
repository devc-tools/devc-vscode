import * as assert from 'assert';
import * as vscode from 'vscode';
import { HerdrEvent } from '../bridge';
import { FocusTracker } from '../focus';
import { componentStates, GlItem } from '../layoutMapping';
import { LayoutState, LayoutStore } from '../layouts';
import { SessionConnection, SessionModel, Snapshot } from '../sessions';
import { PaneStreams } from '../streams';
import { LayoutPanel, MirrorPanel, TILES_VIEW_TYPE, TilesPanels } from '../tilesPanel';
import { makePaneKey, TileProbe } from '../tilesProtocol';
import { snapshot } from './fixtures';

/**
 * Layout panels in a real webview (Golden Layout and xterm running) over a model
 * made up here. Nothing reaches herdr: streams have no session to spawn in, and
 * the fake model records requests instead of sending them. Needs `npm run build`.
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

class FakeModel {
	readonly changed = new vscode.EventEmitter<void>();
	readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	readonly onDidChange = this.changed.event;
	readonly onDidEvent = this.events.event;
	readonly snapshots = new Map<string, Snapshot>();
	readonly requests: string[] = [];

	connection(key: string): SessionConnection | undefined {
		const snap = this.snapshots.get(key);
		return snap && ({ state: 'connected', snapshot: snap, name: key.split('/').pop() } as unknown as SessionConnection);
	}

	request(_key: string, method: string): Promise<unknown> {
		this.requests.push(method);
		if (method === 'layout.export') {
			return Promise.resolve({
				type: 'layout_export',
				layout: {
					tab_id: 'w2:t1',
					workspace_id: 'w2',
					zoomed: false,
					root: { type: 'split', direction: 'right', ratio: 0.6, first: { type: 'pane', pane_id: 'w2:p1' }, second: { type: 'pane', pane_id: 'w2:p2' } },
				},
			});
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

suite('layout panels in a webview', function () {
	this.timeout(30000);
	const A = 'host/a';
	const B = 'container:x/b';
	let model: FakeModel;
	let store: LayoutStore;
	let focus: FocusTracker;
	let streams: PaneStreams;
	let panels: TilesPanels;
	const opened: { panel: vscode.WebviewPanel }[] = [];
	const track = <T extends { panel: vscode.WebviewPanel }>(p: T | undefined): T => {
		assert.ok(p);
		opened.push(p);
		return p;
	};
	const tile = (tiles: TileProbe[], sessionKey: string, paneId: string) => tiles.find((t) => t.paneKey === makePaneKey(sessionKey, paneId));
	const add = (session: string, pane: string) => track(panels.addToLayout(session, pane));
	const tiled = (panel: LayoutPanel, n: number) =>
		waitFor(`${n} tiles`, async () => {
			const p = await panel.probe();
			return p.tiles.length === n && p;
		});
	const savedShape = (id: string) => shape(store.get(id)?.config.root);

	setup(async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		model = new FakeModel();
		model.snapshots.set(A, snapshot());
		model.snapshots.set(B, snapshot());
		const values = new Map<string, unknown>();
		const state: LayoutState = {
			get: (k) => values.get(k),
			update: (k, v) => {
				values.set(k, JSON.parse(JSON.stringify(v)));
				return Promise.resolve();
			},
		};
		store = new LayoutStore(state);
		const fake = model as unknown as SessionModel;
		focus = new FocusTracker(fake, () => 'row');
		streams = new PaneStreams(() => undefined, () => undefined);
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model: fake, streams, focus, layouts: store, rowLabel: (k) => `row ${k}`, log: () => undefined });
	});

	teardown(async () => {
		panels.dispose();
		for (const o of opened.splice(0)) {
			o.panel.dispose();
		}
		streams.dispose();
		focus.dispose();
		await sleep(50);
	});

	test('no open panel: a new Layout 1; a pane from another session joins it in the focused stack', async () => {
		const panel = add(A, 'w2:p1');
		assert.strictEqual(panel.panel.title, 'Layout 1');
		assert.deepStrictEqual(store.names(), ['Layout 1']);
		await tiled(panel, 1);
		assert.strictEqual(add(B, 'w1:p1'), panel, 'the same panel');
		const p = await tiled(panel, 2);
		assert.deepStrictEqual(store.names(), ['Layout 1'], 'no second layout');
		assert.strictEqual(p.breadcrumb, '"Layout 1" · layout');
		assert.deepStrictEqual(shape(p.config?.root), ['w2:p1', 'w1:p1'], 'one stack with two tabs');
		// Golden Layout has made the new tile the front one, and the header says where it comes from.
		await waitFor('headers', async () => {
			const t = (await panel.probe()).tiles;
			return /api-fixer/.test(tile(t, A, 'w2:p1')?.title ?? '') && tile(t, A, 'w2:p1')?.title.includes(`api · row ${A}`) && tile(t, B, 'w1:p1')?.title.includes(`web · row ${B}`);
		});
		assert.strictEqual(focus.lastFocused, makePaneKey(B, 'w1:p1'));
		await waitFor('saved', () => JSON.stringify(savedShape(panel.layoutId)) === JSON.stringify(['w2:p1', 'w1:p1']));
		assert.deepStrictEqual(model.requests, [], 'nothing was asked of herdr');
	});

	test('a pane already in the layout: no new component, its tab comes to the front', async () => {
		const panel = add(A, 'w2:p1');
		await tiled(panel, 1);
		add(A, 'w2:p2');
		const before = await tiled(panel, 2);
		assert.ok((tile(before.tiles, A, 'w2:p1')?.width ?? 1) === 0, 'behind the other tab');
		const serials = before.tiles.map((t) => t.serial);
		add(A, 'w2:p1');
		const after = await waitFor('the tab in front', async () => {
			const p = await panel.probe();
			return (tile(p.tiles, A, 'w2:p1')?.width ?? 0) > 0 && p;
		});
		assert.deepStrictEqual(after.tiles.map((t) => t.serial), serials);
		assert.deepStrictEqual(shape(after.config?.root), ['w2:p1', 'w2:p2']);
		assert.strictEqual(focus.lastFocused, makePaneKey(A, 'w2:p1'));
	});

	test('with no focused tile, a pane goes in a new stack on the right', async () => {
		const seeded = store.create('seeded', {
			settings: { reorderEnabled: true, popoutWholeStack: false, showPopoutIcon: false, showMaximiseIcon: true, showCloseIcon: true },
			header: { popout: false },
			dimensions: { borderWidth: 3, headerHeight: 26 },
			root: { type: 'stack', content: [{ type: 'component', componentType: 'pane', componentState: { sessionKey: A, paneId: 'w2:p1' }, title: 'x' }] },
		});
		const panel = track(panels.openLayout(seeded.id));
		await tiled(panel, 1);
		add(A, 'w2:p2');
		const p = await tiled(panel, 2);
		assert.deepStrictEqual(shape(p.config?.root), { row: [['w2:p1'], ['w2:p2']] });
		assert.ok((tile(p.tiles, A, 'w2:p2')?.x ?? 0) > (tile(p.tiles, A, 'w2:p1')?.x ?? 0));
		assert.ok(Math.abs((tile(p.tiles, A, 'w2:p2')?.width ?? 0) - (tile(p.tiles, A, 'w2:p1')?.width ?? 0)) < 12, 'half each');
	});

	test('the target: active, else most recent open, never a closed one', async () => {
		const one = add(A, 'w2:p1');
		await tiled(one, 1);
		const two = track(panels.newLayout('two'));
		await waitFor('two up', async () => (await two.probe()).breadcrumb === '"two" · layout');
		assert.strictEqual(panels.addToLayout(A, 'w2:p2'), two, 'the active one');
		one.panel.reveal();
		await waitFor('one active', () => one.panel.active);
		assert.strictEqual(panels.addToLayout(A, 'w1:p1'), one);
		two.panel.dispose();
		one.panel.dispose();
		const three = add(A, 'w1:p2');
		assert.notStrictEqual(three, one);
		assert.strictEqual(three.panel.title, 'Layout 2', 'closed layouts stay saved, and are not reopened');
		assert.deepStrictEqual(store.names(), ['Layout 1', 'two', 'Layout 2']);
	});

	test('closing a tile removes it from the layout only; the last leaves an empty saved layout', async () => {
		const panel = add(A, 'w2:p1');
		await tiled(panel, 1);
		add(A, 'w2:p2');
		await tiled(panel, 2);
		await panel.probe({ kind: 'clickTabClose', paneKey: makePaneKey(A, 'w2:p2') });
		await tiled(panel, 1);
		await waitFor('saved', () => JSON.stringify(savedShape(panel.layoutId)) === JSON.stringify(['w2:p1']));
		await panel.probe({ kind: 'clickClose', paneKey: makePaneKey(A, 'w2:p1') });
		await tiled(panel, 0);
		await waitFor('saved empty', () => savedShape(panel.layoutId) === null);
		assert.deepStrictEqual(model.requests, [], 'no pane.close');
		// An empty layout still takes panes.
		add(A, 'w2:p1');
		await tiled(panel, 1);
	});

	test('dragging a tab to the right edge makes a side-by-side split and keeps the terminal', async () => {
		const panel = add(A, 'w2:p1');
		await tiled(panel, 1);
		add(A, 'w2:p2');
		const before = await tiled(panel, 2);
		await panel.probe({ kind: 'dragToRightEdge', paneKey: makePaneKey(A, 'w2:p2') });
		const after = await waitFor('side by side', async () => {
			const p = await panel.probe();
			return JSON.stringify(shape(p.config?.root)) === JSON.stringify({ row: [['w2:p1'], ['w2:p2']] }) && p;
		});
		assert.strictEqual(tile(after.tiles, A, 'w2:p2')?.serial, tile(before.tiles, A, 'w2:p2')?.serial, 'not re-created');
		await waitFor('both visible, beside each other', async () => {
			const t = (await panel.probe()).tiles;
			const [l, r] = [tile(t, A, 'w2:p1')!, tile(t, A, 'w2:p2')!];
			return l.width > 0 && r.width > 0 && r.x > l.x;
		});
		await waitFor('saved', () => JSON.stringify(savedShape(panel.layoutId)) === JSON.stringify({ row: [['w2:p1'], ['w2:p2']] }));
	});

	test('reopen and restore bring back the arrangement; a deleted layout closes its panel', async () => {
		const panel = add(A, 'w2:p1');
		await tiled(panel, 1);
		add(A, 'w2:p2');
		await tiled(panel, 2);
		await panel.probe({ kind: 'dragToRightEdge', paneKey: makePaneKey(A, 'w2:p2') });
		const arranged = { row: [['w2:p1'], ['w2:p2']] };
		await waitFor('saved', () => JSON.stringify(savedShape(panel.layoutId)) === JSON.stringify(arranged));
		const id = panel.layoutId;
		panel.panel.dispose();

		const again = track(panels.openLayout(id));
		assert.strictEqual(again.panel.title, 'Layout 1');
		const p = await tiled(again, 2);
		assert.deepStrictEqual(shape(p.config?.root), arranged);
		await waitFor('both painted at their places', async () => {
			const t = (await again.probe()).tiles;
			return (tile(t, A, 'w2:p2')?.x ?? 0) > (tile(t, A, 'w2:p1')?.x ?? 0);
		});
		again.panel.dispose();

		const restored = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'restored', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		await panels.deserializeWebviewPanel(restored, { kind: 'layout', layoutId: id });
		const back = track(panels.openLayout(id));
		assert.strictEqual(back.panel, restored);
		await tiled(back, 2);
		await waitFor('title', () => restored.title === 'Layout 1');

		panels.deleteLayout(id);
		assert.strictEqual(store.get(id), undefined);
		const orphan = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'orphan', vscode.ViewColumn.Active, {});
		let disposed = false;
		orphan.onDidDispose(() => (disposed = true));
		await panels.deserializeWebviewPanel(orphan, { kind: 'layout', layoutId: id });
		assert.ok(disposed, 'a layout deleted meanwhile closes its panel');
	});

	test('waiting for a session, a pane that is gone, Remove', async () => {
		const panel = add(A, 'w2:p1');
		await tiled(panel, 1);
		const overlay = (want: string) =>
			waitFor(want, async () => (await panel.probe()).tiles[0]?.overlay.includes(want));

		const snap = model.snapshots.get(A)!;
		model.snapshots.delete(A);
		model.changed.fire();
		await overlay(`Waiting for row ${A}…`);

		model.snapshots.set(A, snap);
		model.changed.fire();
		await overlay('Disconnected:'); // In this test streams never have a session; back to trying is the point.

		model.snapshots.set(A, { ...snap, panes: snap.panes.filter((p) => p.pane_id !== 'w2:p1') });
		model.changed.fire();
		await overlay('This pane is gone.');
		assert.deepStrictEqual(model.requests, []);

		await panel.probe({ kind: 'clickRemove', paneKey: makePaneKey(A, 'w2:p1') });
		await tiled(panel, 0);
		await waitFor('saved', () => savedShape(panel.layoutId) === null);
	});

	test('pane.moved with a new id: tiles and saved layouts follow, open or closed', async () => {
		const closed = add(A, 'w2:p2');
		await tiled(closed, 1);
		await waitFor('saved', () => JSON.stringify(savedShape(closed.layoutId)) === JSON.stringify(['w2:p2']));
		closed.panel.dispose();
		const open = track(panels.newLayout('open'));
		await waitFor('up', async () => (await open.probe()).breadcrumb === '"open" · layout');
		add(A, 'w2:p2');
		await tiled(open, 1);

		const snap = model.snapshots.get(A)!;
		model.snapshots.set(A, { ...snap, panes: snap.panes.map((p) => (p.pane_id === 'w2:p2' ? { ...p, pane_id: 'w3:p1' } : p)) });
		model.events.fire({
			sessionKey: A,
			event: { event: 'pane.moved', data: { previous_pane_id: 'w2:p2', pane: { pane_id: 'w3:p1', tab_id: 'w3:t1' } } },
		});
		model.changed.fire();
		await waitFor('the tile follows', async () => tile((await open.probe()).tiles, A, 'w3:p1'));
		assert.strictEqual((await open.probe()).tiles.length, 1);
		assert.deepStrictEqual(savedShape(closed.layoutId), ['w3:p1'], 'a closed layout');
		await waitFor('the open one', () => JSON.stringify(savedShape(open.layoutId)) === JSON.stringify(['w3:p1']));
		assert.strictEqual(tile((await open.probe()).tiles, A, 'w3:p1')?.overlay.includes('gone'), false);

		// Another session's pane with that id is another pane; a move keeping the id changes nothing.
		model.events.fire({ sessionKey: B, event: { event: 'pane.moved', data: { previous_pane_id: 'w3:p1', pane: { pane_id: 'w9:p9' } } } });
		model.events.fire({ sessionKey: A, event: { event: 'pane.moved', data: { previous_pane_id: 'w3:p1', pane: { pane_id: 'w3:p1' } } } });
		await sleep(100);
		assert.deepStrictEqual(savedShape(open.layoutId), ['w3:p1']);
	});

	test('mirrored panel: tiles do not drag, and Copy as Layout copies the arrangement, draggable', async () => {
		const mirror: MirrorPanel = track(panels.openTab(A, 'w2:t1'));
		const up = await waitFor('two tiles', async () => {
			const p = await mirror.probe();
			return p.tiles.length === 2 && p;
		});
		await mirror.probe({ kind: 'dragToRightEdge', paneKey: makePaneKey(A, 'w2:p1') });
		await sleep(100);
		assert.deepStrictEqual(shape((await mirror.probe()).config?.root), { row: [['w2:p1'], ['w2:p2']] }, 'still as herdr has it');
		const widths = up.tiles.map((t) => t.width);
		assert.ok(widths[0] > widths[1], '60% and 40%');

		const config = (await mirror.probe()).config!;
		mirror.onMessage({ type: 'copyAsLayout', config });
		assert.deepStrictEqual(store.names(), ['main (api)']);
		mirror.onMessage({ type: 'copyAsLayout', config });
		assert.deepStrictEqual(store.names(), ['main (api)', 'main (api) 2']);

		const saved = store.list()[1];
		const copy = track(panels.openLayout(saved.id));
		assert.strictEqual(copy.panel.title, 'main (api) 2');
		const p = await tiled(copy, 2);
		assert.deepStrictEqual(shape(p.config?.root), { row: [['w2:p1'], ['w2:p2']] }, 'the same arrangement');
		assert.ok((tile(p.tiles, A, 'w2:p1')?.width ?? 0) > (tile(p.tiles, A, 'w2:p2')?.width ?? 0), 'the same shares');
		assert.strictEqual(p.config?.settings.reorderEnabled, true);
		assert.deepStrictEqual(componentStates(p.config!.root!).map((s) => s.paneId), ['w2:p1', 'w2:p2']);

		await copy.probe({ kind: 'dragToRightEdge', paneKey: makePaneKey(A, 'w2:p1') });
		await waitFor('it drags', async () => JSON.stringify(shape((await copy.probe()).config?.root)) === JSON.stringify({ row: [['w2:p2'], ['w2:p1']] }));
		assert.deepStrictEqual(model.requests.filter((m) => m !== 'layout.export'), [], 'herdr is not told');
		assert.ok(model.requests.length >= 1);
	});

	test('rename: the title and the toolbar follow, and names stay unique', async () => {
		const panel = track(panels.newLayout('first'));
		await waitFor('up', async () => (await panel.probe()).breadcrumb === '"first" · layout');
		store.create('taken');
		assert.strictEqual(panels.renameLayout(panel.layoutId, 'taken'), false);
		assert.strictEqual(panels.renameLayout(panel.layoutId, 'second'), true);
		assert.strictEqual(panel.panel.title, 'second');
		await waitFor('toolbar', async () => (await panel.probe()).breadcrumb === '"second" · layout');
	});
});
