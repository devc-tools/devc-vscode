import * as assert from 'assert';
import { GlItem, StoredLayoutConfig } from '../layoutMapping';
import {
	addPaneAtRoot,
	addPlacement,
	asLayoutConfig,
	copyLayoutName,
	emptyLayoutConfig,
	LAYOUT_SETTINGS,
	layoutPaneKeys,
	LayoutState,
	LAYOUTS_KEY,
	LayoutStore,
	nextLayoutName,
	parsePaneMoved,
	rewritePane,
	selectLayoutTarget,
	uniqueLayoutName,
} from '../layouts';
import { layoutTileMetas, paneAvailability } from '../tilesPanel';
import { snapshot } from './fixtures';

/** As `vscode.Memento` does it: values come back through JSON. */
function memento(): LayoutState & { raw: Map<string, string> } {
	const raw = new Map<string, string>();
	return {
		raw,
		get: (key) => {
			const v = raw.get(key);
			return v === undefined ? undefined : JSON.parse(v);
		},
		update: (key, value) => {
			raw.set(key, JSON.stringify(value));
			return Promise.resolve();
		},
	};
}

const comp = (paneId: string, sessionKey = 'host/s') => ({
	type: 'component' as const,
	componentType: 'pane' as const,
	componentState: { sessionKey, paneId },
	title: paneId,
});
const stack = (paneId: string, size?: string): GlItem => ({ type: 'stack', ...(size ? { size } : {}), content: [comp(paneId)] });
const withRoot = (root: GlItem): StoredLayoutConfig => ({ ...emptyLayoutConfig(), root });

suite('layout target selection', () => {
	const open = new Set(['a', 'b']);

	test('the active Layout panel', () => {
		assert.strictEqual(selectLayoutTarget('b', ['a', 'b'], open), 'b');
	});

	test('else the most recently active one still open', () => {
		assert.strictEqual(selectLayoutTarget(undefined, ['a', 'b'], open), 'a');
		assert.strictEqual(selectLayoutTarget(undefined, ['gone', 'b', 'a'], open), 'b');
		assert.strictEqual(selectLayoutTarget('gone', ['b'], open), 'b');
	});

	test('none open: undefined, meaning a new layout', () => {
		assert.strictEqual(selectLayoutTarget(undefined, ['closed'], new Set()), undefined);
		assert.strictEqual(selectLayoutTarget(undefined, [], new Set()), undefined);
	});
});

suite('layout naming', () => {
	test('Layout <n> with the lowest free n', () => {
		assert.strictEqual(nextLayoutName([]), 'Layout 1');
		assert.strictEqual(nextLayoutName(['Layout 1']), 'Layout 2');
		assert.strictEqual(nextLayoutName(['Layout 2', 'Other']), 'Layout 1');
		assert.strictEqual(nextLayoutName(['Layout 1', 'Layout 3']), 'Layout 2');
	});

	test('Copy as Layout: <tab> (<space>), suffixed when taken', () => {
		assert.strictEqual(copyLayoutName('agents', 'v3_auth', []), 'agents (v3_auth)');
		assert.strictEqual(copyLayoutName('agents', 'v3_auth', ['agents (v3_auth)']), 'agents (v3_auth) 2');
		assert.strictEqual(copyLayoutName('agents', 'v3_auth', ['agents (v3_auth)', 'agents (v3_auth) 2']), 'agents (v3_auth) 3');
		assert.strictEqual(uniqueLayoutName('x', ['y']), 'x');
	});
});

suite('layout store', () => {
	test('round-trips a config through workspace state', () => {
		const state = memento();
		const store = new LayoutStore(state);
		const config: StoredLayoutConfig = {
			resolved: true,
			root: { type: 'row', size: '100%', content: [stack('a', '60%'), { type: 'stack', content: [comp('b'), comp('c', 'container:x/devc')] }] },
			settings: LAYOUT_SETTINGS,
			header: { popout: false },
			dimensions: { borderWidth: 3, headerHeight: 26 },
		};
		const made = store.create('Layout 1');
		store.setConfig(made.id, config);
		const again = new LayoutStore(state);
		assert.deepStrictEqual(again.get(made.id), { id: made.id, name: 'Layout 1', config });
		assert.ok(state.raw.has(LAYOUTS_KEY));
		assert.match(made.id, /^[0-9a-f-]{36}$/);
	});

	test('rename keeps names unique; delete removes', () => {
		const store = new LayoutStore(memento());
		const a = store.create('a');
		const b = store.create('b');
		assert.strictEqual(store.rename(a.id, 'b'), false);
		assert.strictEqual(store.rename(a.id, 'a'), true);
		assert.strictEqual(store.rename(a.id, 'c'), true);
		assert.deepStrictEqual(store.names(), ['c', 'b']);
		assert.strictEqual(store.rename('gone', 'x'), false);
		store.delete(a.id);
		assert.deepStrictEqual(store.names(), ['b']);
		store.setConfig(a.id, emptyLayoutConfig());
		assert.deepStrictEqual(store.list().map((l) => l.id), [b.id]);
	});

	test('junk in workspace state counts as nothing', () => {
		const state = memento();
		void state.update(LAYOUTS_KEY, [{ id: 1 }, 'x', { id: 'ok', name: 'n', config: {} }]);
		assert.deepStrictEqual(new LayoutStore(state).names(), ['n']);
		void state.update(LAYOUTS_KEY, 'nope');
		assert.deepStrictEqual(new LayoutStore(state).list(), []);
	});
});

suite('adding a pane to a layout', () => {
	const config = withRoot(stack('a'));

	test('a pane already present: no new component', () => {
		assert.strictEqual(addPlacement(config, { sessionKey: 'host/s', paneId: 'a' }, true), 'reveal');
		assert.strictEqual(addPlacement(config, { sessionKey: 'host/s', paneId: 'a' }, false), 'reveal');
	});

	test('the same pane id in another session is another pane', () => {
		assert.strictEqual(addPlacement(config, { sessionKey: 'host/other', paneId: 'a' }, true), 'focusedStack');
	});

	test('otherwise the focused stack, else the root', () => {
		assert.strictEqual(addPlacement(config, { sessionKey: 'host/s', paneId: 'b' }, true), 'focusedStack');
		assert.strictEqual(addPlacement(config, { sessionKey: 'host/s', paneId: 'b' }, false), 'root');
		assert.strictEqual(addPlacement(emptyLayoutConfig(), { sessionKey: 'host/s', paneId: 'b' }, false), 'root');
	});

	const pane = { sessionKey: 'host/s', paneId: 'new' };

	test('at the root of an empty layout: a stack', () => {
		assert.deepStrictEqual(addPaneAtRoot(emptyLayoutConfig(), pane, 'new').root, { type: 'stack', content: [comp('new')] });
	});

	test('at the root of a stack or column: wrapped in a row, on the right', () => {
		assert.deepStrictEqual(addPaneAtRoot(config, pane, 'new').root, {
			type: 'row',
			content: [{ ...stack('a'), size: '50%' }, stack('new', '50%')],
		});
		const column: GlItem = { type: 'column', content: [stack('a', '50%'), stack('b', '50%')] };
		const added = addPaneAtRoot(withRoot(column), pane, 'new').root as { type: string; content: GlItem[] };
		assert.strictEqual(added.type, 'row');
		assert.strictEqual(added.content[0].type, 'column');
	});

	test('at the root of a row: a new column on the right, shares kept', () => {
		const added = addPaneAtRoot(withRoot({ type: 'row', content: [stack('a', '75%'), stack('b', '25%')] }), pane, 'new').root as { content: GlItem[] };
		assert.deepStrictEqual(added.content.map((c) => parseFloat(c.size ?? '')).map(Math.round), [50, 17, 33]);
		assert.deepStrictEqual(layoutPaneKeys({ root: added as GlItem }), ['host/s|a', 'host/s|b', 'host/s|new']);
	});

	test('sizes that are not percentages become equal shares', () => {
		const added = addPaneAtRoot(withRoot({ type: 'row', content: [stack('a', '1fr'), stack('b', '1fr')] }), pane, 'new').root as { content: GlItem[] };
		assert.deepStrictEqual(added.content.map((c) => Math.round(parseFloat(c.size ?? ''))), [33, 33, 33]);
	});
});

suite('pane moves and copies', () => {
	test('pane.moved as captured from herdr 0.9.5', () => {
		assert.deepStrictEqual(parsePaneMoved({ previous_pane_id: 'w1:p2', previous_tab_id: 'w1:t2', pane: { pane_id: 'w2:p1', tab_id: 'w2:t1' } }), { from: 'w1:p2', to: 'w2:p1' });
		assert.strictEqual(parsePaneMoved({ previous_pane_id: 'w1:p2', pane: { pane_id: 'w1:p2', tab_id: 'w1:t2' } }), undefined, 'a move inside a workspace keeps the id');
		assert.strictEqual(parsePaneMoved({ pane: { pane_id: 'w1:p2' } }), undefined);
		assert.strictEqual(parsePaneMoved({}), undefined);
	});

	test('rewritePane follows the id, in that session only', () => {
		const config = withRoot({ type: 'row', content: [stack('a'), { type: 'stack', content: [comp('a', 'host/other'), comp('b')] }] });
		const moved = rewritePane(config, 'host/s', 'a', 'z');
		assert.deepStrictEqual(layoutPaneKeys(moved), ['host/s|z', 'host/other|a', 'host/s|b']);
		assert.strictEqual(rewritePane(config, 'host/s', 'nope', 'z'), config, 'unchanged is the same object');
		assert.deepStrictEqual(layoutPaneKeys(config), ['host/s|a', 'host/other|a', 'host/s|b'], 'the original is untouched');
	});

	test('Copy as Layout enables reorder on the settings and on every tile', () => {
		const mirrored: StoredLayoutConfig = {
			resolved: true,
			root: { type: 'row', content: [{ type: 'stack', content: [{ ...comp('a'), reorderEnabled: false }] }] },
			settings: { ...LAYOUT_SETTINGS, reorderEnabled: false },
			header: { popout: false },
			dimensions: { borderWidth: 3, headerHeight: 26 },
		};
		const copy = asLayoutConfig(mirrored);
		assert.strictEqual(copy.settings.reorderEnabled, true);
		const row = copy.root as { content: { content: { reorderEnabled?: boolean }[] }[] };
		assert.strictEqual(row.content[0].content[0].reorderEnabled, true);
		assert.strictEqual(copy.resolved, true);
	});
});

suite('layout tiles', () => {
	const s = snapshot();
	const of = (key: string) => (key === 'gone' ? undefined : s);

	test('headers: the space faded, and the session too when the layout spans sessions', () => {
		assert.deepStrictEqual(layoutTileMetas(['host/a|w2:p1', 'host/a|w2:p2', 'host/a|nope'], of, () => 'row'), [
			{ paneKey: 'host/a|w2:p1', label: 'api-fixer', detail: 'api', status: 'working' },
			{ paneKey: 'host/a|w2:p2', label: 'test', detail: 'api', status: 'shell' },
		]);
		const metas = layoutTileMetas(['host/a|w2:p1', 'host/b|w1:p1', 'gone|w1:p1'], of, (k) => `row ${k}`);
		assert.deepStrictEqual(metas.map((m) => m.detail), ['api · row host/a', 'web · row host/b']);
	});

	test('availability: waiting without a connected snapshot, gone without the pane', () => {
		assert.strictEqual(paneAvailability(undefined, 'w1:p1'), 'waiting');
		assert.strictEqual(paneAvailability({ state: 'connecting', snapshot: undefined }, 'w1:p1'), 'waiting');
		assert.strictEqual(paneAvailability({ state: 'disconnected', snapshot: undefined }, 'w1:p1'), 'waiting');
		assert.strictEqual(paneAvailability({ state: 'connected', snapshot: s }, 'w1:p1'), 'live');
		assert.strictEqual(paneAvailability({ state: 'connected', snapshot: s }, 'nope'), 'gone');
	});
});
