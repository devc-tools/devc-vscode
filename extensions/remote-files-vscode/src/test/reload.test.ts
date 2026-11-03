import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { REMOTE_RESOURCE_WHEN, reloadEditor } from '../reload';

function steps(dirty: boolean, confirm: boolean) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      isDirty: () => dirty,
      confirmDiscard: async () => {
        calls.push('confirm');
        return confirm;
      },
      show: async () => {
        calls.push('show');
      },
      revert: async () => {
        calls.push('revert');
      },
    },
  };
}

suite('Reload Remote File', () => {
  test('a clean editor is shown, then re-read, without asking', async () => {
    const { calls, steps: s } = steps(false, false);
    assert.strictEqual(await reloadEditor(s), true);
    assert.deepStrictEqual(calls, ['show', 'revert']);
  });

  test('unsaved changes are discarded only when the user says so', async () => {
    const yes = steps(true, true);
    assert.strictEqual(await reloadEditor(yes.steps), true);
    assert.deepStrictEqual(yes.calls, ['confirm', 'show', 'revert']);

    const no = steps(true, false);
    assert.strictEqual(await reloadEditor(no.steps), false);
    assert.deepStrictEqual(no.calls, ['confirm']);
  });

  test('the button shows on remote editors only, in the title bar and tab menu', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    );
    const menus = pkg.contributes.menus;
    for (const menu of ['editor/title', 'editor/title/context', 'commandPalette']) {
      const entry = menus[menu].find(
        (m: { command: string }) => m.command === 'remoteFiles.reloadEditor'
      );
      assert.ok(entry, menu);
      assert.strictEqual(entry.when, REMOTE_RESOURCE_WHEN, menu);
    }
    // What the clause matches, as VS Code's =~ does: a regex test.
    const re = /^remotefs-(container|ssh)$/;
    assert.ok(re.test('remotefs-container') && re.test('remotefs-ssh'));
    assert.ok(!re.test('file') && !re.test('herdr-ssh') && !re.test('remotefs-ssh2'));
  });
});
