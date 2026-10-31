import * as assert from 'assert';
import * as cp from 'child_process';
import { bridgeRequest, herdrArgv } from '../bridge';
import { Environments } from '../environments';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { agentRows, blockedCount } from '../views/agentsView';
import { effectiveSelection, sessionRows } from '../views/sessionsView';

/**
 * The whole model (discovery, session list, connections) against a herdr
 * home that holds only a throwaway session. Skipped unless
 * HERDR_VSCODE_LIVE_HOME names that home; HOME is pointed there for the
 * suite, so no other session on the machine is listed or touched.
 */
const LIVE_HOME = process.env.HERDR_VSCODE_LIVE_HOME;
const SESSION = 'hv-test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, ms: number, ok: () => boolean): Promise<number> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (ok()) {
			return Date.now() - start;
		}
		await sleep(25);
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

(LIVE_HOME ? suite : suite.skip)('live model in an isolated herdr home', function () {
	this.timeout(30000);
	let realHome: string | undefined;
	let model: SessionModel;
	const key = `host/${SESSION}`;
	const shell = new LocalShell();

	suiteSetup(() => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		model = new SessionModel(new Environments(() => undefined), (l) => console.log(`[live-model] ${l}`));
		model.start();
	});

	suiteTeardown(() => {
		model?.dispose();
		process.env.HOME = realHome;
	});

	test('lists only the isolated session and connects to it', async () => {
		await waitFor('connected', 10000, () => model.connection(key)?.state === 'connected');
		const host = model.states().find((s) => s.env.key === 'host')!;
		assert.deepStrictEqual(
			host.sessions.filter((s) => s.running).map((s) => s.name),
			[SESSION],
		);
		const rows = sessionRows(host, (k) => model.connection(k), false);
		console.log('[live-model] rows', JSON.stringify(rows.map((r) => [r.label, r.description, r.contextValue, r.tooltip])));
		assert.deepStrictEqual(
			rows.map((r) => [r.key, r.contextValue]),
			[[key, 'herdr.session.running']],
		);
		assert.strictEqual(effectiveSelection(undefined, model.states(), (k) => model.connection(k)), key);
	});

	test('blocked agent counted within 2 s; cleared within 2 s', async () => {
		const snap = model.connection(key)!.snapshot!;
		const paneId = snap.panes[snap.panes.length - 1].pane_id;
		const blocked = () =>
			blockedCount(
				agentRows(
					model
						.connections()
						.filter((c) => c.snapshot)
						.map((c) => ({ sessionKey: c.key, rowLabel: c.name, snapshot: c.snapshot! })),
				),
			);
		await bridgeRequest(shell, SESSION, 'pane.report_agent', {
			pane_id: paneId,
			source: 'herdr-vscode-test',
			agent: 'claude',
			state: 'blocked',
		});
		console.log(`[live-model] blocked counted after ${await waitFor('blocked', 2000, () => blocked() === 1)} ms`);
		await bridgeRequest(shell, SESSION, 'pane.report_agent', {
			pane_id: paneId,
			source: 'herdr-vscode-test',
			agent: 'claude',
			state: 'working',
		});
		console.log(`[live-model] blocked cleared after ${await waitFor('cleared', 2000, () => blocked() === 0)} ms`);
	});

	test('a stopped session is dropped after its subscription ends (HERDR_VSCODE_LIVE_STOP=1)', async function () {
		if (process.env.HERDR_VSCODE_LIVE_STOP !== '1') {
			this.skip();
		}
		const conn = model.connection(key)!;
		const stop = await shell.run(herdrArgv(['--session', SESSION, 'server', 'stop']), { timeoutMs: 10000 });
		assert.strictEqual(stop.exitCode, 0, stop.stderr.toString());
		await waitFor('disconnected', 5000, () => conn.state === 'disconnected');
		const gone = await waitFor('dropped', 10000, () => model.connection(key) === undefined);
		console.log(`[live-model] disconnected, then dropped ${gone} ms later`);
		const host = model.states().find((s) => s.env.key === 'host')!;
		assert.deepStrictEqual(
			sessionRows(host, (k) => model.connection(k), false).map((r) => [r.description, r.contextValue]),
			[['herdr not running', 'herdr.session.absent']],
		);
	});

	test('dispose ends every bridge', async () => {
		model.dispose();
		await waitFor('bridges gone', 5000, () => {
			const ps = cp.execFileSync('ps', ['-eo', 'args']).toString();
			return !ps.split('\n').some((l) => l.includes(`--session ${SESSION} remote-api-bridge`));
		});
	});
});
