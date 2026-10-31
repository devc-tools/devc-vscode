import * as assert from 'assert';
import { containerDisplayName, containerKey, HOST_KEY, sshKey } from '../environments';
import { interpretSessionList, paneLabel, parseSessionList, sessionKey, SnapshotPane } from '../sessions';
import { RAW_SNAPSHOT, snapshot } from './fixtures';

const result = (exitCode: number, stdout = '', stderr = '') => ({
	exitCode,
	stdout: Buffer.from(stdout),
	stderr: Buffer.from(stderr),
});

suite('session list', () => {
	const LIST = JSON.stringify({
		sessions: [
			{ name: 'default', default: true, running: false, session_dir: '/h/.config/herdr', socket_path: '/h/s' },
			{ name: 'code-wksp', default: false, running: true, session_dir: '/h/x', socket_path: '/h/y' },
		],
	});

	test('running and stopped sessions', () => {
		assert.deepStrictEqual(parseSessionList(LIST), [
			{ name: 'default', default: true, running: false },
			{ name: 'code-wksp', default: false, running: true },
		]);
		assert.deepStrictEqual(interpretSessionList(result(0, LIST), false), {
			status: 'ok',
			sessions: parseSessionList(LIST),
		});
	});

	test('malformed JSON gives no sessions', () => {
		assert.deepStrictEqual(parseSessionList('not json'), []);
		assert.deepStrictEqual(parseSessionList('{"sessions":"x"}'), []);
		assert.deepStrictEqual(parseSessionList('{"sessions":[{"running":true},null,{"name":"ok"}]}'), [
			{ name: 'ok', default: false, running: false },
		]);
		assert.deepStrictEqual(interpretSessionList(result(0, '{'), false), { status: 'ok', sessions: [] });
	});

	test('environment errors', () => {
		assert.deepStrictEqual(interpretSessionList(result(127, '', 'sh: 1: exec: herdr: not found'), false), {
			status: 'notInstalled',
		});
		assert.deepStrictEqual(interpretSessionList(result(255, '', 'ssh: connect to host x: refused'), true), {
			status: 'unreachable',
		});
		assert.deepStrictEqual(interpretSessionList(result(1, '', 'boom\nmore'), false), {
			status: 'error',
			message: 'boom',
		});
		// 255 from something other than ssh is just an error.
		assert.strictEqual(interpretSessionList(result(255), false).status, 'error');
	});

	test('session and environment key format', () => {
		assert.strictEqual(sessionKey(HOST_KEY, 'code-wksp'), 'host/code-wksp');
		assert.strictEqual(sessionKey(sshKey('buildbox'), 'default'), 'ssh:buildbox/default');
		assert.strictEqual(sessionKey(containerKey('3f2a9c1b04de77aa'), 'devc'), 'container:3f2a9c1b04de/devc');
		assert.strictEqual(containerDisplayName('/Users/me/src/my-app'), 'my-app');
		assert.strictEqual(containerDisplayName('/Users/me/src/my-app/'), 'my-app');
		assert.strictEqual(containerDisplayName('C:\\src\\proj'), 'proj');
	});
});

suite('snapshot', () => {
	test('parses workspaces, tabs, panes and agent names', () => {
		const s = snapshot();
		assert.strictEqual(s.version, '0.9.5');
		assert.deepStrictEqual(
			s.workspaces.map((w) => [w.workspace_id, w.number, w.repoName]),
			[
				['w2', 2, 'api'],
				['w1', 1, 'frontend'],
			],
		);
		assert.strictEqual(s.panes.length, 4);
		assert.strictEqual(s.panes[1].agent, undefined);
		assert.strictEqual(s.agentNames.get('w2:p1'), 'api-fixer');
		assert.strictEqual(s.agentNames.has('w1:p1'), false);
	});

	test('checkout_path, and the seq fields from agents[] (integer, null, absent)', () => {
		const raw = {
			...RAW_SNAPSHOT,
			workspaces: [
				{ workspace_id: 'w1', number: 1, label: 'web', worktree: { repo_key: 'k', repo_name: 'web', repo_root: '/src/web', checkout_path: '/src/web-wt', is_linked_worktree: true } },
				{ workspace_id: 'w2', number: 2, label: 'api', worktree: null },
			],
			panes: RAW_SNAPSHOT.panes.map((p) => (p.pane_id === 'w2:p1' ? { ...p, state_change_seq: 99 } : p)),
			agents: [
				{ pane_id: 'w2:p1', name: 'api-fixer', state_change_seq: 12, completion_seq: 3 },
				{ pane_id: 'w1:p1', state_change_seq: 4, completion_seq: null },
				{ pane_id: 'w1:p2' },
			],
		};
		const s = snapshot(raw);
		assert.deepStrictEqual(
			s.workspaces.map((w) => [w.workspace_id, w.checkoutPath]),
			[
				['w1', '/src/web-wt'],
				['w2', undefined],
			],
		);
		const byId = (id: string) => s.panes.find((p) => p.pane_id === id)!;
		assert.deepStrictEqual([byId('w2:p1').state_change_seq, byId('w2:p1').completion_seq], [12, 3], 'from agents[], not panes[]');
		assert.deepStrictEqual([byId('w1:p1').state_change_seq, byId('w1:p1').completion_seq], [4, undefined]);
		assert.deepStrictEqual([byId('w1:p2').state_change_seq, byId('w1:p2').completion_seq], [undefined, undefined]);
		assert.ok(!('completion_seq' in byId('w1:p1')), 'null is absent');
		assert.strictEqual(byId('w2:p2').state_change_seq, undefined);
		assert.strictEqual(byId('w1:p2').raw_status, 'done');
		assert.strictEqual(byId('w1:p2').agent_status, 'done');
	});

	test('pane label fallback order', () => {
		const names = { agentNames: new Map([['p', 'named']]) };
		const none = { agentNames: new Map<string, string>() };
		const pane = (extra: Partial<SnapshotPane>): SnapshotPane => ({
			pane_id: 'p',
			tab_id: 't',
			workspace_id: 'w',
			agent_status: 'unknown',
			raw_status: 'unknown',
			focused: false,
			...extra,
		});
		const full = pane({
			display_agent: 'Claude',
			agent: 'claude',
			label: 'my pane',
			foreground_cwd: '/a/fg',
			cwd: '/a/cwd',
		});
		assert.strictEqual(paneLabel(full, names), 'named');
		assert.strictEqual(paneLabel(full, none), 'Claude');
		assert.strictEqual(paneLabel({ ...full, display_agent: undefined }, none), 'claude');
		assert.strictEqual(paneLabel({ ...full, display_agent: undefined, agent: undefined }, none), 'my pane');
		assert.strictEqual(paneLabel(pane({ foreground_cwd: '/a/fg', cwd: '/a/cwd' }), none), 'fg');
		assert.strictEqual(paneLabel(pane({ cwd: '/a/cwd/' }), none), 'cwd');
		assert.strictEqual(paneLabel(pane({ cwd: '/' }), none), 'shell');
		assert.strictEqual(paneLabel(pane({}), none), 'shell');
	});
});
