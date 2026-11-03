import * as assert from 'assert';
import {
	componentStates,
	GlItem,
	LayoutNode,
	layoutPaneIds,
	mirrorConfig,
	MIRROR_SETTINGS,
	parseLayoutExport,
	ratiosByPath,
	structureKey,
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
			reorderEnabled: false,
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
			id: 'split:',
			content: [stack('a', '60%'), stack('b', '40%')],
		});
	});

	test('down split: a column; ratios that do not divide evenly stay short', () => {
		assert.deepStrictEqual(config(split('down', 0.333333, pane('a'), pane('b'))).root, {
			type: 'column',
			id: 'split:',
			content: [stack('a', '33.33%'), stack('b', '66.67%')],
		});
	});

	test('nested down-in-right', () => {
		assert.deepStrictEqual(config(split('right', 0.5, pane('a'), split('down', 0.25, pane('b'), pane('c')))).root, {
			type: 'row',
			id: 'split:',
			content: [
				stack('a', '50%'),
				{ type: 'column', id: 'split:1', size: '50%', content: [stack('b', '25%'), stack('c', '75%')] },
			],
		});
	});

	test('nested right-in-right stays nested', () => {
		assert.deepStrictEqual(config(split('right', 0.5, split('right', 0.5, pane('a'), pane('b')), pane('c'))).root, {
			type: 'row',
			id: 'split:',
			content: [
				{ type: 'row', id: 'split:0', size: '50%', content: [stack('a', '50%'), stack('b', '50%')] },
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
		assert.strictEqual(structureKey(parsed.root), structureKey(split('right', 0.5, pane('w1:p1'), pane('w1:p2'))));
		assert.strictEqual(parseLayoutExport({ layout: { tab_id: 't', workspace_id: 'w', root: { type: 'pane' } } }), undefined);
		assert.strictEqual(parseLayoutExport({}), undefined);
		assert.strictEqual(parseLayoutExport(undefined), undefined);
	});

	test('split ids: a right split holding a down split is row `split:`, column `split:1`; one pane has no id', () => {
		const c = config(split('right', 0.5, pane('p1'), split('down', 0.5, pane('p2'), pane('p3'))));
		assert.strictEqual(c.root.type, 'row');
		assert.strictEqual((c.root as { id?: string }).id, 'split:');
		const column = (c.root as { content: GlItem[] }).content[1] as { type: string; id?: string };
		assert.strictEqual(column.type, 'column');
		assert.strictEqual(column.id, 'split:1');
		assert.ok(!JSON.stringify(config(pane('p1'))).includes('"id"'), 'no id anywhere');
		// Stacks and components never get one.
		assert.strictEqual(JSON.stringify(c).match(/"id"/g)?.length, 2);
	});

	test('structure key ignores ratios, not a swap; ratios by path for a nested tree', () => {
		const tree = (r: number, a = 'p1', b = 'p2') => split('right', r, pane(a), split('down', 0.25, pane(b), pane('p3')));
		assert.strictEqual(structureKey(tree(0.5)), structureKey(tree(0.6)));
		assert.notStrictEqual(structureKey(tree(0.5)), structureKey(tree(0.5, 'p2', 'p1')));
		assert.notStrictEqual(
			structureKey(split('right', 0.5, pane('a'), pane('b'))),
			structureKey(split('down', 0.5, pane('a'), pane('b'))),
			'direction counts',
		);
		assert.deepStrictEqual(ratiosByPath(tree(0.6)), { '': 0.6, '1': 0.25 });
		assert.deepStrictEqual(
			ratiosByPath(split('down', 0.3, split('right', 0.7, pane('a'), pane('b')), split('right', 0.2, pane('c'), pane('d')))),
			{ '': 0.3, '0': 0.7, '1': 0.2 },
		);
		assert.deepStrictEqual(ratiosByPath(pane('a')), {});
	});

	test('component states walk the tree', () => {
		const c = config(split('right', 0.5, pane('a'), split('down', 0.5, pane('b'), pane('c'))));
		assert.deepStrictEqual(
			componentStates(c.root).map((s) => s.paneId),
			['a', 'b', 'c'],
		);
	});
});
