// Ported from devc-vscode/src/test/sshFs.test.ts at 8f2844f; maintained separately.

import * as assert from 'assert';
import { findSshHost, parseSshHosts } from '../sshHosts';

suite('sshHosts', () => {
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

  test('a blank label falls back to the host; labels are trimmed', () => {
    assert.deepStrictEqual(
      parseSshHosts([
        { host: 'a', label: '   ' },
        { host: 'b', label: '  Box  ' },
      ]).hosts,
      [
        { host: 'a', label: 'a', root: undefined },
        { host: 'b', label: 'Box', root: undefined },
      ]
    );
  });

  test('finds a configured host whatever the case', () => {
    const { hosts } = parseSshHosts([{ host: 'Agent-VM' }]);
    assert.strictEqual(findSshHost(hosts, 'agent-vm')?.host, 'Agent-VM');
    assert.strictEqual(findSshHost(hosts, 'other'), undefined);
  });
});
