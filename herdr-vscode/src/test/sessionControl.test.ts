import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { createdTabId, sessionServerArgv, sessionStopArgv, spaceCwd, splitTarget, startDetached, startHostSession, whenTabKnown } from '../sessionControl';
import { Snapshot, SessionModel } from '../sessions';
import { spacesTreeItem, SpaceNode } from '../views/spacesView';
import { sessionRows } from '../views/sessionsView';

const pane = (pane_id: string, tab_id: string, focused = false, cwd?: string) =>
	({ pane_id, tab_id, workspace_id: 'w1', agent_status: 'unknown', focused, cwd }) as Snapshot['panes'][number];
const snapshot = (panes: Snapshot['panes']) => ({ panes, tabs: [{ tab_id: 't1' }] }) as unknown as Snapshot;

suite('session control', () => {
	test('start and stop argv', () => {
		assert.deepStrictEqual(sessionServerArgv('s').slice(-4), ['herdr', '--session', 's', 'server']);
		assert.deepStrictEqual(sessionStopArgv('s').slice(-4), ['herdr', 'session', 'stop', 's']);
	});

	test('starts detached, with no stdio tying it to this window', async () => {
		let options: { detached?: boolean; stdio?: unknown } | undefined;
		let unrefs = 0;
		const child = Object.assign(new EventEmitter(), { unref: () => unrefs++ });
		const spawn = ((_: string, __: string[], o: typeof options) => {
			options = o;
			setImmediate(() => child.emit('spawn'));
			return child;
		}) as never;
		await startDetached(['x'], spawn);
		assert.strictEqual(options?.detached, true);
		assert.strictEqual(options?.stdio, 'ignore');
		assert.strictEqual(unrefs, 1);
	});

	test('a start that cannot spawn rejects', async () => {
		const child = new EventEmitter();
		const spawn = (() => {
			setImmediate(() => child.emit('error', new Error('no sh')));
			return child;
		}) as never;
		await assert.rejects(startDetached(['x'], spawn), /no sh/);
	});

	test('start waits for the listing to show the session running', async () => {
		let lists = 0;
		const model = {
			relist: async () => {
				lists++;
			},
			states: () => [{ env: { key: 'host' }, sessions: [{ name: 's', running: lists >= 2 }] }],
		} as unknown as SessionModel;
		assert.strictEqual(await startHostSession(model, 's', async () => undefined), true);
		assert.strictEqual(lists, 2);
	});

	test("this machine's stopped sessions are always rows; other environments follow the setting", () => {
		const state = (kind: 'host' | 'ssh', key: string) =>
			({ env: { kind, key, label: key, alias: key }, status: 'ok', sessions: [{ name: 's', default: false, running: false }] }) as never;
		const host = sessionRows(state('host', 'host'), () => undefined, false);
		assert.deepStrictEqual(host.map((r) => [r.label, r.description, r.contextValue]), [['s', 'stopped', 'herdr.session.stopped']]);
		assert.strictEqual(sessionRows(state('ssh', 'ssh:b'), () => undefined, false)[0].contextValue, 'herdr.session.absent');
		assert.strictEqual(sessionRows(state('ssh', 'ssh:b'), () => undefined, true)[0].contextValue, 'herdr.session.stopped');
	});

	test('a split starts from the tab focused pane, else its first', () => {
		assert.strictEqual(splitTarget(snapshot([pane('a', 't1'), pane('b', 't1', true), pane('c', 't2')]), 't1'), 'b');
		assert.strictEqual(splitTarget(snapshot([pane('a', 't1'), pane('c', 't2', true)]), 't1'), 'a');
		assert.strictEqual(splitTarget(snapshot([]), 't1'), undefined);
	});

	test('a new tab starts in the space focused directory', () => {
		assert.strictEqual(spaceCwd(snapshot([pane('a', 't1', false, '/a'), pane('b', 't1', true, '/b')]), 'w1'), '/b');
		assert.strictEqual(spaceCwd(snapshot([]), 'w1'), undefined);
	});

	test('the tab in a create result', () => {
		assert.strictEqual(createdTabId({ tab: { tab_id: 'w1:t2' } }), 'w1:t2');
		assert.strictEqual(createdTabId({}), undefined);
		assert.strictEqual(createdTabId(undefined), undefined);
	});

	test('waits for a new tab to reach the snapshot, and gives up', async () => {
		const changed = new vscode.EventEmitter<void>();
		let snap: Snapshot | undefined;
		const model = { connection: () => ({ snapshot: snap }), onDidChange: changed.event } as never;
		const found = whenTabKnown(model, 'k', 't1', 1000);
		snap = snapshot([]);
		changed.fire();
		assert.strictEqual(await found, true);
		assert.strictEqual(await whenTabKnown(model, 'k', 'nope', 10), false);
	});

	test('space rows carry what New Tab needs', () => {
		const node: SpaceNode = { type: 'space', id: 'i', label: 'l', focused: true, children: [], sessionKey: 'host/s', workspaceId: 'w1' } as never;
		assert.strictEqual(spacesTreeItem(node).contextValue, 'herdr.space');
	});
});
