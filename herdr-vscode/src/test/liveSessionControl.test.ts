import * as assert from 'assert';
import { Environments } from '../environments';
import { LocalShell } from '../remoteShell';
import { createdTabId, sessionStopArgv, startHostSession, whenTabKnown } from '../sessionControl';
import { SessionModel } from '../sessions';
import { sessionRows } from '../views/sessionsView';

/**
 * Start, create and stop against real herdr, in a home holding only this
 * suite's throwaway session. Skipped unless HERDR_VSCODE_LIVE_HOME names that
 * home; HOME is pointed there for the suite.
 */
const LIVE_HOME = process.env.HERDR_VSCODE_LIVE_HOME;
const SESSION = 'hv-ctl';
const KEY = `host/${SESSION}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, ms: number, ok: () => boolean): Promise<void> {
	const start = Date.now();
	while (!ok()) {
		if (Date.now() - start > ms) {
			throw new Error(`timed out after ${ms} ms waiting for ${what}`);
		}
		await sleep(25);
	}
}

(LIVE_HOME ? suite : suite.skip)('live session control', function () {
	this.timeout(30000);
	let realHome: string | undefined;
	let model: SessionModel;
	const shell = new LocalShell();
	const hostRows = () =>
		sessionRows(model.states().find((s) => s.env.key === 'host')!, (k) => model.connection(k), false).filter((r) => r.session === SESSION);

	suiteSetup(() => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		model = new SessionModel(new Environments(() => undefined), (l) => console.log(`[live-ctl] ${l}`));
		model.start();
	});

	suiteTeardown(async () => {
		await shell.run(sessionStopArgv(SESSION), { timeoutMs: 10000 }).catch(() => undefined);
		model?.dispose();
		process.env.HOME = realHome;
	});

	test('starts a session, detached', async () => {
		assert.strictEqual(await startHostSession(model, SESSION), true);
		await waitFor('connected', 10000, () => model.connection(KEY)?.state === 'connected');
		assert.strictEqual(hostRows()[0].contextValue, 'herdr.session.running');
	});

	test('a new space, a tab in it, and a split reach the snapshot', async () => {
		const space = await model.request(KEY, 'workspace.create', { focus: false });
		console.log('[live-ctl] workspace.create', JSON.stringify(space).slice(0, 300));
		const firstTab = createdTabId(space);
		assert.ok(firstTab, 'workspace.create names its tab');
		assert.strictEqual(await whenTabKnown(model, KEY, firstTab), true);
		const workspaceId = model.connection(KEY)!.snapshot!.tabs.find((t) => t.tab_id === firstTab)!.workspace_id;

		const tab = await model.request(KEY, 'tab.create', { workspace_id: workspaceId, focus: false });
		const secondTab = createdTabId(tab);
		assert.ok(secondTab, 'tab.create names its tab');
		assert.strictEqual(await whenTabKnown(model, KEY, secondTab), true);

		const panes = () => model.connection(KEY)!.snapshot!.panes.filter((p) => p.tab_id === secondTab);
		await waitFor('the tab pane', 3000, () => panes().length === 1);
		await model.request(KEY, 'pane.split', { target_pane_id: panes()[0].pane_id, direction: 'right', focus: false });
		await waitFor('the split pane', 3000, () => panes().length === 2);
	});

	test('stopping lists it as stopped, and it starts again', async () => {
		const res = await shell.run(sessionStopArgv(SESSION), { timeoutMs: 15000 });
		assert.strictEqual(res.exitCode, 0, res.stderr.toString());
		await model.relist('host');
		await waitFor('dropped', 10000, () => model.connection(KEY) === undefined);
		assert.deepStrictEqual(hostRows().map((r) => [r.description, r.contextValue]), [['stopped', 'herdr.session.stopped']]);
		assert.strictEqual(await startHostSession(model, SESSION), true);
	});
});
