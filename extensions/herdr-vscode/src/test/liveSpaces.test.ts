import * as assert from 'assert';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { bridgeRequest } from '../bridge';
import { Environments } from '../environments';
import { FocusTracker } from '../focus';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TilesPanels } from '../tilesPanel';
import { makePaneKey } from '../tilesProtocol';

/**
 * Space panels over a real herdr session: one editor tab per space, the strip
 * and herdr's active tab synced both ways, + / × / rename, a closed space. In
 * a herdr home that holds only the throwaway session `hv-test` (see liveTiles).
 * Each test works in a space of its own, made here and closed afterwards.
 */
const LIVE_HOME = process.env.HERDR_VSCODE_LIVE_HOME;
const SESSION = 'hv-test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, get: () => T | undefined | false | Promise<T | undefined | false>): Promise<{ value: T; after: number }> {
	const start = Date.now();
	let last: unknown;
	while (Date.now() - start < ms) {
		const v = await get();
		if (v) {
			return { value: v, after: Date.now() - start };
		}
		last = v;
		await sleep(25);
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** The panes of the test session that have a controller running. */
function controlledPanes(): string[] {
	return cp
		.execFileSync('ps', ['-eo', 'args'])
		.toString()
		.split('\n')
		.filter((l) => l.includes(`--session ${SESSION} terminal session control`))
		.map((l) => l.split('terminal session control ')[1]?.split(' ')[0] ?? '');
}

(LIVE_HOME ? suite : suite.skip)('live space panels in an isolated herdr home', function () {
	this.timeout(60000);
	let realHome: string | undefined;
	let model: SessionModel;
	let streams: PaneStreams;
	let focus: FocusTracker;
	let panels: TilesPanels;
	const key = `host/${SESSION}`;
	const shell = new LocalShell();
	const req = (method: string, params: unknown) => bridgeRequest(shell, SESSION, method, params);
	const pk = (id: string) => makePaneKey(key, id);
	const snap = () => model.connection(key)!.snapshot!;
	const activeTab = (workspaceId: string) => snap().workspaces.find((w) => w.workspace_id === workspaceId)?.activeTabId;
	let workspaceId: string;
	/** The space's two tabs and their root panes: `one` (made with the space), then `two`. */
	let one: { tab: string; pane: string };
	let two: { tab: string; pane: string };
	let panel: MirrorPanel;
	const tilesOf = async () => (await panel.probe()).tiles.map((t) => t.paneKey);

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		const log = (l: string) => console.log(`[live-spaces] ${l}`);
		model = new SessionModel(new Environments(() => undefined), log);
		model.start();
		await waitFor('connected', 15000, () => model.connection(key)?.state === 'connected' && model.connection(key)?.snapshot);
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		streams = new PaneStreams((k) => {
			const c = model.connection(k);
			return c && { shell: c.env.shell, name: c.name };
		}, log);
		focus = new FocusTracker(model, () => 'hv-row');
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model, streams, focus, rowLabel: () => 'hv-row', log });
	});

	setup(async () => {
		const ws = (await req('workspace.create', { label: 'spaces', focus: false })) as Record<string, Record<string, unknown>>;
		console.log(`[live-spaces] workspace.create → ${JSON.stringify(ws).slice(0, 400)}`);
		workspaceId = (ws.workspace?.workspace_id ?? (ws.workspace as unknown as Record<string, unknown>)?.id) as string;
		await waitFor('space in snapshot', 5000, () => snap().tabs.some((t) => t.workspace_id === workspaceId)).catch((err) => {
			const c = model.connection(key);
			console.log(`[live-spaces] state ${c?.state}; snapshot spaces ${JSON.stringify(c?.snapshot?.workspaces.map((w) => w.workspace_id))}`);
			throw err;
		});
		const first = snap().tabs.find((t) => t.workspace_id === workspaceId)!.tab_id;
		one = { tab: first, pane: snap().panes.find((p) => p.tab_id === first)!.pane_id };
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'two', focus: false })) as {
			tab: { tab_id: string };
			root_pane: { pane_id: string };
		};
		two = { tab: created.tab.tab_id, pane: created.root_pane.pane_id };
		await waitFor('two in snapshot', 5000, () => snap().panes.some((p) => p.pane_id === two.pane));
		assert.strictEqual(activeTab(workspaceId), one.tab, 'a tab made with focus:false is not active');
		panel = panels.openSpace(key, workspaceId);
		await waitFor('one shown', 15000, async () => JSON.stringify(await tilesOf()) === JSON.stringify([pk(one.pane)]));
	});

	teardown(async () => {
		panel?.panel.dispose();
		await req('workspace.close', { workspace_id: workspaceId }).catch(() => undefined);
		await sleep(200);
	});

	suiteTeardown(async () => {
		panels?.dispose();
		streams?.dispose();
		focus?.dispose();
		model?.dispose();
		process.env.HOME = realHome;
	});

	test('one panel titled with the space; a strip of its tabs', async () => {
		const p = await panel.probe();
		assert.strictEqual(panel.panel.title, 'hv-test · spaces');
		assert.deepStrictEqual(p.strip.length, 2);
		assert.ok(p.strip[0].startsWith('*'), `strip ${p.strip}`);
		assert.strictEqual(p.strip[1], 'two');
		assert.strictEqual(panels.openTab(key, two.tab), panel, 'a tab of the space opens the same panel');
		await waitFor('two active in herdr', 5000, () => activeTab(workspaceId) === two.tab);
	});

	test('herdr switching tabs switches the tiles within 1 s; the old tab\'s stream is released', async () => {
		await req('tab.focus', { tab_id: two.tab });
		const { after } = await waitFor('two shown', 1000, async () => JSON.stringify(await tilesOf()) === JSON.stringify([pk(two.pane)]));
		console.log(`[live-spaces] herdr tab.focus → tiles after ${after} ms`);
		const released = await waitFor('one released', 5000, () => !controlledPanes().includes(one.pane) && controlledPanes().includes(two.pane));
		console.log(`[live-spaces] old tab's controller gone after ${released.after} ms`);
	});

	test('a strip click makes it herdr\'s active tab; tab.focus and the focused space measured', async () => {
		const before = (await req('session.snapshot', {})) as { snapshot: { focused_workspace_id?: string } };
		await panel.probe({ kind: 'clickStrip', tabId: two.tab, part: 'tab' });
		const { after } = await waitFor('herdr active', 3000, () => activeTab(workspaceId) === two.tab);
		console.log(`[live-spaces] strip click → herdr active_tab_id after ${after} ms`);
		await waitFor('two shown', 2000, async () => JSON.stringify(await tilesOf()) === JSON.stringify([pk(two.pane)]));
		const later = (await req('session.snapshot', {})) as { snapshot: { focused_workspace_id?: string } };
		console.log(
			`[live-spaces] focused_workspace_id before ${before.snapshot.focused_workspace_id}, after tab.focus ${later.snapshot.focused_workspace_id} (this space ${workspaceId})`,
		);
	});

	test('+ creates a tab in this space that becomes shown', async () => {
		panel.onMessage({ type: 'newTab' });
		const { value } = await waitFor('third tab active', 5000, () => {
			const tabs = snap().tabs.filter((t) => t.workspace_id === workspaceId);
			return tabs.length === 3 && activeTab(workspaceId) === tabs[2].tab_id && tabs[2];
		});
		const pane = snap().panes.find((p) => p.tab_id === value.tab_id)!.pane_id;
		await waitFor('new tab shown', 2000, async () => JSON.stringify(await tilesOf()) === JSON.stringify([pk(pane)]));
	});

	test('rename and close go to herdr; the strip follows', async () => {
		await panel.renameTab(two.tab, 'renamed');
		await waitFor('renamed in strip', 3000, async () => (await panel.probe()).strip.includes('renamed'));
		await panel.closeTab(two.tab, false);
		await waitFor('closed in strip', 3000, async () => (await panel.probe()).strip.length === 1);
	});

	test('closing the shown tab, then the last tab: measured; a closed space closes its editor tab', async () => {
		await req('tab.focus', { tab_id: two.tab });
		await waitFor('two shown', 2000, async () => JSON.stringify(await tilesOf()) === JSON.stringify([pk(two.pane)]));
		await panel.closeTab(two.tab, false);
		await waitFor('one shown again', 3000, async () => JSON.stringify(await tilesOf()) === JSON.stringify([pk(one.pane)]));
		let disposed = false;
		panel.panel.onDidDispose(() => (disposed = true));
		const lastClose = await req('tab.close', { tab_id: one.tab }).then(
			(r) => `ok ${JSON.stringify(r).slice(0, 200)}`,
			(e: Error) => `error ${e.message}`,
		);
		await sleep(500);
		const spaceLeft = snap().workspaces.some((w) => w.workspace_id === workspaceId);
		console.log(`[live-spaces] closing a space's last tab: ${lastClose}; space still there: ${spaceLeft}; editor tab closed: ${disposed}`);
		if (spaceLeft) {
			await req('workspace.close', { workspace_id: workspaceId });
		}
		await waitFor('editor tab closed', 3000, () => disposed);
		await waitFor('no controllers', 5000, () => !controlledPanes().some((p) => p === one.pane || p === two.pane));
	});
});
