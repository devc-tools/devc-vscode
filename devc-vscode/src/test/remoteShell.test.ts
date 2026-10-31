import * as cp from 'child_process';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  closeHerdrPane,
  focusHerdrAgent,
  startShellAgent,
  watchHerdr,
} from '../herdr';
import { DockerShell, containerTerminalCommand } from '../remoteShell';
import { classifyScreen, probeContainer } from '../terminalAgents';

/**
 * The docker argv each call built before the runner seam, copied from the
 * previous source. The Docker path must not change.
 */
const OLD_WATCH_SCRIPT = `
PATH="$HOME/.local/bin:$PATH"
command -v herdr >/dev/null 2>&1 || exit 127
(
  prev=
  while :; do
    cur=$(herdr --session=devc api snapshot 2>&1 | tr -d '\\n')
    if [ "$cur" != "$prev" ]; then
      printf '%s\\n' "$cur"
      prev=$cur
    fi
    sleep 1
  done
) &
loop=$!
cat >/dev/null
kill $loop
`;

suite('DockerShell keeps the docker argv', () => {
  let dir: string;
  let docker: string;
  let log: string;

  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-fake-docker-'));
    log = path.join(dir, 'argv');
    docker = path.join(dir, 'docker');
    // Records its argv, NUL-separated, drains stdin briefly (so input is
    // never written to a closed pipe), and exits.
    fs.writeFileSync(
      docker,
      `#!/bin/sh\n: > '${log}'\nfor a; do printf '%s\\0' "$a" >> '${log}'; done\ntimeout 0.3 cat > /dev/null 2>&1\nexit 0\n`,
      { mode: 0o755 }
    );
  });

  suiteTeardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function argv(): string[] {
    return fs.readFileSync(log, 'utf8').split('\0').slice(0, -1);
  }

  const shell = () => new DockerShell('c1', 'vscode', docker);

  test('file system commands', async () => {
    await new DockerShell('c1', undefined, docker).run(['cat', '--', '/x'], {
      interactive: true,
    });
    assert.deepStrictEqual(argv(), ['exec', '-i', 'c1', 'cat', '--', '/x']);
    await new DockerShell('c1', undefined, docker).run(
      ['sh', '-c', 'cat > "$1"', 'sh', '/x'],
      { input: Buffer.from('hi'), interactive: true }
    );
    assert.deepStrictEqual(argv(), [
      'exec',
      '-i',
      'c1',
      'sh',
      '-c',
      'cat > "$1"',
      'sh',
      '/x',
    ]);
  });

  test('herdr watcher', async () => {
    await new Promise<void>(resolve => {
      watchHerdr(shell(), 'devc', () => {}, resolve);
    });
    assert.deepStrictEqual(argv(), [
      'exec',
      '-i',
      '-u',
      'vscode',
      'c1',
      'sh',
      '-c',
      OLD_WATCH_SCRIPT,
    ]);
  });

  test('focus, close and start', async () => {
    await focusHerdrAgent(shell(), 'devc', { paneId: 'w1:p1', tabId: 'w1:t1' });
    assert.deepStrictEqual(argv(), [
      'exec',
      '-u',
      'vscode',
      'c1',
      'sh',
      '-c',
      `PATH="$HOME/.local/bin:$PATH"
      if [ -n "$2" ]; then herdr --session=devc tab focus "$2" >/dev/null || exit; fi
      exec herdr --session=devc agent focus "$1"`,
      'sh',
      'w1:p1',
      'w1:t1',
    ]);
    await closeHerdrPane(shell(), 'devc', 'w1:p1');
    assert.deepStrictEqual(argv(), [
      'exec',
      '-u',
      'vscode',
      'c1',
      'sh',
      '-c',
      'PATH="$HOME/.local/bin:$PATH" exec herdr --session=devc pane close "$1"',
      'sh',
      'w1:p1',
    ]);
    // The fake prints no pane, so starting stops after `tab create`.
    await startShellAgent(shell(), 'devc', '/w', 'claude');
    assert.deepStrictEqual(argv(), [
      'exec',
      '-u',
      'vscode',
      'c1',
      'sh',
      '-c',
      'PATH="$HOME/.local/bin:$PATH" exec herdr --session=devc "$@"',
      'sh',
      'tab',
      'create',
      '--cwd',
      '/w',
      '--focus',
    ]);
  });

  test('probe and classify', async () => {
    await probeContainer(shell());
    const probe = argv();
    assert.deepStrictEqual(probe.slice(0, 6), [
      'exec',
      '-u',
      'vscode',
      'c1',
      'sh',
      '-c',
    ]);
    assert.ok(probe[6].includes('ps -eo pid=,tty=,pgid=,tpgid=,etimes=,args='));
    assert.strictEqual(probe.length, 7);

    await classifyScreen(shell(), 'claude', 'screen');
    const classify = argv();
    assert.deepStrictEqual(classify.slice(0, 7), [
      'exec',
      '-i',
      '-u',
      'vscode',
      'c1',
      'sh',
      '-c',
    ]);
    assert.ok(classify[7].includes('herdr agent explain --file "$f"'));
    assert.deepStrictEqual(classify.slice(8), ['sh', 'claude']);
  });
});

suite('containerTerminalCommand', () => {
  const SCRIPT =
    'PATH="$HOME/.local/bin:$PATH"; if command -v herdr >/dev/null 2>&1; then exec herdr --session=devc; else s=$(getent passwd "$(id -u)" | cut -d: -f7); exec "${s:-sh}" -l; fi';
  const quoted = `'${SCRIPT.replace(/'/g, `'\\''`)}'`;

  test('builds the exact command', () => {
    assert.strictEqual(
      containerTerminalCommand('docker', 'abc123', 'vscode', '/workspaces/app', 'devc'),
      `docker exec -it -u vscode -w /workspaces/app abc123 sh -c ${quoted}`
    );
  });

  test('omits the user and workdir when unknown, and quotes the docker path', () => {
    assert.strictEqual(
      containerTerminalCommand('/opt/my docker', 'abc123', undefined, undefined, 'devc'),
      `'/opt/my docker' exec -it abc123 sh -c ${quoted}`
    );
  });

  test('the host shell hands sh the script intact', () => {
    const out = cp.execFileSync('sh', [
      '-c',
      containerTerminalCommand('printf', 'x', undefined, undefined, 'devc').replace(
        /^printf exec -it x sh -c /,
        "printf '%s' "
      ),
    ]);
    assert.strictEqual(out.toString('utf8'), SCRIPT);
  });
});
