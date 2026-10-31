import * as assert from 'assert';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { bridgeRequest } from '../bridge';
import { Environments } from '../environments';
import { FocusTracker } from '../focus';
import { emptyLayoutConfig, LayoutState, LayoutStore } from '../layouts';
import { PaneDragController, paneRowRef } from '../paneDrag';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { PaneStreams } from '../streams';
import { LayoutPanel, TILES_VIEW_TYPE, TilesPanels } from '../tilesPanel';
import { makePaneKey, TileProbe } from '../tilesProtocol';
import { buildSpaces, SpacesNode } from '../views/spacesView';

/**
 * Dragging real herdr panes into Layout tabs: a Spaces row's drag arms, the
 * Layout panel places, and a grip moves a live tile to another Layout tab.
 * Skipped unless HERDR_VSCODE_LIVE_HOME names a herdr home holding only the
 * throwaway session `hv-test` (see liveLayouts.test.ts).
 */
const LIVE_HOME = process.env.HERDR_VSCODE_LIVE_HOME;
const SESSION = 'hv-test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, get: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
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

function controllers(): string[] {
	return cp
		.execFileSync('ps', ['-eo', 'args'])
		.toString()
		.split('\n')
		.filter((l) => l.includes(`--session ${SESSION} terminal session control`));
}

(LIVE_HOME ? suite : suite.skip)('live: dragging panes into Layout tabs', function () {
	this.timeout(90000);
	let realHome: string | undefined;
	let model: SessionModel;
	let streams: PaneStreams;
	let focus: FocusTracker;
	let store: LayoutStore;
	let panels: TilesPanels;
	let tabId: string;
	let p1: string;
	let p2: string;
	const key = `host/${SESSION}`;
	const shell = new LocalShell();
	const req = (method: string, params: unknown) => bridgeRequest(shell, SESSION, method, params);
	const pk = (id: string) => makePaneKey(key, id);
	const tile = (tiles: TileProbe[], id: string) => tiles.find((t) => t.paneKey === pk(id));
	const exported = async () => JSON.stringify(((await req('layout.export', { tab_id: tabId })) as { layout: { root: unknown } }).layout.root);
	const painted = (p: LayoutPanel, id: string, text: string) =>
		waitFor(`"${text}" in ${id}`, 15000, async () => tile((await p.probe()).tiles, id)?.text.includes(text));

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		const log = (l: string) => console.log(`[live-drag] ${l}`);
		model = new SessionModel(new Environments(() => undefined), log);
		model.start();
		await waitFor('connected', 15000, () => model.connection(key)?.state === 'connected' && model.connection(key)?.snapshot);
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		streams = new PaneStreams((k) => {
			const c = model.connection(k);
			return c && { shell: c.env.shell, name: c.name };
		}, log);
		focus = new FocusTracker(model, () => 'hv-row');
		const values = new Map<string, unknown>();
		const state: LayoutState = {
			get: (k) => values.get(k),
			update: (k, v) => {
				values.set(k, JSON.parse(JSON.stringify(v)));
				return Promise.resolve();
			},
		};
		store = new LayoutStore(state);
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model, streams, focus, layouts: store, rowLabel: () => 'hv-row', log });

		const workspaceId = model.connection(key)!.snapshot!.workspaces[0].workspace_id;
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'drag', focus: false })) as {
			tab: { tab_id: string };
			root_pane: { pane_id: string };
		};
		tabId = created.tab.tab_id;
		p1 = created.root_pane.pane_id;
		p2 = ((await req('pane.split', { target_pane_id: p1, direction: 'right', focus: false })) as { pane: { pane_id: string } }).pane.pane_id;
		await waitFor('tab in snapshot', 5000, () => model.connection(key)?.snapshot?.panes.filter((p) => p.tab_id === tabId).length === 2);
	});

	suiteTeardown(async () => {
		panels?.dispose();
		await req('tab.close', { tab_id: tabId }).catch(() => undefined);
		streams?.dispose();
		focus?.dispose();
		model?.dispose();
		process.env.HOME = realHome;
	});

	test('a Spaces row dragged, then a click at an edge: a live split; a grip moves it to another Layout tab', async () => {
		const before = await exported();
		const one = panels.addToLayout(key, p1)!;
		await waitFor('p1 painted', 15000, async () => tile((await one.probe()).tiles, p1)?.text.length);

		// The drag: the tree's own controller over the real snapshot.
		const controller = new PaneDragController<SpacesNode>(panels.placement, paneRowRef, (k) => model.connection(k)?.snapshot);
		const row = buildSpaces(model.connection(key)!.snapshot!, key)
			.flatMap((s) => s.children)
			.flatMap((t) => t.children)
			.find((p) => p.ref.paneId === p2)!;
		const dt = new vscode.DataTransfer();
		controller.handleDrag([row], dt);
		assert.strictEqual(await dt.get('application/vnd.herdr.pane')?.asString(), JSON.stringify([{ sessionKey: key, paneId: p2 }]));
		assert.deepStrictEqual(panels.placement.placing, { sessionKey: key, paneId: p2 });

		await one.probe({ kind: 'placeAt', at: { paneKey: pk(p1), segment: 'right' } });
		assert.strictEqual(panels.placement.placing, undefined);
		await waitFor('beside each other, both painted', 15000, async () => {
			const t = (await one.probe()).tiles;
			const [a, b] = [tile(t, p1), tile(t, p2)];
			return a && b && a.width > 0 && b.width > 0 && b.x > a.x && b.text.length > 0;
		});
		assert.strictEqual(focus.lastFocused, pk(p2));
		one.onMessage({ type: 'input', paneKey: pk(p2), text: 'echo placed-$((6*7))\r' });
		await painted(one, p2, 'placed-42');
		assert.strictEqual(controllers().length, 2);

		// The grip: into a Layout tab beside this one.
		const saved = store.create('beside', emptyLayoutConfig());
		const raw = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'beside', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
		await panels.deserializeWebviewPanel(raw, { kind: 'layout', layoutId: saved.id });
		const two = panels.openLayout(saved.id)!;
		await waitFor('beside up', 15000, async () => (await two.probe()).breadcrumb === '"beside" · layout');
		const data = JSON.stringify({ sessionKey: key, paneId: p2, title: 'shell', layoutId: one.layoutId });
		await two.probe({ kind: 'dropTileAt', at: { center: true }, data });
		await painted(two, p2, 'placed-42');
		await waitFor('gone from the first', 5000, async () => !tile((await one.probe()).tiles, p2));
		assert.strictEqual(one.showsPane(key, p2), false);
		await waitFor('one controller per pane', 5000, () => controllers().length === 2);
		two.onMessage({ type: 'input', paneKey: pk(p2), text: 'echo moved-$((2+3))\r' });
		await painted(two, p2, 'moved-5');
		assert.strictEqual(await exported(), before, 'herdr has not changed');

		raw.dispose();
		one.panel.dispose();
		await waitFor('no controller', 5000, () => controllers().length === 0);
	});
});
