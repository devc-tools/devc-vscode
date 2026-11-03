import * as assert from 'assert';
import * as cp from 'child_process';
import {
	BridgeError,
	bridgeCheckPassed,
	bridgeRequest,
	EVENTS_LOST,
	GLOBAL_EVENT_TYPES,
	HERDR_WRAPPER,
	herdrArgv,
	HerdrEvent,
	normalizeEventName,
	subscribe,
	subscriptionList,
} from '../bridge';
import { DockerShell, LocalShell, RemoteShell, SshShell } from '../remoteShell';

/** A RemoteShell whose bridge is a `sh` script standing in for herdr. */
function fakeShell(script: string): RemoteShell {
	return {
		run: () => Promise.reject(new Error('not used')),
		spawn: () => cp.spawn('sh', ['-c', script], { stdio: ['pipe', 'pipe', 'ignore'] }),
	};
}

/** Reads the request line, then answers with its id. */
const ECHO_ID = `read line; id=$(printf '%s' "$line" | sed 's/.*"id":"\\([^"]*\\)".*/\\1/');`;

suite('bridge', () => {
	test('event-name normalization', () => {
		assert.strictEqual(normalizeEventName('pane_created'), 'pane.created');
		assert.strictEqual(normalizeEventName('workspace_metadata_updated'), 'workspace.metadata_updated');
		assert.strictEqual(normalizeEventName('pane.agent_status_changed'), 'pane.agent_status_changed');
		assert.strictEqual(normalizeEventName('layout_updated'), 'layout.updated');
	});

	test('subscription list: global types plus one agent status entry per pane', () => {
		const list = subscriptionList(['w1:p1', 'w1:p2']);
		assert.strictEqual(list.length, GLOBAL_EVENT_TYPES.length + 2);
		assert.deepStrictEqual(list.slice(-2), [
			{ type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
			{ type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
		]);
		assert.ok(list.some((s) => s.type === 'workspace.metadata_updated'));
	});

	test('--check output', () => {
		assert.strictEqual(bridgeCheckPassed(0, 'herdr-api-bridge-v1\n'), true);
		assert.strictEqual(bridgeCheckPassed(0, 'herdr-api-bridge-v2\n'), false);
		assert.strictEqual(bridgeCheckPassed(2, 'herdr-api-bridge-v1\n'), false);
		assert.strictEqual(bridgeCheckPassed(0, 'error: unrecognized subcommand\n'), false);
	});

	suite('herdr wrapper argv for each environment kind', () => {
		const args = ['--session', 'code-wksp', 'remote-api-bridge'];
		const wrapped = ['sh', '-c', 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"', 'herdr', ...args];
		const capture = () => {
			const calls: { command: string; args: string[] }[] = [];
			const spawn = (command: string, a: string[]) => {
				calls.push({ command, args: a });
				return cp.spawn('true');
			};
			return { calls, spawn };
		};

		test('wrapper', () => {
			assert.strictEqual(HERDR_WRAPPER, 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"');
			assert.deepStrictEqual(herdrArgv(args), wrapped);
		});

		test('this machine', () => {
			const { calls, spawn } = capture();
			new LocalShell(spawn).spawn(herdrArgv(args));
			assert.deepStrictEqual(calls, [{ command: 'sh', args: wrapped.slice(1) }]);
		});

		test('dev container', () => {
			const { calls, spawn } = capture();
			new DockerShell('3f2a9c1b04de', 'vscode', 'docker', spawn).spawn(herdrArgv(args));
			assert.deepStrictEqual(calls, [
				{ command: 'docker', args: ['exec', '-i', '-u', 'vscode', '3f2a9c1b04de', ...wrapped] },
			]);
		});

		test('SSH host', () => {
			const { calls, spawn } = capture();
			new SshShell('buildbox', {
				sshPath: 'ssh',
				controlDir: undefined,
				allowed: (h) => h === 'buildbox',
				spawn,
			}).spawn(herdrArgv(args));
			assert.strictEqual(calls[0].command, 'ssh');
			const sshArgs = calls[0].args;
			assert.ok(sshArgs.includes('ForwardAgent=no'));
			assert.deepStrictEqual(sshArgs.slice(-2), [
				'buildbox',
				`'sh' '-c' 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"' 'herdr' '--session' 'code-wksp' 'remote-api-bridge'`,
			]);
		});
	});

	test('one-shot request resolves with result', async () => {
		const shell = fakeShell(`${ECHO_ID} printf '{"id":"other","result":1}\\n{"id":"%s","result":{"ok":true}}\\n' "$id"; cat >/dev/null`);
		assert.deepStrictEqual(await bridgeRequest(shell, 's', 'session.snapshot', {}), { ok: true });
	});

	test('one-shot request rejects with herdr error', async () => {
		const shell = fakeShell(
			`${ECHO_ID} printf '{"id":"%s","error":{"code":"pane_not_found","message":"pane nope not found"}}\\n' "$id"; cat >/dev/null`,
		);
		await assert.rejects(bridgeRequest(shell, 's', 'pane.focus', { pane_id: 'nope' }), (err: BridgeError) => {
			return err.code === 'pane_not_found' && err.message === 'pane nope not found';
		});
	});

	test('one-shot request rejects when the bridge exits', async () => {
		await assert.rejects(bridgeRequest(fakeShell('read line; exit 1'), 's', 'x', {}), (err: BridgeError) => {
			return err.code === 'bridge_exited';
		});
	});

	test('subscribe: started, normalized events, events_lost, ended', async () => {
		const shell = fakeShell(
			`read line; printf '%s\\n' '{"id":"s","result":{"type":"subscription_started"}}' '{"event":"pane_created","data":{"pane_id":"w1:p2"}}' '{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked"}}' '{"id":"s","error":{"code":"events_lost","message":"lost"}}'; read rest; exit 0`,
		);
		const events: HerdrEvent[] = [];
		const sub = await subscribe(shell, 's', subscriptionList([]), (ev) => events.push(ev));
		await new Promise((r) => setTimeout(r, 200));
		assert.deepStrictEqual(
			events.map((e) => e.event),
			['pane.created', 'pane.agent_status_changed', EVENTS_LOST],
		);
		assert.strictEqual(events[0].data.pane_id, 'w1:p2');
		sub.close();
		await sub.ended;
	});

	test('subscribe rejects on an error before it starts', async () => {
		const shell = fakeShell(
			`read line; printf '%s\\n' '{"id":"s","error":{"code":"invalid_request","message":"missing field pane_id"}}'; cat >/dev/null`,
		);
		await assert.rejects(subscribe(shell, 's', [], () => undefined), (err: BridgeError) => err.code === 'invalid_request');
	});
});
