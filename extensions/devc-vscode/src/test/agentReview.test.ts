import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  AgentCommentingRanges,
  PromptInput,
  ReplyTracker,
  buildPrompt,
  failureMessage,
  padReply,
  selectedLines,
  sideLabel,
  threadLabel,
} from '../agentReview';
import { ContainerBindMount } from '../containerTree';

const INPUT: PromptInput = {
  threadId: '1a2b3c4d',
  seq: 1,
  containerPath: '/workspaces/app/src/a.ts',
  startLine: 3,
  endLine: 4,
  side: 'working tree',
  languageId: 'typescript',
  lines: ['const a = 1;', 'const b = a + 1;'],
  comment: 'what does this do?',
};

const MOUNTS: ContainerBindMount[] = [
  {
    containerId: 'c1',
    containerName: 'app-1',
    localFolder: '/Users/me/code/app',
    source: '/Users/me/code/app',
    destination: '/workspaces/app',
  },
];

function fakeDocument(uri: vscode.Uri, lineCount: number): vscode.TextDocument {
  return { uri, lineCount } as vscode.TextDocument;
}

suite('Agent review comments', () => {
  test('first prompt in a thread quotes the lines', () => {
    assert.strictEqual(
      buildPrompt(INPUT),
      [
        '[devc review 1a2b3c4d#1] Question from a code review in VS Code.',
        'Location: /workspaces/app/src/a.ts:3-4 (working tree)',
        '```typescript',
        'const a = 1;',
        'const b = a + 1;',
        '```',
        'what does this do?',
        '',
        "Answer the question. Also write your answer as Markdown to /tmp/devc-vscode/review/1a2b3c4d/1.md (the reviewer reads it in their editor). Don't change code unless the question asks you to. Don't post to GitHub or the PR; reply only in the file.",
      ].join('\n')
    );
  });

  test('a one-line range prints N-N', () => {
    const prompt = buildPrompt({
      ...INPUT,
      startLine: 7,
      endLine: 7,
      lines: ['x'],
    });
    assert.ok(
      prompt.includes('a.ts:7-7 (working tree)\n```typescript\nx\n```')
    );
  });

  test('more than 200 lines points at the file instead of quoting', () => {
    const lines = Array.from({ length: 201 }, (_, i) => `line ${i}`);
    const prompt = buildPrompt({ ...INPUT, startLine: 1, endLine: 201, lines });
    assert.strictEqual(
      prompt.split('\n').slice(1, 4).join('\n'),
      [
        'Location: /workspaces/app/src/a.ts:1-201 (working tree)',
        '(201 lines selected; read them from the file)',
        'what does this do?',
      ].join('\n')
    );
    assert.ok(!prompt.includes('```'));

    const exactly200 = buildPrompt({
      ...INPUT,
      startLine: 1,
      endLine: 200,
      lines: lines.slice(0, 200),
    });
    assert.ok(exactly200.includes('```typescript\nline 0\n'));
  });

  test('follow-up prompt', () => {
    assert.strictEqual(
      buildPrompt({ ...INPUT, seq: 2, comment: 'and why?' }),
      [
        '[devc review 1a2b3c4d#2] Follow-up on /workspaces/app/src/a.ts:3-4.',
        'and why?',
        '',
        "Write your answer as Markdown to /tmp/devc-vscode/review/1a2b3c4d/2.md. Don't post to GitHub or the PR; reply only in the file.",
      ].join('\n')
    );
  });

  test('side label per scheme', () => {
    const uri = (scheme: string, query: unknown) => ({
      scheme,
      query: typeof query === 'string' ? query : JSON.stringify(query),
    });
    assert.strictEqual(sideLabel(uri('file', '')), 'working tree');
    const git = (ref: string) =>
      sideLabel(uri('git', { path: '/Users/me/code/app/a.ts', ref }));
    assert.strictEqual(git('HEAD'), 'git diff, HEAD');
    assert.strictEqual(git('~'), 'git diff, index');
    assert.strictEqual(git(''), 'git diff, index');
    assert.strictEqual(git('abc1234'), 'git diff, commit abc1234');
    assert.strictEqual(git('origin/main'), 'git diff, origin/main');
    assert.strictEqual(
      sideLabel(uri('review', { base: true, commit: 'abc123', path: '/x' })),
      'PR diff, base side, commit abc123'
    );
    assert.strictEqual(
      sideLabel(uri('review', { base: false, commit: 'def456' })),
      'PR diff, changed side, commit def456'
    );
    const pr = {
      prNumber: 42,
      baseCommit: 'b1',
      headCommit: 'h2',
      fileName: 'a.ts',
    };
    assert.strictEqual(
      sideLabel(uri('pr', { ...pr, isBase: true })),
      'PR #42 diff, base side, commit b1'
    );
    assert.strictEqual(
      sideLabel(uri('pr', { ...pr, isBase: false })),
      'PR #42 diff, head side, commit h2'
    );
  });

  test('side label falls back to "diff view"', () => {
    for (const [scheme, query] of [
      ['review', ''],
      ['review', '{not json'],
      ['review', '{"commit":"abc"}'],
      ['review', '{"base":true}'],
      ['review', 'null'],
      ['pr', '{"isBase":true,"headCommit":"h"}'],
      ['pr', '{"baseCommit":"b","headCommit":"h","prNumber":1}'],
      ['pr', '[]'],
      ['git', '{}'],
      ['git', 'not json'],
      ['vscode-userdata', '{}'],
    ]) {
      assert.strictEqual(
        sideLabel({ scheme, query }),
        'diff view',
        `${scheme} ${query}`
      );
    }
  });

  test('reply listing: changed entries trigger a read, unchanged and unknown do not', () => {
    const tracker = new ReplyTracker();
    const known = (id: string) => id === 'aaaa1111' || id === 'bbbb2222';
    const entry = (crc: number, size: number, thread: string, seq: number) =>
      `${crc} ${size} /tmp/devc-vscode/review/${thread}/${seq}.md`;

    assert.deepStrictEqual(tracker.changed('', known), []);
    assert.deepStrictEqual(
      tracker.changed(
        [
          entry(1, 10, 'aaaa1111', 1),
          entry(2, 20, 'cccc3333', 1),
          entry(3, 30, 'bbbb2222', 2),
          '',
        ].join(';'),
        known
      ),
      [
        { threadId: 'aaaa1111', seq: 1 },
        { threadId: 'bbbb2222', seq: 2 },
      ]
    );
    // Same listing again: nothing new.
    assert.deepStrictEqual(
      tracker.changed(
        [entry(1, 10, 'aaaa1111', 1), entry(3, 30, 'bbbb2222', 2), ''].join(
          ';'
        ),
        known
      ),
      []
    );
    // A new crc, a new size, and a new file.
    assert.deepStrictEqual(
      tracker.changed(
        [
          entry(9, 10, 'aaaa1111', 1),
          entry(3, 31, 'bbbb2222', 2),
          entry(4, 40, 'aaaa1111', 2),
          '',
        ].join(';'),
        known
      ),
      [
        { threadId: 'aaaa1111', seq: 1 },
        { threadId: 'bbbb2222', seq: 2 },
        { threadId: 'aaaa1111', seq: 2 },
      ]
    );
    assert.deepStrictEqual(tracker.changed('garbage;', known), []);
  });

  test('thread label names the side, short commit, then the agent', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    assert.strictEqual(threadLabel('working tree'), 'Working tree');
    assert.strictEqual(
      threadLabel(`PR #42 diff, head side, commit ${sha}`, 'claude'),
      'claude · PR #42 diff, head side, commit 0123456'
    );
    assert.strictEqual(
      threadLabel('PR diff, base side, commit abc123'),
      'PR diff, base side, commit abc123'
    );
  });

  test('replies end with a spacer paragraph', () => {
    assert.strictEqual(padReply('# Hi\n\ntext\n\n'), '# Hi\n\ntext\n\n&nbsp;');
  });

  test('failure messages', () => {
    assert.strictEqual(
      failureMessage({ code: 'agent_blocked', message: 'blocked' }, 'claude'),
      'claude is waiting on a prompt in its pane. Answer it, then Resend.'
    );
    assert.strictEqual(
      failureMessage({ code: 'agent_not_found', message: 'gone' }, 'claude'),
      'That agent is gone. Resend to pick another.'
    );
    assert.strictEqual(
      failureMessage(
        { code: 'server_not_running', message: 'no herdr server' },
        'claude'
      ),
      'no herdr server'
    );
    assert.strictEqual(
      failureMessage({ message: 'herdr exited with 2' }, 'claude'),
      'herdr exited with 2'
    );
  });

  test('commenting ranges cover mapped documents only', async () => {
    const ranges = new AgentCommentingRanges(async () => MOUNTS);
    const mapped = '/Users/me/code/app/src/a.ts';
    for (const uri of [
      vscode.Uri.file(mapped),
      vscode.Uri.from({
        scheme: 'review',
        path: mapped,
        query: '{"base":false,"commit":"abc"}',
      }),
      vscode.Uri.from({ scheme: 'pr', path: mapped, query: '{}' }),
      vscode.Uri.from({
        scheme: 'git',
        path: mapped,
        query: JSON.stringify({ path: mapped, ref: 'HEAD' }),
      }),
    ]) {
      const result = await ranges.provideCommentingRanges(
        fakeDocument(uri, 12)
      );
      assert.strictEqual(result.length, 1, uri.toString());
      assert.ok(result[0].isEqual(new vscode.Range(0, 0, 11, 0)));
    }
    assert.deepStrictEqual(
      await ranges.provideCommentingRanges(
        fakeDocument(vscode.Uri.file('/Users/me/code/other/a.ts'), 12)
      ),
      []
    );
    assert.deepStrictEqual(
      await ranges.provideCommentingRanges(
        fakeDocument(
          vscode.Uri.from({ scheme: 'gitlens', path: mapped, query: '{}' }),
          12
        )
      ),
      []
    );
    assert.deepStrictEqual(
      await ranges.provideCommentingRanges(
        fakeDocument(vscode.Uri.from({ scheme: 'untitled', path: mapped }), 12)
      ),
      []
    );
  });

  test('a selection ending at column 0 stops a line short', () => {
    const lines = (a: number, b: number, c: number, d: number) => {
      const r = selectedLines(new vscode.Selection(a, b, c, d));
      return [r.start.line, r.end.line];
    };
    assert.deepStrictEqual(lines(2, 4, 5, 0), [2, 4]);
    assert.deepStrictEqual(lines(2, 4, 5, 1), [2, 5]);
    assert.deepStrictEqual(lines(3, 0, 3, 0), [3, 3]);
    assert.deepStrictEqual(lines(3, 2, 3, 6), [3, 3]);
  });
});
