import * as assert from 'assert';
import {
  Classification,
  parseExplain,
  parseProbe,
  pickClassification,
} from '../terminalAgents';
import { TerminalScreen } from '../terminalScreen';

suite('parseProbe', () => {
  // Shaped like devc-dev: claude straight in exec'd shells, plus one in herdr.
  const PROBE = [
    'claude',
    'codex',
    '---',
    '  140     0 herdr',
    '  177   140 /home/vscode/.local/bin/herdr server',
    '  197   177 bash',
    '26722   197 claude',
    ' 7504     0 bash',
    ' 7746  7504 claude',
    ' 8000     0 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    ' 8100     0 /bin/sh /tmp/spikebin/claude',
    ' 9000     0 vim notes.md',
  ].join('\n');

  test('finds agents that have a manifest, once per agent', () => {
    assert.deepStrictEqual(parseProbe(PROBE), [
      { agent: 'claude', pid: 7746 },
      { agent: 'codex', pid: 8000 },
    ]);
  });

  test('leaves out agents herdr is running', () => {
    const onlyHerdr = PROBE.split('\n')
      .filter(l => !/ (7746|8000|8100) /.test(l))
      .join('\n');
    assert.deepStrictEqual(parseProbe(onlyHerdr), []);
  });

  test('no manifests means no agents', () => {
    assert.deepStrictEqual(parseProbe('---\n 1 0 claude'), []);
  });
});

suite('parseExplain / pickClassification', () => {
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

  test("herdr's idle fallback does not count as the agent's screen", () => {
    const results: Classification[] = [
      { agent: 'claude', status: 'idle', keepPrevious: false },
      { agent: 'codex', status: 'working', rule: 'r', keepPrevious: false },
    ];
    assert.strictEqual(pickClassification(results)?.agent, 'codex');
    assert.strictEqual(pickClassification(results.slice(0, 1)), undefined);
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
