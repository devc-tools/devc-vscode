import * as assert from 'assert';
import {
	componentStates,
	GlItem,
	LayoutNode,
	layoutPaneIds,
	layoutShape,
	mirrorConfig,
	MIRROR_SETTINGS,
	parseLayoutExport,
} from '../layoutMapping';

const pane = (id: string): LayoutNode => ({ type: 'pane', pane_id: id });
const split = (direction: 'right' | 'down', ratio: number, first: LayoutNode, second: LayoutNode): LayoutNode => ({
	type: 'split',
	direction,
	ratio,
	first,
	second,
});
const config = (root: LayoutNode) => mirrorConfig(root, 'host/s', (id) => `label ${id}`);
const stack = (id: string, size?: string): GlItem => ({
	type: 'stack',
	...(size ? { size } : {}),
	content: [
		{
			type: 'component',
			componentType: 'pane',
			componentState: { sessionKey: 'host/s', paneId: id },
			title: `label ${id}`,
		},
	],
});

suite('layout mapping', () => {
	test('single pane: a stack with one component', () => {
		const c = config(pane('w1:p1'));
		assert.deepStrictEqual(c.root, stack('w1:p1'));
		assert.deepStrictEqual(c.settings, MIRROR_SETTINGS);
		assert.strictEqual(c.settings.reorderEnabled, false);
		assert.deepStrictEqual(c.header, { popout: false });
	});

	test('right split with ratio 0.6: a row sized 60% and 40%', () => {
		assert.deepStrictEqual(config(split('right', 0.6, pane('a'), pane('b'))).root, {
			type: 'row',
			content: [stack('a', '60%'), stack('b', '40%')],
		});
	});

	test('down split: a column; ratios that do not divide evenly stay short', () => {
		assert.deepStrictEqual(config(split('down', 0.333333, pane('a'), pane('b'))).root, {
			type: 'column',
			content: [stack('a', '33.33%'), stack('b', '66.67%')],
		});
	});

	test('nested down-in-right', () => {
		assert.deepStrictEqual(config(split('right', 0.5, pane('a'), split('down', 0.25, pane('b'), pane('c')))).root, {
			type: 'row',
			content: [
				stack('a', '50%'),
				{ type: 'column', size: '50%', content: [stack('b', '25%'), stack('c', '75%')] },
			],
		});
	});

	test('nested right-in-right stays nested', () => {
		assert.deepStrictEqual(config(split('right', 0.5, split('right', 0.5, pane('a'), pane('b')), pane('c'))).root, {
			type: 'row',
			content: [
				{ type: 'row', size: '50%', content: [stack('a', '50%'), stack('b', '50%')] },
				stack('c', '50%'),
			],
		});
	});

	test('parses layout.export as herdr 0.9.5 sends it; malformed gives undefined', () => {
		const raw = {
			type: 'layout_export',
			layout: {
				workspace_id: 'w1',
				tab_id: 'w1:t1',
				zoomed: false,
				focused_pane_id: 'w1:p1',
				root: {
					type: 'split',
					direction: 'right',
					ratio: 0.5,
					first: { type: 'pane', pane_id: 'w1:p1', cwd: '/tmp' },
					second: { type: 'pane', pane_id: 'w1:p2', cwd: '/tmp' },
				},
			},
		};
		const parsed = parseLayoutExport(raw)!;
		assert.strictEqual(parsed.tab_id, 'w1:t1');
		assert.strictEqual(parsed.focused_pane_id, 'w1:p1');
		assert.deepStrictEqual(layoutPaneIds(parsed.root), ['w1:p1', 'w1:p2']);
		// `cwd` is not part of the shape: a cd must not re-create the layout.
		assert.strictEqual(layoutShape(parsed.root), layoutShape(split('right', 0.5, pane('w1:p1'), pane('w1:p2'))));
		assert.strictEqual(parseLayoutExport({ layout: { tab_id: 't', workspace_id: 'w', root: { type: 'pane' } } }), undefined);
		assert.strictEqual(parseLayoutExport({}), undefined);
		assert.strictEqual(parseLayoutExport(undefined), undefined);
	});

	test('component states walk the tree', () => {
		const c = config(split('right', 0.5, pane('a'), split('down', 0.5, pane('b'), pane('c'))));
		assert.deepStrictEqual(
			componentStates(c.root).map((s) => s.paneId),
			['a', 'b', 'c'],
		);
	});
});
