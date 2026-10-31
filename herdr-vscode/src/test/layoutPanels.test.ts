import * as assert from 'assert';
import * as vscode from 'vscode';
import { HerdrEvent } from '../bridge';
import { FocusTracker } from '../focus';
import { componentStates, GlItem } from '../layoutMapping';
import { emptyLayoutConfig, LayoutState, LayoutStore, layoutPaneKeys } from '../layouts';
import { SessionConnection, SessionModel, Snapshot } from '../sessions';
import { PaneStreams } from '../streams';
import { LayoutPanel, MirrorPanel, TILES_VIEW_TYPE, TilesPanels } from '../tilesPanel';
import { DropPoint, makePaneKey, TileProbe, WebviewMessage } from '../tilesProtocol';
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
		if (method === 'pane.swap') {
			return Promise.resolve({ type: 'pane_swap', swap: { changed: true } });
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

	test('after the focused tile closes, the next pane still goes in its stack', async () => {
		const panel = track(panels.newLayout('closing'));
		add(A, 'w2:p1');
		await tiled(panel, 1);
		add(A, 'w2:p2');
		await tiled(panel, 2);
		await panel.probe({ kind: 'clickTabClose', paneKey: makePaneKey(A, 'w2:p2') });
		await tiled(panel, 1);
		add(A, 'w2:p2');
		const p = await tiled(panel, 2);
		assert.deepStrictEqual(shape(p.config?.root), ['w2:p1', 'w2:p2']);
	});

	test('with no focused tile, a pane goes in as a tab, not a new split', async () => {
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
		assert.deepStrictEqual(shape(p.config?.root), ['w2:p1', 'w2:p2']);
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

	test('mirrored panel: tiles do not drag locally (the drop goes to herdr), and Copy as Layout copies the arrangement, draggable', async () => {
		const mirror: MirrorPanel = track(panels.openTab(A, 'w2:t1'));
		const up = await waitFor('two tiles', async () => {
			const p = await mirror.probe();
			return p.tiles.length === 2 && p;
		});
		await mirror.probe({ kind: 'dragToRightEdge', paneKey: makePaneKey(A, 'w2:p1') });
		// Over p2's tile: `movePane`, a swap in herdr (herdr 0.9.5 has no same-tab pane.move).
		await waitFor('pane.swap', () => model.requests.includes('pane.swap'));
		assert.ok(!model.requests.includes('pane.move'));
		assert.deepStrictEqual(shape((await mirror.probe()).config?.root), { row: [['w2:p1'], ['w2:p2']] }, 'still as herdr has it');
		assert.strictEqual((await mirror.probe()).dragging, false, 'no Golden Layout drag');
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

		model.requests.length = 0;
		await copy.probe({ kind: 'dragToRightEdge', paneKey: makePaneKey(A, 'w2:p1') });
		await waitFor('it drags', async () => JSON.stringify(shape((await copy.probe()).config?.root)) === JSON.stringify({ row: [['w2:p2'], ['w2:p1']] }));
		assert.deepStrictEqual(model.requests.filter((m) => m !== 'layout.export'), [], 'herdr is not told');
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
	// ── Dragging panes in ───────────────────────────────────────────────────

	/** P1…P5: panes of session A; P5 is added to its snapshot here. */
	const [P1, P2, P3, P4, P5] = ['w2:p1', 'w2:p2', 'w1:p1', 'w1:p2', 'w1:p3'];
	const key = (paneId: string) => makePaneKey(A, paneId);
	const withP5 = () => {
		const snap = model.snapshots.get(A)!;
		model.snapshots.set(A, { ...snap, panes: [...snap.panes, { ...snap.panes.find((p) => p.pane_id === P4)!, pane_id: P5 }] });
		model.changed.fire();
	};
	/** Records what a panel's webview posts. */
	const record = (panel: LayoutPanel | MirrorPanel): WebviewMessage[] => {
		const seen: WebviewMessage[] = [];
		const original = panel.onMessage.bind(panel);
		panel.onMessage = (msg: WebviewMessage) => {
			seen.push(msg);
			original(msg);
		};
		return seen;
	};
	const types = (seen: WebviewMessage[]) => seen.map((m) => m.type).filter((t) => t.startsWith('place') || t === 'tileMovedIn');
	const savedIs = (id: string, want: unknown) =>
		waitFor(`saved ${JSON.stringify(want)}`, () => JSON.stringify(savedShape(id)) === JSON.stringify(want));
	const place = async (panel: LayoutPanel, paneId: string, at: DropPoint) => {
		assert.ok(panels.placement.arm({ sessionKey: A, paneId }, `title ${paneId}`), 'armed');
		await panel.probe({ kind: 'placeAt', at });
		assert.strictEqual(panels.placement.placing, undefined, 'placed');
	};
	/** A Layout panel beside the active one, so both are on screen. */
	const besideLayout = async (name: string, root?: GlItem): Promise<LayoutPanel> => {
		const saved = store.create(name, { ...emptyLayoutConfig(), ...(root ? { root } : {}) });
		const raw = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, name, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
		await panels.deserializeWebviewPanel(raw, { kind: 'layout', layoutId: saved.id });
		const panel = track(panels.openLayout(saved.id));
		assert.strictEqual(panel.panel, raw);
		await waitFor(`${name} up`, async () => (await panel.probe()).breadcrumb === `"${name}" · layout`);
		return panel;
	};
	const stackOf = (...paneIds: string[]): GlItem => ({
		type: 'stack',
		content: paneIds.map((paneId) => ({ type: 'component', componentType: 'pane', componentState: { sessionKey: A, paneId }, title: paneId })),
	});

	test('placing: Golden Layout\'s zones, a pane already there moves or is focused, an edge, an empty layout', async () => {
		withP5();
		const panel = add(A, P1);
		await tiled(panel, 1);
		const seen = record(panel);

		await place(panel, P2, { paneKey: key(P1), segment: 'right' });
		await savedIs(panel.layoutId, { row: [[P1], [P2]] });
		assert.strictEqual(focus.lastFocused, key(P2));
		assert.deepStrictEqual(types(seen), ['placeHover', 'placed']);

		await place(panel, P3, { paneKey: key(P2), segment: 'header' });
		await savedIs(panel.layoutId, { row: [[P1], [P2, P3]] });

		await place(panel, P4, { paneKey: key(P1), segment: 'top' });
		await savedIs(panel.layoutId, { row: [{ column: [[P4], [P1]] }, [P2, P3]] });

		const before = tile((await tiled(panel, 4)).tiles, A, P1)!.serial;
		await place(panel, P1, { paneKey: key(P3), segment: 'bottom' });
		await savedIs(panel.layoutId, { row: [[P4], { column: [[P2, P3], [P1]] }] });
		assert.strictEqual(tile((await tiled(panel, 4)).tiles, A, P1)?.serial, before, 'the terminal was not re-created');
		assert.strictEqual(focus.lastFocused, key(P1));

		add(A, P2); // P2 in front of its stack, so that P3 has to come forward.
		await waitFor('P2 in front', async () => (tile((await panel.probe()).tiles, A, P3)?.width ?? 1) === 0);
		await place(panel, P3, { paneKey: key(P3), segment: 'header' });
		await waitFor('P3 in front', async () => (tile((await panel.probe()).tiles, A, P3)?.width ?? 0) > 0);
		await sleep(600);
		assert.deepStrictEqual(savedShape(panel.layoutId), { row: [[P4], { column: [[P2, P3], [P1]] }] }, 'unchanged');
		assert.strictEqual(focus.lastFocused, key(P3));

		await place(panel, P5, { edge: 'left' });
		await waitFor('P5 first in the root row', () => {
			const root = savedShape(panel.layoutId) as { row?: unknown[] };
			return JSON.stringify(root.row?.[0]) === JSON.stringify([P5]) && root.row?.length === 3;
		});
		assert.strictEqual((await panel.probe()).tiles.length, 5);

		const empty = track(panels.newLayout('empty'));
		await waitFor('empty up', async () => (await empty.probe()).breadcrumb === '"empty" · layout');
		await place(empty, P1, { center: true });
		await savedIs(empty.layoutId, [P1]);
		assert.ok(panels.showsPane(A, P1));
	});

	test('placing: Escape, placeEnd and herdr.cancelPlacement cancel; the press is swallowed', async () => {
		const panel = add(A, P1);
		await tiled(panel, 1);
		const seen = record(panel);

		assert.ok(panels.placement.arm({ sessionKey: A, paneId: P2 }, 'p2'));
		await panel.probe({ kind: 'press', paneKey: key(P1), key: 'Escape', keyCode: 27 });
		assert.deepStrictEqual(types(seen), ['placeCancel']);
		assert.strictEqual(panels.placement.placing, undefined);
		await panel.probe({ kind: 'placeAt', at: { paneKey: key(P1), segment: 'right' } });

		assert.ok(panels.placement.arm({ sessionKey: A, paneId: P2 }, 'p2'));
		panels.placement.cancel(); // placeEnd
		await panel.probe({ kind: 'placeAt', at: { paneKey: key(P1), segment: 'right' } });

		assert.ok(panels.placement.arm({ sessionKey: A, paneId: P2 }, 'p2'));
		await vscode.commands.executeCommand('herdr.cancelPlacement'); // The extension's own placement: not this one.
		panels.placement.cancel();
		await panel.probe({ kind: 'placeAt', at: { paneKey: key(P1), segment: 'left' } });

		await sleep(600);
		assert.deepStrictEqual(shape((await panel.probe()).config?.root), [P1], 'nothing placed');
		assert.deepStrictEqual(types(seen), ['placeCancel']);

		// Placing over a tile: its xterm does not take the focus first, and Golden Layout starts no drag.
		await place(panel, P3, { paneKey: key(P1), segment: 'right' });
		await savedIs(panel.layoutId, { row: [[P1], [P3]] });
		const focused: string[] = [];
		const sub = focus.onDidChangeLastFocused((k) => focused.push(k ?? ''));
		try {
			await place(panel, P2, { paneKey: key(P1), segment: 'header' });
			const after = await panel.probe();
			assert.strictEqual(after.dragging, false, 'no .lm_dragProxy');
			assert.deepStrictEqual(focused, [key(P2)]);
		} finally {
			sub.dispose();
		}
		await savedIs(panel.layoutId, { row: [[P1, P2], [P3]] });

		// placed: the panel shows the pane at once, before the next save.
		assert.ok(panels.placement.arm({ sessionKey: A, paneId: P4 }, 'p4'));
		assert.strictEqual(panels.showsPane(A, P4), false);
		panel.onMessage({ type: 'placed', sessionKey: A, paneId: P4 });
		assert.strictEqual(panels.showsPane(A, P4), true);
		assert.strictEqual(panels.placement.placing, undefined);
	});

	test('grip: a tile moves between Layout tabs, never duplicated', async () => {
		const l1 = add(A, P1);
		add(A, P2);
		await tiled(l1, 2);
		await savedIs(l1.layoutId, [P1, P2]);
		const l2 = await besideLayout('L2', stackOf(P3));
		await tiled(l2, 1);
		const seen2 = record(l2);
		const grip = (from: string, paneId = P1) => JSON.stringify({ sessionKey: A, paneId, title: 'claude', layoutId: from });

		assert.ok((await l1.probe()).tiles.every((t) => t.grip), 'Layout tiles have a grip');

		await l2.probe({ kind: 'dropTileAt', at: { paneKey: key(P3), segment: 'right' }, data: grip(l1.layoutId) });
		await savedIs(l2.layoutId, { row: [[P3], [P1]] });
		await savedIs(l1.layoutId, [P2]);
		assert.strictEqual(l1.showsPane(A, P1), false);
		assert.strictEqual(l2.showsPane(A, P1), true);
		assert.deepStrictEqual(types(seen2), ['tileMovedIn']);

		await l2.probe({ kind: 'dropTileAt', at: { paneKey: key(P3), segment: 'left' }, data: grip(l1.layoutId) });
		await savedIs(l2.layoutId, { row: [[P1], [P3]] });
		const keys = layoutPaneKeys(store.get(l2.layoutId)!.config);
		assert.strictEqual(keys.filter((k) => k === key(P1)).length, 1, 'P1 once');
		assert.strictEqual((await l2.probe()).tiles.length, 2);

		const shapeBefore = savedShape(l2.layoutId);
		await l2.probe({ kind: 'dropTileAt', at: { paneKey: key(P3), segment: 'top' }, data: '' });
		await sleep(600);
		assert.deepStrictEqual(savedShape(l2.layoutId), shapeBefore, 'a tree drag\'s "" with nothing armed does nothing');

		seen2.length = 0;
		await l2.probe({ kind: 'dropTileAt', at: { paneKey: key(P3), segment: 'header' }, data: grip(l2.layoutId) });
		await savedIs(l2.layoutId, [P3, P1]);
		assert.deepStrictEqual(types(seen2), [], 'a move within the layout posts no tileMovedIn');
		assert.deepStrictEqual(savedShape(l1.layoutId), [P2]);

		const mirror: MirrorPanel = track(panels.openTab(A, 'w2:t1'));
		const m = await waitFor('mirror tiles', async () => {
			const p = await mirror.probe();
			return p.tiles.length === 2 && p;
		});
		assert.ok(m.tiles.every((t) => !t.grip), 'mirrored tiles have no grip');
	});

	test('mirrors: never armed, and a grip drop on one changes nothing', async () => {
		const mirror: MirrorPanel = track(panels.openTab(A, 'w2:t1'));
		await waitFor('mirror tiles', async () => (await mirror.probe()).tiles.length === 2);
		const posted: string[] = [];
		const spy = mirror as unknown as { post(msg: { type: string }): void };
		const post = spy.post.bind(mirror);
		spy.post = (msg) => {
			posted.push(msg.type);
			post(msg);
		};
		assert.strictEqual(panels.placement.arm({ sessionKey: A, paneId: P3 }, 'p3'), false, 'no Layout panel on screen');

		const layout = await besideLayout('L', stackOf(P3));
		assert.ok(panels.placement.arm({ sessionKey: A, paneId: P4 }, 'p4'), 'the Layout panel is armed');
		panels.placement.cancel();
		assert.ok(!posted.includes('placePane'), 'the mirror never is');

		const before = shape((await mirror.probe()).config?.root);
		const data = JSON.stringify({ sessionKey: A, paneId: P3, title: 'x', layoutId: layout.layoutId });
		await mirror.probe({ kind: 'dropTileAt', at: { paneKey: key(P1), segment: 'right' }, data });
		await sleep(300);
		assert.deepStrictEqual(shape((await mirror.probe()).config?.root), before);
		assert.deepStrictEqual(savedShape(layout.layoutId), [P3], 'the source keeps its tile');
	});
});
