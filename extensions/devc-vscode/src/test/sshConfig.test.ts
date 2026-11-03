import * as assert from 'assert';
import { ConfigFs, sshConfigAliases } from '../sshConfig';

/** An in-memory file tree: paths to contents. */
function fakeFs(files: Record<string, string>): ConfigFs {
  return {
    readFileSync(file) {
      if (!(file in files)) {
        throw new Error(`ENOENT: ${file}`);
      }
      return files[file];
    },
    readdirSync(dir) {
      const names = Object.keys(files)
        .filter(f => f.startsWith(`${dir}/`))
        .map(f => f.slice(dir.length + 1))
        .filter(name => !name.includes('/'));
      if (!names.length) {
        throw new Error(`ENOENT: ${dir}`);
      }
      return names;
    },
  };
}

suite('sshConfigAliases', () => {
  test('lists concrete Host aliases in order, each once', () => {
    const files = fakeFs({
      '/home/u/.ssh/config': [
        '# comment',
        'Host agent-vm build',
        '  HostName 10.0.0.2',
        'host=Other',
        'Host "quoted-host" *.internal !bastion web?',
        'Match host foo exec "true"',
        '  User bar',
        'Host AGENT-VM',
        'Host -oProxyCommand=x',
      ].join('\n'),
    });
    assert.deepStrictEqual(sshConfigAliases('/home/u', files), [
      'agent-vm',
      'build',
      'Other',
      'quoted-host',
    ]);
  });

  test('follows Include: relative, ~/ and a glob in the last segment', () => {
    const files = fakeFs({
      '/home/u/.ssh/config': [
        'Include config.d/*.conf',
        'Include ~/.orbstack/ssh/config',
        'Host last',
      ].join('\n'),
      '/home/u/.ssh/config.d/b.conf': 'Host from-b',
      '/home/u/.ssh/config.d/a.conf': 'Host from-a',
      '/home/u/.ssh/config.d/skip.txt': 'Host skipped',
      '/home/u/.orbstack/ssh/config': 'Host orb',
    });
    assert.deepStrictEqual(sshConfigAliases('/home/u', files), [
      'from-a',
      'from-b',
      'orb',
      'last',
    ]);
  });

  test('an include cycle stops', () => {
    const files = fakeFs({
      '/home/u/.ssh/config': 'Host top\nInclude loop',
      '/home/u/.ssh/loop': 'Host looped\nInclude loop',
    });
    assert.deepStrictEqual(sshConfigAliases('/home/u', files), [
      'top',
      'looped',
    ]);
  });

  test('a missing file yields nothing', () => {
    assert.deepStrictEqual(sshConfigAliases('/home/u', fakeFs({})), []);
    const files = fakeFs({
      '/home/u/.ssh/config': 'Include missing\nInclude nodir/*\nHost ok',
    });
    assert.deepStrictEqual(sshConfigAliases('/home/u', files), ['ok']);
  });
});
