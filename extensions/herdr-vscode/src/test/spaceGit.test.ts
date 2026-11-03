import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseStatus } from '../git';
import { LocalShell, RemoteShell } from '../remoteShell';
import { Snapshot } from '../sessions';
import { gitDescription, readSpaceGit, SpaceGit, spaceDirectory } from '../spaceGit';
import { snapshot } from './fixtures';

const info = (...records: string[]) => {
	const status = parseStatus(records.join('\0') + '\0');
	return { ...status, head: status.branch ?? '1a2b3c4' };
};

function git(cwd: string, ...args: string[]): void {
	cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

suite('space git', () => {
	test('description from parseStatus results', () => {
		assert.strictEqual(
			gitDescription(info('## v3_auth...origin/v3_auth [ahead 1]', ' M a', '?? c', 'R  d', 'e', 'A  f')),
			'⎇ v3_auth ● 4 ↑1',
		);
		assert.strictEqual(gitDescription(info('## main...origin/main')), '⎇ main · clean');
		assert.strictEqual(gitDescription(info('## main...origin/main [behind 2]')), '⎇ main · clean ↓2');
		assert.strictEqual(gitDescription(info('## docs', '?? x')), '⎇ docs ● 1');
		assert.strictEqual(gitDescription(info('## HEAD (no branch)', ' M a', ' M b')), '⎇ 1a2b3c4 ● 2', 'detached: the short SHA');
	});

	test('directory: checkout_path, else the focused pane, else the first pane', () => {
		const s = snapshot();
		assert.strictEqual(spaceDirectory(s, 'w2'), '/src/api', 'checkout_path');
		const base: Snapshot = {
			...s,
			workspaces: s.workspaces.map((w) => ({ ...w, checkoutPath: undefined })),
		};
		const pane = (id: string, focused: boolean, cwd: string, fg?: string) =>
			({ pane_id: id, tab_id: 't', workspace_id: 'w9', focused, cwd, foreground_cwd: fg, agent_status: 'unknown', raw_status: 'unknown' }) as Snapshot['panes'][number];
		const w9 = (panes: Snapshot['panes']): Snapshot => ({ ...base, workspaces: [{ workspace_id: 'w9', label: 'x', number: 9, focused: false }], panes });
		assert.strictEqual(spaceDirectory(w9([pane('a', false, '/a'), pane('b', true, '/b', '/b/fg')]), 'w9'), '/b/fg', 'focused pane, foreground_cwd first');
		assert.strictEqual(spaceDirectory(w9([pane('a', false, '/a'), pane('b', false, '/b')]), 'w9'), '/a', 'first pane');
		assert.strictEqual(spaceDirectory(w9([]), 'w9'), undefined);
	});

	suite('real repositories through LocalShell', () => {
		let tmp: string;
		const shell = new LocalShell();

		suiteSetup(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-spacegit-'));
		});
		suiteTeardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

		test('changes, ahead of origin, not a repo', async () => {
			const repo = path.join(tmp, 'repo');
			fs.mkdirSync(repo);
			git(repo, 'init', '-q', '-b', 'main');
			fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
			git(repo, 'add', '.');
			git(repo, 'commit', '-q', '-m', 'a');
			fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
			assert.strictEqual(await readSpaceGit(shell, repo), '⎇ main ● 1');
			fs.mkdirSync(path.join(repo, 'sub'));
			assert.strictEqual(await readSpaceGit(shell, path.join(repo, 'sub')), '⎇ main ● 1', 'from a subdirectory');

			const origin = path.join(tmp, 'origin.git');
			git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
			git(repo, 'checkout', '-q', '--', 'a.txt');
			git(repo, 'push', '-q', origin, 'main');
			const clone = path.join(tmp, 'clone');
			git(tmp, 'clone', '-q', origin, clone);
			fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
			git(clone, 'add', '.');
			git(clone, 'commit', '-q', '-m', 'b');
			assert.strictEqual(await readSpaceGit(shell, clone), '⎇ main · clean ↑1');

			const plain = path.join(tmp, 'plain');
			fs.mkdirSync(plain);
			assert.strictEqual(await readSpaceGit(shell, plain), undefined);
			assert.strictEqual(await readSpaceGit(shell, path.join(tmp, 'missing')), undefined);
		});
	});

	suite('poller', () => {
		const shell = {} as RemoteShell;
		const timing = { passMs: 60000, debounceMs: 5 };
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		test('runs only while visible, per directory; drops a result taken elsewhere', async () => {
			const runs: string[] = [];
			const poller = new SpaceGit(() => shell, async (_s, dir) => {
				runs.push(dir);
				return `⎇ ${path.basename(dir)}`;
			}, timing);
			let fired = 0;
			poller.onDidChange(() => fired++);
			const s = snapshot();
			poller.update('host/s', s, false);
			await sleep(30);
			assert.deepStrictEqual(runs, [], 'hidden: nothing runs');
			assert.strictEqual(poller.polling, false);

			poller.update('host/s', s, true);
			assert.strictEqual(poller.polling, true);
			await sleep(30);
			assert.deepStrictEqual(runs.sort(), ['/src/api', '/src/web']);
			assert.strictEqual(fired, 1);
			assert.strictEqual(poller.description('host/s', 'w2', '/src/api'), '⎇ api');

			poller.update('host/s', s, true);
			await sleep(30);
			assert.strictEqual(runs.length, 2, 'nothing changed: no extra pass');

			assert.strictEqual(poller.description('host/s', 'w2', '/elsewhere'), undefined);
			assert.strictEqual(poller.description('host/s', 'w2', '/src/api'), undefined, 'dropped');

			poller.update('host/s', s, false);
			assert.strictEqual(poller.polling, false);
			poller.dispose();
		});

		test('at most 4 at a time; a space still running is skipped', async () => {
			let active = 0;
			let peak = 0;
			const release: (() => void)[] = [];
			const poller = new SpaceGit(() => shell, async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise<void>((r) => release.push(r));
				active--;
				return undefined;
			}, { passMs: 60000, debounceMs: 60000 });
			const s = snapshot();
			const many: Snapshot = {
				...s,
				workspaces: Array.from({ length: 6 }, (_, i) => ({ workspace_id: `w${i}`, label: `s${i}`, number: i, focused: false, checkoutPath: `/r/${i}` })),
			};
			poller.update('host/s', many, true);
			const first = poller.pass();
			await sleep(5);
			assert.strictEqual(active, 4);
			const second = poller.pass();
			await sleep(5);
			assert.strictEqual(active, 6, 'the second pass takes only the two not running');
			while (release.length) {
				release.shift()!();
				await sleep(1);
			}
			await Promise.all([first, second]);
			assert.strictEqual(peak, 6, 'no space ran twice at once');
			poller.dispose();
		});
	});
});
