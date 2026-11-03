// Ported from devc-vscode/src/test/sshFs.test.ts at 8f2844f; maintained separately.

import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import {
  MAX_CONTROL_DIR_LENGTH,
  SshShell,
  Spawn,
  controlDirUsable,
  ensureControlDir,
  remoteCommand,
  sshArgs,
  sshFailure,
} from '../remoteShell';

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

suite('remoteShell (no ssh required)', () => {
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
    const safety = [
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'PermitLocalCommand=no',
    ];
    assert.deepStrictEqual(
      sshArgs('agent-vm', ['stat', '-L', '--', '/a b'], '/tmp/rfs'),
      [
        '-T',
        '-o',
        'BatchMode=yes',
        ...safety,
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPath=/tmp/rfs/%C',
        '-o',
        'ControlPersist=60',
        '--',
        'agent-vm',
        command,
      ]
    );
    // No usable control directory: no multiplexing options.
    assert.deepStrictEqual(
      sshArgs('agent-vm', ['stat', '-L', '--', '/a b'], undefined),
      ['-T', '-o', 'BatchMode=yes', ...safety, '--', 'agent-vm', command]
    );
  });

  test('the shell spawns ssh with that argv', async () => {
    const { spawn, calls } = recordingSpawn();
    await shell('agent-vm', spawn, '/tmp/rfs').run(['true']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, 'ssh');
    assert.deepStrictEqual(
      calls[0].args,
      sshArgs('agent-vm', ['true'], '/tmp/rfs')
    );
  });

  test('refuses unconfigured hosts without spawning', async () => {
    const { spawn, calls } = recordingSpawn();
    for (const host of ['other', '', '-oProxyCommand=x']) {
      await assert.rejects(
        shell(host, spawn).run(['true']),
        /is not a configured SSH host \(remoteFiles\.sshHosts\)/
      );
      assert.throws(() => shell(host, spawn).spawn(['true']));
    }
    assert.strictEqual(calls.length, 0);
    await shell('Agent-VM', spawn).run(['true']);
    assert.strictEqual(calls.length, 1, 'a configured host, whatever the case');
  });

  test('maps ssh failures', () => {
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
        stderr: Buffer.from(
          'ssh: connect to host agent-vm port 22: Connection refused'
        ),
      }),
      'ssh: connect to host agent-vm port 22: Connection refused'
    );
    assert.strictEqual(
      sshFailure('agent-vm', { exitCode: 255, stderr: Buffer.alloc(0) }),
      'agent-vm: ssh failed'
    );
    assert.strictEqual(
      sshFailure('agent-vm', { exitCode: 1, stderr: Buffer.from('nope') }),
      undefined
    );
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

  test('the control directory is /tmp/rfs-<uid>, short enough for socket paths', () => {
    const dir = ensureControlDir();
    assert.strictEqual(dir, `/tmp/rfs-${process.getuid!()}`);
    assert.ok(dir.length <= MAX_CONTROL_DIR_LENGTH, dir);
  });
});
