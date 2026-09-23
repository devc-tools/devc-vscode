import * as assert from 'assert';
import { adoptTty, parseExplain, parseProbe } from '../terminalAgents';
import { TerminalScreen } from '../terminalScreen';

// Shaped like devc-dev: a stale claude on pts/3, the herdr client on pts/9
// with its agent on its own pane pty, and a fresh claude on pts/13 whose
// foreground job is a tool it launched.
const PROBE = [
  'claude',
  'codex',
  '---',
  // pid tty pgid tpgid etimes args
  ' 7504 pts/3   7504  7746 90000 bash',
  ' 7746 pts/3   7746  7746 89990 claude',
  '  140 pts/9    140   140  4000 herdr',
  '26722 pts/10 26722 26722  3900 claude',
  '33000 pts/13 33000 33100    40 bash',
  '33050 pts/13 33050 33100    35 claude',
  '33100 pts/13 33100 33100     2 npm test',
  '  177 ?        177    -1  4000 /home/vscode/.local/bin/herdr server',
  '---',
  'pts/3 25 114',
  'pts/9 30 120',
  'pts/10 28 98',
  'pts/13 31 110',
].join('\n');

suite('parseProbe', () => {
  test('maps each pty to its age, size and agent', () => {
    const { ttys } = parseProbe(PROBE);
    assert.deepStrictEqual(ttys.get('pts/13'), {
      ageSeconds: 40,
      size: { rows: 31, cols: 110 },
      agent: { agent: 'claude', pid: 33050 },
    });
    assert.deepStrictEqual(ttys.get('pts/3')?.agent, {
      agent: 'claude',
      pid: 7746,
    });
    assert.strictEqual(ttys.get('pts/9')?.agent, undefined);
    assert.strictEqual(ttys.has('?'), false);
  });

  test('no manifests means no agents', () => {
    const { ttys } = parseProbe('---\n 1 pts/0 1 1 5 claude\n---\n');
    assert.strictEqual(ttys.get('pts/0')?.agent, undefined);
  });
});

suite('adoptTty', () => {
  test('takes the pty opened after the command started', () => {
    assert.strictEqual(adoptTty(parseProbe(PROBE), 45, new Set()), 'pts/13');
  });

  test('never takes a pty older than the command', () => {
    assert.strictEqual(adoptTty(parseProbe(PROBE), 20, new Set()), undefined);
  });

  test('skips ptys another terminal owns', () => {
    const probe = parseProbe(PROBE);
    assert.strictEqual(adoptTty(probe, 45, new Set(['pts/13'])), undefined);
    assert.strictEqual(
      adoptTty(probe, 5000, new Set(['pts/13', 'pts/9'])),
      'pts/10'
    );
  });
});

suite('parseExplain', () => {
  test('reads state and the matched rule', () => {
    const line = JSON.stringify({
      agent: 'claude',
      state: 'working',
      matched_rule: { id: 'live_turn_working' },
      skip_state_update: false,
    });
    assert.deepStrictEqual(parseExplain(line), {
      agent: 'claude',
      status: 'working',
      rule: 'live_turn_working',
      keepPrevious: false,
    });
  });

  test('a fallback has no rule', () => {
    const line = JSON.stringify({
      agent: 'claude',
      state: 'idle',
      matched_rule: null,
    });
    assert.strictEqual(parseExplain(line)?.rule, undefined);
  });
});

suite('TerminalScreen', () => {
  test('redraws in place leave only the latest frame', async () => {
    const screen = new TerminalScreen(40, 5);
    await screen.write('\x1b]0;⠋ busy\x07\x1b[?1049h\x1b[H\x1b[2Jworking…\r\n');
    await screen.write('\x1b[H\x1b[2J❯ \r\n  ? for shortcuts');
    assert.strictEqual(screen.text(), '❯ \n  ? for shortcuts\n');
    assert.strictEqual(screen.title, '⠋ busy');
    screen.dispose();
  });

  test('cursor-up rewrites replace earlier lines', async () => {
    const screen = new TerminalScreen(40, 5);
    await screen.write('line one\r\n* Thinking… (1s)\r\n');
    await screen.write('\x1b[1A\x1b[2K* Thinking… (2s)\r\n');
    assert.strictEqual(screen.text(), 'line one\n* Thinking… (2s)\n');
    screen.dispose();
  });
});
