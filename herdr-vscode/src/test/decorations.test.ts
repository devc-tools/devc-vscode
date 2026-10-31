import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitApiLike, PaneDecorations, SINCE_FRAGMENT } from '../decorations';

class FakeGit implements GitApiLike {
	state: 'uninitialized' | 'initialized' = 'initialized';
	readonly repos = new Set<string>();
	readonly opened = new vscode.EventEmitter<unknown>();
	readonly closed = new vscode.EventEmitter<unknown>();
	readonly stateChanged = new vscode.EventEmitter<unknown>();
	readonly onDidOpenRepository = this.opened.event;
	readonly onDidCloseRepository = this.closed.event;
	readonly onDidChangeState = this.stateChanged.event;
	getRepository(uri: vscode.Uri): unknown | null {
		return [...this.repos].some((r) => uri.path === r || uri.path.startsWith(`${r}/`)) ? {} : null;
	}
}

suite('decorations', () => {
	const file = (p: string) => vscode.Uri.file(p);
	const container = (p: string) => vscode.Uri.from({ scheme: 'herdr-container', authority: 'abcdefabcdef', path: p, query: JSON.stringify({ label: 'app' }) });
	const badge = (d: vscode.FileDecoration | undefined | null) => d && [d.badge, d.tooltip, (d.color as vscode.ThemeColor | undefined)?.id, d.propagate];
	let git: FakeGit | undefined;
	let deco: PaneDecorations;
	let fired: (vscode.Uri | vscode.Uri[] | undefined)[];

	setup(() => {
		git = new FakeGit();
		deco = new PaneDecorations(() => git);
		fired = [];
		deco.onDidChangeFileDecorations((e) => fired.push(e));
	});
	teardown(() => deco.dispose());

	test('the XY table, row by row, with propagation', () => {
		const rows: [string, string, string, string][] = [
			['UU', '!', 'Conflict', 'gitDecoration.conflictingResourceForeground'],
			['??', 'U', 'Untracked', 'gitDecoration.untrackedResourceForeground'],
			[' D', 'D', 'Deleted', 'gitDecoration.deletedResourceForeground'],
			['R ', 'R', 'Renamed', 'gitDecoration.renamedResourceForeground'],
			['A ', 'A', 'Added', 'gitDecoration.addedResourceForeground'],
			['C ', 'A', 'Added', 'gitDecoration.addedResourceForeground'],
			[' M', 'M', 'Modified', 'gitDecoration.modifiedResourceForeground'],
			[' T', 'M', 'Modified', 'gitDecoration.modifiedResourceForeground'],
		];
		deco.set({ status: rows.map(([xy], i) => ({ uri: container(`/r/f${i}`), xy })), untrackedDirs: [], since: [] });
		rows.forEach(([xy, b, tooltip, color], i) => {
			assert.deepStrictEqual(badge(deco.provideFileDecoration(container(`/r/f${i}`))), [b, tooltip, color, true], xy);
		});
		assert.strictEqual(deco.provideFileDecoration(container('/r')), undefined, 'folders are not decorated directly');
		assert.strictEqual(deco.provideFileDecoration(container('/r/other')), undefined);
	});

	test('an untracked directory and anything under it', () => {
		const dir = container('/r/fresh');
		deco.set({ status: [{ uri: dir, xy: '??' }], untrackedDirs: [dir], since: [] });
		assert.deepStrictEqual(badge(deco.provideFileDecoration(dir)), ['U', 'Untracked', 'gitDecoration.untrackedResourceForeground', true]);
		assert.deepStrictEqual(badge(deco.provideFileDecoration(vscode.Uri.joinPath(dir, 'deep', 'x.ts'))), ['U', 'Untracked', 'gitDecoration.untrackedResourceForeground', true]);
		assert.strictEqual(deco.provideFileDecoration(container('/r/freshly')), undefined, 'a sibling with the same prefix');
		assert.strictEqual(deco.provideFileDecoration(dir.with({ query: '' }).with({ path: '/r/fresh/x' })), undefined, 'another URI shape');
	});

	test('since rows: their own letters, never propagated, never yielded', () => {
		const a = file('/repo/scopes.ts').with({ fragment: SINCE_FRAGMENT });
		const m = file('/repo/b.ts').with({ fragment: SINCE_FRAGMENT });
		const d = file('/repo/c.ts').with({ fragment: SINCE_FRAGMENT });
		git!.repos.add('/repo');
		deco.set({
			status: [{ uri: file('/repo/scopes.ts'), xy: '??' }],
			untrackedDirs: [],
			since: [
				{ uri: a, status: 'A' },
				{ uri: m, status: 'M' },
				{ uri: d, status: 'D' },
			],
			sinceTime: '10:31',
		});
		assert.deepStrictEqual(badge(deco.provideFileDecoration(a)), ['A', 'Added since 10:31', 'gitDecoration.addedResourceForeground', false]);
		assert.deepStrictEqual(badge(deco.provideFileDecoration(m)), ['M', 'Modified since 10:31', 'gitDecoration.modifiedResourceForeground', false]);
		assert.deepStrictEqual(badge(deco.provideFileDecoration(d)), ['D', 'Deleted since 10:31', 'gitDecoration.deletedResourceForeground', false]);
		assert.strictEqual(deco.provideFileDecoration(file('/repo/scopes.ts')), undefined, 'the plain file is Git\'s');
	});

	test("file: URIs yield to VS Code's Git when it has the repo; decorated when it has not, or is absent", () => {
		const f = file('/repo/a.ts');
		deco.set({ status: [{ uri: f, xy: ' M' }, { uri: container('/repo/a.ts'), xy: ' M' }], untrackedDirs: [], since: [] });
		assert.strictEqual(badge(deco.provideFileDecoration(f))?.[0], 'M', 'getRepository is null');
		git!.repos.add('/repo');
		assert.strictEqual(deco.provideFileDecoration(f), undefined, 'Git has it');
		assert.strictEqual(badge(deco.provideFileDecoration(container('/repo/a.ts')))?.[0], 'M', 'herdr-container: always');
		fired.length = 0;
		git!.opened.fire({});
		assert.strictEqual(fired.length, 1, 'a repository opening re-fires');
		assert.ok(Array.isArray(fired[0]) && fired[0].length === 2);
		git!.stateChanged.fire({});
		assert.strictEqual(fired.length, 2);

		git = undefined;
		deco.attachGit();
		assert.strictEqual(badge(deco.provideFileDecoration(f))?.[0], 'M', 'Git absent: decorated');
	});

	test('changes fire the explicit old ∪ new URIs, never undefined', () => {
		const a = container('/r/a');
		const b = container('/r/b');
		const c = container('/r/c');
		deco.set({ status: [{ uri: a, xy: ' M' }, { uri: b, xy: '??' }], untrackedDirs: [], since: [] });
		assert.deepStrictEqual(fired.map((e) => (e as vscode.Uri[]).map(String).sort()), [[a, b].map(String).sort()]);
		fired.length = 0;
		deco.set({ status: [{ uri: a, xy: ' M' }, { uri: b, xy: 'A ' }, { uri: c, xy: '??' }], untrackedDirs: [], since: [] });
		assert.deepStrictEqual((fired[0] as vscode.Uri[]).map(String).sort(), [b, c].map(String).sort(), 'b changed letter, c is new; a is the same');
		fired.length = 0;
		deco.set({ status: [{ uri: c, xy: '??' }], untrackedDirs: [], since: [] });
		assert.deepStrictEqual((fired[0] as vscode.Uri[]).map(String).sort(), [a, b].map(String).sort());
		fired.length = 0;
		deco.set({ status: [{ uri: c, xy: '??' }], untrackedDirs: [], since: [] });
		assert.strictEqual(fired.length, 0, 'nothing changed');
		deco.set(undefined);
		assert.deepStrictEqual((fired[0] as vscode.Uri[]).map(String), [String(c)]);
		assert.ok(fired.every((e) => Array.isArray(e)));
		assert.strictEqual(deco.provideFileDecoration(c), undefined);
	});
});
