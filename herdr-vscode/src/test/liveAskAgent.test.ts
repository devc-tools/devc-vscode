import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentReviewController, failureMessage, isAgentGone, REPLY_ROOT } from '../agentReview';
import { Environments } from '../environments';
import { EnvironmentPaths } from '../paths';
import { SessionModel } from '../sessions';

/**
 * Ask Agent against real herdr: `agent.prompt` over the real bridge, to a fake
 * `claude` (a POSIX sh loop that logs what it is typed and writes `ok` to the
 * reply path in it) running in a pane of the throwaway session. Skipped unless
 * HERDR_VSCODE_LIVE_HOME names a home holding only a running `hv-test`.
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
		await sleep(50);
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

const FAKE_AGENT = (log: string) => `#!/bin/sh
# A fake agent for herdr-vscode's live tests.
printf 'fake claude ready\\n'
while IFS= read -r line; do
  printf '%s\\n' "$line" >> '${log}'
  p=$(printf '%s\\n' "$line" | grep -o '/tmp/herdr-vscode/review/[0-9a-f]*/[0-9]*\\.md' | head -n 1)
  if [ -n "$p" ]; then
    mkdir -p "$(dirname "$p")"
    printf 'ok\\n' > "$p"
  fi
done
`;

(LIVE_HOME ? suite : suite.skip)('live ask agent in an isolated herdr home', function () {
	this.timeout(60000);
	const key = `host/${SESSION}`;
	let realHome: string | undefined;
	let model: SessionModel;
	let paths: EnvironmentPaths;
	let ctl: AgentReviewController;
	let dir: string;
	let file: vscode.Uri;
	let received: string;
	let workspaceId: string | undefined;
	let shellPane: string;
	let agentPane: string;
	const req = (method: string, params: unknown) => model.request(key, method, params);
	const pane = (id: string) => model.connection(key)?.snapshot?.panes.find((p) => p.pane_id === id);
	const comments = (t: vscode.CommentThread) => t.comments.map((c) => [c.author.name, typeof c.body === 'string' ? c.body : c.body.value, c.contextValue, c.label]);
	const threadIds: string[] = [];
	const lastThreadId = () => {
		const ids = [...fs.readFileSync(received, 'utf8').matchAll(/\[herdr-vscode review ([0-9a-f]{8})#\d+\]/g)].map((m) => m[1]);
		return ids[ids.length - 1];
	};

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ask-')));
		received = path.join(dir, 'received.log');
		fs.writeFileSync(received, '');
		const fake = path.join(dir, 'claude');
		fs.writeFileSync(fake, FAKE_AGENT(received), { mode: 0o755 });
		const src = path.join(dir, 'auth.ts');
		fs.writeFileSync(src, Array.from({ length: 25 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\n') + '\n');
		file = vscode.Uri.file(src);

		const log = (l: string) => console.log(`[live-ask] ${l}`);
		const environments = new Environments(() => undefined);
		model = new SessionModel(environments, log);
		paths = new EnvironmentPaths(environments);
		model.start();
		await waitFor('connected', 15000, () => model.connection(key)?.state === 'connected' && !!model.connection(key)?.snapshot);

		const created = (await req('workspace.create', { cwd: dir, label: 'ask', focus: false })) as { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
		workspaceId = created.workspace.workspace_id;
		shellPane = created.root_pane.pane_id;
		agentPane = ((await req('pane.split', { target_pane_id: shellPane, direction: 'right', cwd: dir, focus: false })) as { pane: { pane_id: string } }).pane.pane_id;
		await req('pane.send_text', { pane_id: agentPane, text: `${fake}\r` });
		const ms = await waitFor('the fake detected as an agent', 15000, () => pane(agentPane)?.agent === 'claude');
		console.log(`[live-ask] fake claude detected after ${ms} ms: ${JSON.stringify(pane(agentPane))}`);

		ctl = new AgentReviewController({
			model,
			environments,
			mounts: (env) => paths.mounts(env),
			rowLabel: () => 'this machine › hv-test',
			// Other suites may have reported agents in this session: follow the fake.
			followed: () => `${key}|${agentPane}`,
			pick: async () => undefined,
			log,
		});
		await vscode.workspace.openTextDocument(file);
	});

	suiteTeardown(async () => {
		ctl?.dispose();
		if (workspaceId) {
			await req('workspace.close', { workspace_id: workspaceId }).catch(() => undefined);
		}
		paths?.dispose();
		model?.dispose();
		process.env.HOME = realHome;
		for (const id of threadIds) {
			fs.rmSync(path.join(REPLY_ROOT, id), { recursive: true, force: true });
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('agent.prompt to a plain shell pane fails as agent_not_found, mapped', async () => {
		const err = await req('agent.prompt', { target: shellPane, text: 'x' }).then(
			() => undefined,
			(e: unknown) => e,
		);
		console.log(`[live-ask] plain pane: ${(err as { code?: string }).code}: ${(err as Error).message}`);
		assert.ok(isAgentGone(err), String(err));
		assert.strictEqual(failureMessage(err, 'claude'), 'That agent is gone. Resend to pick another.');
	});

	test('round trip: the prompt reaches the fake, its reply file shows in the thread', async () => {
		const thread = ctl.commentController.createCommentThread(file, new vscode.Range(18, 0, 20, 0), []);
		await ctl.submit({ thread, text: 'Why these three?' });
		assert.deepStrictEqual(comments(thread)[1], ['claude', '_Waiting for reply…_', 'pending', undefined]);
		assert.strictEqual(thread.label, 'Ask agent · claude (ask) · lines 19–21');
		await waitFor('the prompt received', 5000, () => fs.readFileSync(received, 'utf8').includes("Don't post to GitHub"));
		const got = fs.readFileSync(received, 'utf8');
		const id = lastThreadId();
		threadIds.push(id);
		assert.ok(got.startsWith(`[herdr-vscode review ${id}#1] Question from a code review in VS Code.\nLocation: ${file.path}:19-21 (working tree)\n\`\`\`typescript\nexport const v19 = 19;\n`), got);
		const ms = await waitFor('the reply', 5000, () => thread.comments[1]?.contextValue === 'reply');
		console.log(`[live-ask] reply shown ${ms} ms after the prompt was received`);
		assert.deepStrictEqual(comments(thread)[1], ['claude', 'ok\n\n&nbsp;', 'reply', undefined]);
		assert.ok(fs.existsSync(path.join(REPLY_ROOT, id, '1.md')), 'written in the real reply root');
		await ctl.deleteThread(thread);
		assert.ok(!fs.existsSync(path.join(REPLY_ROOT, id)), 'Delete Thread removed it');
	});

	test('a blocked agent: Not sent; Resend after it is idle delivers', async () => {
		const report = (state: string) => req('pane.report_agent', { pane_id: agentPane, source: 'herdr-vscode-test', agent: 'claude', state });
		await report('blocked');
		await waitFor('blocked', 5000, () => pane(agentPane)?.raw_status === 'blocked');
		const thread = ctl.commentController.createCommentThread(file, new vscode.Range(2, 0, 2, 0), []);
		await ctl.submit({ thread, text: 'Blocked?' });
		assert.deepStrictEqual(comments(thread), [['You', 'Blocked?', 'failed', 'Not sent']]);
		await report('idle');
		await waitFor('idle', 5000, () => pane(agentPane)?.raw_status === 'idle');
		await ctl.resend(thread.comments[0] as unknown as { threadId: string; seq: number });
		await waitFor('the reply after Resend', 8000, () => thread.comments[1]?.contextValue === 'reply');
		const id = lastThreadId();
		threadIds.push(id);
		assert.ok(fs.readFileSync(received, 'utf8').includes(`[herdr-vscode review ${id}#1] Question from a code review in VS Code.\nLocation: ${file.path}:3-3 (working tree)`));
		await ctl.deleteThread(thread);
		await waitFor('the watcher stopped', 5000, () => ctl.watcherProcess('host') === undefined);
	});
});
