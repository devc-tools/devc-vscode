import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
  SshShell,
  Spawn,
  controlDirUsable,
  ensureControlDir,
  MAX_CONTROL_DIR_LENGTH,
  remoteCommand,
  sshArgs,
  sshFailure,
  sshTerminalCommand,
} from '../remoteShell';
import { SshFileSystemProvider, parseSshHosts, sshUri } from '../sshFs';

/** A spawn that records its calls and never runs anything. */
function recordingSpawn(exitCode = 0, stderr = '') {
  const calls: { command: string; args: string[] }[] = [];
  const spawn: Spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter() as cp.ChildProcess;
    const stdout = new EventEmitter();
    const err = new EventEmitter();
    Object.assign(child, {
      stdout,
      stderr: err,
      stdin: { on() {}, write() {}, end() {} },
      kill() {},
    });
    setTimeout(() => {
      if (stderr) {
        err.emit('data', Buffer.from(stderr));
      }
      child.emit('close', exitCode);
    }, 0);
    return child;
  };
  return { spawn, calls };
}

function shell(host: string, spawn: Spawn, controlDir?: string) {
  return new SshShell(host, {
    sshPath: 'ssh',
    controlDir,
    allowed: h => h.toLowerCase() === 'agent-vm',
    spawn,
  });
}

async function fsErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof vscode.FileSystemError, `got ${err}`);
    return (err as vscode.FileSystemError).code;
  }
  assert.fail('expected a FileSystemError');
}

suite('SSH (no ssh required)', () => {
  test('quoting survives the remote shell', () => {
    const words = [
      'a b',
      "it's",
      '$(touch /tmp/x)',
      '`id`',
      'a\nb',
      'back\\slash',
      '-rf',
      '%f\\0%y\\0',
    ];
    for (const word of words) {
      // What the remote login shell does with the joined string.
      const out = cp.execFileSync(
        'sh',
        ['-c', remoteCommand(['printf', '%s', word])],
        { encoding: 'utf8' }
      );
      assert.strictEqual(out, word);
    }
  });

  test('builds the exact non-interactive argv', () => {
    const command = `'stat' '-L' '--' '/a b'`;
    assert.deepStrictEqual(
      sshArgs('agent-vm', ['stat', '-L', '--', '/a b'], '/tmp/dcs'),
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ForwardX11=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPath=/tmp/dcs/%C',
        '-o',
        'ControlPersist=60',
        '--',
        'agent-vm',
        command,
      ]
    );
    // No usable control directory: no multiplexing options.
    assert.deepStrictEqual(sshArgs('agent-vm', ['stat', '-L', '--', '/a b'], undefined), [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'PermitLocalCommand=no',
      '--',
      'agent-vm',
      command,
    ]);
  });

  test('the shell spawns ssh with that argv', async () => {
    const { spawn, calls } = recordingSpawn();
    await shell('agent-vm', spawn, '/tmp/dcs').run(['true']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, 'ssh');
    assert.deepStrictEqual(
      calls[0].args,
      sshArgs('agent-vm', ['true'], '/tmp/dcs')
    );
  });

  test('refuses unconfigured hosts without spawning', async () => {
    const { spawn, calls } = recordingSpawn();
    for (const host of ['other', '', '-oProxyCommand=x']) {
      await assert.rejects(shell(host, spawn).run(['true']));
      assert.throws(() => shell(host, spawn).spawn(['true']));
    }
    const provider = new SshFileSystemProvider(
      host => shell(host, spawn),
      host => host.toLowerCase() === 'agent-vm'
    );
    for (const host of ['other', '-oProxyCommand=x']) {
      assert.strictEqual(
        await fsErrorCode(provider.stat(sshUri(host, '/x'))),
        'NoPermissions'
      );
    }
    assert.strictEqual(
      await fsErrorCode(
        provider.stat(vscode.Uri.from({ scheme: 'devc-ssh', path: '/x' }))
      ),
      'NoPermissions'
    );
    assert.strictEqual(calls.length, 0);
  });

  test('allows a configured host case-insensitively', async () => {
    const { spawn, calls } = recordingSpawn();
    await shell('Agent-VM', spawn).run(['true']);
    assert.strictEqual(calls.length, 1);
  });

  test('maps ssh failures', async () => {
    assert.strictEqual(
      sshFailure('agent-vm', {
        exitCode: 255,
        stderr: Buffer.from('Host key verification failed.\r\n'),
      }),
      'agent-vm: unknown host key — run "ssh agent-vm" once in a terminal to accept it.'
    );
    assert.strictEqual(
      sshFailure('agent-vm', {
        exitCode: 255,
        stderr: Buffer.from('ssh: connect to host agent-vm port 22: Connection refused'),
      }),
      'ssh: connect to host agent-vm port 22: Connection refused'
    );
    assert.strictEqual(
      sshFailure('agent-vm', { exitCode: 1, stderr: Buffer.from('nope') }),
      undefined
    );
    const unreachable = recordingSpawn(255, 'Connection refused');
    const provider = new SshFileSystemProvider(
      host => shell(host, unreachable.spawn),
      () => true
    );
    assert.strictEqual(
      await fsErrorCode(provider.stat(sshUri('agent-vm', '/x'))),
      'Unavailable'
    );
    const missing = recordingSpawn(1, 'stat: cannot statx: No such file or directory');
    const provider2 = new SshFileSystemProvider(
      host => shell(host, missing.spawn),
      () => true
    );
    assert.strictEqual(
      await fsErrorCode(provider2.stat(sshUri('agent-vm', '/x'))),
      'FileNotFound'
    );
  });

  test('builds the exact terminal command', () => {
    assert.strictEqual(
      sshTerminalCommand(
        'ssh',
        'agent-vm',
        "/home/ubuntu/my work's",
        'code.app',
        '/tmp/dcs'
      ),
      `ssh -t -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ControlMaster=auto -o ControlPath=/tmp/dcs/%C -o ControlPersist=60 -- agent-vm 'cd '\\''/home/ubuntu/my work'\\''\\'\\'''\\''s'\\'' && PATH="$HOME/.local/bin:$PATH" && if command -v herdr >/dev/null 2>&1; then exec herdr --session '\\''code.app'\\''; else exec "\${SHELL:-sh}" -l; fi'`
    );
    // No root: starts in the remote home; no control directory: no sharing.
    assert.strictEqual(
      sshTerminalCommand('/opt/my ssh', 'agent-vm', undefined, 'devc', undefined),
      `'/opt/my ssh' -t -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no -- agent-vm 'PATH="$HOME/.local/bin:$PATH" && if command -v herdr >/dev/null 2>&1; then exec herdr --session '\\''devc'\\''; else exec "\${SHELL:-sh}" -l; fi'`
    );
  });

  test('the terminal command runs its remote part as written', () => {
    // Unwrap the remote part the way the host shell would, and check the
    // remote shell sees the root and session intact.
    const command = sshTerminalCommand(
      'ssh',
      'agent-vm',
      "/w/it's here",
      "odd name's",
      undefined
    );
    const remote = cp.execFileSync(
      'sh',
      ['-c', 'eval "set -- $1"; shift $(($# - 1)); printf %s "$1"', 'sh', command],
      { encoding: 'utf8' }
    );
    assert.ok(remote.startsWith(`cd '/w/it'\\''s here' && `));
    assert.ok(remote.includes(`exec herdr --session 'odd name'\\''s'`));
  });

  test('parses settings, dropping invalid and duplicate entries', () => {
    assert.deepStrictEqual(
      parseSshHosts([
        { host: 'agent-vm', root: '/home/ubuntu/work', label: 'Sandbox' },
        { host: 'plain' },
        { host: '-oProxyCommand=x' },
        { host: 'rel', root: 'work' },
        { host: 'AGENT-VM' },
        { root: '/x' },
        'agent-vm',
      ]),
      {
        hosts: [
          { host: 'agent-vm', label: 'Sandbox', root: '/home/ubuntu/work' },
          { host: 'plain', label: 'plain', root: undefined },
        ],
        invalid: [
          '-oProxyCommand=x',
          'rel',
          'AGENT-VM',
          '{"root":"/x"}',
          '"agent-vm"',
        ],
      }
    );
    assert.deepStrictEqual(parseSshHosts(undefined), { hosts: [], invalid: [] });
  });

  test('uses a control directory only when private to this user', () => {
    const stat = (dir: boolean, uid: number, mode: number) => ({
      isDirectory: () => dir,
      uid,
      mode,
    });
    assert.ok(controlDirUsable(stat(true, 1000, 0o40700), 1000));
    assert.ok(!controlDirUsable(stat(true, 1000, 0o40755), 1000));
    assert.ok(!controlDirUsable(stat(true, 0, 0o40700), 1000));
    assert.ok(!controlDirUsable(stat(false, 1000, 0o120700), 1000));
  });

  test('keeps the control directory short enough for socket paths', () => {
    const dir = ensureControlDir();
    assert.ok(dir, 'control directory should be usable');
    assert.ok(dir.length <= MAX_CONTROL_DIR_LENGTH, dir);
  });
});

const LIVE_HOST = process.env.DEVC_SSH_TEST_HOST;
const LIVE_ROOT = process.env.DEVC_SSH_TEST_ROOT;

(LIVE_HOST && LIVE_ROOT ? suite : suite.skip)(
  'SshFileSystemProvider (live host)',
  function () {
    this.timeout(60000);
    const host = LIVE_HOST!;
    const provider = new SshFileSystemProvider(
      h =>
        new SshShell(h, {
          sshPath: 'ssh',
          controlDir: undefined,
          allowed: x => x === host,
        }),
      h => h === host
    );
    const dir = `${LIVE_ROOT}/devc-ssh-test-${Math.random().toString(36).slice(2)}`;
    const uri = (p: string) => sshUri(host, `${dir}${p}`);

    suiteTeardown(async () => {
      try {
        await provider.delete(uri(''), { recursive: true });
      } catch {
        // Already gone.
      }
    });

    test('create, write, read, stat, list, rename, delete', async () => {
      await provider.createDirectory(uri(''));
      const name = "/a file's name.txt";
      await provider.writeFile(uri(name), Buffer.from('hello'), {
        create: true,
        overwrite: false,
      });
      assert.strictEqual(
        Buffer.from(await provider.readFile(uri(name))).toString('utf8'),
        'hello'
      );
      const stat = await provider.stat(uri(name));
      assert.strictEqual(stat.type, vscode.FileType.File);
      assert.strictEqual(stat.size, 5);
      assert.deepStrictEqual(await provider.readDirectory(uri('')), [
        ["a file's name.txt", vscode.FileType.File],
      ]);
      await provider.rename(uri(name), uri('/b c.txt'), { overwrite: false });
      assert.deepStrictEqual(await provider.readDirectory(uri('')), [
        ['b c.txt', vscode.FileType.File],
      ]);
      await provider.delete(uri('/b c.txt'), { recursive: false });
      assert.deepStrictEqual(await provider.readDirectory(uri('')), []);
      await provider.delete(uri(''), { recursive: true });
      assert.strictEqual(
        await fsErrorCode(provider.stat(uri(''))),
        'FileNotFound'
      );
    });
  }
);
