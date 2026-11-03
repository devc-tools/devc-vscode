import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  desiredOpen,
  planMove,
  prunePending,
  readPinnedRepo,
  resolvePin,
  rootPin,
  sortPinned,
  togglePending,
  unpinnedFolders,
} from '../workspaceRepos';
import { makeGit } from '../git';

// No vscode import: this suite also runs under plain mocha
// (`npx mocha --ui tdd out/test/workspaceRepos.test.js`).

suite('workspace repos: git', function () {
  this.timeout(30000);
  let tmp: string;
  let alpha: string;
  const git = makeGit(
    {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
    () => undefined
  );
  const run = async (cwd: string, ...args: string[]) => {
    const res = await git(cwd, args);
    assert.strictEqual(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  };

  suiteSetup(function () {
    if (cp.spawnSync('git', ['--version']).status !== 0) {
      this.skip();
    }
  });

  setup(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-folders-')));
    alpha = path.join(tmp, 'alpha');
    fs.mkdirSync(path.join(alpha, 'sub'), { recursive: true });
    await run(alpha, 'init', '-q', '-b', 'main');
    await run(alpha, 'commit', '-q', '--allow-empty', '-m', 'init');
    await run(alpha, 'worktree', 'add', '-q', '-b', 'zeta', '../alpha.worktrees/zeta');
    await run(alpha, 'worktree', 'add', '-q', '--detach', '../alpha.worktrees/loose');
    await run(alpha, 'worktree', 'add', '-q', '-b', 'beta', '../alpha.worktrees/beta');
    fs.mkdirSync(path.join(tmp, 'plain'));
    fs.symlinkSync(alpha, path.join(tmp, 'link'));
  });

  teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('a main worktree pins itself', async () => {
    assert.deepStrictEqual(await resolvePin(alpha, git), { main: alpha });
  });

  test('a linked worktree pins its main repo', async () => {
    assert.deepStrictEqual(
      await resolvePin(path.join(tmp, 'alpha.worktrees', 'zeta'), git),
      { main: alpha }
    );
  });

  test('a symlink to a repo pins the real path', async () => {
    assert.deepStrictEqual(await resolvePin(path.join(tmp, 'link'), git), {
      main: alpha,
    });
  });

  test('a folder inside a repo pins itself', async () => {
    const dir = path.join(alpha, 'sub');
    assert.deepStrictEqual(await resolvePin(dir, git), { main: dir });
  });

  test('a folder outside any repo pins itself', async () => {
    const dir = path.join(tmp, 'plain');
    assert.deepStrictEqual(await resolvePin(dir, git), { main: dir });
  });

  test('a folder that does not exist is an error', async () => {
    const dir = path.join(tmp, 'gone');
    assert.deepStrictEqual(await resolvePin(dir, git), {
      error: `${dir} is not a folder.`,
    });
  });

  test('the first folder pins its repo, or itself', async () => {
    assert.strictEqual(await rootPin(path.join(tmp, 'alpha.worktrees', 'beta'), git), alpha);
    assert.strictEqual(await rootPin(path.join(tmp, 'plain'), git), path.join(tmp, 'plain'));
    assert.strictEqual(await rootPin(path.join(alpha, 'sub'), git), path.join(alpha, 'sub'));
  });

  test('reads a repo’s linked worktrees, named first and detached last', async () => {
    const repo = await readPinnedRepo(alpha, git);
    assert.strictEqual(repo.missing, false);
    assert.strictEqual(repo.git, true);
    assert.deepStrictEqual(
      repo.worktrees.map(w => [path.basename(w.path), w.branch, w.main]),
      [
        ['beta', 'beta', alpha],
        ['zeta', 'zeta', alpha],
        ['loose', undefined, alpha],
      ]
    );
  });

  test('a folder that is not the top of a repo has no worktrees', async () => {
    for (const dir of [path.join(tmp, 'plain'), path.join(alpha, 'sub')]) {
      assert.deepStrictEqual(await readPinnedRepo(dir, git), {
        main: dir,
        worktrees: [],
        git: false,
        missing: false,
      });
    }
  });

  test('a folder that is gone is missing', async () => {
    const dir = path.join(tmp, 'gone');
    assert.deepStrictEqual(await readPinnedRepo(dir, git), {
      main: dir,
      worktrees: [],
      git: false,
      missing: true,
    });
  });
});

suite('workspace repos: pending toggles', () => {
  test('sorts pinned repos by project name', () => {
    const repo = (main: string) => ({ main, worktrees: [], git: true, missing: false });
    assert.deepStrictEqual(
      sortPinned([repo('/b/zed'), repo('/a/web'), repo('/c/api')]).map(r => r.main),
      ['/c/api', '/a/web', '/b/zed']
    );
  });

  test('a toggle back to the current state is forgotten', () => {
    const pending = new Map<string, boolean>();
    togglePending(pending, '/a', true, false);
    assert.deepStrictEqual([...pending], [['/a', true]]);
    togglePending(pending, '/a', false, false);
    assert.deepStrictEqual([...pending], []);
  });

  test('prunes toggles the workspace matches or the view no longer lists', () => {
    const pending = new Map([
      ['/open-now', true],
      ['/still-wanted', true],
      ['/unlisted', true],
      ['/to-close', false],
    ]);
    prunePending(
      pending,
      new Set(['/open-now', '/to-close']),
      new Set(['/open-now', '/still-wanted', '/to-close'])
    );
    assert.deepStrictEqual(
      [...pending],
      [
        ['/still-wanted', true],
        ['/to-close', false],
      ]
    );
  });

  test('desired state is the toggle, else what is open', () => {
    assert.deepStrictEqual(
      desiredOpen(
        ['/a', '/b', '/c', '/d'],
        new Set(['/a', '/b']),
        new Map([
          ['/b', false],
          ['/c', true],
        ])
      ),
      ['/a', '/c']
    );
  });
});

suite('workspace repos: unpinned folders', () => {
  test('lists open folders no pin covers, never the first', () => {
    assert.deepStrictEqual(
      unpinnedFolders(
        ['/root', '/a', '/manual', '/a.worktrees/x', '/other'],
        new Set(['/a', '/a.worktrees/x'])
      ),
      ['/manual', '/other']
    );
  });
});

suite('workspace repos: moving folders', () => {
  test('moving down lands after the target', () => {
    assert.deepStrictEqual(planMove(5, [1], 3), { start: 1, order: [2, 3, 1, 4] });
  });

  test('moving up lands before the target', () => {
    assert.deepStrictEqual(planMove(5, [4], 2), { start: 2, order: [4, 2, 3] });
  });

  test('dropping on the first folder lands right after it', () => {
    assert.deepStrictEqual(planMove(4, [3], 0), { start: 1, order: [3, 1, 2] });
  });

  test('no target moves to the end', () => {
    assert.deepStrictEqual(planMove(4, [1], undefined), { start: 1, order: [2, 3, 1] });
  });

  test('several folders keep their order and move together', () => {
    assert.deepStrictEqual(planMove(6, [4, 1], 2), { start: 1, order: [2, 1, 4, 3, 5] });
  });

  test('the first folder never moves', () => {
    assert.strictEqual(planMove(3, [0], 2), undefined);
  });

  test('a drop onto a moved folder, or one that changes nothing, is nothing', () => {
    assert.strictEqual(planMove(4, [1, 2], 2), undefined);
    assert.strictEqual(planMove(4, [3], undefined), undefined);
    assert.strictEqual(planMove(2, [1], 0), undefined);
  });
});
