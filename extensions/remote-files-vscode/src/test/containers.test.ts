import * as assert from 'assert';
import {
  LabelledContainer,
  isPathWithin,
  parseDevContainers,
  remoteUserFromMetadata,
  rootLabel,
  scopeContainers,
} from '../containers';

const c = (
  id: string,
  containerName: string,
  localFolder: string
): LabelledContainer => ({ id, containerName, localFolder });

suite('container discovery (no Docker required)', () => {
  test('parses docker ps output, tab-delimited, short ids', () => {
    assert.deepStrictEqual(
      parseDevContainers(
        [
          'abcdefabcdef\tapp_devcontainer\t/home/me/code/my app',
          '0123456789abcdef\tlong\t/home/me/long',
          'noFolder\tx\t',
          'short line',
          '',
        ].join('\n')
      ),
      [
        c('abcdefabcdef', 'app_devcontainer', '/home/me/code/my app'),
        c('0123456789ab', 'long', '/home/me/long'),
      ]
    );
  });

  test('workspace scope: only containers under a workspace folder, labelled relative to it', () => {
    const labelled = [
      c('a00000000000', 'app-1', '/code/app'),
      c('b00000000000', 'api-1', '/code/app/services/api'),
      c('c00000000000', 'other-1', '/elsewhere/other'),
    ];
    assert.deepStrictEqual(
      scopeContainers(labelled, 'workspace', ['/code/app']),
      [
        { id: 'a00000000000', name: 'app', containerName: 'app-1', localFolder: '/code/app' },
        {
          id: 'b00000000000',
          name: 'app/services/api',
          containerName: 'api-1',
          localFolder: '/code/app/services/api',
        },
      ]
    );
    // The most specific workspace folder labels it.
    assert.deepStrictEqual(
      scopeContainers(labelled, 'workspace', ['/code/app', '/code/app/services'])
        .map(x => x.name),
      ['app', 'services/api']
    );
    assert.deepStrictEqual(scopeContainers(labelled, 'workspace', []), []);
  });

  test('all scope: every container, by folder name, then Docker name', () => {
    const labelled = [
      c('a00000000000', 'web-2', '/x/web'),
      c('b00000000000', 'web-1', '/y/web/'),
      c('c00000000000', 'api-1', '/z/api'),
      c('a00000000000', 'web-2', '/x/web'),
    ];
    assert.deepStrictEqual(
      scopeContainers(labelled, 'all', []).map(x => [x.name, x.containerName]),
      [
        ['api', 'api-1'],
        ['web', 'web-1'],
        ['web', 'web-2'],
      ]
    );
  });

  test('rootLabel and isPathWithin', () => {
    assert.strictEqual(rootLabel('/code/app', '/code/app/'), 'app');
    assert.strictEqual(rootLabel('/code/app', '/code/app/a/b'), 'app/a/b');
    assert.ok(isPathWithin('/code/app', '/code/app/x'));
    assert.ok(isPathWithin('/', '/anything'));
    assert.ok(!isPathWithin('/code/app', '/code/apple'));
  });

  test('the remote user comes from devcontainer.metadata', () => {
    assert.strictEqual(
      remoteUserFromMetadata(
        JSON.stringify([{ containerUser: 'root' }, { remoteUser: 'vscode' }])
      ),
      'vscode'
    );
    assert.strictEqual(
      remoteUserFromMetadata(JSON.stringify({ containerUser: 'node' })),
      'node'
    );
    assert.strictEqual(remoteUserFromMetadata(''), undefined);
    assert.strictEqual(remoteUserFromMetadata('[]'), undefined);
  });
});
