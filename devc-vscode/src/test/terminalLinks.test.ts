import * as assert from 'assert';
import {
  PathContext,
  findPathCandidates,
  resolveCandidatePath,
} from '../terminalLinks';

/** The matched text of every candidate in `line`. */
function matches(line: string): string[] {
  return findPathCandidates(line).map(c =>
    line.slice(c.startIndex, c.startIndex + c.length)
  );
}

/** The resolved absolute paths, with unresolvable candidates as undefined. */
function resolveAll(
  line: string,
  context: PathContext
): (string | undefined)[] {
  return findPathCandidates(line).map(c =>
    resolveCandidatePath(c.raw, context)
  );
}

const CONTEXT: PathContext = {
  cwd: '/workspaces/app',
  home: '/home/vscode',
};

suite('findPathCandidates', () => {
  test('absolute paths', () => {
    assert.deepStrictEqual(matches('/workspaces/app/src/main.ts'), [
      '/workspaces/app/src/main.ts',
    ]);
    assert.deepStrictEqual(matches('ERROR /tmp/x.log failed'), ['/tmp/x.log']);
  });

  test('relative paths need a slash, bare words are not links', () => {
    assert.deepStrictEqual(matches('src/main.ts'), ['src/main.ts']);
    assert.deepStrictEqual(matches('./src/main.ts'), ['./src/main.ts']);
    assert.deepStrictEqual(matches('../sibling/main.ts'), [
      '../sibling/main.ts',
    ]);
    assert.deepStrictEqual(matches('package.json'), []);
    assert.deepStrictEqual(matches('Makefile'), []);
  });

  test('tilde paths are matched whole, including the ~', () => {
    assert.deepStrictEqual(matches('~/projects/foo/bar.ts'), [
      '~/projects/foo/bar.ts',
    ]);
    assert.deepStrictEqual(matches('~/.bashrc'), ['~/.bashrc']);
  });

  test('line and column suffixes are captured on both path shapes', () => {
    assert.deepStrictEqual(findPathCandidates('/a/b.ts:42:7'), [
      { startIndex: 0, length: 12, raw: '/a/b.ts', line: 42, column: 7 },
    ]);
    assert.deepStrictEqual(findPathCandidates('src/b.ts:42'), [
      {
        startIndex: 0,
        length: 11,
        raw: 'src/b.ts',
        line: 42,
        column: undefined,
      },
    ]);
  });

  test('the link covers the suffix so clicking a line number works', () => {
    assert.deepStrictEqual(matches('at fn (/a/b.ts:42:7)'), ['/a/b.ts:42:7']);
  });

  test('trailing sentence punctuation is excluded', () => {
    assert.deepStrictEqual(matches('see /etc/hosts.'), ['/etc/hosts']);
  });

  test('fragments of larger tokens are skipped, not half-matched', () => {
    // ~user homes: expanding them needs a passwd lookup we do not do.
    assert.deepStrictEqual(matches('~vscode/notes.md'), []);
    // Unexpanded variables.
    assert.deepStrictEqual(matches('$HOME/foo.txt'), []);
    assert.deepStrictEqual(matches('${HOME}/foo.txt'), []);
    // URLs.
    assert.deepStrictEqual(matches('https://example.com/a/b.html'), []);
  });

  test('several paths on one line', () => {
    assert.deepStrictEqual(matches('cp /a/x.ts /b/y.ts'), [
      '/a/x.ts',
      '/b/y.ts',
    ]);
  });

  test('re-entrant calls do not share regex state', () => {
    const line = 'cp /a/x.ts /b/y.ts';
    const first = findPathCandidates(line);
    findPathCandidates(line);
    assert.deepStrictEqual(findPathCandidates(line), first);
  });
});

suite('resolveCandidatePath', () => {
  test('absolute paths pass through normalized', () => {
    assert.strictEqual(
      resolveCandidatePath('/workspaces/app/src/main.ts', CONTEXT),
      '/workspaces/app/src/main.ts'
    );
    assert.strictEqual(
      resolveCandidatePath('/a/./b/../c.ts', CONTEXT),
      '/a/c.ts'
    );
  });

  test('relative paths resolve against the mount destination', () => {
    assert.deepStrictEqual(resolveAll('src/main.ts', CONTEXT), [
      '/workspaces/app/src/main.ts',
    ]);
    assert.deepStrictEqual(resolveAll('./src/main.ts', CONTEXT), [
      '/workspaces/app/src/main.ts',
    ]);
    assert.deepStrictEqual(resolveAll('../other/main.ts', CONTEXT), [
      '/workspaces/other/main.ts',
    ]);
  });

  test('tilde resolves against the container home', () => {
    assert.deepStrictEqual(resolveAll('~/.bashrc', CONTEXT), [
      '/home/vscode/.bashrc',
    ]);
  });

  test('no home means tilde paths do not resolve', () => {
    assert.deepStrictEqual(
      resolveAll('~/.bashrc', { cwd: '/workspaces/app' }),
      [undefined]
    );
  });

  test('no base means relative paths do not resolve', () => {
    assert.deepStrictEqual(
      resolveAll('src/main.ts', { home: '/home/vscode' }),
      [undefined]
    );
  });

  test('the container root is not a usable base', () => {
    // Otherwise "usr/bin/env" in some tool's output becomes a confident link
    // to an unrelated file.
    assert.deepStrictEqual(resolveAll('usr/bin/env', { cwd: '/' }), [
      undefined,
    ]);
  });

  test('absolute paths still resolve without any context', () => {
    assert.deepStrictEqual(resolveAll('/etc/hosts', {}), ['/etc/hosts']);
  });
});
