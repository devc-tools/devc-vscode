import * as assert from 'assert';
import { Baseline, BASELINE_MAX_AGE_MS, BASELINES_KEY, baselineTime, BaselineStore, memoryMemento, PaneState, paneStateIn, sinceLabel } from '../baselines';
import { sinceDescription } from '../paneContext';

suite('baselines', () => {
	const b = (at: number, tree = 'a'.repeat(40)): Baseline => ({ tree, head: 'b'.repeat(40), at });

	test('time label: today, another day; no locale formatting', () => {
		const now = new Date(2026, 9, 31, 18, 0).getTime();
		assert.strictEqual(sinceLabel(new Date(2026, 9, 31, 9, 5).getTime(), now), 'since 09:05');
		assert.strictEqual(sinceLabel(new Date(2026, 9, 30, 9, 5).getTime(), now), 'since Oct 30 09:05');
		assert.strictEqual(sinceLabel(new Date(2026, 0, 3, 23, 59).getTime(), now), 'since Jan 3 23:59');
		assert.strictEqual(sinceLabel(new Date(2025, 9, 31, 0, 0).getTime(), now), 'since Oct 31 00:00', 'a year ago is not today');
		assert.strictEqual(baselineTime(new Date(2026, 9, 31, 10, 31).getTime(), now), '10:31');
	});

	test('the section description: commits when there are any', () => {
		const now = new Date(2026, 9, 31, 18, 0).getTime();
		const at = new Date(2026, 9, 31, 10, 31).getTime();
		assert.strictEqual(sinceDescription(at, 0, now), 'since 10:31');
		assert.strictEqual(sinceDescription(at, undefined, now), 'since 10:31');
		assert.strictEqual(sinceDescription(at, 1, now), 'since 10:31 · 1 commit');
		assert.strictEqual(sinceDescription(at, 2, now), 'since 10:31 · 2 commits');
	});

	test('stored per (pane, toplevel) under herdr.paneContext.baselines; survives a new store on the same memento', async () => {
		const memento = memoryMemento();
		const store = new BaselineStore(memento);
		await store.set('host/a|w1:p1', '/r', b(1));
		await store.set('host/a|w1:p1', '/s', b(2));
		assert.deepStrictEqual(memento.get(BASELINES_KEY), { 'host/a|w1:p1\n/r': b(1), 'host/a|w1:p1\n/s': b(2) });
		const again = new BaselineStore(memento);
		assert.deepStrictEqual(again.get('host/a|w1:p1', '/r'), b(1));
		assert.strictEqual(again.get('host/a|w1:p2', '/r'), undefined);
		await again.delete('host/a|w1:p1', '/r');
		assert.strictEqual(again.get('host/a|w1:p1', '/r'), undefined);
	});

	test('malformed stored values are ignored', async () => {
		const memento = memoryMemento();
		await memento.update(BASELINES_KEY, { 'k\n/r': { tree: 1 }, 'host/a|p\n/r': b(5) });
		assert.deepStrictEqual(new BaselineStore(memento).keys(), ['host/a|p\n/r']);
		await memento.update(BASELINES_KEY, 'nonsense');
		assert.deepStrictEqual(new BaselineStore(memento).keys(), []);
	});

	test('prune: older than 7 days; a closed pane of a connected session; kept while disconnected', async () => {
		const now = 10 * BASELINE_MAX_AGE_MS;
		const store = new BaselineStore(memoryMemento());
		await store.set('host/a|w1:p1', '/r', b(now - BASELINE_MAX_AGE_MS - 1)); // old
		await store.set('host/a|w1:p2', '/r', b(now)); // present
		await store.set('host/a|w1:p3', '/r', b(now)); // closed
		await store.set('host/a|w1:p3', '/s', b(now)); // closed
		await store.set('host/b|w1:p3', '/r', b(now)); // disconnected
		const conns: Record<string, { state: string; snapshot?: { panes: { pane_id: string }[] } }> = {
			'host/a': { state: 'connected', snapshot: { panes: [{ pane_id: 'w1:p1' }, { pane_id: 'w1:p2' }] } },
			'host/b': { state: 'disconnected' },
		};
		const state = paneStateIn((k) => conns[k]);
		assert.deepStrictEqual((['host/a|w1:p2', 'host/a|w1:p3', 'host/b|w1:p3', 'host/c|x'] as const).map(state), ['present', 'closed', 'unknown', 'unknown'] as PaneState[]);
		await store.prune(state, now);
		assert.deepStrictEqual(store.keys().sort(), ['host/a|w1:p2\n/r', 'host/b|w1:p3\n/r']);
		assert.strictEqual(store.prune(state, now), undefined, 'nothing to drop: nothing written');
	});

	test('pane.moved moves every entry of the pane', async () => {
		const store = new BaselineStore(memoryMemento());
		await store.set('host/a|w1:p1', '/r', b(1));
		await store.set('host/a|w1:p1', '/s', b(2));
		await store.set('host/a|w1:p2', '/r', b(3));
		await store.move('host/a|w1:p1', 'host/a|w9:p1');
		assert.deepStrictEqual(store.keys().sort(), ['host/a|w1:p2\n/r', 'host/a|w9:p1\n/r', 'host/a|w9:p1\n/s']);
		assert.deepStrictEqual(store.get('host/a|w9:p1', '/s'), b(2));
		assert.strictEqual(store.move('host/a|w1:p1', 'host/a|x'), undefined);
	});
});
