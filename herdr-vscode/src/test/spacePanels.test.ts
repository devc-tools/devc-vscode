import * as assert from 'assert';
import * as vscode from 'vscode';
import { HerdrEvent } from '../bridge';
import { FocusTracker } from '../focus';
import { LayoutStore } from '../layouts';
import { SessionConnection, SessionModel, Snapshot } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TILES_VIEW_TYPE, TilesPanels } from '../tilesPanel';
import { makePaneKey } from '../tilesProtocol';
import { RAW_SNAPSHOT, snapshot } from './fixtures';

/**
 * Space panels: one editor tab per herdr space, showing the space's active tab,
 * in a real webview over a made-up model. Space `w1` ("web") has two
 * single-pane tabs, `w1:t2` "logs" (pane `w1:p2`) then `w1:t1` "1" (`w1:p1`),
 * and `w1:t1` is active. Needs `npm run build`.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, get: () => T | undefined | false | Promise<T | undefined | false>, ms = 10000): Promise<T> {
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
const pk = (id: string) => makePaneKey(S, id);

class FakeHerdr {
	readonly changed = new vscode.EventEmitter<void>();
	readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	readonly onDidChange = this.changed.event;
	readonly onDidEvent = this.events.event;
	snap: Snapshot;
	readonly requests: { method: string; params: Record<string, unknown> }[] = [];
	/** Delays `layout.export` of these tabs (ms). */
	readonly exportDelay = new Map<string, number>();

	constructor() {
		const raw = JSON.parse(JSON.stringify(RAW_SNAPSHOT)) as typeof RAW_SNAPSHOT;
		(raw.panes.find((p) => p.pane_id === 'w1:p1') as Record<string, unknown>).foreground_cwd = '/src/web/app';
		this.snap = snapshot(raw);
	}

	connection(key: string): SessionConnection | undefined {
		return key === S ? ({ state: 'connected', snapshot: this.snap, name: 'a' } as unknown as SessionConnection) : undefined;
	}

	edits(): { method: string; params: Record<string, unknown> }[] {
		return this.requests.filter((r) => r.method !== 'layout.export');
	}

	/** herdr makes `tabId` its space's active tab, and a new snapshot arrives. */
	activate(tabId: string): void {
		const tab = this.snap.tabs.find((t) => t.tab_id === tabId)!;
		this.snap = {
			...this.snap,
			workspaces: this.snap.workspaces.map((w) => (w.workspace_id === tab.workspace_id ? { ...w, activeTabId: tabId } : w)),
		};
		this.changed.fire();
	}

	async request(_key: string, method: string, params: Record<string, unknown>): Promise<unknown> {
		this.requests.push({ method, params });
		switch (method) {
			case 'layout.export': {
				const tabId = params.tab_id as string;
				await sleep(this.exportDelay.get(tabId) ?? 0);
				const panes = this.snap.panes.filter((p) => p.tab_id === tabId);
				const tab = this.snap.tabs.find((t) => t.tab_id === tabId)!;
				return {
					type: 'layout_export',
					layout: { tab_id: tabId, workspace_id: tab.workspace_id, zoomed: false, focused_pane_id: panes[0].pane_id, root: { type: 'pane', pane_id: panes[0].pane_id } },
				};
			}
			case 'tab.focus':
				setTimeout(() => this.activate(params.tab_id as string), 30);
				return { type: 'tab_info' };
			case 'tab.create':
			case 'tab.close':
			case 'tab.rename':
				return { type: 'ok' };
		}
		throw new Error(`unexpected ${method}`);
	}
}

suite('space panels', function () {
	this.timeout(30000);
	let herdr: FakeHerdr;
	let focus: FocusTracker;
	let streams: PaneStreams;
	let panels: TilesPanels;
	const extra: vscode.WebviewPanel[] = [];

	/** The pane ids of the tiles on screen. */
	const shown = async (panel: MirrorPanel) => (await panel.probe()).tiles.map((t) => t.paneKey).sort();
	const showing = (panel: MirrorPanel, ...ids: string[]) =>
		waitFor(`tiles ${ids}`, async () => {
			const keys = await shown(panel);
			return JSON.stringify(keys) === JSON.stringify(ids.map(pk).sort()) && keys;
		});

	setup(() => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		herdr = new FakeHerdr();
		const fake = herdr as unknown as SessionModel;
		focus = new FocusTracker(fake, () => 'row');
		streams = new PaneStreams(() => undefined, () => undefined);
		const noLayouts = new LayoutStore({ get: () => undefined, update: () => Promise.resolve() });
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model: fake, streams, focus, layouts: noLayouts, rowLabel: (k) => `row ${k}`, log: () => undefined });
	});

	teardown(async () => {
		panels.dispose();
		for (const p of extra.splice(0)) {
			p.dispose();
		}
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		streams.dispose();
		focus.dispose();
		await sleep(50);
	});

	test('one panel per space, titled with the space; it shows the active tab and a strip of the space\'s tabs', async () => {
		const web = panels.openSpace(S, 'w1');
		assert.strictEqual(web.panel.title, 'web');
		await showing(web, 'w1:p1');
		const probe = await web.probe();
		assert.deepStrictEqual(probe.strip, ['logs', '*1']);
		assert.strictEqual(probe.breadcrumb, `row ${S} › web`);
		assert.strictEqual(panels.openSpace(S, 'w1'), web);
		assert.strictEqual(panels.openTab(S, 'w1:t2'), web, 'another tab of the space: the same panel');
		const api = panels.openTab(S, 'w2:t1');
		assert.notStrictEqual(api, web, 'another space: another panel');
		assert.strictEqual(api?.panel.title, 'api');
		assert.deepStrictEqual(herdr.edits().filter((r) => r.method === 'tab.focus').map((r) => r.params), [{ tab_id: 'w1:t2' }], 'only the inactive tab is focused');
	});

	test('a strip click shows the tab at once, focuses it in herdr; showsPane follows the shown tab', async () => {
		const web = panels.openSpace(S, 'w1');
		await showing(web, 'w1:p1');
		assert.strictEqual(web.showsPane(S, 'w1:p1'), true);
		assert.strictEqual(web.showsPane(S, 'w1:p2'), false);
		await web.probe({ kind: 'clickStrip', tabId: 'w1:t2', part: 'tab' });
		await showing(web, 'w1:p2');
		assert.deepStrictEqual(herdr.edits(), [{ method: 'tab.focus', params: { tab_id: 'w1:t2' } }]);
		assert.strictEqual(web.showsPane(S, 'w1:p2'), true);
		assert.strictEqual(web.showsPane(S, 'w1:p1'), false);
		await waitFor('strip active', async () => (await web.probe()).strip[0] === '*logs');
		await sleep(300);
		assert.deepStrictEqual(await shown(web), [pk('w1:p2')], 'herdr\'s snapshot agrees: it stays');
	});

	test('herdr switching the space\'s tab switches the tiles', async () => {
		const web = panels.openSpace(S, 'w1');
		await showing(web, 'w1:p1');
		herdr.activate('w1:t2');
		await showing(web, 'w1:p2');
		herdr.activate('w1:t1');
		await showing(web, 'w1:p1');
		assert.deepStrictEqual(herdr.edits(), [], 'following herdr asks herdr nothing');
	});

	test('a tab.focus error goes back to herdr\'s tab', async () => {
		const web = panels.openSpace(S, 'w1');
		await showing(web, 'w1:p1');
		const request = herdr.request.bind(herdr);
		herdr.request = (key, method, params) => (method === 'tab.focus' ? Promise.reject(new Error('no')) : request(key, method, params));
		await web.selectTab('w1:t2');
		await showing(web, 'w1:p1');
	});

	test('an old tab\'s late export is dropped', async () => {
		herdr.exportDelay.set('w1:t1', 400);
		const web = panels.openSpace(S, 'w1');
		await sleep(150); // w1:t1's export is in flight
		herdr.activate('w1:t2');
		await showing(web, 'w1:p2');
		await sleep(700);
		assert.deepStrictEqual(await shown(web), [pk('w1:p2')]);
	});

	test('openPaneTab focuses the pane\'s tab, then its tile', async () => {
		const web = panels.openPaneTab(S, 'w1:p2')!;
		await showing(web, 'w1:p2');
		await waitFor('tile focus', () => focus.lastFocused === pk('w1:p2'));
	});

	test('+, × and rename go to herdr', async () => {
		const web = panels.openSpace(S, 'w1');
		await showing(web, 'w1:p1');
		web.onMessage({ type: 'newTab' });
		await waitFor('tab.create', () => herdr.edits().length === 1);
		assert.deepStrictEqual(herdr.edits()[0], { method: 'tab.create', params: { workspace_id: 'w1', cwd: '/src/web/app', focus: true } });
		herdr.activate('w1:t2');
		await showing(web, 'w1:p2');
		web.onMessage({ type: 'newTab' });
		await waitFor('tab.create', () => herdr.edits().length === 2);
		assert.deepStrictEqual(herdr.edits()[1].params, { workspace_id: 'w1', cwd: '/src/web', focus: true }, 'no foreground_cwd: cwd');
		await web.closeTab('w1:t1', false);
		await web.renameTab('w1:t2', ' new name ');
		await web.renameTab('w1:t2', '  ');
		assert.deepStrictEqual(herdr.edits().slice(2), [
			{ method: 'tab.close', params: { tab_id: 'w1:t1' } },
			{ method: 'tab.rename', params: { tab_id: 'w1:t2', label: 'new name' } },
		]);
	});

	test('a closed space says so', async () => {
		const web = panels.openSpace(S, 'w1');
		await showing(web, 'w1:p1');
		herdr.snap = { ...herdr.snap, workspaces: herdr.snap.workspaces.filter((w) => w.workspace_id !== 'w1'), tabs: herdr.snap.tabs.filter((t) => t.workspace_id !== 'w1') };
		herdr.events.fire({ sessionKey: S, event: { event: 'workspace.closed', data: { workspace_id: 'w1' } } });
		await waitFor('closed text', async () => (await web.probe()).message === 'This herdr space was closed.');
		assert.strictEqual(web.showsPane(S, 'w1:p1'), false);
	});

	test('an older build\'s tab state restores as that tab\'s space, without focusing the tab', async () => {
		const panel = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'old', vscode.ViewColumn.Active, { enableScripts: true });
		extra.push(panel);
		await panels.deserializeWebviewPanel(panel, { kind: 'mirror', sessionKey: S, tabId: 'w1:t2' });
		const web = panels.openSpace(S, 'w1');
		assert.strictEqual(web.panel, panel, 'the restored panel is the space\'s');
		assert.strictEqual(web.panel.title, 'web');
		await showing(web, 'w1:p1');
		assert.deepStrictEqual(herdr.edits(), []);

		const gone = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'old', vscode.ViewColumn.Active, { enableScripts: true });
		extra.push(gone);
		await panels.deserializeWebviewPanel(gone, { kind: 'mirror', sessionKey: S, tabId: 'w9:t9' });
		await sleep(300);
		const goneMirror = (panels as unknown as { allPanels(): MirrorPanel[] }).allPanels().find((p) => p.panel === gone)!;
		await waitFor('closed text', async () => (await goneMirror.probe()).message === 'This herdr space was closed.');
	});

	test('a second restored panel of one space is dropped', async () => {
		const first = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'a', vscode.ViewColumn.Active, { enableScripts: true });
		const second = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'b', vscode.ViewColumn.Active, { enableScripts: true });
		extra.push(first, second);
		let disposed = false;
		second.onDidDispose(() => (disposed = true));
		await panels.deserializeWebviewPanel(first, { kind: 'space', sessionKey: S, workspaceId: 'w1' });
		await panels.deserializeWebviewPanel(second, { kind: 'mirror', sessionKey: S, tabId: 'w1:t1' });
		assert.strictEqual(disposed, true);
		assert.strictEqual(panels.openSpace(S, 'w1').panel, first);
	});
});
