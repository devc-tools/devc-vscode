import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	EMPTY_TREE,
	GitHeadContentProvider,
	gitHeadUri,
	gitRevisionUri,
	isoLocal,
	makeSpanDir,
	parseDiffTree,
	parseGitHeadUri,
	parseLog,
	parseStatus,
	readBase,
	readCommitFiles,
	readCommits,
	readStatus,
	readToplevel,
	readWorktreeId,
	removeSpanDir,
	shortTime,
	spanDiff,
	spanSnapshot,
	statusLetter,
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

	suite('span snapshots and commits over temp repos', () => {
		const shell = new LocalShell();
		const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
		const run = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
		const made: string[] = [];
		const tempDir = (prefix: string) => {
			const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
			made.push(d);
			return d;
		};
		const configure = (d: string) => {
			run(d, 'config', 'user.email', 't@example.invalid');
			run(d, 'config', 'user.name', 'T');
		};
		const repo = (commit = true) => {
			const d = tempDir('hv-snap-');
			run(d, 'init', '-q', '-b', 'main');
			configure(d);
			if (commit) {
				fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
				fs.writeFileSync(path.join(d, 'b.txt'), 'b\n');
				run(d, 'add', '.');
				run(d, 'commit', '-q', '-m', 'one');
			}
			return d;
		};
		const commit = (d: string, message: string, file = 'f.txt', content = message) => {
			fs.writeFileSync(path.join(d, file), `${content}\n`);
			run(d, 'add', file);
			run(d, 'commit', '-q', '-m', message);
			return run(d, 'rev-parse', 'HEAD').trim();
		};
		/** Every file under a directory with its size and mtime. */
		const listing = (dir: string): string[] => {
			const out: string[] = [];
			const walk = (d: string) => {
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const p = path.join(d, e.name);
					if (e.isDirectory()) {
						walk(p);
					} else {
						const st = fs.statSync(p);
						out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`);
					}
				}
			};
			walk(dir);
			return out.sort();
		};
		const objectCount = (gitDir: string) => listing(path.join(gitDir, 'objects')).length;
		/** A whole span, as the recorder runs it. */
		const span = async (top: string, during: () => void) => {
			const d = await makeSpanDir(shell);
			try {
				const start = await spanSnapshot(shell, top, d);
				during();
				const end = await spanSnapshot(shell, top, d);
				return { dir: d, changes: await spanDiff(shell, top, d, start, end) };
			} finally {
				await removeSpanDir(shell, d);
			}
		};
		let savedTmp: string | undefined;
		let tmp: string;

		setup(() => {
			// Span directories go here, so they can be checked to be gone.
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

		test('a span: M / A / D for exactly its files; nothing written to .git; its directory is gone', async () => {
			const d = repo();
			fs.writeFileSync(path.join(d, 'a.txt'), 'modified before the span\n');
			fs.writeFileSync(path.join(d, 'gone.txt'), 'untracked, deleted in the span\n');
			const gitDir = path.join(d, '.git');
			const index = path.join(gitDir, 'index');
			run(d, 'status', '--porcelain=v1'); // git status itself refreshes the real index: before the span.
			const before = { objects: objectCount(gitDir), index: fs.statSync(index).mtimeMs, all: listing(gitDir) };
			const { dir, changes } = await span(d, () => {
				fs.writeFileSync(path.join(d, 'b.txt'), 'changed in the span\n');
				fs.mkdirSync(path.join(d, 'src'));
				fs.writeFileSync(path.join(d, 'src', 'new.ts'), 'added\n');
				fs.rmSync(path.join(d, 'gone.txt'));
			});
			assert.deepStrictEqual(changes, [
				{ status: 'M', path: 'b.txt' },
				{ status: 'D', path: 'gone.txt' },
				{ status: 'A', path: 'src/new.ts' },
			]);
			assert.ok(!changes.some((c) => c.path === 'a.txt'), 'modified before the span: not reported');
			assert.ok(dir.startsWith(`${tmp}/herdr-vscode-span.`), dir);
			assert.ok(!fs.existsSync(dir), 'the span directory is gone');
			assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('herdr-vscode-span.')), []);
			assert.strictEqual(objectCount(gitDir), before.objects, '.git/objects file count');
			assert.strictEqual(fs.statSync(index).mtimeMs, before.index, '.git/index mtime');
			assert.deepStrictEqual(listing(gitDir), before.all, 'nothing in .git changed at all, mtimes included');
		});

		test('the snapshot writes its objects to the span directory, and the tree reads through the repo', async () => {
			const d = repo();
			fs.writeFileSync(path.join(d, 'u.txt'), 'untracked\n');
			const spanDir = await makeSpanDir(shell);
			try {
				const tree = await spanSnapshot(shell, d, spanDir);
				assert.match(tree, /^[0-9a-f]{40}$/);
				assert.ok(fs.existsSync(path.join(spanDir, 'index')), 'the span index');
				assert.ok(listing(path.join(spanDir, 'objects')).length > 0, 'new objects in the span');
				assert.throws(() => run(d, 'cat-file', '-e', tree), 'the repo itself does not have the tree');
				assert.strictEqual(await spanSnapshot(shell, d, spanDir), tree, 'the same state, the same tree');
			} finally {
				await removeSpanDir(shell, spanDir);
			}
		});

		test('a linked worktree (absolute objects path) and a plain repo (relative) both work', async () => {
			const main = repo();
			const linked = path.join(tempDir('hv-wt-'), 'linked');
			run(main, 'worktree', 'add', '-q', linked);
			assert.match(run(main, 'rev-parse', '--git-path', 'objects').trim(), /^\.git\/objects$/, 'relative in a plain repo');
			assert.match(run(linked, 'rev-parse', '--git-path', 'objects').trim(), /^\//, 'absolute in a linked worktree');
			const gitDir = path.join(main, '.git');
			// The checkout's files are racily clean: add -A hashes them again, to blobs the repo already has.
			const before = listing(gitDir);
			const { changes } = await span(linked, () => {
				fs.writeFileSync(path.join(linked, 'w.txt'), 'w\n');
				fs.writeFileSync(path.join(linked, 'a.txt'), 'changed\n');
			});
			assert.deepStrictEqual(changes, [
				{ status: 'M', path: 'a.txt' },
				{ status: 'A', path: 'w.txt' },
			]);
			assert.deepStrictEqual(listing(gitDir), before, 'the common .git (and the worktree index) unchanged');
		});

		test('no commits and no index at all', async () => {
			const empty = repo(false);
			assert.ok(!fs.existsSync(path.join(empty, '.git', 'index')), 'a fresh git init has no index');
			const { changes } = await span(empty, () => fs.writeFileSync(path.join(empty, 'first.txt'), 'f\n'));
			assert.deepStrictEqual(changes, [{ status: 'A', path: 'first.txt' }]);
			assert.ok(!fs.existsSync(path.join(empty, '.git', 'index')), 'still none');
		});

		test('a racily clean file: the copy keeps the index mtime, so the new content is recorded', async () => {
			// A same-size rewrite in the second the index was written, as an agent or a test does right after a commit.
			// ctime is left out of it here, so whole seconds can be set.
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
			const spanDir = await makeSpanDir(shell);
			try {
				const tree = await spanSnapshot(shell, d, spanDir);
				const head = run(d, 'rev-parse', 'HEAD^{tree}').trim();
				assert.notStrictEqual(tree, head, 'bbbb was hashed, not taken from the stat cache');
			} finally {
				await removeSpanDir(shell, spanDir);
			}
		});

		test("a failure says git's first stderr line", async () => {
			const spanDir = await makeSpanDir(shell);
			try {
				const missing = path.join(tmp, 'nope');
				await assert.rejects(spanSnapshot(shell, missing, spanDir), (err: Error) => err.message === `fatal: cannot change to '${missing}': No such file or directory`);
				const plain = tempDir('hv-plain-');
				await assert.rejects(spanSnapshot(shell, plain, spanDir), (err: Error) => /^fatal: not a git repository/.test(err.message));
				await assert.rejects(spanDiff(shell, repo(), spanDir, 'f'.repeat(40), 'e'.repeat(40)), /^Error: fatal:/);
			} finally {
				await removeSpanDir(shell, spanDir);
			}
		});

		test('a type change shows as M', async () => {
			assert.deepStrictEqual(parseDiffTree('T\0link\0M\0a\0'), [
				{ status: 'M', path: 'a' },
				{ status: 'M', path: 'link' },
			]);
			const d = repo();
			const { changes } = await span(d, () => {
				fs.rmSync(path.join(d, 'a.txt'));
				fs.symlinkSync('b.txt', path.join(d, 'a.txt'));
			});
			assert.deepStrictEqual(changes, [{ status: 'M', path: 'a.txt' }]);
		});

		test('herdr-git at a commit SHA and the empty tree; an invalid query runs nothing', async () => {
			const d = repo();
			const first = run(d, 'rev-parse', 'HEAD').trim();
			fs.writeFileSync(path.join(d, 'a.txt'), 'later\n');
			let runs = 0;
			const counting: RemoteShell = { run: (argv, o) => (runs++, shell.run(argv, o)), spawn: () => shell.spawn([]) };
			const provider = new GitHeadContentProvider((key) => (key === 'host' ? { shell: counting } : undefined));
			assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'a.txt', first)), 'a\n');
			assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'gone.txt', first)), '', 'not in the commit: empty');
			assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'a.txt', EMPTY_TREE)), '', 'the empty tree: empty');
			assert.strictEqual(runs, 3);
			for (const bad of ['--output=x', 'HEAD~1', 'head', 'A'.repeat(40), 'a'.repeat(39), '']) {
				assert.strictEqual(await provider.provideTextDocumentContent(gitRevisionUri('host', d, 'a.txt', bad)), '', bad);
			}
			assert.strictEqual(runs, 3, 'nothing spawned for an invalid query');
		});

		test('git log parse: a multi-line body, a root commit, malformed records', () => {
			const a = 'a'.repeat(40);
			const b = 'b'.repeat(40);
			const c = 'c'.repeat(64);
			const out = [
				`${a}\x1f${b}\x1fAnn Author\x1f1793643563\x1fSubject line\n\nBody one\nBody two\n`,
				`${b}\x1f\x1fRoot\x1f1700000000\x1f\n`,
				'not a record',
				`xyz\x1f\x1fX\x1f1\x1fbad sha\n`,
				`${a}\x1f\x1fshort`,
				`${c}\x1f${a} ${b}\x1fM\x1f1\x1fmerge\x1fwith a unit separator\n`,
				'',
			].join('\0');
			const commits = parseLog(out);
			assert.deepStrictEqual(
				commits.map((x) => [x.sha.slice(0, 3), x.parents.length, x.author, x.at]),
				[
					['aaa', 1, 'Ann Author', 1793643563000],
					['bbb', 0, 'Root', 1700000000000],
					['ccc', 2, 'M', 1000],
				],
			);
			assert.strictEqual(commits[0].body, 'Subject line\n\nBody one\nBody two\n');
			assert.deepStrictEqual(commits[1].parents, [], 'a root commit has no parents');
			assert.strictEqual(commits[2].body, 'merge\x1fwith a unit separator\n');
		});

		test('base detection: a clone counts against origin/HEAD', async () => {
			const upstream = repo();
			const clone = path.join(tempDir('hv-clone-'), 'c');
			cp.execFileSync('git', ['clone', '-q', upstream, clone], { env });
			configure(clone);
			assert.strictEqual(await readBase(shell, clone), 'origin/main');
			run(clone, 'checkout', '-q', '-b', 'feat');
			const f1 = commit(clone, 'feat one');
			const f2 = commit(clone, 'feat two');
			const list = (await readCommits(shell, clone))!;
			assert.strictEqual(list.description, 'vs origin/main');
			assert.deepStrictEqual(list.commits.map((c) => c.sha), [f2, f1], "only the branch's commits");
			assert.strictEqual(list.head, f2);
		});

		test('base detection: no remote, but a main', async () => {
			const local = repo();
			run(local, 'checkout', '-q', '-b', 'topic');
			const t1 = commit(local, 'topic one');
			assert.strictEqual(await readBase(shell, local), 'main');
			const vsMain = (await readCommits(shell, local))!;
			assert.strictEqual(vsMain.description, 'vs main');
			assert.deepStrictEqual(vsMain.commits.map((c) => c.sha), [t1]);
		});

		test('base detection: on main itself, the most recent, at most 20', async () => {
			const local = repo();
			// Empty commits: one git process each, where commit() takes three.
			for (let i = 0; i < 24; i++) {
				run(local, 'commit', '-q', '--allow-empty', '-m', `main ${i}`);
			}
			const recent = (await readCommits(shell, local))!;
			assert.strictEqual(recent.description, 'recent');
			assert.strictEqual(recent.commits.length, 20);
			assert.strictEqual(recent.commits[0].body, 'main 23\n');
		});

		test('base detection: a master, and neither', async () => {
			const m = tempDir('hv-master-');
			run(m, 'init', '-q', '-b', 'master');
			configure(m);
			commit(m, 'one');
			assert.strictEqual(await readBase(shell, m), 'master');
			const none = tempDir('hv-none-');
			run(none, 'init', '-q', '-b', 'trunk');
			configure(none);
			commit(none, 'one');
			assert.strictEqual(await readBase(shell, none), undefined);
			assert.strictEqual((await readCommits(shell, none))!.description, 'recent');
			assert.strictEqual(await readCommits(shell, repo(false)), undefined, 'no HEAD: no Commits');
		});

		test('commit files: modify / add / delete, and a root commit', async () => {
			const d = repo();
			const root = run(d, 'rev-list', '--max-parents=0', 'HEAD').trim();
			fs.writeFileSync(path.join(d, 'a.txt'), 'changed\n');
			fs.rmSync(path.join(d, 'b.txt'));
			fs.mkdirSync(path.join(d, 'src'));
			fs.writeFileSync(path.join(d, 'src', 'n.ts'), 'n\n');
			run(d, 'add', '-A');
			run(d, 'commit', '-q', '-m', 'two');
			const [two] = parseLog(run(d, 'log', '-z', '-n', '1', '--format=%H%x1f%P%x1f%an%x1f%at%x1f%B', 'HEAD'));
			assert.deepStrictEqual(await readCommitFiles(shell, d, two), [
				{ status: 'M', path: 'a.txt' },
				{ status: 'D', path: 'b.txt' },
				{ status: 'A', path: 'src/n.ts' },
			]);
			assert.deepStrictEqual(await readCommitFiles(shell, d, { sha: root, parents: [] }), [
				{ status: 'A', path: 'a.txt' },
				{ status: 'A', path: 'b.txt' },
			]);
			assert.strictEqual(await readCommitFiles(shell, d, { sha: 'f'.repeat(40), parents: [] }), undefined);
		});

		test('times: HH:MM today, else Mon D HH:MM; ISO 8601 local', () => {
			const now = new Date(2026, 10, 2, 15, 0).getTime();
			assert.strictEqual(shortTime(new Date(2026, 10, 2, 9, 5).getTime(), now), '09:05');
			assert.strictEqual(shortTime(new Date(2026, 9, 30, 9, 5).getTime(), now), 'Oct 30 09:05');
			assert.match(isoLocal(new Date(2026, 10, 2, 9, 5, 7).getTime()), /^2026-11-02T09:05:07[+-]\d\d:\d\d$/);
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
	});
});
