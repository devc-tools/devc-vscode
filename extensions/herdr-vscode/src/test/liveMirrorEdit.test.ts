import * as assert from 'assert';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { bridgeRequest } from '../bridge';
import { Environments } from '../environments';
import { FocusTracker } from '../focus';
import { LayoutNode, parseLayoutExport } from '../layoutMapping';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TilesPanels } from '../tilesPanel';
import { makePaneKey, TileProbe } from '../tilesProtocol';

/**
 * A mirrored tab editing a real herdr tab: splitter drags, tile drops and
 * maximise go to herdr, and herdr's ratio and zoom changes come back, in a herdr
 * home that holds only the throwaway session `hv-test`. Skipped unless
 * HERDR_VSCODE_LIVE_HOME names that home (it needs one workspace).
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

function controllers(): string[] {
	return cp
		.execFileSync('ps', ['-eo', 'args'])
		.toString()
		.split('\n')
		.filter((l) => l.includes(`--session ${SESSION} terminal session control`));
}

/** A tree as text, without ratios: `(right p1 (down p2 p3))`. */
function text(node: LayoutNode): string {
	return node.type === 'pane' ? node.pane_id : `(${node.direction} ${text(node.first)} ${text(node.second)})`;
}

(LIVE_HOME ? suite : suite.skip)('live mirror edits in an isolated herdr home', function () {
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
	const extraTabs: string[] = [];
	const key = `host/${SESSION}`;
	const shell = new LocalShell();
	const req = (method: string, params: unknown) => bridgeRequest(shell, SESSION, method, params);
	const pk = (id: string) => makePaneKey(key, id);
	const tile = (tiles: TileProbe[], id: string) => tiles.find((t) => t.paneKey === pk(id))!;
	const exported = async () => parseLayoutExport(await req('layout.export', { tab_id: tabId }))!;

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		const log = (l: string) => console.log(`[live-mirror] ${l}`);
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

		// Its own tab: p1 | (p2 / p3).
		const workspaceId = model.connection(key)!.snapshot!.workspaces[0].workspace_id;
		const created = (await req('tab.create', { workspace_id: workspaceId, label: 'edits', focus: false })) as {
			tab: { tab_id: string };
			root_pane: { pane_id: string };
		};
		tabId = created.tab.tab_id;
		p1 = created.root_pane.pane_id;
		const split = async (target: string, direction: string) =>
			((await req('pane.split', { target_pane_id: target, direction, focus: false })) as { pane: { pane_id: string } }).pane.pane_id;
		p2 = await split(p1, 'right');
		p3 = await split(p2, 'down');
		await waitFor('tab in snapshot', 5000, () => model.connection(key)?.snapshot?.panes.filter((p) => p.tab_id === tabId).length === 3);
		panel = panels.openTab(key, tabId)!;
		await waitFor('three painted tiles', 15000, async () => {
			const p = await panel.probe();
			return p.tiles.length === 3 && p.tiles.every((t) => t.text.length > 0) && p;
		});
		for (const id of [p1, p2, p3]) {
			panel.onMessage({ type: 'input', paneKey: pk(id), text: `clear; echo mark-${id.replace(/\W/g, '')}\r` });
		}
		await waitFor('marks', 5000, async () => {
			const t = (await panel.probe()).tiles;
			return [p1, p2, p3].every((id) => tile(t, id).text.includes(`mark-${id.replace(/\W/g, '')}`));
		});
	});

	suiteTeardown(async () => {
		panels?.dispose();
		for (const id of [tabId, ...extraTabs]) {
			await req('tab.close', { tab_id: id }).catch(() => undefined);
		}
		streams?.dispose();
		focus?.dispose();
		model?.dispose();
		process.env.HOME = realHome;
	});

	test('a splitter drag to 0.3 is herdr\'s root ratio within 1 s', async () => {
		const start = Date.now();
		await panel.probe({ kind: 'dragSplitter', splitId: 'split:', fraction: 0.3 });
		const { value } = await waitFor('herdr root at 0.3', 1000, async () => {
			const root = (await exported()).root;
			return root.type === 'split' && Math.abs(root.ratio - 0.3) <= 0.01 && root;
		});
		console.log(`[live-mirror] root ratio ${(value as { ratio: number }).ratio} after ${Date.now() - start} ms`);
	});

	test('set_split_ratio from outside on [true]: the column\'s tiles resize in place within 1 s', async () => {
		const before = await panel.probe();
		await req('layout.set_split_ratio', { tab_id: tabId, path: [true], ratio: 0.7 });
		const { value, after } = await waitFor('p2 at 70% of the column', 1000, async () => {
			const p = await panel.probe();
			const [b, c] = [tile(p.tiles, p2), tile(p.tiles, p3)];
			return Math.abs(b.height / (b.height + c.height) - 0.7) < 0.03 && p;
		});
		console.log(`[live-mirror] column resized after ${after} ms`);
		for (const id of [p1, p2, p3]) {
			assert.strictEqual(tile(value.tiles, id).serial, tile(before.tiles, id).serial, `${id} kept its terminal`);
		}
	});

	/** Pane id → terminal id, from herdr (the model's snapshot does not keep terminal ids). */
	const terminals = async () => {
		const raw = (await req('session.snapshot', {})) as { snapshot: { panes: { pane_id: string; terminal_id: string }[] } };
		return new Map(raw.snapshot.panes.map((p) => [p.pane_id, p.terminal_id]));
	};
	const tabCount = () => model.connection(key)!.snapshot!.tabs.length;

	test('p3 dropped on p1\'s left edge: herdr splits p1 with p3 on the left, same panes and terminals, no extra tab', async () => {
		const before = await panel.probe();
		const [terms, tabs] = [await terminals(), tabCount()];
		const start = Date.now();
		await panel.probe({ kind: 'dragTile', paneKey: pk(p3), targetPaneKey: pk(p1), zone: 'left' });
		const { value: layout } = await waitFor('moved in herdr', 5000, async () => {
			const l = await exported();
			return text(l.root) === `(right (right ${p3} ${p1}) ${p2})` && l;
		});
		const { value, after } = await waitFor('tiles follow', 5000, async () => {
			const p = await panel.probe();
			return p.tiles.length === 3 && tile(p.tiles, p3).x < tile(p.tiles, p1).x && tile(p.tiles, p1).x < tile(p.tiles, p2).x && p;
		});
		console.log(`[live-mirror] edge drop shown after ${Date.now() - start} ms (tiles ${after} ms after herdr)`, text(layout.root));
		for (const id of [p1, p2, p3]) {
			assert.strictEqual(tile(value.tiles, id).serial, tile(before.tiles, id).serial, `${id} kept its tile`);
		}
		await waitFor('the passing tab gone', 5000, () => tabCount() === tabs);
		assert.deepStrictEqual(await terminals(), terms, 'every pane kept its terminal');
		await waitFor('p3 shows its old screen', 3000, async () => tile((await panel.probe()).tiles, p3).text.includes(`mark-${p3.replace(/\W/g, '')}`));
	});

	test('p2 dropped on p3\'s top edge: p2 above p3', async () => {
		await panel.probe({ kind: 'dragTile', paneKey: pk(p2), targetPaneKey: pk(p3), zone: 'top' });
		await waitFor('moved in herdr', 5000, async () => text((await exported()).root) === `(right (down ${p2} ${p3}) ${p1})`);
		await waitFor('tiles follow', 5000, async () => {
			const p = await panel.probe();
			return tile(p.tiles, p2).y < tile(p.tiles, p3).y && p;
		});
	});

	test('p1 dropped on p2\'s centre: p1 and p2 exchanged in herdr', async () => {
		await panel.probe({ kind: 'dragTile', paneKey: pk(p1), targetPaneKey: pk(p2), zone: 'center' });
		await waitFor('swapped in herdr', 5000, async () => text((await exported()).root) === `(right (down ${p1} ${p3}) ${p2})`);
		await waitFor('tiles follow', 5000, async () => {
			const p = await panel.probe();
			return tile(p.tiles, p1).y < tile(p.tiles, p3).y && tile(p.tiles, p2).x > tile(p.tiles, p1).x && p;
		});
	});

	test('maximise zooms herdr; unzoom from outside restores the tile within 1 s', async () => {
		await panel.probe({ kind: 'clickMaximise', paneKey: pk(p2) });
		const { value } = await waitFor('herdr zoomed on p2', 5000, async () => {
			const l = await exported();
			return l.zoomed && l;
		});
		assert.strictEqual(value.focused_pane_id, p2);
		assert.strictEqual((await panel.probe()).maximised, pk(p2));
		await req('pane.zoom', { pane_id: p2, mode: 'off' });
		const { after } = await waitFor('nothing maximised', 1000, async () => (await panel.probe()).maximised === null);
		console.log(`[live-mirror] unzoom shown after ${after} ms`);
		assert.strictEqual((await exported()).zoomed, false);
	});

	test('p3 dropped on +: a new herdr tab holds it; p2 dropped on that tab\'s strip entry joins it', async () => {
		const tabsBefore = new Set(model.connection(key)!.snapshot!.tabs.map((t) => t.tab_id));
		const stripBefore = (await panel.probe()).strip.length;
		const term3 = (await terminals()).get(p3);
		await panel.probe({ kind: 'dragTileToStrip', paneKey: pk(p3), tabId: null });
		const { value: newTab } = await waitFor('p3 in a new tab', 5000, () => {
			const p = model.connection(key)!.snapshot!.panes.find((x) => x.pane_id === p3);
			return p && !tabsBefore.has(p.tab_id) && p.tab_id;
		});
		extraTabs.push(newTab);
		assert.strictEqual((await terminals()).get(p3), term3, 'p3 kept its terminal');
		await waitFor('two tiles left', 5000, async () => (await panel.probe()).tiles.length === 2);
		assert.strictEqual((await panel.probe()).strip.filter((e) => e.startsWith('*')).length, 1, 'the panel still shows one tab');
		await waitFor('the new tab on the strip', 5000, async () => (await panel.probe()).strip.length === stripBefore + 1);
		await panel.probe({ kind: 'dragTileToStrip', paneKey: pk(p2), tabId: newTab });
		await waitFor('p2 in the new tab', 5000, () => model.connection(key)!.snapshot!.panes.find((x) => x.pane_id === p2)?.tab_id === newTab);
		await waitFor('one tile left', 5000, async () => (await panel.probe()).tiles.length === 1);
	});

	test('no controller is left once the panel closes', async () => {
		panel.panel.dispose();
		await waitFor('no controllers', 5000, () => controllers().length === 0);
	});
});
