// Ported from devc-vscode/src/test/containerTree.test.ts at 8f2844f; maintained separately.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ContainerInfo, listDevContainers } from '../containers';
import {
  ContainerSource,
  FileOps,
  RemoteNode,
  RemoteTreeDataProvider,
  SshHostSource,
  containerUri,
  parseUriList,
  sortEntries,
  sshUri,
} from '../tree';

/** In-memory FileOps. Keys are "<authority><path>", e.g. "c1/workspaces/app". */
class FakeFileOps implements FileOps {
  readonly nodes = new Map<
    string,
    { type: vscode.FileType; content: Uint8Array }
  >();

  private key(uri: vscode.Uri): string {
    return `${uri.authority}${uri.path}`;
  }

  private prefix(uri: vscode.Uri): string {
    const k = this.key(uri);
    return k.endsWith('/') ? k : `${k}/`;
  }

  dir(container: string, path: string): this {
    this.nodes.set(`${container}${path}`, {
      type: vscode.FileType.Directory,
      content: new Uint8Array(0),
    });
    return this;
  }

  file(container: string, path: string, text = ''): this {
    this.nodes.set(`${container}${path}`, {
      type: vscode.FileType.File,
      content: Buffer.from(text),
    });
    return this;
  }

  has(container: string, path: string): boolean {
    return this.nodes.has(`${container}${path}`);
  }

  text(container: string, path: string): string {
    return Buffer.from(this.nodes.get(`${container}${path}`)!.content).toString(
      'utf8'
    );
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const n = this.nodes.get(this.key(uri));
    if (!n) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: n.type, ctime: 0, mtime: 0, size: n.content.length };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    if (!this.nodes.has(this.key(uri))) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const prefix = this.prefix(uri);
    const out: [string, vscode.FileType][] = [];
    for (const [key, value] of this.nodes) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const rest = key.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) {
        continue;
      }
      out.push([rest, value.type]);
    }
    return out;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return (await this.statNode(uri)).content;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    this.nodes.set(this.key(uri), { type: vscode.FileType.File, content });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    if (this.nodes.has(this.key(uri))) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    this.nodes.set(this.key(uri), {
      type: vscode.FileType.Directory,
      content: new Uint8Array(0),
    });
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const key = this.key(uri);
    const prefix = this.prefix(uri);
    for (const existing of [...this.nodes.keys()]) {
      if (existing === key || existing.startsWith(prefix)) {
        this.nodes.delete(existing);
      }
    }
  }

  async rename(source: vscode.Uri, target: vscode.Uri): Promise<void> {
    const from = this.key(source);
    const to = this.key(target);
    for (const [key, value] of [...this.nodes]) {
      if (key === from) {
        this.nodes.delete(key);
        this.nodes.set(to, value);
      } else if (key.startsWith(this.prefix(source))) {
        this.nodes.delete(key);
        this.nodes.set(to + key.slice(from.length), value);
      }
    }
  }

  private async statNode(uri: vscode.Uri) {
    const n = this.nodes.get(this.key(uri));
    if (!n) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return n;
  }
}

class FakeContainerSource implements ContainerSource {
  constructor(public containers: ContainerInfo[]) {}
  async listRunning(): Promise<ContainerInfo[]> {
    return this.containers;
  }
}

const NO_SSH: SshHostSource = { list: () => [], root: async () => '/' };

const BASE = '/workspaces/app';

const c1: ContainerInfo = {
  id: 'c1',
  name: 'app',
  containerName: 'app-container',
  localFolder: '/work/app',
};
const c2: ContainerInfo = {
  id: 'c2',
  name: 'other',
  containerName: 'other-container',
  localFolder: '/work/other',
};

/** A directory or file node, as the tree builds them. */
const dir = (id: string, path: string): RemoteNode => ({
  kind: 'directory',
  uri: containerUri(id, path, id === 'c1' ? 'app' : 'other'),
});
const file = (id: string, path: string): RemoteNode => ({
  kind: 'file',
  uri: containerUri(id, path, id === 'c1' ? 'app' : 'other'),
});

function fixture(confirm = async () => true) {
  const files = new FakeFileOps();
  files
    .dir('c1', '/')
    .dir('c1', '/etc')
    .file('c1', '/init.sh', 'init')
    .dir('c1', '/workspaces')
    .dir('c1', BASE)
    .dir('c1', `${BASE}/src`)
    .file('c1', `${BASE}/src/index.ts`, 'index')
    .file('c1', `${BASE}/README.md`, 'readme')
    .file('c1', `${BASE}/apple.txt`, 'apple')
    .dir('c1', `${BASE}/Zebra`)
    .dir('c2', '/')
    .dir('c2', '/srv');
  const source = new FakeContainerSource([c1, c2]);
  const provider = new RemoteTreeDataProvider(source, NO_SSH, files, confirm);
  return { files, provider, source };
}

async function rootFor(
  provider: RemoteTreeDataProvider,
  id: string
): Promise<RemoteNode> {
  const roots = await provider.getChildren();
  return roots.find(r => r.kind === 'container' && r.containerId === id)!;
}

const transfer = (...uris: vscode.Uri[]) => {
  const dt = new vscode.DataTransfer();
  dt.set(
    'text/uri-list',
    new vscode.DataTransferItem(uris.map(u => u.toString()).join('\r\n'))
  );
  return dt;
};

suite('RemoteTreeDataProvider: containers (no Docker required)', () => {
  test('one root per container, at its filesystem root, with its label in the URI', async () => {
    const { provider } = fixture();
    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.map(r => [r.kind, r.uri.scheme, r.uri.authority, r.uri.path]),
      [
        ['container', 'remotefs-container', 'c1', '/'],
        ['container', 'remotefs-container', 'c2', '/'],
      ]
    );
    assert.strictEqual(roots[0].uri.query, JSON.stringify({ label: 'app' }));
  });

  test('a container root shows only /workspaces by default', async () => {
    const { provider } = fixture();
    const children = await provider.getChildren(await rootFor(provider, 'c1'));
    assert.deepStrictEqual(
      children.map(c => c.uri.path),
      ['/workspaces']
    );
    // Children keep the root's label query.
    assert.strictEqual(children[0].uri.query, JSON.stringify({ label: 'app' }));
  });

  test('a container without /workspaces lists all of /', async () => {
    const { files, provider } = fixture();
    await files.delete(containerUri('c1', '/workspaces', 'app'));
    const children = await provider.getChildren(await rootFor(provider, 'c1'));
    assert.deepStrictEqual(
      children.map(c => c.uri.path),
      ['/etc', '/init.sh']
    );
  });

  test('showing all files expands a container root to /', async () => {
    const { provider } = fixture();
    const fired: (RemoteNode | undefined)[] = [];
    await rootFor(provider, 'c1');
    provider.onDidChangeTreeData(n => fired.push(n));
    provider.setShowAllFiles(true);
    assert.strictEqual(fired.length, 2, 'each container root refreshes');
    const children = await provider.getChildren(await rootFor(provider, 'c1'));
    assert.deepStrictEqual(
      children.map(c => c.uri.path),
      ['/etc', '/workspaces', '/init.sh']
    );
  });

  test('directories sort before files, case-insensitively', async () => {
    const { provider } = fixture();
    const children = await provider.getChildren(dir('c1', BASE));
    assert.deepStrictEqual(
      children.map(c => c.uri.path.split('/').pop()),
      ['src', 'Zebra', 'apple.txt', 'README.md']
    );
  });

  test('sortEntries is case-insensitive within a type', () => {
    const sorted = sortEntries([
      ['beta.txt', vscode.FileType.File],
      ['Alpha.txt', vscode.FileType.File],
      ['zed', vscode.FileType.Directory],
    ]);
    assert.deepStrictEqual(
      sorted.map(([n]) => n),
      ['zed', 'Alpha.txt', 'beta.txt']
    );
  });

  test('getParent walks back to the container root', async () => {
    const { provider } = fixture();
    const root = await rootFor(provider, 'c1');
    let node: RemoteNode | undefined = file('c1', `${BASE}/src/index.ts`);
    for (const path of [`${BASE}/src`, BASE, '/workspaces']) {
      node = await provider.getParent(node!);
      assert.strictEqual(node!.kind, 'directory');
      assert.strictEqual(node!.uri.path, path);
      assert.strictEqual(node!.uri.query, JSON.stringify({ label: 'app' }));
    }
    const containerRoot = await provider.getParent(node!);
    assert.strictEqual(containerRoot, root);
    assert.strictEqual(await provider.getParent(containerRoot!), undefined);
  });

  test('getTreeItem: roots, directories, files', async () => {
    const { provider } = fixture();
    const root = await rootFor(provider, 'c1');
    const rootItem = provider.getTreeItem(root);
    assert.strictEqual(rootItem.contextValue, 'container');
    assert.strictEqual(rootItem.id, 'container:c1');
    assert.strictEqual(rootItem.label, 'app');
    assert.strictEqual(rootItem.description, 'app-container');
    assert.strictEqual(rootItem.tooltip, 'app-container — /work/app');
    assert.strictEqual(rootItem.resourceUri, undefined);
    assert.strictEqual(rootItem.command, undefined);
    assert.strictEqual((rootItem.iconPath as vscode.ThemeIcon).id, 'vm-running');

    // A Docker name equal to the label shows the id instead.
    const same = new RemoteTreeDataProvider(
      new FakeContainerSource([{ ...c1, containerName: 'app' }]),
      NO_SSH,
      new FakeFileOps()
    );
    const [sameRoot] = await same.getChildren();
    assert.strictEqual(same.getTreeItem(sameRoot).description, 'c1');

    const dirItem = provider.getTreeItem(dir('c1', BASE));
    assert.strictEqual(dirItem.contextValue, 'directory');
    assert.strictEqual(
      dirItem.collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    assert.strictEqual(dirItem.command, undefined);

    const f = file('c1', `${BASE}/README.md`);
    const fileItem = provider.getTreeItem(f);
    assert.strictEqual(fileItem.contextValue, 'file');
    assert.strictEqual(
      fileItem.collapsibleState,
      vscode.TreeItemCollapsibleState.None
    );
    assert.strictEqual(fileItem.command?.command, 'vscode.open');
    assert.strictEqual(fileItem.id, f.uri.toString());
  });

  test('a missing directory yields no children rather than throwing', async () => {
    const { provider } = fixture();
    assert.deepStrictEqual(await provider.getChildren(dir('c1', `${BASE}/gone`)), []);
  });

  suite('drop targets', () => {
    test('a file drops into its parent directory', () => {
      const { provider } = fixture();
      assert.strictEqual(
        provider.dropDirectory(file('c1', `${BASE}/src/index.ts`))!.path,
        `${BASE}/src`
      );
    });

    test('a directory drops into itself, a container into its root', async () => {
      const { provider } = fixture();
      assert.strictEqual(provider.dropDirectory(dir('c1', `${BASE}/src`))!.path, `${BASE}/src`);
      assert.strictEqual(provider.dropDirectory(await rootFor(provider, 'c1'))!.path, '/');
    });

    test('no target means no drop', () => {
      const { provider } = fixture();
      assert.strictEqual(provider.dropDirectory(undefined), undefined);
    });
  });

  suite('drops', () => {
    test('within one container a drop moves', async () => {
      const { provider, files } = fixture();
      await provider.handleDrop(
        dir('c1', `${BASE}/src`),
        transfer(containerUri('c1', `${BASE}/apple.txt`, 'app'))
      );
      assert.ok(!files.has('c1', `${BASE}/apple.txt`), 'source should be gone');
      assert.strictEqual(files.text('c1', `${BASE}/src/apple.txt`), 'apple');
    });

    test('across containers a drop copies, directories recursively', async () => {
      const { provider, files } = fixture();
      await provider.handleDrop(
        dir('c2', '/srv'),
        transfer(
          containerUri('c1', `${BASE}/apple.txt`, 'app'),
          containerUri('c1', `${BASE}/src`, 'app')
        )
      );
      assert.ok(files.has('c1', `${BASE}/apple.txt`), 'source should remain');
      assert.strictEqual(files.text('c2', '/srv/apple.txt'), 'apple');
      assert.strictEqual(files.text('c2', '/srv/src/index.ts'), 'index');
    });

    test('a local file dropped in copies', async () => {
      const { provider, files } = fixture();
      files.file('', '/home/me/notes.txt', 'notes');
      await provider.handleDrop(
        dir('c2', '/srv'),
        transfer(vscode.Uri.file('/home/me/notes.txt'))
      );
      assert.strictEqual(files.text('c2', '/srv/notes.txt'), 'notes');
      assert.ok(files.has('', '/home/me/notes.txt'));
    });

    test('declining the overwrite prompt leaves the destination alone', async () => {
      const { provider, files } = fixture(async () => false);
      files.file('c2', '/srv/apple.txt', 'original');
      await provider.handleDrop(
        dir('c2', '/srv'),
        transfer(containerUri('c1', `${BASE}/apple.txt`, 'app'))
      );
      assert.strictEqual(files.text('c2', '/srv/apple.txt'), 'original');
    });

    test('accepting the overwrite prompt replaces the destination', async () => {
      const { provider, files } = fixture(async () => true);
      files.file('c2', '/srv/apple.txt', 'original');
      await provider.handleDrop(
        dir('c2', '/srv'),
        transfer(containerUri('c1', `${BASE}/apple.txt`, 'app'))
      );
      assert.strictEqual(files.text('c2', '/srv/apple.txt'), 'apple');
    });

    test('a directory cannot be dropped into its own subtree', async () => {
      const { provider, files } = fixture();
      await provider.handleDrop(
        dir('c1', `${BASE}/src`),
        transfer(containerUri('c1', BASE, 'app'))
      );
      assert.ok(files.has('c1', BASE), 'source should be untouched');
      assert.ok(!files.has('c1', `${BASE}/src/app`), 'no nested copy');
    });

    test('dragging rows out puts their URIs on the transfer, roots left out', async () => {
      const { provider } = fixture();
      const dt = new vscode.DataTransfer();
      const a = file('c1', `${BASE}/README.md`);
      const b = dir('c1', `${BASE}/src`);
      provider.handleDrag([await rootFor(provider, 'c1'), a, b], dt);
      assert.strictEqual(
        await dt.get('text/uri-list')!.asString(),
        `${a.uri.toString()}\r\n${b.uri.toString()}`
      );
    });
  });

  test('parseUriList splits on CRLF or LF and skips comments', () => {
    assert.deepStrictEqual(
      parseUriList('# comment\r\nfile:///a\r\n\nfile:///b\n').map(u => u.toString()),
      ['file:///a', 'file:///b']
    );
  });
});

suite('RemoteTreeDataProvider: SSH hosts (no ssh required)', () => {
  const ROOT = '/home/ubuntu/work';

  function sshFixture() {
    const files = new FakeFileOps();
    files
      .dir('agent-vm', '/home/ubuntu')
      .dir('agent-vm', ROOT)
      .dir('agent-vm', `${ROOT}/src`)
      .file('agent-vm', `${ROOT}/src/a.ts`, 'a')
      .file('agent-vm', `${ROOT}/README.md`, 'readme')
      .dir('c1', '/')
      .dir('c1', '/srv');
    const provider = new RemoteTreeDataProvider(
      new FakeContainerSource([c1]),
      {
        list: () => [
          { host: 'agent-vm', label: 'Sandbox' },
          { host: 'down', label: 'down' },
          { host: 'fixed', label: 'fixed', root: '/srv' },
        ],
        root: async host => {
          if (host === 'down') {
            throw new Error('ssh: connect to host down port 22: Connection refused');
          }
          return ROOT;
        },
      },
      files,
      async () => true
    );
    return { files, provider };
  }

  test('lists SSH roots after containers, in settings order', async () => {
    const { provider } = sshFixture();
    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.map(r => r.kind),
      ['container', 'sshHost', 'sshHost', 'sshHost']
    );
    const item = provider.getTreeItem(roots[1]);
    assert.strictEqual(item.label, 'Sandbox');
    assert.strictEqual(item.id, 'sshHost:agent-vm');
    assert.strictEqual(item.description, '~');
    assert.strictEqual(item.contextValue, 'sshHost');
    assert.strictEqual(item.tooltip, 'SSH host agent-vm');
    assert.strictEqual(item.resourceUri, undefined);
    assert.strictEqual(provider.getTreeItem(roots[3]).description, '/srv');
  });

  test('a root expands at its resolved root, directories first', async () => {
    const { provider } = sshFixture();
    const root = (await provider.getChildren())[1];
    const children = await provider.getChildren(root);
    assert.deepStrictEqual(
      children.map(c => [c.kind, c.uri.toString()]),
      [
        ['directory', `remotefs-ssh://agent-vm${ROOT}/src`],
        ['file', `remotefs-ssh://agent-vm${ROOT}/README.md`],
      ]
    );
    assert.strictEqual(provider.getTreeItem(root).description, ROOT);
    assert.strictEqual((await provider.baseUri(root)).path, ROOT);
    // getParent walks back up to the root and stops there.
    const src = children[0];
    const [a] = await provider.getChildren(src);
    assert.strictEqual((await provider.getParent(a))?.uri.toString(), src.uri.toString());
    assert.strictEqual(await provider.getParent(src), root);
    // A path above the root parents to the root too.
    assert.strictEqual(
      await provider.getParent({ kind: 'directory', uri: sshUri('agent-vm', '/home/ubuntu') }),
      root
    );
    assert.strictEqual(await provider.rootOf(sshUri('AGENT-VM', `${ROOT}/src`)), root);
  });

  test('an unreachable root shows why as its only child', async () => {
    const { provider } = sshFixture();
    const down = (await provider.getChildren())[2];
    const [error] = await provider.getChildren(down);
    assert.strictEqual(error.kind, 'sshError');
    const item = provider.getTreeItem(error);
    assert.strictEqual(item.label, 'Cannot reach down');
    assert.strictEqual(item.contextValue, 'sshError');
    assert.strictEqual(item.tooltip, 'ssh: connect to host down port 22: Connection refused');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(provider.dropDirectory(error), undefined);
    assert.strictEqual(await provider.getParent(error), down);
  });

  test('drops move within a host, copy across, and land at a root\'s effective root', async () => {
    const { files, provider } = sshFixture();
    const root = (await provider.getChildren())[1];
    const src = (await provider.getChildren(root)).find(c => c.uri.path.endsWith('/src'))!;
    await provider.handleDrop(src, transfer(sshUri('agent-vm', `${ROOT}/README.md`)));
    assert.ok(files.has('agent-vm', `${ROOT}/src/README.md`));
    assert.ok(!files.has('agent-vm', `${ROOT}/README.md`));

    const containerRoot = (await provider.getChildren())[0];
    provider.setShowAllFiles(true);
    const [srv] = await provider.getChildren(containerRoot);
    await provider.handleDrop(srv, transfer(sshUri('agent-vm', `${ROOT}/src/a.ts`)));
    assert.strictEqual(files.text('c1', '/srv/a.ts'), 'a');
    assert.ok(files.has('agent-vm', `${ROOT}/src/a.ts`));

    await provider.handleDrop(root, transfer(containerUri('c1', '/srv/a.ts', 'app')));
    assert.strictEqual(files.text('agent-vm', `${ROOT}/a.ts`), 'a');
  });
});

suite('Docker CLI missing', () => {
  test('lists no containers rather than failing', async () => {
    assert.deepStrictEqual(await listDevContainers('/nonexistent/docker', 'all', []), []);
    assert.deepStrictEqual(
      await listDevContainers('/nonexistent/docker', 'workspace', ['/work/app']),
      []
    );
  });

  test('SSH roots still list', async () => {
    const provider = new RemoteTreeDataProvider(
      { listRunning: () => listDevContainers('/nonexistent/docker', 'all', []) },
      { list: () => [{ host: 'agent-vm', label: 'Sandbox' }], root: async () => '/home/ubuntu' },
      new FakeFileOps()
    );
    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.map(r => [r.kind, r.kind === 'sshHost' ? r.host : undefined]),
      [['sshHost', 'agent-vm']]
    );
  });
});
