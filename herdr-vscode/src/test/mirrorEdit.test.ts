import * as assert from 'assert';
import {
	changedRatios,
	clampRatio,
	dropRequests,
	dropZone,
	EDGE_ZONES_OFFERED,
	herdrPath,
	offeredZone,
	pathKeyOf,
	refusal,
	stripDropRequest,
	zoomedAfter,
	zoomRequests,
} from '../mirrorEdit';

suite('mirror edit', () => {
	test('path key ↔ herdr path: "" is the root, 1 is second', () => {
		assert.deepStrictEqual(herdrPath(''), []);
		assert.deepStrictEqual(herdrPath('01'), [false, true]);
		assert.strictEqual(pathKeyOf([]), '');
		assert.strictEqual(pathKeyOf([false, true]), '01');
		assert.strictEqual(pathKeyOf(herdrPath('1101')), '1101');
	});

	test('ratio diff: f32 noise is no change, 0.02 is; an in-flight path is skipped', () => {
		assert.deepStrictEqual(changedRatios({ '': 0.6 }, { '': 0.6000000238418579 }), {});
		assert.deepStrictEqual(changedRatios({ '': 0.6 }, { '': 0.62 }), { '': 0.62 });
		assert.deepStrictEqual(changedRatios({ '': 0.6, '1': 0.5 }, { '': 0.62, '1': 0.7 }, new Set(['1'])), { '': 0.62 });
		assert.deepStrictEqual(changedRatios({}, { '0': 0.3 }), { '0': 0.3 }, 'a new path counts');
	});

	test('clamping and rounding', () => {
		assert.strictEqual(clampRatio(0.01), 0.05);
		assert.strictEqual(clampRatio(0.99), 0.95);
		assert.strictEqual(clampRatio(0.4567), 0.457);
		assert.strictEqual(clampRatio(Number.NaN), 0.5);
	});

	test('drop zone: header and body centre are the centre; else the nearest edge, ties to the left', () => {
		const rect = { left: 100, top: 50, width: 400, height: 226 }; // body: 200 px below a 26 px header
		const body = (rx: number, ry: number) => dropZone(rect, 26, 100 + 400 * rx, 76 + 200 * ry);
		assert.strictEqual(dropZone(rect, 26, 110, 60), 'center', 'header');
		assert.strictEqual(body(0.5, 0.5), 'center');
		assert.strictEqual(body(0.1, 0.5), 'left');
		assert.strictEqual(body(0.9, 0.5), 'right');
		assert.strictEqual(body(0.5, 0.1), 'top');
		assert.strictEqual(body(0.5, 0.9), 'bottom');
		assert.strictEqual(body(0.1, 0.1), 'left', 'corner');
		assert.strictEqual(body(0.25, 0.3), 'center', 'a quarter in is the centre');
	});

	test('edges are offered: every zone is itself', () => {
		assert.strictEqual(EDGE_ZONES_OFFERED, true);
		for (const zone of ['center', 'left', 'right', 'top', 'bottom'] as const) {
			assert.strictEqual(offeredZone(zone), zone);
		}
	});

	const ctx = { tabId: 'w1:t1', workspaceId: 'w1', label: 'claude' };
	const out = { method: 'pane.move', params: { pane_id: 'w1:p1', destination: { type: 'new_tab', workspace_id: 'w1', label: 'claude' }, focus: false } };
	const back = (split: string) => ({
		method: 'pane.move',
		params: { pane_id: 'w1:p1', destination: { type: 'tab', tab_id: 'w1:t1', split, target_pane_id: 'w1:p2', ratio: 0.5 }, focus: false },
	});
	const swap = { method: 'pane.swap', params: { source_pane_id: 'w1:p1', target_pane_id: 'w1:p2' } };

	test('drop requests: the centre is one pane.swap; onto itself nothing', () => {
		assert.deepStrictEqual(dropRequests('center', 'w1:p1', 'w1:p2', ctx), [swap]);
		assert.deepStrictEqual(dropRequests('center', 'w1:p1', 'w1:p1', ctx), []);
		assert.deepStrictEqual(dropRequests('left', 'w1:p1', 'w1:p1', ctx), []);
	});

	test('drop requests: an edge moves out to a new tab and back split around the target; left and top also swap', () => {
		assert.deepStrictEqual(dropRequests('right', 'w1:p1', 'w1:p2', ctx), [out, back('right')]);
		assert.deepStrictEqual(dropRequests('bottom', 'w1:p1', 'w1:p2', ctx), [out, back('down')]);
		assert.deepStrictEqual(dropRequests('left', 'w1:p1', 'w1:p2', ctx), [out, back('right'), swap]);
		assert.deepStrictEqual(dropRequests('top', 'w1:p1', 'w1:p2', ctx), [out, back('down'), swap]);
	});

	test('strip drops: another tab is a move there (split right); + is a move to a new tab', () => {
		assert.deepStrictEqual(stripDropRequest('w1:p1', 'w1', 'w1:t2'), {
			method: 'pane.move',
			params: { pane_id: 'w1:p1', destination: { type: 'tab', tab_id: 'w1:t2', split: 'right' }, focus: false },
		});
		assert.deepStrictEqual(stripDropRequest('w1:p1', 'w1', null), {
			method: 'pane.move',
			params: { pane_id: 'w1:p1', destination: { type: 'new_tab', workspace_id: 'w1' }, focus: false },
		});
	});

	test('zoom requests: another pane off first; null turns herdr off; nothing when nothing changes', () => {
		assert.deepStrictEqual(zoomRequests('A', 'B'), [
			{ method: 'pane.zoom', params: { pane_id: 'A', mode: 'off' } },
			{ method: 'pane.zoom', params: { pane_id: 'B', mode: 'on' } },
		]);
		assert.deepStrictEqual(zoomRequests('A', null), [{ method: 'pane.zoom', params: { pane_id: 'A', mode: 'off' } }]);
		assert.deepStrictEqual(zoomRequests(undefined, null), []);
		assert.deepStrictEqual(zoomRequests(undefined, 'B'), [{ method: 'pane.zoom', params: { pane_id: 'B', mode: 'on' } }]);
		assert.deepStrictEqual(zoomRequests('B', 'B'), []);
	});

	test('answers: refusal reasons and the zoomed pane, as herdr 0.9.5 sends them', () => {
		assert.strictEqual(refusal({ type: 'pane_swap', swap: { changed: true } }), undefined);
		assert.strictEqual(refusal({ type: 'pane_swap', swap: { changed: false, reason: 'cross_tab' } }), 'cross_tab');
		assert.strictEqual(refusal({ type: 'pane_move', move_result: { changed: false, reason: 'same_tab' } }), 'same_tab');
		assert.strictEqual(zoomedAfter({ type: 'pane_zoom', zoom: { changed: true, zoomed: true, pane_id: 'w1:p2' } }), 'w1:p2');
		assert.strictEqual(zoomedAfter({ type: 'pane_zoom', zoom: { changed: true, zoomed: false, reason: 'single_pane', pane_id: 'w1:p5' } }), null);
		assert.strictEqual(zoomedAfter({}), undefined);
	});
});
