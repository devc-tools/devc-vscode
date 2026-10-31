import * as assert from 'assert';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { bridgeRequest, herdrArgv } from '../bridge';
import { Environments } from '../environments';
import { FocusTracker } from '../focus';
import { LayoutState, LayoutStore } from '../layouts';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { PaneStreams } from '../streams';
import { LayoutPanel, MirrorPanel, TilesPanels } from '../tilesPanel';
import { makePaneKey, TileProbe } from '../tilesProtocol';

/**
 * Layout tabs in a real webview over a real herdr session, in a herdr home that
 * holds only the throwaway session `hv-test`. Skipped unless
 * HERDR_VSCODE_LIVE_HOME names that home (it needs one workspace); HOME is pointed
 * there for the suite, so no other session is listed or touched. It stops and
 * restarts that session's server.
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

(LIVE_HOME ? suite : suite.skip)('live layout tabs in an isolated herdr home', function () {
	this.timeout(90000);
	let realHome: string | undefined;
	let model: SessionModel;
	let streams: PaneStreams;
	let focus: FocusTracker;
	let store: LayoutStore;
	let panels: TilesPanels;
	let panel: LayoutPanel;
	let tabId: string;
	let workspaceId: string;
	let p1: string;
	let p2: string;
	const key = `host/${SESSION}`;
	const shell = new LocalShell();
	const req = (method: string, params: unknown) => bridgeRequest(shell, SESSION, method, params);
	const pk = (id: string) => makePaneKey(key, id);
	const tile = (tiles: TileProbe[], id: string) => tiles.find((t) => t.paneKey === pk(id));
	const exported = async () => {
		const r = (await req('layout.export', { tab_id: tabId })) as { layout: { root: unknown } };
		return JSON.stringify(r.layout.root);
	};
	const painted = (p: LayoutPanel | MirrorPanel, id: string, text: string, ms = 15000) =>
		waitFor(`"${text}" in ${id}`, ms, async () => tile((await p.probe()).tiles, id)?.text.includes(text));

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		const log = (l: string) => console.log(`[live-layouts] ${l}`);
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

		workspaceId = model.connection(key)!.snapshot!.workspaces[0].workspace_id;
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'layouts', focus: false })) as {
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

	test('panes come in live, in one Layout tab, and typing reaches them', async () => {
		const before = await exported();
		panel = panels.addToLayout(key, p1)!;
		assert.strictEqual(panel.panel.title, 'Layout 1');
		await waitFor('p1 painted', 15000, async () => tile((await panel.probe()).tiles, p1)?.text.length);
		panel.onMessage({ type: 'input', paneKey: pk(p1), text: 'echo mark-$((40+2))\r' });
		await painted(panel, p1, 'mark-42');
		assert.strictEqual(panels.addToLayout(key, p2), panel);
		await waitFor('p2 painted', 15000, async () => tile((await panel.probe()).tiles, p2)?.text.length);
		const p = await panel.probe();
		assert.strictEqual(p.tiles.length, 2);
		assert.strictEqual(controllers().length, 2, 'the tile behind the other tab keeps its stream');
		assert.strictEqual(await exported(), before, 'herdr has not changed');
	});

	test('dragging apart keeps both streams and changes nothing in herdr', async () => {
		const before = await exported();
		await panel.probe({ kind: 'dragToRightEdge', paneKey: pk(p2) });
		await waitFor('beside each other', 5000, async () => {
			const t = (await panel.probe()).tiles;
			const [a, b] = [tile(t, p1), tile(t, p2)];
			return a && b && a.width > 0 && b.width > 0 && b.x > a.x;
		});
		await painted(panel, p1, 'mark-42');
		panel.onMessage({ type: 'input', paneKey: pk(p2), text: 'echo two-$((1+1))\r' });
		await painted(panel, p2, 'two-2');
		assert.strictEqual(controllers().length, 2);
		assert.strictEqual(await exported(), before);
	});

	test('a pane also open in its mirrored tab has one controller', async () => {
		const mirror = panels.openTab(key, tabId);
		await waitFor('mirror painted', 15000, async () => {
			const t = (await mirror.probe()).tiles;
			return t.length === 2 && t.every((x) => x.text.length > 0);
		});
		assert.strictEqual(controllers().length, 2);

		// Copy as Layout: the same arrangement, and rearranging it leaves herdr alone.
		const before = await exported();
		mirror.onMessage({ type: 'copyAsLayout', config: (await mirror.probe()).config! });
		const copy = store.list().find((l) => l.name === 'layouts (' + model.connection(key)!.snapshot!.workspaces[0].label + ')');
		assert.ok(copy);
		const copied = panels.openLayout(copy.id)!;
		await waitFor('copy painted', 15000, async () => {
			const t = (await copied.probe()).tiles;
			return t.length === 2 && t.every((x) => x.text.length > 0);
		});
		await copied.probe({ kind: 'dragToRightEdge', paneKey: pk(p1) });
		await waitFor('rearranged', 5000, async () => {
			const t = (await copied.probe()).tiles;
			return (tile(t, p1)?.x ?? 0) > (tile(t, p2)?.x ?? 0);
		});
		assert.strictEqual(await exported(), before, 'TUI unchanged');
		copied.panel.dispose();
		mirror.panel.dispose();
		await sleep(200);
		assert.strictEqual(controllers().length, 2, 'the Layout tab keeps the streams');
		panel.panel.reveal();
	});

	test('closing a tile leaves the pane running in herdr, and releases its stream', async () => {
		const before = await exported();
		await panel.probe({ kind: 'clickTabClose', paneKey: pk(p2) });
		await waitFor('tile gone', 5000, async () => (await panel.probe()).tiles.length === 1);
		await waitFor('stream gone', 5000, () => !controllers().some((l) => l.includes(` ${p2} `)));
		assert.strictEqual(await exported(), before);
		assert.ok(model.connection(key)?.snapshot?.panes.some((p) => p.pane_id === p2), 'the pane is still in herdr');
		panels.addToLayout(key, p2);
		await painted(panel, p2, 'two-2');
	});

	test('pane.move to another workspace: the tile follows the new id, same terminal', async () => {
		const move = await shell.run(herdrArgv(['--session', SESSION, 'pane', 'move', p2, '--new-workspace', '--label', 'moved', '--no-focus']), { timeoutMs: 10000 });
		assert.strictEqual(move.exitCode, 0, move.stderr.toString());
		const r = JSON.parse(move.stdout.toString()) as { result: { move_result: { pane: { pane_id: string }; previous_pane_id: string } } };
		const moved = r.result.move_result.pane.pane_id;
		assert.notStrictEqual(moved, p2);
		assert.strictEqual(r.result.move_result.previous_pane_id, p2);
		await painted(panel, moved, 'two-2');
		const p = await panel.probe();
		assert.strictEqual(tile(p.tiles, p2), undefined);
		await waitFor('old stream gone, new one up', 5000, () => {
			const c = controllers();
			return !c.some((l) => l.includes(` ${p2} `)) && c.some((l) => l.includes(` ${moved} `));
		});
		panel.onMessage({ type: 'input', paneKey: pk(moved), text: 'echo moved-$((2+2))\r' });
		await painted(panel, moved, 'moved-4');
		await waitFor('saved with the new id', 5000, () => JSON.stringify(store.get(panel.layoutId)?.config).includes(`"${moved}"`));
		p2 = moved;
	});

	test('a pane closed in herdr: This pane is gone, Remove removes the tile', async () => {
		await req('pane.close', { pane_id: p2 });
		await waitFor('gone', 5000, async () => tile((await panel.probe()).tiles, p2)?.overlay.includes('This pane is gone.'));
		await panel.probe({ kind: 'clickRemove', paneKey: pk(p2) });
		await waitFor('removed', 5000, async () => {
			const t = (await panel.probe()).tiles;
			return t.length === 1 && t[0].paneKey === pk(p1);
		});
	});

	test('the session stops: Waiting for it; it comes back: the tile reconnects', async () => {
		const stop = await shell.run(herdrArgv(['--session', SESSION, 'server', 'stop']), { timeoutMs: 10000 });
		assert.strictEqual(stop.exitCode, 0, stop.stderr.toString());
		await waitFor('waiting', 30000, async () => tile((await panel.probe()).tiles, p1)?.overlay.includes('Waiting for hv-row…'));
		await waitFor('no controller', 5000, () => controllers().length === 0);
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR_')));
		const [cmd, ...args] = herdrArgv(['--session', SESSION, 'server']);
		const server = cp.spawn(cmd, args, { env, detached: true, stdio: 'ignore' });
		server.unref();
		await waitFor('reconnected', 45000, async () => {
			const t = tile((await panel.probe()).tiles, p1);
			return t && t.overlay === '' && t.text.length > 0;
		});
		assert.strictEqual(controllers().length, 1);
		panel.onMessage({ type: 'input', paneKey: pk(p1), text: 'echo back-$((5+5))\r' });
		await painted(panel, p1, 'back-10');
	});

	test('closing the Layout tab keeps it saved and leaves no controller', async () => {
		const id = panel.layoutId;
		panel.panel.dispose();
		await waitFor('no controller', 5000, () => controllers().length === 0);
		assert.ok(store.get(id));
		const again = panels.openLayout(id)!;
		await waitFor('painted again', 15000, async () => tile((await again.probe()).tiles, p1)?.text.includes('back-10'));
		again.panel.dispose();
		await waitFor('no controller', 5000, () => controllers().length === 0);
	});
});
