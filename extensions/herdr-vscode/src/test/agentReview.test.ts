import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	AgentCommentingRanges,
	agentPickItems,
	AgentReviewController,
	AgentTarget,
	buildPrompt,
	Candidate,
	chooseAgent,
	failureMessage,
	findCandidates,
	padReply,
	PromptInput,
	ReplyTracker,
	ReviewConnection,
	ReviewEnvironment,
	sideLabel,
	threadLabel,
} from '../agentReview';
import { BridgeError, HerdrEvent } from '../bridge';
import { EnvironmentsChange } from '../environments';
import { gitHeadUri } from '../git';
import { BindMount, containerPathOf, environmentPathOf } from '../paths';
import { LocalShell } from '../remoteShell';
import { parseSnapshot, Snapshot } from '../sessions';
import { agentRows } from '../views/agentsView';

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

const shell = new LocalShell();
const HOST: ReviewEnvironment = { key: 'host', kind: 'host', shell };
const CONTAINER: ReviewEnvironment = { key: 'container:abcdefabcdef', kind: 'container', containerId: 'abcdefabcdef0123456789', shell };
const SSH: ReviewEnvironment = { key: 'ssh:Dev', kind: 'ssh', alias: 'Dev', shell };
const MOUNTS: BindMount[] = [
	{ source: '/Users/me/code/app', destination: '/workspaces/app' },
	{ source: '/Users/me/code/app/cache/', destination: '/cache/' },
];

/** A snapshot of one workspace `v3_auth` with the given panes. */
function snap(panes: { id: string; agent?: string; status?: string }[]): Snapshot {
	return parseSnapshot({
		workspaces: [{ workspace_id: 'w1', number: 1, label: 'v3_auth', focused: true }],
		tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: true }],
		panes: panes.map((p) => ({ pane_id: p.id, tab_id: 'w1:t1', workspace_id: 'w1', agent: p.agent, agent_status: p.status ?? 'idle', focused: false })),
		agents: [],
	})!;
}

function targets(sessionKey: string, env: ReviewEnvironment, snapshot: Snapshot): AgentTarget[] {
	return agentRows([{ sessionKey, rowLabel: sessionKey, snapshot }]).map((row) => ({ row, env, snapshot }));
}

const mountsOf = async (env: ReviewEnvironment) => (env.kind === 'container' ? MOUNTS : []);

suite('agent review: prompt and labels', () => {
	const base: PromptInput = {
		threadId: 'a1b2c3d4',
		seq: 1,
		environmentPath: '/workspaces/app/src/x.ts',
		startLine: 19,
		endLine: 21,
		side: 'working tree',
		languageId: 'typescript',
		lines: ['const a = 1;', 'const b = 2;', 'return a + b;'],
		comment: 'Why add here?',
	};

	test('first comment', () => {
		assert.strictEqual(
			buildPrompt(base),
			[
				'[herdr-vscode review a1b2c3d4#1] Question from a code review in VS Code.',
				'Location: /workspaces/app/src/x.ts:19-21 (working tree)',
				'```typescript',
				'const a = 1;',
				'const b = 2;',
				'return a + b;',
				'```',
				'Why add here?',
				'',
				"Answer the question. Also write your answer as Markdown to /tmp/herdr-vscode/review/a1b2c3d4/1.md (the reviewer reads it in their editor). Don't change code unless the question asks you to. Don't post to GitHub or the PR; reply only in the file.",
			].join('\n'),
		);
	});

	test('follow-up', () => {
		assert.strictEqual(
			buildPrompt({ ...base, seq: 2, comment: 'And here?' }),
			[
				'[herdr-vscode review a1b2c3d4#2] Follow-up on /workspaces/app/src/x.ts:19-21.',
				'And here?',
				'',
				"Write your answer as Markdown to /tmp/herdr-vscode/review/a1b2c3d4/2.md. Don't post to GitHub or the PR; reply only in the file.",
			].join('\n'),
		);
	});

	test('one line prints N-N; 200 lines are quoted, 201 are not', () => {
		assert.ok(buildPrompt({ ...base, startLine: 7, endLine: 7, lines: ['x'] }).includes('\nLocation: /workspaces/app/src/x.ts:7-7 (working tree)\n```typescript\nx\n```\n'));
		const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
		const p200 = buildPrompt({ ...base, startLine: 1, endLine: 200, lines: lines(200) });
		assert.ok(p200.includes('```typescript\nl0\n') && p200.includes('\nl199\n```\n'));
		const p201 = buildPrompt({ ...base, startLine: 1, endLine: 201, lines: lines(201) });
		assert.ok(p201.includes('(working tree)\n(201 lines selected; read them from the file)\nWhy add here?'));
		assert.ok(!p201.includes('```'));
	});

	test('side labels', () => {
		const q = (scheme: string, query: unknown) => sideLabel({ scheme, query: typeof query === 'string' ? query : JSON.stringify(query) });
		const sha = 'a'.repeat(40);
		assert.strictEqual(q('file', ''), 'working tree');
		assert.strictEqual(q('git', { path: '/x', ref: '' }), 'git diff, index');
		assert.strictEqual(q('git', { path: '/x', ref: '~' }), 'git diff, index');
		assert.strictEqual(q('git', { path: '/x', ref: sha }), `git diff, commit ${sha}`);
		assert.strictEqual(q('git', { path: '/x', ref: 'HEAD' }), 'git diff, HEAD');
		assert.strictEqual(q('review', { base: true, commit: 'abc1234' }), 'PR diff, base side, commit abc1234');
		assert.strictEqual(q('review', { base: false, commit: 'abc1234' }), 'PR diff, changed side, commit abc1234');
		assert.strictEqual(q('pr', { prNumber: 12, isBase: true, baseCommit: 'b1', headCommit: 'h1' }), 'PR #12 diff, base side, commit b1');
		assert.strictEqual(q('pr', { prNumber: 12, isBase: false, baseCommit: 'b1', headCommit: 'h1' }), 'PR #12 diff, head side, commit h1');
		assert.strictEqual(q('git', '{not json'), 'diff view');
		assert.strictEqual(q('git', ''), 'diff view');
		assert.strictEqual(q('git', { path: '/x' }), 'diff view');
		assert.strictEqual(q('review', { commit: 'abc' }), 'diff view');
		assert.strictEqual(q('pr', { prNumber: 1, isBase: true }), 'diff view');
		assert.strictEqual(q('herdr-container', '{"label":"app"}'), 'working tree');
		assert.strictEqual(q('herdr-ssh', ''), 'working tree');
		assert.strictEqual(q('herdr-git', 'HEAD'), 'git diff, HEAD');
		assert.strictEqual(q('herdr-git', 'b'.repeat(40)), 'diff view');
	});

	test('thread labels', () => {
		assert.strictEqual(threadLabel(19, 21, 'working tree'), 'Ask agent · lines 19–21');
		assert.strictEqual(threadLabel(19, 21, 'working tree', { label: 'claude', space: 'v3_auth' }), 'Ask agent · claude (v3_auth) · lines 19–21');
		assert.strictEqual(threadLabel(7, 7, 'working tree'), 'Ask agent · line 7');
		const sha = '0123456789abcdef0123456789abcdef01234567';
		assert.strictEqual(
			threadLabel(3, 4, `PR diff, base side, commit ${sha}`, { label: 'claude', space: 'api' }),
			'Ask agent · claude (api) · lines 3–4 · PR diff, base side, commit 0123456',
		);
		assert.strictEqual(threadLabel(1, 2, 'git diff, HEAD'), 'Ask agent · lines 1–2 · git diff, HEAD');
	});

	test('padReply and failure messages', () => {
		assert.strictEqual(padReply('hi\n\n'), 'hi\n\n&nbsp;');
		assert.strictEqual(failureMessage(new BridgeError('agent_blocked', 'agent w1:p2 is blocked'), 'claude'), 'claude is waiting on a prompt in its pane. Answer it, then Resend.');
		assert.strictEqual(failureMessage(new BridgeError('agent_not_found', 'agent target w1:p1 not found'), 'claude'), 'That agent is gone. Resend to pick another.');
		assert.strictEqual(failureMessage(new BridgeError('timeout', 'agent.prompt timed out'), 'claude'), 'herdr: agent.prompt timed out');
		assert.strictEqual(failureMessage(new Error('session host/x is not connected'), 'claude'), 'herdr: session host/x is not connected');
	});

	test('reply listing parser', () => {
		const t = new ReplyTracker();
		const known = (id: string) => id === 'a1b2c3d4';
		const line1 = '123 10 /tmp/herdr-vscode/review/a1b2c3d4/1.md;999 5 /tmp/herdr-vscode/review/ffffffff/1.md;7 7 /tmp/devc-vscode/review/a1b2c3d4/2.md;';
		assert.deepStrictEqual(t.changed(line1, known), [{ threadId: 'a1b2c3d4', seq: 1 }]);
		assert.deepStrictEqual(t.changed(line1, known), []);
		assert.deepStrictEqual(t.changed('', known), []);
		assert.deepStrictEqual(t.changed('124 10 /tmp/herdr-vscode/review/a1b2c3d4/1.md;', known), [{ threadId: 'a1b2c3d4', seq: 1 }]);
		assert.deepStrictEqual(t.changed('124 11 /tmp/herdr-vscode/review/a1b2c3d4/1.md;5 2 /tmp/herdr-vscode/review/a1b2c3d4/2.md;', known), [
			{ threadId: 'a1b2c3d4', seq: 1 },
			{ threadId: 'a1b2c3d4', seq: 2 },
		]);
		assert.deepStrictEqual(t.changed('124 11 /tmp/herdr-vscode/review/a1b2c3d4/1.md;5 2 /tmp/herdr-vscode/review/a1b2c3d4/2.md;', known), []);
	});
});

suite('agent review: paths', () => {
	test('containerPathOf', () => {
		assert.strictEqual(containerPathOf('/Users/me/code/app/src/a.ts', MOUNTS), '/workspaces/app/src/a.ts');
		// Longest source wins; trailing slashes on either side.
		assert.strictEqual(containerPathOf('/Users/me/code/app/cache/x', MOUNTS), '/cache/x');
		assert.strictEqual(containerPathOf('/Users/me/code/app/cache', MOUNTS), '/cache');
		assert.strictEqual(containerPathOf('/Users/me/code/app', MOUNTS), '/workspaces/app');
		assert.strictEqual(containerPathOf('/Users/me/code/application', MOUNTS), undefined);
		assert.strictEqual(containerPathOf('/etc/hosts', MOUNTS), undefined);
		assert.strictEqual(containerPathOf('/srv/x', [{ source: '/srv/', destination: '/' }]), '/x');
		assert.strictEqual(containerPathOf('/srv', [{ source: '/srv', destination: '/' }]), '/');
	});

	test('environmentPathOf, every cell', () => {
		const at = (uri: vscode.Uri, env: ReviewEnvironment) => environmentPathOf(uri, env, env.kind === 'container' ? MOUNTS : []);
		const host = '/Users/me/code/app/src/a.ts';
		for (const scheme of ['file', 'git', 'review', 'pr']) {
			const uri = vscode.Uri.from({ scheme, path: host, query: scheme === 'file' ? '' : '{"x":1}' });
			assert.strictEqual(at(uri, HOST), host, scheme);
			assert.strictEqual(at(uri, CONTAINER), '/workspaces/app/src/a.ts', scheme);
			assert.strictEqual(at(uri, SSH), undefined, scheme);
		}
		assert.strictEqual(at(vscode.Uri.file('/etc/hosts'), CONTAINER), undefined);
		const inContainer = vscode.Uri.from({ scheme: 'herdr-container', authority: 'abcdefabcdef', path: '/etc/os-release', query: '{"label":"app"}' });
		assert.strictEqual(at(inContainer, CONTAINER), '/etc/os-release');
		assert.strictEqual(at(inContainer.with({ query: '' }), CONTAINER), '/etc/os-release', 'without the label query');
		assert.strictEqual(at(inContainer.with({ authority: 'ABCDEFABCDEF' }), CONTAINER), '/etc/os-release');
		assert.strictEqual(at(inContainer.with({ authority: '111111111111' }), CONTAINER), undefined, 'another container');
		assert.strictEqual(at(inContainer, HOST), undefined);
		assert.strictEqual(at(inContainer, SSH), undefined);
		const onSsh = vscode.Uri.from({ scheme: 'herdr-ssh', authority: 'DEV', path: '/home/me/x' });
		assert.strictEqual(at(onSsh, SSH), '/home/me/x');
		assert.strictEqual(at(vscode.Uri.parse(onSsh.toString()), SSH), '/home/me/x', 'lower-cased by toString');
		assert.strictEqual(at(onSsh.with({ authority: 'other' }), SSH), undefined);
		assert.strictEqual(at(onSsh, HOST), undefined);
		assert.strictEqual(at(onSsh, CONTAINER), undefined);
		for (const env of [HOST, CONTAINER, SSH]) {
			const same = gitHeadUri(env.key, '/repo', 'src/a.ts');
			assert.strictEqual(at(same, env), '/repo/src/a.ts', env.key);
			assert.strictEqual(at(vscode.Uri.parse(same.toString()), env), '/repo/src/a.ts', `${env.key} after toString`);
			assert.strictEqual(at(gitHeadUri('container:999999999999', '/repo', 'src/a.ts'), env), undefined, env.key);
		}
		assert.strictEqual(at(vscode.Uri.from({ scheme: 'untitled', path: 'Untitled-1' }), HOST), undefined);
		assert.strictEqual(at(vscode.Uri.from({ scheme: 'vscode-remote', path: host }), HOST), undefined);
	});
});

suite('agent review: candidates and choice', () => {
	const hostSnap = snap([
		{ id: 'w1:p1', agent: 'claude', status: 'idle' },
		{ id: 'w1:p2' },
		{ id: 'w1:p3', agent: 'codex', status: 'blocked' },
	]);
	const containerSnap = snap([{ id: 'w1:p1', agent: 'claude', status: 'working' }]);
	const all = [...targets('host/s', HOST, hostSnap), ...targets('container:abcdefabcdef/devc', CONTAINER, containerSnap)];
	const doc = (uri: vscode.Uri) => ({ uri, lineCount: 30 }) as vscode.TextDocument;

	test('commenting ranges: the whole document for each mapped scheme, none otherwise', async () => {
		const ranges = new AgentCommentingRanges(() => all, mountsOf);
		const whole = [new vscode.Range(0, 0, 29, 0)];
		const mapped = [
			vscode.Uri.file('/tmp/anything.ts'),
			vscode.Uri.from({ scheme: 'git', path: '/tmp/a.ts', query: '{"ref":""}' }),
			vscode.Uri.from({ scheme: 'review', path: '/tmp/a.ts', query: '{}' }),
			vscode.Uri.from({ scheme: 'pr', path: '/tmp/a.ts', query: '{}' }),
			vscode.Uri.from({ scheme: 'herdr-container', authority: 'abcdefabcdef', path: '/etc/x' }),
			gitHeadUri('host', '/repo', 'a.ts'),
		];
		for (const uri of mapped) {
			assert.deepStrictEqual(await ranges.provideCommentingRanges(doc(uri)), whole, uri.toString());
		}
		assert.deepStrictEqual(
			await new AgentCommentingRanges(() => targets('ssh:Dev/s', SSH, containerSnap), mountsOf).provideCommentingRanges(doc(vscode.Uri.from({ scheme: 'herdr-ssh', authority: 'dev', path: '/x' }))),
			whole,
		);
		// Only a container agent: a host file outside its mounts is not seen.
		const containerOnly = new AgentCommentingRanges(() => targets('container:abcdefabcdef/devc', CONTAINER, containerSnap), mountsOf);
		assert.deepStrictEqual(await containerOnly.provideCommentingRanges(doc(vscode.Uri.file('/etc/hosts'))), []);
		assert.deepStrictEqual(await containerOnly.provideCommentingRanges(doc(vscode.Uri.file('/Users/me/code/app/a.ts'))), whole);
		const untitled = await vscode.workspace.openTextDocument({ content: 'x\ny' });
		assert.deepStrictEqual(await ranges.provideCommentingRanges(untitled), []);
		assert.deepStrictEqual(await new AgentCommentingRanges(() => [], mountsOf).provideCommentingRanges(doc(vscode.Uri.file('/tmp/a.ts'))), []);
	});

	test('candidates carry the environment path', async () => {
		const uri = vscode.Uri.file('/Users/me/code/app/src/a.ts');
		const found = await findCandidates(uri, all, mountsOf);
		assert.deepStrictEqual(
			found.map((c) => [c.row.ref.sessionKey, c.row.ref.paneId, c.path]),
			[
				['host/s', 'w1:p1', '/Users/me/code/app/src/a.ts'],
				['host/s', 'w1:p3', '/Users/me/code/app/src/a.ts'],
				['container:abcdefabcdef/devc', 'w1:p1', '/workspaces/app/src/a.ts'],
			],
		);
		const items = agentPickItems(found);
		assert.deepStrictEqual(
			items.map((i) => [i.label, i.description, i.detail]),
			[
				['codex', 'codex · blocked', 'host/s › v3_auth · blocked'],
				['claude', 'claude · working', 'container:abcdefabcdef/devc › v3_auth · working'],
				['claude', 'claude · idle', 'host/s › v3_auth · idle'],
			],
		);
	});

	test('agent choice order', async () => {
		const uri = vscode.Uri.file('/Users/me/code/app/src/a.ts');
		const found = await findCandidates(uri, all, mountsOf);
		let picks = 0;
		const pick = async (c: readonly Candidate[]) => {
			picks++;
			return c[2];
		};
		const ref = (sessionKey: string, paneId: string) => ({ sessionKey, paneId });
		const key = (c?: { candidate: Candidate; source: string }) => c && `${c.source}:${c.candidate.row.ref.sessionKey}|${c.candidate.row.ref.paneId}`;
		// The thread's agent is kept.
		assert.strictEqual(key(await chooseAgent({ candidates: found, thread: ref('host/s', 'w1:p3'), followed: 'host/s|w1:p1', pick })), 'thread:host/s|w1:p3');
		// The followed pane beats the remembered pick.
		assert.strictEqual(key(await chooseAgent({ candidates: found, followed: 'host/s|w1:p1', remembered: ref('host/s', 'w1:p3'), pick })), 'followed:host/s|w1:p1');
		// A thread agent that is gone falls through.
		assert.strictEqual(key(await chooseAgent({ candidates: found, thread: ref('host/s', 'w1:p9'), followed: 'host/s|w1:p1', pick })), 'followed:host/s|w1:p1');
		// A followed shell pane, or an agent that cannot see the doc, is skipped.
		assert.strictEqual(key(await chooseAgent({ candidates: found, followed: 'host/s|w1:p2', remembered: ref('host/s', 'w1:p3'), pick })), 'remembered:host/s|w1:p3');
		const hostOnly = await findCandidates(vscode.Uri.file('/etc/hosts'), all, mountsOf);
		assert.strictEqual(
			key(await chooseAgent({ candidates: hostOnly, followed: 'container:abcdefabcdef/devc|w1:p1', remembered: ref('host/s', 'w1:p1'), pick })),
			'remembered:host/s|w1:p1',
		);
		// One candidate: no picker.
		const one = await findCandidates(vscode.Uri.file('/etc/hosts'), targets('host/s', HOST, snap([{ id: 'w1:p1', agent: 'claude' }])), mountsOf);
		assert.strictEqual(key(await chooseAgent({ candidates: one, followed: 'x|y', pick })), 'only:host/s|w1:p1');
		assert.strictEqual(picks, 0);
		// Otherwise the picker.
		assert.strictEqual(key(await chooseAgent({ candidates: found, followed: 'host/s|w1:p2', pick })), 'picker:container:abcdefabcdef/devc|w1:p1');
		assert.strictEqual(picks, 1);
		assert.strictEqual(await chooseAgent({ candidates: found, pick: async () => undefined }), undefined);
		assert.strictEqual(await chooseAgent({ candidates: [], pick }), undefined);
		assert.strictEqual(picks, 1);
	});
});

/** A model with one connected host session whose `request` is scripted. */
class FakeModel {
	readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	readonly onDidEvent = this.events.event;
	readonly calls: { key: string; method: string; params: unknown }[] = [];
	fail: Error | undefined;
	constructor(private readonly conns: ReviewConnection[]) {}
	connections(): ReviewConnection[] {
		return this.conns;
	}
	async request(key: string, method: string, params: unknown): Promise<unknown> {
		this.calls.push({ key, method, params });
		if (this.fail) {
			throw this.fail;
		}
		return { type: 'agent_prompted' };
	}
}

suite('agent review: extension host round trip', function () {
	this.timeout(30000);
	let dir: string;
	let root: string;
	let file: vscode.Uri;
	let model: FakeModel;
	let ctl: AgentReviewController;
	const envChanged = new vscode.EventEmitter<EnvironmentsChange>();
	const containerEvents = new vscode.EventEmitter<string>();

	suiteSetup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-review-'));
		root = path.join(dir, 'review');
		fs.mkdirSync(root);
		const p = path.join(dir, 'a.ts');
		fs.writeFileSync(p, Array.from({ length: 30 }, (_, i) => `const l${i + 1} = ${i + 1};`).join('\n') + '\n');
		file = vscode.Uri.file(p);
		model = new FakeModel([{ key: 'host/s', name: 's', state: 'connected', env: HOST, snapshot: snap([{ id: 'w1:p2', agent: 'claude', status: 'idle' }]) }]);
		ctl = new AgentReviewController({
			model,
			environments: { onDidChange: envChanged.event, onDidContainerEvent: containerEvents.event },
			mounts: async () => [],
			rowLabel: () => 'this machine › s',
			followed: () => undefined,
			pick: async () => undefined,
			replyRoot: root,
		});
	});

	suiteTeardown(() => {
		ctl?.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const comments = (t: vscode.CommentThread) => t.comments.map((c) => [c.author.name, typeof c.body === 'string' ? c.body : c.body.value, c.contextValue, c.label]);
	const threadIdOf = (text: string) => /^\[herdr-vscode review ([0-9a-f]{8})#(\d+)\]/.exec(text)![1];
	const lastPrompt = () => (model.calls[model.calls.length - 1].params as { text: string }).text;

	test('submit, reply, rewrite, failure, Resend, Delete, watcher exit', async () => {
		await vscode.workspace.openTextDocument(file);
		// Thread A on lines 19–21, as the gutter `+` would make it.
		const a = ctl.commentController.createCommentThread(file, new vscode.Range(18, 0, 20, 0), []);
		await ctl.submit({ thread: a, text: '  Why?  ' });
		assert.strictEqual(model.calls.length, 1);
		assert.deepStrictEqual(Object.keys(model.calls[0].params as object).sort(), ['target', 'text']);
		assert.strictEqual(model.calls[0].method, 'agent.prompt');
		assert.strictEqual((model.calls[0].params as { target: string }).target, 'w1:p2');
		const idA = threadIdOf(lastPrompt());
		assert.ok(lastPrompt().includes(`Location: ${file.path}:19-21 (working tree)\n\`\`\`typescript\nconst l19 = 19;\nconst l20 = 20;\nconst l21 = 21;\n\`\`\`\nWhy?\n`));
		assert.ok(lastPrompt().includes(`${root}/${idA}/1.md`));
		assert.deepStrictEqual(comments(a), [
			['You', 'Why?', undefined, undefined],
			['claude', '_Waiting for reply…_', 'pending', undefined],
		]);
		assert.strictEqual(a.label, 'Ask agent · claude (v3_auth) · lines 19–21');
		assert.strictEqual(a.contextValue, 'hasAgent');
		assert.ok(fs.existsSync(path.join(root, idA)), 'reply directory made');
		const watcher = ctl.watcherProcess('host');
		assert.ok(watcher, 'the watcher runs');

		// Thread B stays pending, so the watcher keeps running through A's rewrite.
		const b = ctl.commentController.createCommentThread(file, new vscode.Range(0, 0, 0, 0), []);
		await ctl.submit({ thread: b, text: 'And this?' });
		const idB = threadIdOf(lastPrompt());
		assert.strictEqual(ctl.watcherProcess('host'), watcher, 'one watcher per environment');

		fs.writeFileSync(path.join(root, idA, '1.md'), 'Because.\n');
		const ms = await waitFor('reply', 3000, () => a.comments[1]?.contextValue === 'reply');
		console.log(`[agent-review] reply shown after ${ms} ms`);
		assert.deepStrictEqual(comments(a)[1], ['claude', 'Because.\n\n&nbsp;', 'reply', undefined]);
		fs.writeFileSync(path.join(root, idA, '1.md'), 'Because, rewritten.\n');
		await waitFor('rewritten reply', 3000, () => (a.comments[1]?.body as vscode.MarkdownString).value.startsWith('Because, rewritten.'));

		// A blocked agent: Not sent, no placeholder.
		model.fail = new BridgeError('agent_blocked', 'agent w1:p2 is blocked and requires interactive input');
		const c = ctl.commentController.createCommentThread(file, new vscode.Range(4, 0, 4, 0), []);
		await ctl.submit({ thread: c, text: 'Third?' });
		assert.deepStrictEqual(comments(c), [['You', 'Third?', 'failed', 'Not sent']]);
		model.fail = undefined;
		await ctl.resend(c.comments[0] as unknown as { threadId: string; seq: number });
		assert.deepStrictEqual(comments(c), [
			['You', 'Third?', undefined, undefined],
			['claude', '_Waiting for reply…_', 'pending', undefined],
		]);
		const idC = threadIdOf(lastPrompt());
		assert.ok(fs.existsSync(path.join(root, idC)));
		await ctl.deleteThread(c);
		assert.ok(!fs.existsSync(path.join(root, idC)), 'Delete Thread removes the reply directory');

		// B's reply is the last one pending: the watcher ends after it.
		fs.writeFileSync(path.join(root, idB, '1.md'), 'Yes.');
		await waitFor('reply B', 3000, () => b.comments[1]?.contextValue === 'reply');
		assert.strictEqual(ctl.watcherProcess('host'), undefined);
		await waitFor('watcher exit', 5000, () => watcher!.exitCode !== null || watcher!.signalCode !== null);
		console.log(`[agent-review] watcher exit ${watcher!.exitCode} ${watcher!.signalCode}`);
		const left = cp.spawnSync('pgrep', ['-f', root]).stdout.toString().trim();
		assert.strictEqual(left, '', `no watcher loop left: ${left}`);
		a.dispose();
		b.dispose();
	});

	test('agent_not_found clears the thread agent; follow-ups use the follow-up form', async () => {
		const t = ctl.commentController.createCommentThread(file, new vscode.Range(2, 0, 3, 0), []);
		model.fail = new BridgeError('agent_not_found', 'agent target w1:p2 not found');
		await ctl.submit({ thread: t, text: 'Gone?' });
		assert.deepStrictEqual(comments(t), [['You', 'Gone?', 'failed', 'Not sent']]);
		assert.strictEqual(t.contextValue, undefined);
		model.fail = undefined;
		await ctl.resend(t.comments[0] as unknown as { threadId: string; seq: number });
		await ctl.submit({ thread: t, text: 'More?' });
		assert.ok(/^\[herdr-vscode review [0-9a-f]{8}#2\] Follow-up on .*a\.ts:3-4\.\nMore\?\n/.test(lastPrompt()), lastPrompt());
		assert.strictEqual(t.comments.length, 4);
		await ctl.deleteThread(t);
		await waitFor('watcher stopped', 3000, () => ctl.watcherProcess('host') === undefined);
	});

	test('a moved pane keeps its thread', async () => {
		let shown: unknown;
		const moved = new AgentReviewController({
			model,
			environments: { onDidChange: envChanged.event, onDidContainerEvent: containerEvents.event },
			mounts: async () => [],
			rowLabel: () => undefined,
			followed: () => undefined,
			showPane: async (ref) => {
				shown = ref;
			},
			replyRoot: root,
		});
		try {
			const t2 = moved.commentController.createCommentThread(file, new vscode.Range(0, 0, 0, 0), []);
			await moved.submit({ thread: t2, text: 'Q' });
			await moved.showAgent(t2);
			assert.deepStrictEqual(shown, { sessionKey: 'host/s', paneId: 'w1:p2' });
			model.events.fire({ sessionKey: 'host/s', event: { event: 'pane.moved', data: { previous_pane_id: 'w1:p2', pane: { pane_id: 'w2:p1' } } } });
			shown = undefined;
			await moved.showAgent(t2);
			assert.strictEqual(shown, undefined, 'w2:p1 is not in the snapshot: That agent is gone.');
			await moved.deleteThread(t2);
		} finally {
			moved.dispose();
		}
	});
});
