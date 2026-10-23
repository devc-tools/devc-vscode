import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  expandTitle,
  featureAt,
  featureLabel,
  listFeatures,
  mountedFeatureRoots,
  planFolders,
  projectOf,
  removalRuns,
} from '../features';
import { makeGit } from '../workspaceSync';

// No vscode import: this suite also runs under plain mocha
// (`npx mocha --ui tdd out/test/features.test.js`).

suite('planFolders', () => {
  const catalog = ['/c/a', '/c/a.worktrees/x', '/c/b', '/c/b.worktrees/y'];

  test('adds picked features and removes unpicked ones', () => {
    assert.deepStrictEqual(
      planFolders(['/c/root', '/c/a', '/c/b'], catalog, ['/c/b', '/c/a.worktrees/x']),
      { added: ['/c/a.worktrees/x'], removed: [{ index: 1, path: '/c/a' }] }
    );
  });

  test('never removes the first folder, even an unpicked feature', () => {
    assert.deepStrictEqual(planFolders(['/c/a', '/c/b'], catalog, []), {
      added: [],
      removed: [{ index: 1, path: '/c/b' }],
    });
  });

  test('does not add the first folder again', () => {
    assert.deepStrictEqual(planFolders(['/c/a'], catalog, ['/c/a']), {
      added: [],
      removed: [],
    });
  });

  test('leaves folders that are not features alone', () => {
    assert.deepStrictEqual(
      planFolders(['/c/root', '/home/me/.config/x', '/c/b'], catalog, []),
      { added: [], removed: [{ index: 2, path: '/c/b' }] }
    );
  });

  test('ignores picks that are not in the catalog', () => {
    assert.deepStrictEqual(planFolders(['/c/root'], catalog, ['/elsewhere']), {
      added: [],
      removed: [],
    });
  });
});

suite('mountedFeatureRoots', () => {
  const id = (p: string) => p;
  const mount = (
    containerId: string,
    localFolder: string,
    source: string,
    destination: string
  ) => ({ containerId, localFolder, source, destination });
  const dev = [
    mount('c1', '/h/dev', '/h/dev', '/workspaces/dev'),
    mount('c1', '/h/dev', '/h/dev/.git', '/workspaces/dev/.git'),
    mount('c1', '/h/dev', '/h/tools/a', '/workspaces/tools/a'),
    mount('c1', '/h/dev', '/h/tools/a.wt', '/workspaces/tools/a.wt'),
    mount('c1', '/h/dev', '/h/skills/x', '/home/vscode/.claude/skills/x'),
  ];
  const all = ['/h/dev', '/h/tools/a', '/h/tools/a.wt'];

  test('offers every /workspaces mount of the container whose project is open', () => {
    assert.deepStrictEqual(mountedFeatureRoots(['/h/dev'], dev, id), all);
  });

  test('a mounted folder alone finds its container', () => {
    assert.deepStrictEqual(mountedFeatureRoots(['/h/tools/a'], dev, id), all);
  });

  test('a folder inside the project finds its container', () => {
    assert.deepStrictEqual(mountedFeatureRoots(['/h/dev/sub'], dev, id), all);
  });

  test('compares realpaths', () => {
    const real = (p: string) => p.replace(/^\/link/, '/h');
    const linked = dev.map(m => ({ ...m, localFolder: '/link/dev' }));
    assert.deepStrictEqual(mountedFeatureRoots(['/h/other'], linked, real), []);
    assert.deepStrictEqual(mountedFeatureRoots(['/h/dev'], linked, real), all);
  });

  test('ignores containers that do not serve the workspace', () => {
    const other = [mount('c2', '/h/else', '/h/else', '/workspaces/else')];
    const mounts = [...dev, ...other];
    assert.deepStrictEqual(mountedFeatureRoots(['/h/dev'], mounts, id), all);
  });
});

suite('expandTitle', () => {
  const feature = { path: '/c/a.worktrees/x', main: '/c/a', branch: 'feature-x' };

  test('fills in the feature and leaves other variables to VS Code', () => {
    assert.strictEqual(
      expandTitle('${project} / ${branch} [${space}] ${rootName}', feature, 'one'),
      'a / feature-x [one] ${rootName}'
    );
    assert.strictEqual(expandTitle('${folder}', feature, undefined), 'x');
  });

  test("fills in the focused pane's title, with any $ made harmless", () => {
    assert.strictEqual(
      expandTitle('${branch}${separator}${title}', feature, undefined, 'Fixing $PATH'),
      'feature-x${separator}Fixing ＄PATH'
    );
    assert.strictEqual(expandTitle('${branch} ${title}', feature, undefined), 'feature-x ');
  });

  test('a detached HEAD is named by its folder', () => {
    assert.strictEqual(
      expandTitle('${project} / ${branch}', { path: '/c/a.worktrees/x', main: '/c/a' }, undefined),
      'a / x'
    );
  });
});

suite('removalRuns', () => {
  test('groups neighbours, highest run first', () => {
    assert.deepStrictEqual(removalRuns([2, 6, 1, 5, 3, 9]), [
      { start: 9, count: 1 },
      { start: 5, count: 2 },
      { start: 1, count: 3 },
    ]);
  });

  test('nothing to remove', () => {
    assert.deepStrictEqual(removalRuns([]), []);
  });
});

suite('listFeatures', function () {
  this.timeout(30000);
  let tmp: string;
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
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devc-features-')));
    for (const name of ['beta', 'alpha']) {
      const repo = path.join(tmp, name);
      fs.mkdirSync(repo);
      await run(repo, 'init', '-q', '-b', 'main');
      await run(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    const alpha = path.join(tmp, 'alpha');
    await run(alpha, 'worktree', 'add', '-q', '-b', 'feature-a', '../alpha.worktrees/feature-a');
    await run(alpha, 'worktree', 'add', '-q', '--detach', '../alpha.worktrees/loose');
    fs.mkdirSync(path.join(tmp, 'plain'));
  });

  teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('lists each repo and its worktrees, main worktree first', async () => {
    const features = await listFeatures(
      [path.join(tmp, 'beta'), path.join(tmp, 'alpha.worktrees'), path.join(tmp, 'plain')],
      git
    );
    assert.deepStrictEqual(
      features.map(f => `${projectOf(f)} / ${featureLabel(f)}`),
      ['alpha / main', 'alpha / feature-a', 'alpha / loose (detached)', 'beta / main']
    );
    assert.deepStrictEqual(
      features.map(f => path.relative(tmp, f.path)),
      ['alpha', 'alpha.worktrees/feature-a', 'alpha.worktrees/loose', 'beta']
    );
    assert.ok(features.slice(0, 3).every(f => f.main === path.join(tmp, 'alpha')));
  });

  test('featureAt finds the worktree a folder is in', async () => {
    const worktree = path.join(tmp, 'alpha.worktrees', 'feature-a');
    fs.mkdirSync(path.join(worktree, 'src'));
    assert.deepStrictEqual(await featureAt(path.join(worktree, 'src'), git), {
      path: worktree,
      main: path.join(tmp, 'alpha'),
      branch: 'feature-a',
    });
    assert.deepStrictEqual(await featureAt(path.join(tmp, 'beta'), git), {
      path: path.join(tmp, 'beta'),
      main: path.join(tmp, 'beta'),
      branch: 'main',
    });
    assert.strictEqual(
      (await featureAt(path.join(tmp, 'alpha.worktrees', 'loose'), git))?.branch,
      undefined
    );
    assert.strictEqual(await featureAt(path.join(tmp, 'plain'), git), undefined);
  });

  test('a parent folder finds the repos directly in it', async () => {
    const features = await listFeatures([tmp], git);
    assert.deepStrictEqual(
      [...new Set(features.map(projectOf))],
      ['alpha', 'beta']
    );
  });
  test('a folder that is not a repo finds nothing above it', async () => {
    // Stands for a home directory kept in Git, above `code/x.worktrees`.
    await run(tmp, 'init', '-q', '-b', 'main');
    const features = await listFeatures(
      [path.join(tmp, 'alpha.worktrees'), path.join(tmp, 'plain')],
      git
    );
    assert.deepStrictEqual(
      features.map(f => path.relative(tmp, f.path)),
      ['alpha', 'alpha.worktrees/feature-a', 'alpha.worktrees/loose']
    );
  });
});
