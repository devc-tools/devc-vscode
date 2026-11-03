import * as assert from 'assert';
import * as cp from 'child_process';
import { bridgeRequest, herdrArgv } from '../bridge';
import { Environments } from '../environments';
import { LocalShell } from '../remoteShell';
import { parseSnapshot, SessionModel } from '../sessions';
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

	test('working → idle shows done within 2 s; a seen mark makes it idle', async () => {
		await waitFor('connected', 10000, () => model.connection(key)?.state === 'connected');
		const snap = model.connection(key)!.snapshot!;
		const paneId = snap.panes[snap.panes.length - 1].pane_id;
		const shown = () => model.connection(key)?.snapshot?.panes.find((p) => p.pane_id === paneId);
		const rawAgent = async () => {
			const res = (await bridgeRequest(shell, SESSION, 'session.snapshot', {})) as { snapshot?: { agents?: { pane_id?: string }[] } };
			return JSON.stringify(res.snapshot?.agents?.find((a) => a.pane_id === paneId));
		};
		const report = (state: string) =>
			bridgeRequest(shell, SESSION, 'pane.report_agent', { pane_id: paneId, source: 'herdr-vscode-test', agent: 'claude', state });
		await report('working');
		await waitFor('working', 2000, () => shown()?.agent_status === 'working');
		console.log(`[live-model] agents[] while working: ${await rawAgent()}`);
		await report('idle');
		const after = await waitFor('done', 2000, () => shown()?.agent_status === 'done');
		console.log(`[live-model] done shown after ${after} ms; agents[] after idle: ${await rawAgent()}`);
		const p = shown()!;
		assert.strictEqual(p.raw_status, 'idle');
		assert.ok(p.state_since !== undefined, 'the change was observed: time in state is shown');
		console.log(`[live-model] tracker record: ${JSON.stringify(model.agentStates.record(`${key}|${paneId}`))}`);
		model.markSeen(key, paneId);
		await waitFor('idle after seen', 2000, () => shown()?.agent_status === 'idle');
		await report('working');
		await waitFor('working again', 2000, () => shown()?.agent_status === 'working');
		console.log(`[live-model] agents[] working again: ${await rawAgent()}`);
		await report('blocked');
		await waitFor('blocked', 2000, () => shown()?.agent_status === 'blocked');
		await report('idle');
		await waitFor('idle', 2000, () => shown()?.raw_status === 'idle');
		await sleep(400);
		console.log(`[live-model] blocked → idle shows ${shown()?.agent_status}; agents[]: ${await rawAgent()}`);
	});

	test('report-metadata tokens reach the snapshot; the events each emits are logged', async () => {
		await waitFor('connected', 10000, () => model.connection(key)?.state === 'connected');
		const snap = model.connection(key)!.snapshot!;
		const ws = snap.workspaces[0].workspace_id;
		const paneId = snap.panes[0].pane_id;
		const seen: string[] = [];
		const sub = model.onDidEvent((e) => {
			if (e.sessionKey === key) {
				seen.push(e.event.event);
			}
		});
		try {
			// herdr 0.9.5 takes the id before the options (`--source hv <id>` fails with `unknown option: hv`).
			const run = async (args: string[]) => {
				const res = await shell.run(herdrArgv(['--session', SESSION, ...args]), { timeoutMs: 10000 });
				assert.strictEqual(res.exitCode, 0, res.stderr.toString());
			};
			const value = `x${Date.now() % 1000}`;
			await run(['workspace', 'report-metadata', ws, '--source', 'hv', '--token', `jj_status=${value}`]);
			const wsMs = await waitFor('workspace token', 3000, () =>
				model.connection(key)?.snapshot?.workspaces.find((w) => w.workspace_id === ws)?.tokens?.jj_status === value,
			);
			await sleep(500);
			console.log(`[live-model] workspace report-metadata: token after ${wsMs} ms; events ${JSON.stringify(seen.splice(0))}`);
			await run(['pane', 'report-metadata', paneId, '--source', 'hv', '--token', 'ticket=DH-1']);
			let paneMs: number | undefined;
			try {
				paneMs = await waitFor('pane token', 3000, () =>
					model.connection(key)?.snapshot?.panes.find((p) => p.pane_id === paneId)?.tokens?.ticket === 'DH-1',
				);
			} catch {
				// No event: the token shows only in a fresh snapshot.
			}
			await sleep(500);
			console.log(`[live-model] pane report-metadata: token in the model ${paneMs === undefined ? 'not within 3 s' : `after ${paneMs} ms`}; events ${JSON.stringify(seen.splice(0))}`);
			const raw = (await bridgeRequest(shell, SESSION, 'session.snapshot', {})) as { snapshot?: unknown };
			const parsed = parseSnapshot(raw.snapshot)!;
			assert.strictEqual(parsed.workspaces.find((w) => w.workspace_id === ws)?.tokens?.jj_status, value);
			assert.strictEqual(parsed.panes.find((p) => p.pane_id === paneId)?.tokens?.ticket, 'DH-1');
			await run(['workspace', 'report-metadata', ws, '--source', 'hv', '--clear-token', 'jj_status']);
			await run(['pane', 'report-metadata', paneId, '--source', 'hv', '--clear-token', 'ticket']);
		} finally {
			sub.dispose();
		}
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
			[['stopped', 'herdr.session.stopped']],
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
