import * as assert from 'assert';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { bridgeRequest, herdrArgv } from '../bridge';
import { Environments } from '../environments';
import { FocusTracker } from '../focus';
import { LayoutStore } from '../layouts';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TILES_VIEW_TYPE, TilesPanels } from '../tilesPanel';
import { makePaneKey, TileProbe } from '../tilesProtocol';

/**
 * A real webview over a real herdr session: mirrored tab, frames, input, splits
 * and takeover, in a herdr home that holds only the throwaway session `hv-test`.
 * Skipped unless HERDR_VSCODE_LIVE_HOME names that home (it needs one workspace);
 * HOME is pointed there for the suite, so no other session is listed or touched.
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

/** Whether a controller of the test session is running. */
function controllers(): string[] {
	return cp
		.execFileSync('ps', ['-eo', 'args'])
		.toString()
		.split('\n')
		.filter((l) => l.includes(`--session ${SESSION} terminal session control`));
}

(LIVE_HOME ? suite : suite.skip)('live tiles in an isolated herdr home', function () {
	this.timeout(60000);
	let realHome: string | undefined;
	let model: SessionModel;
	let streams: PaneStreams;
	let focus: FocusTracker;
	let panels: TilesPanels;
	let panel: MirrorPanel;
	let tabId: string;
	let p1: string;
	let p2: string;
	let p3: string;
	const key = `host/${SESSION}`;
	const shell = new LocalShell();
	const req = (method: string, params: unknown) => bridgeRequest(shell, SESSION, method, params);
	const pk = (id: string) => makePaneKey(key, id);
	const tile = (tiles: TileProbe[], id: string) => tiles.find((t) => t.paneKey === pk(id));

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		model = new SessionModel(new Environments(() => undefined), (l) => console.log(`[live-tiles] ${l}`));
		model.start();
		await waitFor('connected', 15000, () => model.connection(key)?.state === 'connected' && model.connection(key)?.snapshot);
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const log = (l: string) => console.log(`[live-tiles] ${l}`);
		streams = new PaneStreams((k) => {
			const c = model.connection(k);
			return c && { shell: c.env.shell, name: c.name };
		}, log);
		focus = new FocusTracker(model, () => 'hv-row');
		const noLayouts = new LayoutStore({ get: () => undefined, update: () => Promise.resolve() });
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model, streams, focus, layouts: noLayouts, rowLabel: () => 'hv-row', log });

		// A new tab holding three panes: one split right, then the right one split down.
		const workspaceId = model.connection(key)!.snapshot!.workspaces[0].workspace_id;
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'mirror', focus: false })) as {
			tab: { tab_id: string };
			root_pane: { pane_id: string };
		};
		tabId = created.tab.tab_id;
		p1 = created.root_pane.pane_id;
		const split = async (target: string, direction: string) =>
			((await req('pane.split', { target_pane_id: target, direction, focus: false })) as { pane: { pane_id: string } }).pane.pane_id;
		p2 = await split(p1, 'right');
		p3 = await split(p2, 'down');
		await waitFor('tab in snapshot', 5000, () =>
			model.connection(key)?.snapshot?.panes.filter((p) => p.tab_id === tabId).length === 3,
		);
	});

	suiteTeardown(async () => {
		panels?.dispose();
		await req('tab.close', { tab_id: tabId }).catch(() => undefined);
		streams?.dispose();
		focus?.dispose();
		model?.dispose();
		process.env.HOME = realHome;
	});

	test('opens with the same arrangement and live output in each tile', async () => {
		panel = panels.openTab(key, tabId);
		assert.match(panel.panel.title, /^mirror · /);
		assert.strictEqual(panels.openTab(key, tabId), panel, 'the same tab reveals the same panel');
		const { value, after } = await waitFor('three painted tiles', 15000, async () => {
			const p = await panel.probe();
			return p.tiles.length === 3 && p.tiles.every((t) => t.text.length > 0) && p;
		});
		console.log(`[live-tiles] three painted tiles after ${after} ms`, JSON.stringify(value.tiles.map((t) => [t.title, t.x, t.y, t.width, t.height, t.cols, t.rows])));
		assert.match(value.breadcrumb, /^hv-row › .+ › mirror$/);
		const [a, b, c] = [tile(value.tiles, p1)!, tile(value.tiles, p2)!, tile(value.tiles, p3)!];
		assert.ok(b.x > a.x, 'p2 is right of p1');
		assert.strictEqual(c.x, b.x, 'p3 is under p2');
		assert.ok(c.y > b.y, 'p3 is under p2');
		assert.ok(a.height > b.height * 1.5, 'p1 spans the height');
		assert.ok(Math.abs(a.width - b.width) < 12, 'split at 50%');
		assert.strictEqual(controllers().length, 3, 'one controller per pane');
	});

	test('the pty takes the tile\'s size', async () => {
		const p = await panel.probe();
		const t = tile(p.tiles, p1)!;
		const sttyMarker = `size-${t.rows}-${t.cols}`;
		panel.onMessage({ type: 'input', paneKey: pk(p1), text: `clear; echo size-$(stty size | tr ' ' -)\r` });
		await waitFor(sttyMarker, 5000, async () => tile((await panel.probe()).tiles, p1)?.text.includes(sttyMarker));
	});

	test('a key pressed in the xterm reaches the app raw, and its output comes back', async () => {
		panel.onMessage({ type: 'input', paneKey: pk(p2), text: 'cat -v\r' });
		await sleep(300);
		await panel.probe({ kind: 'press', paneKey: pk(p2), key: 'ArrowUp', keyCode: 38 });
		await panel.probe({ kind: 'press', paneKey: pk(p2), key: 'Enter', keyCode: 13 });
		await waitFor('^[[A echoed', 5000, async () => tile((await panel.probe()).tiles, p2)?.text.includes('^[[A'));
		panel.onMessage({ type: 'input', paneKey: pk(p2), text: '\x03' });
	});

	test('Split Right: the new tile appears within 1 s, existing terminals are kept', async () => {
		const before = await panel.probe();
		panel.onMessage({ type: 'focus', paneKey: pk(p3) });
		await sleep(50);
		panel.onMessage({ type: 'split', direction: 'right' });
		const { value, after } = await waitFor('a fourth painted tile', 3000, async () => {
			const p = await panel.probe();
			return p.tiles.length === 4 && p.tiles.every((t) => t.text.length > 0) && p;
		});
		console.log(`[live-tiles] fourth tile after ${after} ms`);
		assert.ok(after < 1000, `took ${after} ms`);
		for (const t of before.tiles) {
			assert.strictEqual(tile(value.tiles, t.paneKey.split('|')[1])?.serial, t.serial, 'not re-created');
		}
		const added = value.tiles.find((t) => !before.tiles.some((o) => o.paneKey === t.paneKey))!;
		const third = tile(value.tiles, p3)!;
		assert.ok(added.x > third.x && added.y === third.y, 'it sits to the right of the focused tile');
	});

	test('a pane closed in herdr goes within 1 s, others keep their terminal and content', async () => {
		const before = await panel.probe();
		const marked = tile(before.tiles, p1)!;
		await req('pane.close', { pane_id: p3 });
		const { value, after } = await waitFor('three tiles', 3000, async () => {
			const p = await panel.probe();
			return p.tiles.length === 3 && p;
		});
		console.log(`[live-tiles] tile gone after ${after} ms`);
		assert.ok(after < 1000, `took ${after} ms`);
		assert.strictEqual(tile(value.tiles, p1)?.serial, marked.serial);
		await waitFor('p1 keeps its text', 2000, async () => tile((await panel.probe()).tiles, p1)?.text.includes('size-'));
		await waitFor('p3 controller gone', 5000, () => !controllers().some((l) => l.includes(` ${p3} `)));
	});

	test('tile headers follow the model without a re-layout', async () => {
		await req('pane.report_agent', { pane_id: p1, source: 'herdr-vscode-test', agent: 'claude', state: 'blocked' });
		const before = await panel.probe();
		await waitFor('agent label', 3000, async () => tile((await panel.probe()).tiles, p1)?.title.includes('claude'));
		const after = await panel.probe();
		assert.strictEqual(tile(after.tiles, p1)?.serial, tile(before.tiles, p1)?.serial);
		await req('pane.release_agent', { pane_id: p1, source: 'herdr-vscode-test', agent: 'claude' }).catch(() => undefined);
	});

	test('another viewer takes over; Reconnect takes the pane back', async () => {
		const other = shell.spawn(herdrArgv(['--session', SESSION, 'terminal', 'session', 'control', p1, '--takeover', '--cols', '50', '--rows', '20']));
		try {
			await waitFor('overlay', 5000, async () => tile((await panel.probe()).tiles, p1)?.overlay.includes('Opened in another viewer.'));
			panel.onMessage({ type: 'reconnect', paneKey: pk(p1) });
			await waitFor('overlay cleared', 5000, async () => tile((await panel.probe()).tiles, p1)?.overlay === '');
		} finally {
			other.stdin?.end();
			other.kill();
		}
	});

	test('openPaneTab focuses the tile, and the status bar source follows', async () => {
		panel.onMessage({ type: 'focus', paneKey: pk(p1) });
		assert.strictEqual(focus.lastFocused, pk(p1));
		assert.strictEqual(panels.openPaneTab(key, p2), panel);
		// The webview's xterm really takes the focus, and reports it.
		await waitFor('focus report', 5000, () => focus.lastFocused === pk(p2));
	});

	test('Golden Layout close control: asks the host, and the tile stays', async () => {
		// (The test host refuses to show the modal itself, and that refusal is logged.)
		const asked: unknown[] = [];
		const listener = panel.panel.webview.onDidReceiveMessage((m: { type: string; paneKey?: string }) => {
			if (m.type === 'closePane') {
				asked.push(m.paneKey);
			}
		});
		const before = await panel.probe();
		await panel.probe({ kind: 'clickClose', paneKey: pk(p2) });
		await waitFor('closePane', 2000, () => asked.length === 1);
		listener.dispose();
		assert.deepStrictEqual(asked, [pk(p2)]);
		const after = await panel.probe();
		assert.strictEqual(after.tiles.length, before.tiles.length);
		assert.strictEqual(tile(after.tiles, p2)?.serial, tile(before.tiles, p2)?.serial);
	});

	test('restore: a deserialized panel reconnects', async () => {
		panel.panel.dispose();
		await waitFor('controllers released', 5000, () => controllers().length === 0);
		const restored = vscode.window.createWebviewPanel(TILES_VIEW_TYPE, 'restored', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		await panels.deserializeWebviewPanel(restored, { kind: 'mirror', sessionKey: key, tabId });
		panel = panels.openTab(key, tabId);
		assert.strictEqual(panel.panel, restored);
		await waitFor('tiles back', 15000, async () => {
			const p = await panel.probe();
			return p.tiles.length === 3 && p.tiles.every((t) => t.text.length > 0);
		});
		assert.match(restored.title, /^mirror · /);
	});

	test('the herdr tab closed: the panel says so and releases its streams', async () => {
		await req('tab.close', { tab_id: tabId });
		await waitFor('closed message', 5000, async () => (await panel.probe()).message === 'This herdr tab was closed.');
		await waitFor('controllers gone', 5000, () => controllers().length === 0);
		assert.strictEqual((await panel.probe()).tiles.length, 0);
	});

	test('a new panel on a pane focuses its tile once the webview is up', async () => {
		const workspaceId = model.connection(key)!.snapshot!.workspaces[0].workspace_id;
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'third', focus: false })) as {
			tab: { tab_id: string };
			root_pane: { pane_id: string };
		};
		const id = created.root_pane.pane_id;
		await waitFor('new pane', 5000, () => model.connection(key)?.snapshot?.panes.some((p) => p.pane_id === id));
		const opened = panels.openPaneTab(key, id)!;
		assert.match(opened.panel.title, /^third · /);
		await waitFor('focus report', 10000, () => focus.lastFocused === pk(id));
		opened.panel.dispose();
		await req('tab.close', { tab_id: created.tab.tab_id });
	});

	test('a session that does not connect: Connecting…, then closed after 10 s', async () => {
		const stranded = panels.openTab('host/nosuch', 'w1:t1');
		await waitFor('connecting message', 5000, async () => (await stranded.probe()).message === 'Connecting to hv-row…');
		await waitFor('closed message', 12000, async () => (await stranded.probe()).message === 'This herdr tab was closed.');
		stranded.panel.dispose();
	});

	test('closing the editor tab leaves no controller within 5 s', async () => {
		// The tab is gone, so open another to hold a stream.
		const workspaceId = model.connection(key)!.snapshot!.workspaces[0].workspace_id;
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'second', focus: false })) as { tab: { tab_id: string } };
		await waitFor('new tab', 5000, () => model.connection(key)?.snapshot?.tabs.some((t) => t.tab_id === created.tab.tab_id));
		tabId = created.tab.tab_id;
		panel.panel.dispose();
		const second = panels.openTab(key, tabId);
		await waitFor('stream', 15000, () => controllers().length === 1);
		second.panel.dispose();
		const { after } = await waitFor('no controller', 5000, () => controllers().length === 0);
		console.log(`[live-tiles] no controller ${after} ms after closing the panel`);
	});
});
