import * as assert from 'assert';
import * as vscode from 'vscode';
import { PANE_MIME } from '../layouts';
import { EntryNode, PaneContextNode, PaneRowNode } from '../paneContext';
import { PaneDragController, PanePlacement, PlacementPanel, PlacementTimers, paneRowRef, PLACEMENT_TIMEOUT_MS } from '../paneDrag';
import { Snapshot } from '../sessions';
import { agentRows, AgentRow } from '../views/agentsView';
import { buildSpaces, PaneRef, SpacesNode } from '../views/spacesView';
import { snapshot } from './fixtures';

const A = 'host/a';
const OFF = 'host/off';

class FakePlacement {
	readonly calls: string[] = [];
	arm(ref: PaneRef, title: string): boolean {
		this.calls.push(`arm ${ref.sessionKey} ${ref.paneId} ${title}`);
		return true;
	}
	cancel(): void {
		this.calls.push('cancel');
	}
}

suite('pane drag sources', () => {
	const snap = snapshot();
	const snapshots = new Map<string, Snapshot>([[A, snap]]);
	const connected = (key: string) => snapshots.get(key);

	async function drag<T>(paneOf: (node: T) => PaneRef | undefined, node: T): Promise<{ calls: string[]; data: string | undefined }> {
		const placement = new FakePlacement();
		const controller = new PaneDragController<T>(placement, paneOf, connected);
		assert.deepStrictEqual(controller.dragMimeTypes, ['application/vnd.herdr.pane']);
		assert.deepStrictEqual(controller.dropMimeTypes, []);
		const dt = new vscode.DataTransfer();
		await controller.handleDrag([node], dt);
		return { calls: placement.calls, data: await dt.get(PANE_MIME)?.asString() };
	}

	const spaces = buildSpaces(snap, A);
	const space = spaces.find((s) => s.workspaceId === 'w2')!;
	const tab = space.children[0];
	const paneNode = tab.children.find((p) => p.ref.paneId === 'w2:p1')!;

	test('a Spaces pane node: the data, and armed with its label', async () => {
		const { calls, data } = await drag<SpacesNode>(paneRowRef, paneNode);
		assert.strictEqual(data, JSON.stringify([{ sessionKey: A, paneId: 'w2:p1' }]));
		assert.deepStrictEqual(calls, ['cancel', `arm ${A} w2:p1 api-fixer`]);
	});

	test('an Agents row', async () => {
		const row = agentRows([{ sessionKey: A, rowLabel: 'a', snapshot: snap }]).find((r) => r.pane.pane_id === 'w1:p1')!;
		const { calls, data } = await drag<AgentRow>((r) => r.ref, row);
		assert.strictEqual(data, JSON.stringify([{ sessionKey: A, paneId: 'w1:p1' }]));
		assert.deepStrictEqual(calls, ['cancel', `arm ${A} w1:p1 Codex`]);
	});

	test('a Pane Context pane node', async () => {
		const pane = snap.panes.find((p) => p.pane_id === 'w2:p2')!;
		const node: PaneRowNode = { type: 'pane', id: `${A}|pane|w2:p2`, label: 'x', pane, ref: { sessionKey: A, paneId: 'w2:p2' } };
		const { calls, data } = await drag<PaneContextNode>(paneRowRef, node);
		assert.strictEqual(data, JSON.stringify([{ sessionKey: A, paneId: 'w2:p2' }]));
		assert.strictEqual(calls.length, 2);
		assert.match(calls[1], new RegExp(`^arm ${A} w2:p2 `));
	});

	test('a space, a tab or a Files row: no data, and a placement in progress is disarmed', async () => {
		const files: EntryNode = {
			type: 'entry',
			id: 'f',
			name: 'a.ts',
			uri: vscode.Uri.file('/tmp/a.ts'),
			directory: false,
			parent: { type: 'group', group: 'files', id: 'g', label: 'Files' },
		};
		for (const result of [await drag<SpacesNode>(paneRowRef, space), await drag<SpacesNode>(paneRowRef, tab), await drag<PaneContextNode>(paneRowRef, files)]) {
			assert.strictEqual(result.data, undefined);
			assert.deepStrictEqual(result.calls, ['cancel']);
		}
	});

	test('a pane whose session is not connected arms nothing', async () => {
		const offNode = buildSpaces(snap, OFF)[0].children[0].children[0];
		const { calls } = await drag<SpacesNode>(paneRowRef, offNode);
		assert.deepStrictEqual(calls, ['cancel']);
	});
});

class FakePanel implements PlacementPanel {
	readonly posts: string[] = [];
	constructor(public visible: boolean) {}
	isVisible(): boolean {
		return this.visible;
	}
	placePane(sessionKey: string, paneId: string, title: string): void {
		this.posts.push(`placePane ${paneId} ${title}`);
	}
	placeEnd(): void {
		this.posts.push('placeEnd');
	}
}

class FakeClock implements PlacementTimers {
	private next = 0;
	readonly pending = new Map<number, { run: () => void; ms: number }>();
	set(run: () => void, ms: number): unknown {
		this.pending.set(++this.next, { run, ms });
		return this.next;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	fire(): void {
		for (const [id, t] of [...this.pending]) {
			this.pending.delete(id);
			t.run();
		}
	}
}

suite('pane placement', () => {
	const ref = { sessionKey: A, paneId: 'w2:p1' };
	let panels: FakePanel[];
	let context: boolean[];
	let clock: FakeClock;
	let placement: PanePlacement;

	setup(() => {
		panels = [new FakePanel(true), new FakePanel(false), new FakePanel(true)];
		context = [];
		clock = new FakeClock();
		placement = new PanePlacement({ panels: () => panels, setContext: (v) => context.push(v), timers: clock });
	});

	test('arm: visible Layout panels only, and the context key', () => {
		assert.strictEqual(placement.arm(ref, 'api'), true);
		assert.deepStrictEqual(panels.map((p) => p.posts), [['placePane w2:p1 api'], [], ['placePane w2:p1 api']]);
		assert.deepStrictEqual(context, [true]);
		assert.deepStrictEqual(placement.placing, ref);
		assert.deepStrictEqual([...clock.pending.values()].map((t) => t.ms), [PLACEMENT_TIMEOUT_MS]);
		assert.strictEqual(PLACEMENT_TIMEOUT_MS, 15000);
	});

	test('with no visible Layout panel nothing is armed', () => {
		panels = [new FakePanel(false)];
		assert.strictEqual(placement.arm(ref, 'api'), false);
		assert.deepStrictEqual(panels[0].posts, []);
		assert.deepStrictEqual(context, []);
		assert.strictEqual(placement.placing, undefined);
	});

	test('placeHover: the others end, and the timer stops', () => {
		placement.arm(ref, 'api');
		placement.hover(panels[2]);
		assert.deepStrictEqual(panels[0].posts, ['placePane w2:p1 api', 'placeEnd']);
		assert.deepStrictEqual(panels[2].posts, ['placePane w2:p1 api']);
		assert.strictEqual(clock.pending.size, 0);
		assert.deepStrictEqual(context, [true]);
	});

	const disarmers: [string, (p: PanePlacement, owner: FakePanel) => void][] = [
		['placed', (p, owner) => p.ended(owner)],
		['placeCancel', (p, owner) => p.ended(owner)],
		['herdr.cancelPlacement', (p) => p.cancel()],
		['a new drag', (p) => p.arm({ sessionKey: A, paneId: 'w2:p2' }, 'other')],
		['the owner closing', (p, owner) => p.panelDisposed(owner)],
	];
	for (const [what, disarm] of disarmers) {
		test(`disarmed by ${what}`, () => {
			placement.arm(ref, 'api');
			placement.hover(panels[0]);
			disarm(placement, panels[0]);
			// Every armed panel still open; a closed one gets nothing.
			assert.strictEqual(panels[0].posts.includes('placeEnd'), what !== 'the owner closing');
			assert.strictEqual(context[1], false);
			if (what !== 'a new drag') {
				assert.strictEqual(placement.placing, undefined);
				assert.deepStrictEqual(context, [true, false]);
			}
		});
	}

	test('disarmed after 15 s without placeHover', () => {
		placement.arm(ref, 'api');
		clock.fire();
		assert.deepStrictEqual(panels[0].posts, ['placePane w2:p1 api', 'placeEnd']);
		assert.deepStrictEqual(panels[2].posts, ['placePane w2:p1 api', 'placeEnd']);
		assert.deepStrictEqual(context, [true, false]);
		assert.strictEqual(placement.placing, undefined);
	});

	test('nothing armed: cancel does nothing', () => {
		placement.cancel();
		assert.deepStrictEqual(context, []);
	});
});
