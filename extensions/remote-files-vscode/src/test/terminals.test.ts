import * as assert from 'assert';
import * as cp from 'child_process';
import {
  CONTAINER_LOGIN_SHELL,
  containerTerminalArgs,
  sshTerminalArgs,
  terminalName,
} from '../terminals';

const SAFETY = [
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'PermitLocalCommand=no',
];

suite('Terminal Here commands', () => {
  test('a container shell runs as the remote user, in the folder', () => {
    assert.deepStrictEqual(
      containerTerminalArgs('abcdefabcdef', 'vscode', '/workspaces/app'),
      [
        'exec',
        '-it',
        '-u',
        'vscode',
        '-w',
        '/workspaces/app',
        'abcdefabcdef',
        'sh',
        '-c',
        CONTAINER_LOGIN_SHELL,
      ]
    );
  });

  test('without a remote user, Docker picks the user', () => {
    assert.deepStrictEqual(
      containerTerminalArgs('abcdefabcdef', undefined, "/w/it's here"),
      [
        'exec',
        '-it',
        '-w',
        "/w/it's here",
        'abcdefabcdef',
        'sh',
        '-c',
        CONTAINER_LOGIN_SHELL,
      ]
    );
  });

  test('an ssh shell has forwarding off and shares connections when it can', () => {
    assert.deepStrictEqual(sshTerminalArgs('agent-vm', '/home/u', '/tmp/rfs'), [
      '-t',
      ...SAFETY,
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPath=/tmp/rfs/%C',
      '-o',
      'ControlPersist=60',
      '--',
      'agent-vm',
      `cd '/home/u' && exec "\${SHELL:-sh}" -l`,
    ]);
    assert.deepStrictEqual(sshTerminalArgs('agent-vm', '/home/u', undefined), [
      '-t',
      ...SAFETY,
      '--',
      'agent-vm',
      `cd '/home/u' && exec "\${SHELL:-sh}" -l`,
    ]);
  });

  test('the remote shell sees the folder intact', () => {
    const dir = "/w/it's $(id) here";
    const remote = sshTerminalArgs('agent-vm', dir, undefined).at(-1)!;
    // Run the cd part the way the remote shell would, then print where it is.
    const out = cp.execFileSync(
      'sh',
      ['-c', `printf %s ${remote.slice(3, remote.indexOf(' && '))}`],
      { encoding: 'utf8' }
    );
    assert.strictEqual(out, dir);
  });

  test('terminal names', () => {
    assert.strictEqual(terminalName('app', '/workspaces/app/src'), 'app: src');
    assert.strictEqual(terminalName('Sandbox', '/'), 'Sandbox');
  });
});
