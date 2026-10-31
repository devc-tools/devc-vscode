import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitHeadContentProvider, gitHeadUri, parseGitHeadUri, parseStatus, readStatus, readToplevel } from '../git';
import { LocalShell } from '../remoteShell';

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
});
