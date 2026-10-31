import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	countCommits,
	diffTrees,
	GitHeadContentProvider,
	gitHeadUri,
	gitRevisionUri,
	parseDiffTree,
	parseGitHeadUri,
	parseSnapshot,
	parseStatus,
	readStatus,
	readToplevel,
	readWorktreeId,
	sinceLetter,
	statusLetter,
	takeSnapshot,
	worktreeMarker,
} from '../git';
import { LocalShell, RemoteShell } from '../remoteShell';

suite('git', () => {
	suite('porcelain parsing', () => {
		const parse = (...records: string[]) => parseStatus(records.join('\0') + '\0');

		test('a branch with an upstream, ahead and behind', () => {
			assert.deepStrictEqual(parse('## main...origin/main [ahead 2, behind 3]'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, changes: [] });
			assert.deepStrictEqual(parse('## main...origin/main [ahead 2]'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0, changes: [] });
			assert.deepStrictEqual(parse('## feat/x...origin/feat/x [behind 1]'), { branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 1, changes: [] });
			assert.deepStrictEqual(parse('## main...origin/main'), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] });
			assert.deepStrictEqual(parse('## main...origin/main [gone]'), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] });
		});

		test('no upstream, detached, and no commits yet', () => {
			assert.deepStrictEqual(parse('## topic'), { branch: 'topic', upstream: undefined, ahead: 0, behind: 0, changes: [] });
			const detached = parse('## HEAD (no branch)');
			assert.strictEqual(detached.branch, undefined);
			assert.strictEqual(parse('## No commits yet on main').branch, 'main');
		});

		test('rename and copy records are skipped; ?? is a path', () => {
			const status = parse('## main', 'R  new name.ts', 'old name.ts', ' M a.ts', 'C  copy.ts', 'orig.ts', '?? un tracked.txt', ' R added.ts', 'gone.ts', 'D  d.ts');
			assert.deepStrictEqual(status.changes, [
				{ xy: 'R ', path: 'new name.ts' },
				{ xy: ' M', path: 'a.ts' },
				{ xy: 'C ', path: 'copy.ts' },
				{ xy: '??', path: 'un tracked.txt' },
				{ xy: ' R', path: 'added.ts' },
				{ xy: 'D ', path: 'd.ts' },
			]);
		});

		test('empty output', () => {
			assert.deepStrictEqual(parseStatus(''), { ahead: 0, behind: 0, changes: [] });
		});
	});

	suite('a real repo in a temp directory', () => {
		let dir: string;
		const shell = new LocalShell();
		const git = (...args: string[]) => cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

		setup(() => {
			dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-git-')));
			git('init', '-q', '-b', 'main');
			git('config', 'user.email', 't@example.invalid');
			git('config', 'user.name', 'T');
			fs.writeFileSync(path.join(dir, 'a.txt'), 'head a\n');
			fs.writeFileSync(path.join(dir, 'old.txt'), 'rename me, long enough to be detected\n');
			git('add', '.');
			git('commit', '-q', '-m', 'one');
		});
		teardown(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test('toplevel from a subdirectory; not a repo is undefined', async () => {
			fs.mkdirSync(path.join(dir, 'sub'));
			assert.strictEqual(await readToplevel(shell, path.join(dir, 'sub')), dir);
			assert.strictEqual(await readToplevel(shell, os.tmpdir()), undefined);
			assert.strictEqual(await readToplevel(shell, path.join(dir, 'missing')), undefined);
		});

		test('status with a rename, an untracked file, and upstream counts', async () => {
			fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
			fs.writeFileSync(path.join(dir, 'new file.txt'), 'x\n');
			git('mv', 'old.txt', 'renamed.txt');
			const status = (await readStatus(shell, dir))!;
			assert.strictEqual(status.head, 'main');
			assert.deepStrictEqual(status.changes, [
				{ xy: ' M', path: 'a.txt' },
				{ xy: 'R ', path: 'renamed.txt' },
				{ xy: '??', path: 'new file.txt' },
			]);
			git('commit', '-q', '-a', '-m', 'two');
			const head = git('rev-parse', 'HEAD').trim();
			git('branch', 'upstream', 'HEAD~1');
			git('branch', '-u', 'upstream');
			const ahead = (await readStatus(shell, dir))!;
			assert.strictEqual(ahead.upstream, 'upstream');
			assert.strictEqual(ahead.ahead, 1);
			assert.strictEqual(ahead.behind, 0);
			git('checkout', '-q', '--detach', head);
			const detached = (await readStatus(shell, dir))!;
			assert.strictEqual(detached.branch, undefined);
			assert.strictEqual(detached.head, git('rev-parse', '--short', 'HEAD').trim());
		});

		test('a rename in the second column (git add -N) has an original path too', async () => {
			git('mv', 'old.txt', 'renamed.txt');
			git('reset', '-q');
			git('add', '-N', 'renamed.txt');
			const status = (await readStatus(shell, dir))!;
			assert.deepStrictEqual(status.changes, [{ xy: ' R', path: 'renamed.txt' }]);
		});

		test('a repo with no commits', async () => {
			const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-git-')));
			try {
				cp.execFileSync('git', ['-C', empty, 'init', '-q', '-b', 'trunk']);
				const status = (await readStatus(shell, empty))!;
				assert.strictEqual(status.head, 'trunk');
				assert.deepStrictEqual(status.changes, []);
			} finally {
				fs.rmSync(empty, { recursive: true, force: true });
			}
		});

		test('the HEAD content provider, through a real document', async () => {
			fs.writeFileSync(path.join(dir, 'a.txt'), 'working tree\n');
			fs.writeFileSync(path.join(dir, 'added.txt'), 'new\n');
			const provider = new GitHeadContentProvider((key) => (key === 'host' ? { shell } : undefined));
			const registration = vscode.workspace.registerTextDocumentContentProvider('herdr-git-test', provider);
			try {
				const uri = gitHeadUri('host', dir, 'a.txt').with({ scheme: 'herdr-git-test' });
				assert.strictEqual((await vscode.workspace.openTextDocument(uri)).getText(), 'head a\n');
				assert.strictEqual(await provider.provideTextDocumentContent(gitHeadUri('host', dir, 'added.txt')), '', 'added: empty');
				assert.strictEqual(await provider.provideTextDocumentContent(gitHeadUri('container:gone', dir, 'a.txt')), '', 'unknown environment: empty, nothing run');
			} finally {
				registration.dispose();
			}
		});
	});

	test('herdr-git URI shape, and what it says survives a round trip', () => {
		const uri = gitHeadUri('container:abcdefabcdef', '/workspaces/my app', 'src/a b.ts');
		assert.strictEqual(uri.scheme, 'herdr-git');
		assert.strictEqual(uri.authority, 'container:abcdefabcdef');
		assert.strictEqual(uri.path, '/workspaces/my app/src/a b.ts');
		assert.strictEqual(uri.query, 'HEAD');
		assert.deepStrictEqual(parseGitHeadUri(vscode.Uri.parse(uri.toString())), { envKey: 'container:abcdefabcdef', toplevel: '/workspaces/my app', file: 'src/a b.ts' });
		assert.strictEqual(parseGitHeadUri(uri.with({ fragment: '' })), undefined);
		assert.strictEqual(parseGitHeadUri(uri.with({ fragment: '3' })), undefined);
	});

	suite('baselines: snapshots and what changed since', () => {
		const shell = new LocalShell();
		const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
		const run = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
		const made: string[] = [];
		const tempDir = (prefix: string) => {
			const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
			made.push(d);
			return d;
		};
		const repo = (commit = true) => {
			const d = tempDir('hv-snap-');
			run(d, 'init', '-q', '-b', 'main');
			run(d, 'config', 'user.email', 't@example.invalid');
			run(d, 'config', 'user.name', 'T');
			if (commit) {
				fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
				fs.writeFileSync(path.join(d, 'b.txt'), 'b\n');
				run(d, 'add', '.');
				run(d, 'commit', '-q', '-m', 'one');
			}
			return d;
		};
		let savedTmp: string | undefined;
		let tmp: string;

		setup(() => {
			// The script's temp dir goes here, so it can be checked to be gone.
			savedTmp = process.env.TMPDIR;
			tmp = tempDir('hv-tmpdir-');
			process.env.TMPDIR = tmp;
		});
		teardown(() => {
			if (savedTmp === undefined) {
				delete process.env.TMPDIR;
			} else {
				process.env.TMPDIR = savedTmp;
			}
			for (const d of made.splice(0)) {
				fs.rmSync(d, { recursive: true, force: true });
			}
		});

		test('parsing the script output', () => {
			const t = 'a'.repeat(40);
			const h = 'b'.repeat(40);
			assert.deepStrictEqual(parseSnapshot(`${t}\n${h}\n`), { tree: t, head: h });
			assert.deepStrictEqual(parseSnapshot(`${t}\n`), { tree: t, head: '' });
			assert.deepStrictEqual(parseSnapshot(`${'c'.repeat(64)}\n${'d'.repeat(64)}\n`), { tree: 'c'.repeat(64), head: 'd'.repeat(64) });
			assert.strictEqual(parseSnapshot(''), undefined);
			assert.strictEqual(parseSnapshot('warning: x\n'), undefined);
			assert.strictEqual(parseSnapshot(`${t}\n${h}\nextra\n`), undefined);
		});

		test("tree and HEAD; the real index is untouched; no temp dir is left", async () => {
			const d = repo();
			fs.writeFileSync(path.join(d, 'a.txt'), 'staged\n');
			run(d, 'add', 'a.txt');
			fs.writeFileSync(path.join(d, 'b.txt'), 'unstaged\n');
			fs.writeFileSync(path.join(d, 'u.txt'), 'untracked\n');
			const index = () => run(d, 'ls-files', '-s', '--debug');
			const status = () => run(d, 'status', '--porcelain=v1');
			const before = [index(), status()];
			const snap = await takeSnapshot(shell, d);
			assert.deepStrictEqual([index(), status()], before);
			assert.strictEqual(snap.head, run(d, 'rev-parse', 'HEAD').trim());
			assert.match(snap.tree, /^[0-9a-f]{40}$/);
			// The tree holds the working state: staged, unstaged and untracked.
			assert.strictEqual(run(d, 'show', `${snap.tree}:a.txt`), 'staged\n');
			assert.strictEqual(run(d, 'show', `${snap.tree}:b.txt`), 'unstaged\n');
			assert.strictEqual(run(d, 'show', `${snap.tree}:u.txt`), 'untracked\n');
			assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('herdr-vscode.')), []);
			assert.deepStrictEqual((await takeSnapshot(shell, d)).tree, snap.tree, 'the same state, the same tree');
		});

		test('in a linked worktree, with no commits, and with no index at all', async () => {
			const main = repo();
			const linked = path.join(tempDir('hv-wt-'), 'linked');
			run(main, 'worktree', 'add', '-q', linked);
			assert.match(run(linked, 'rev-parse', '--git-path', 'index').trim(), /^\//, 'absolute in a linked worktree');
			fs.writeFileSync(path.join(linked, 'w.txt'), 'w\n');
			const wt = await takeSnapshot(shell, linked);
			assert.strictEqual(run(linked, 'show', `${wt.tree}:w.txt`), 'w\n');
			assert.strictEqual(run(linked, 'status', '--porcelain=v1'), '?? w.txt\n');

			const empty = repo(false);
			assert.ok(!fs.existsSync(path.join(empty, '.git', 'index')), 'a fresh git init has no index');
			fs.writeFileSync(path.join(empty, 'first.txt'), 'f\n');
			const unborn = await takeSnapshot(shell, empty);
			assert.strictEqual(unborn.head, '');
			assert.strictEqual(run(empty, 'show', `${unborn.tree}:first.txt`), 'f\n');
			assert.ok(!fs.existsSync(path.join(empty, '.git', 'index')), 'still none');
			assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('herdr-vscode.')), []);
		});

		test('a racily clean file: the copy keeps the index mtime, so the new content is recorded', async () => {
			// A same-size rewrite in the second the index was written, as an agent or a test does right after a commit.
			// ctime is left out of it here, so whole seconds can be set; in the live run it matched by falling in the same second.
			const d = repo(false);
			run(d, 'config', 'core.trustctime', 'false');
			const t = new Date(1700000000 * 1000);
			const a = path.join(d, 'a.txt');
			fs.writeFileSync(a, 'aaaa\n');
			fs.utimesSync(a, t, t);
			run(d, 'add', 'a.txt');
			run(d, 'commit', '-q', '-m', 'one');
			fs.writeFileSync(a, 'bbbb\n');
			fs.utimesSync(a, t, t);
			fs.utimesSync(path.join(d, '.git', 'index'), t, t);
			const snap = await takeSnapshot(shell, d);
			assert.strictEqual(run(d, 'show', `${snap.tree}:a.txt`), 'bbbb\n');
		});

		test('a failure says git\'s first stderr line', async () => {
			const missing = path.join(tmp, 'nope');
			await assert.rejects(takeSnapshot(shell, missing), (err: Error) => err.message === `fatal: cannot change to '${missing}': No such file or directory`);
			const plain = tempDir('hv-plain-');
			await assert.rejects(takeSnapshot(shell, plain), (err: Error) => /^fatal: not a git repository/.test(err.message));
		});

		test('modify, add, delete an untracked-at-baseline file, and commit: M, A, D by path; commits counted', async () => {
			const d = repo();
			fs.writeFileSync(path.join(d, 'u.txt'), 'untracked at baseline\n');
			const base = await takeSnapshot(shell, d);
			fs.writeFileSync(path.join(d, 'b.txt'), 'changed\n');
			fs.writeFileSync(path.join(d, 'new.txt'), 'n\n');
			fs.rmSync(path.join(d, 'u.txt'));
			run(d, 'add', 'b.txt');
			run(d, 'commit', '-q', '-m', 'two');
			const now = await takeSnapshot(shell, d);
			assert.deepStrictEqual(await diffTrees(shell, d, base.tree, now.tree), [
				{ status: 'M', path: 'b.txt' },
				{ status: 'A', path: 'new.txt' },
				{ status: 'D', path: 'u.txt' },
			]);
			assert.strictEqual(await countCommits(shell, d, base.head), 1);
			run(d, 'commit', '-q', '--allow-empty', '-m', 'three');
			assert.strictEqual(await countCommits(shell, d, base.head), 2);
			assert.strictEqual(await countCommits(shell, d, ''), 3, 'from no commits: all of them');
			assert.strictEqual(await countCommits(shell, d, 'f'.repeat(40)), undefined, 'an unknown commit');
			assert.strictEqual(await diffTrees(shell, d, 'f'.repeat(40), now.tree), undefined, 'a pruned baseline');
		});

		test('a type change shows as M', async () => {
			assert.deepStrictEqual(parseDiffTree('T\0link\0M\0a\0'), [
				{ status: 'M', path: 'a' },
				{ status: 'M', path: 'link' },
			]);
			const d = repo();
			const base = await takeSnapshot(shell, d);
			fs.rmSync(path.join(d, 'a.txt'));
			fs.symlinkSync('b.txt', path.join(d, 'a.txt'));
			const raw = run(d, 'diff-tree', '-r', '--no-renames', '--name-status', base.tree, (await takeSnapshot(shell, d)).tree);
			assert.strictEqual(raw, 'T\ta.txt\n', 'git says T');
			assert.deepStrictEqual(await diffTrees(shell, d, base.tree, (await takeSnapshot(shell, d)).tree), [{ status: 'M', path: 'a.txt' }]);
		});

		test('herdr-git at a tree shows the baseline; an invalid query runs nothing', async () => {
			const d = repo();
			const base = await takeSnapshot(shell, d);
			fs.writeFileSync(path.join(d, 'a.txt'), 'later\n');
			let runs = 0;
			const counting: RemoteShell = { run: (argv, o) => (runs++, shell.run(argv, o)), spawn: () => shell.spawn([]) };
			const provider = new GitHeadContentProvider((key) => (key === 'host' ? { shell: counting } : undefined));
			assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'a.txt', base.tree)), 'a\n');
			assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'gone.txt', base.tree)), '', 'not in the tree: empty');
			assert.strictEqual(runs, 2);
			for (const bad of ['--output=x', 'HEAD~1', 'head', 'A'.repeat(40), 'a'.repeat(39), '']) {
				assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'a.txt', bad)), '', bad);
			}
			assert.strictEqual(runs, 2, 'nothing spawned for an invalid query');
		});

		test('worktrees: same, other, another repo, not a repo; a relative common dir', async () => {
			const main = repo();
			fs.mkdirSync(path.join(main, 'sub'));
			const linked = path.join(tempDir('hv-wt-'), 'linked');
			run(main, 'worktree', 'add', '-q', linked);
			assert.strictEqual(run(path.join(main, 'sub'), 'rev-parse', '--git-common-dir').trim(), '../.git', 'relative from a subdirectory');
			const top = await readWorktreeId(shell, main);
			const sub = await readWorktreeId(shell, path.join(main, 'sub'));
			assert.deepStrictEqual(sub, { toplevel: main, commonDir: path.join(main, '.git') });
			assert.deepStrictEqual(top, sub);
			const other = await readWorktreeId(shell, linked);
			assert.strictEqual(other?.commonDir, path.join(main, '.git'));
			assert.strictEqual(worktreeMarker(top, sub), 'same worktree');
			assert.strictEqual(worktreeMarker(top, other), 'other worktree');
			assert.strictEqual(worktreeMarker(top, await readWorktreeId(shell, repo())), undefined, 'another repo');
			assert.strictEqual(await readWorktreeId(shell, tempDir('hv-plain-')), undefined);
			assert.strictEqual(worktreeMarker(top, undefined), undefined, 'not a repo');
			assert.strictEqual(worktreeMarker(undefined, top), undefined);
		});
	});

	test('status letters, the first rule that matches', () => {
		const badge = (xy: string) => [statusLetter(xy).badge, statusLetter(xy).tooltip, statusLetter(xy).color];
		for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
			assert.deepStrictEqual(badge(xy), ['!', 'Conflict', 'gitDecoration.conflictingResourceForeground'], xy);
		}
		assert.deepStrictEqual(badge('??'), ['U', 'Untracked', 'gitDecoration.untrackedResourceForeground']);
		for (const xy of ['D ', ' D', 'MD', 'RD']) {
			assert.deepStrictEqual(badge(xy), ['D', 'Deleted', 'gitDecoration.deletedResourceForeground'], xy);
		}
		for (const xy of ['R ', ' R', 'RM']) {
			assert.deepStrictEqual(badge(xy), ['R', 'Renamed', 'gitDecoration.renamedResourceForeground'], xy);
		}
		for (const xy of ['A ', 'AM', 'C ', ' A']) {
			assert.deepStrictEqual(badge(xy), ['A', 'Added', 'gitDecoration.addedResourceForeground'], xy);
		}
		for (const xy of [' M', 'M ', 'MM', ' T', 'T ']) {
			assert.deepStrictEqual(badge(xy), ['M', 'Modified', 'gitDecoration.modifiedResourceForeground'], xy);
		}
		assert.deepStrictEqual([sinceLetter('A').badge, sinceLetter('M').badge, sinceLetter('D').badge], ['A', 'M', 'D']);
		assert.strictEqual(sinceLetter('D').color, 'gitDecoration.deletedResourceForeground');
	});
});
