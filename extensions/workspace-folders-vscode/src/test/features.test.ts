// Copied from devc-vscode/src/test/features.test.ts at 9031682 (the helpers copied into ../features).
import * as assert from 'assert';
import { planFolders, removalRuns, worktreeFolderName } from '../features';

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

suite('worktreeFolderName', () => {
  test('names a linked worktree project/folder', () => {
    assert.strictEqual(
      worktreeFolderName({
        path: '/w/alpha.worktrees/feature-a',
        main: '/w/alpha',
        branch: 'feat/a',
      }),
      'alpha/feature-a'
    );
  });

  test('leaves a main worktree unnamed', () => {
    assert.strictEqual(
      worktreeFolderName({ path: '/w/alpha', main: '/w/alpha', branch: 'main' }),
      undefined
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

