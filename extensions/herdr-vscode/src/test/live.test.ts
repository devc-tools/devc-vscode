import * as assert from 'assert';
import * as cp from 'child_process';
import { bridgeRequest } from '../bridge';
import { Environment } from '../environments';
import { LocalShell } from '../remoteShell';
import { SessionConnection, Snapshot } from '../sessions';
import { agentRows, blockedCount } from '../views/agentsView';
import { buildSpaces } from '../views/spacesView';

/**
 * Against a real, throwaway herdr session on this machine. Skipped unless
 * HERDR_VSCODE_LIVE_SESSION names it; the session must already run with at
 * least one workspace. Only that session is touched.
 */
const SESSION = process.env.HERDR_VSCODE_LIVE_SESSION;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, get: () => T | undefined | false): Promise<{ value: T; after: number }> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const v = get();
		if (v) {
			return { value: v, after: Date.now() - start };
		}
		await sleep(25);
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

(SESSION ? suite : suite.skip)(`live herdr session ${SESSION}`, function () {
	this.timeout(30000);
	const shell = new LocalShell();
	const env: Environment = { key: 'host', kind: 'host', label: 'this machine', shell };
	const key = `host/${SESSION}`;
	const session = SESSION!;
	let conn: SessionConnection;
	const req = (method: string, params: unknown) => bridgeRequest(shell, session, method, params);
	const pane = (s: Snapshot | undefined, id: string) => s?.panes.find((p) => p.pane_id === id);

	suiteSetup(async () => {
		conn = new SessionConnection(key, env, session, {
			changed: () => undefined,
			event: () => undefined,
			log: (l) => console.log(`[live] ${l}`),
			relist: async () => undefined,
		});
		void conn.connect();
		await waitFor('connected', 10000, () => conn.state === 'connected' && conn.snapshot);
	});

	suiteTeardown(() => conn?.dispose());

	test('snapshot fills Spaces', () => {
		const spaces = buildSpaces(conn.snapshot!, key);
		assert.ok(spaces.length >= 1);
		console.log(
			'[live] spaces',
			JSON.stringify(spaces.map((s) => [s.label, s.children.map((t) => [t.label, t.children.map((p) => p.label)])])),
		);
	});

	test('agent status reaches the model within 2 s, and resubscribes on new panes', async () => {
		const first = conn.snapshot!.panes[0];
		const split = (await req('pane.split', { direction: 'right', target_pane_id: first.pane_id, focus: false })) as {
			pane: { pane_id: string };
		};
		const id = split.pane.pane_id;
		const seen = await waitFor('new pane in snapshot', 2000, () => pane(conn.snapshot, id));
		console.log(`[live] new pane ${id} seen after ${seen.after} ms`);

		await req('pane.report_agent', { pane_id: id, source: 'herdr-vscode-test', agent: 'claude', state: 'blocked' });
		const blocked = await waitFor('blocked', 2000, () => pane(conn.snapshot, id)?.agent_status === 'blocked');
		console.log(`[live] blocked seen after ${blocked.after} ms`);
		const rows = agentRows([{ sessionKey: key, rowLabel: session, snapshot: conn.snapshot! }]);
		assert.ok(blockedCount(rows) >= 1);

		await req('pane.report_agent', { pane_id: id, source: 'herdr-vscode-test', agent: 'claude', state: 'idle' });
		const idle = await waitFor('idle', 2000, () => pane(conn.snapshot, id)?.agent_status === 'idle');
		console.log(`[live] idle seen after ${idle.after} ms`);

		await req('pane.focus', { pane_id: id });
		await waitFor('focus', 2000, () => pane(conn.snapshot, id)?.focused);
		await req('pane.focus', { pane_id: first.pane_id });
		await waitFor('focus back', 2000, () => pane(conn.snapshot, first.pane_id)?.focused);
	});

	test('dispose ends every bridge', async () => {
		conn.dispose();
		await waitFor('bridges gone', 5000, () => {
			const ps = cp.execFileSync('ps', ['-eo', 'args']).toString();
			return !ps.split('\n').some((l) => l.includes(`--session ${session} remote-api-bridge`));
		});
	});
});
