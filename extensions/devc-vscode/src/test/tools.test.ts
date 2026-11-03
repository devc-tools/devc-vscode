import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  commandAvailable,
  dockerInstalled,
  findDevc,
  isUserSet,
} from '../tools';

suite('dockerInstalled', () => {
  test('a Docker CLI that cannot be run is absent', async () => {
    assert.strictEqual(await dockerInstalled('/nonexistent/docker'), false);
  });

  test('a command that exits 0 for --version is present', async () => {
    // `true` ignores its arguments and exits 0, as `docker --version` does.
    assert.strictEqual(await dockerInstalled('true'), true);
  });
});

suite('findDevc', () => {
  let tmp: string;
  let home: string;
  let binA: string;
  let binB: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-tools-'));
    home = path.join(tmp, 'home');
    binA = path.join(tmp, 'a');
    binB = path.join(tmp, 'b');
    for (const dir of [path.join(home, '.local', 'bin'), binA, binB]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function devcIn(dir: string, mode = 0o755): string {
    const file = path.join(dir, 'devc');
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, mode);
    return file;
  }

  const env = (...dirs: string[]) => ({ PATH: dirs.join(path.delimiter) });

  test('finds an executable devc on PATH', async () => {
    const file = devcIn(binB);
    assert.strictEqual(await findDevc(env(binA, binB), home, 'linux'), file);
  });

  test('ignores a devc that is not executable', async () => {
    devcIn(binA, 0o644);
    assert.strictEqual(await findDevc(env(binA), home, 'linux'), undefined);
  });

  test('ignores a directory named devc', async () => {
    fs.mkdirSync(path.join(binA, 'devc'));
    assert.strictEqual(await findDevc(env(binA), home, 'linux'), undefined);
  });

  test('checks ~/.local/bin first, even when PATH lacks it', async () => {
    devcIn(binA);
    const local = devcIn(path.join(home, '.local', 'bin'));
    assert.strictEqual(await findDevc(env(binA), home, 'linux'), local);
  });

  test('absent everywhere', async () => {
    assert.strictEqual(await findDevc(env(binA, binB), home, 'linux'), undefined);
  });
});

suite('command availability', () => {
  test('a non-blank value at any scope is user-set', () => {
    assert.strictEqual(isUserSet({ globalValue: 'mydevc stop' }), true);
    assert.strictEqual(isUserSet({ workspaceValue: 'x' }), true);
    assert.strictEqual(isUserSet({ workspaceFolderValue: 'x' }), true);
  });

  test('blank or missing values are unset', () => {
    assert.strictEqual(isUserSet(undefined), false);
    assert.strictEqual(isUserSet({}), false);
    assert.strictEqual(isUserSet({ globalValue: '' }), false);
    assert.strictEqual(isUserSet({ workspaceValue: '   ' }), false);
  });

  test('a user-set command is available without devc', () => {
    assert.strictEqual(commandAvailable({ globalValue: 'docker stop x' }, false), true);
  });

  test('a blank value is the same as unset', () => {
    assert.strictEqual(commandAvailable({ globalValue: '' }, false), false);
    assert.strictEqual(commandAvailable({ globalValue: '' }, true), true);
  });

  test('an unset command follows whether devc was found', () => {
    assert.strictEqual(commandAvailable({}, true), true);
    assert.strictEqual(commandAvailable({}, false), false);
  });
});
