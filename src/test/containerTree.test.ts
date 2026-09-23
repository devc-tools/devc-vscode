import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ContainerInfo,
  ContainerNode,
  ContainerSource,
  ContainerTreeDataProvider,
  FileOps,
  containerUri,
  isPathWithin,
  parseUriList,
  rootLabel,
  sortEntries,
} from '../containerTree';

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

const BASE = '/workspaces/app';

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

  const c1: ContainerInfo = {
    id: 'c1',
    name: 'app',
    containerName: 'app-container',
  };
  // c2 is running but out of scope, so it is never a root.
  const source = new FakeContainerSource([c1]);
  const provider = new ContainerTreeDataProvider(source, files, confirm);
  return { files, provider, source };
}

async function rootFor(
  provider: ContainerTreeDataProvider,
  id: string
): Promise<ContainerNode> {
  const roots = await provider.getChildren();
  return roots.find(r => r.containerId === id)!;
}

suite('ContainerTreeDataProvider (no Docker required)', () => {
  test('roots are scoped to containers serving the workspace', async () => {
    const { provider } = fixture();
    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.map(r => [r.kind, r.containerId]),
      [['container', 'c1']]
    );
    // One root per container, at the container's filesystem root.
    assert.strictEqual(roots[0].uri.path, '/');
    assert.strictEqual(
      roots[0].kind === 'container' ? roots[0].name : undefined,
      'app'
    );
  });

  test('revealing a container that is not in scope adds no root', async () => {
    const { provider } = fixture();
    await provider.nodeFor('c2', '/srv');
    assert.deepStrictEqual(
      (await provider.getChildren()).map(r => r.containerId),
      ['c1']
    );
  });

  test('a container root expands to /', async () => {
    const { provider } = fixture();
    const children = await provider.getChildren(await rootFor(provider, 'c1'));
    assert.deepStrictEqual(
      children.map(c => c.uri.path),
      ['/etc', '/workspaces', '/init.sh']
    );
  });

  test('directories sort before files, case-insensitively', async () => {
    const { provider } = fixture();
    const children = await provider.getChildren(
      await provider.nodeFor('c1', BASE)
    );
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
    const deep = await provider.nodeFor('c1', `${BASE}/src/index.ts`);

    // /workspaces/app/src/index.ts -> src -> app -> workspaces -> container
    const expected = [`${BASE}/src`, BASE, '/workspaces'];
    let node: ContainerNode | undefined = deep;
    for (const path of expected) {
      node = await provider.getParent(node!);
      assert.strictEqual(node!.kind, 'directory');
      assert.strictEqual(node!.uri.path, path);
    }

    const containerRoot = await provider.getParent(node!);
    assert.strictEqual(containerRoot!.kind, 'container');
    assert.strictEqual(containerRoot!.containerId, 'c1');
    assert.strictEqual(containerRoot!.uri.toString(), root.uri.toString());

    assert.strictEqual(await provider.getParent(containerRoot!), undefined);
  });

  test('a top-level path parents straight to the container root', async () => {
    const { provider } = fixture();
    const parent = await provider.getParent(
      await provider.nodeFor('c1', '/etc')
    );
    assert.strictEqual(parent!.kind, 'container');
    assert.strictEqual(parent!.uri.path, '/');
  });

  test('getTreeItem maps kind to contextValue and opens files', async () => {
    const { provider } = fixture();
    const root = await rootFor(provider, 'c1');
    const rootItem = provider.getTreeItem(root);
    assert.strictEqual(rootItem.contextValue, 'container');
    assert.strictEqual(rootItem.id, 'container:c1');
    // Labelled by host-folder basename, with docker's name as the subtitle.
    assert.strictEqual(rootItem.label, 'app');
    assert.strictEqual(rootItem.description, 'app-container');
    assert.strictEqual(rootItem.resourceUri, undefined);
    assert.strictEqual(rootItem.command, undefined);

    const children = await provider.getChildren(root);
    const dir = children.find(c => c.kind === 'directory')!;
    const file = children.find(c => c.kind === 'file')!;

    const dirItem = provider.getTreeItem(dir);
    assert.strictEqual(dirItem.contextValue, 'directory');
    assert.strictEqual(
      dirItem.collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    assert.strictEqual(dirItem.command, undefined);

    const fileItem = provider.getTreeItem(file);
    assert.strictEqual(fileItem.contextValue, 'file');
    assert.strictEqual(
      fileItem.collapsibleState,
      vscode.TreeItemCollapsibleState.None
    );
    assert.strictEqual(fileItem.command?.command, 'vscode.open');
    assert.strictEqual(fileItem.id, file.uri.toString());
  });

  test('missing directory yields an empty node rather than throwing', async () => {
    const { provider } = fixture();
    const ghost = await provider.nodeFor('c1', `${BASE}/gone`);
    assert.deepStrictEqual(await provider.getChildren(ghost), []);
  });

  suite('drop targets', () => {
    test('a file drops into its parent directory', async () => {
      const { provider } = fixture();
      const node = await provider.nodeFor('c1', `${BASE}/src/index.ts`);
      assert.strictEqual(provider.dropDirectory(node)!.path, `${BASE}/src`);
    });

    test('a directory drops into itself', async () => {
      const { provider } = fixture();
      const node = await provider.nodeFor('c1', `${BASE}/src`);
      assert.strictEqual(provider.dropDirectory(node)!.path, `${BASE}/src`);
    });

    test('a container drops into its root', async () => {
      const { provider } = fixture();
      const root = await rootFor(provider, 'c1');
      assert.strictEqual(provider.dropDirectory(root)!.path, '/');
    });

    test('no target means no drop', async () => {
      const { provider } = fixture();
      assert.strictEqual(provider.dropDirectory(undefined), undefined);
    });
  });

  suite('drops', () => {
    const transfer = (...uris: vscode.Uri[]) => {
      const dt = new vscode.DataTransfer();
      dt.set(
        'text/uri-list',
        new vscode.DataTransferItem(uris.map(u => u.toString()).join('\r\n'))
      );
      return dt;
    };

    test('within one container a drop moves', async () => {
      const { provider, files } = fixture();
      const target = await provider.nodeFor('c1', `${BASE}/src`);
      await provider.handleDrop(
        target,
        transfer(containerUri('c1', `${BASE}/apple.txt`))
      );
      assert.ok(!files.has('c1', `${BASE}/apple.txt`), 'source should be gone');
      assert.strictEqual(files.text('c1', `${BASE}/src/apple.txt`), 'apple');
    });

    test('across containers a drop copies', async () => {
      const { provider, files } = fixture();
      const target = await provider.nodeFor('c2', '/srv');
      await provider.handleDrop(
        target,
        transfer(containerUri('c1', `${BASE}/apple.txt`))
      );
      assert.ok(files.has('c1', `${BASE}/apple.txt`), 'source should remain');
      assert.strictEqual(files.text('c2', '/srv/apple.txt'), 'apple');
    });

    test('a directory copies recursively across containers', async () => {
      const { provider, files } = fixture();
      const target = await provider.nodeFor('c2', '/srv');
      await provider.handleDrop(
        target,
        transfer(containerUri('c1', `${BASE}/src`))
      );
      assert.strictEqual(files.text('c2', '/srv/src/index.ts'), 'index');
    });

    test('declining the overwrite prompt leaves the destination alone', async () => {
      const { provider, files } = fixture(async () => false);
      files.file('c2', '/srv/apple.txt', 'original');
      const target = await provider.nodeFor('c2', '/srv');
      await provider.handleDrop(
        target,
        transfer(containerUri('c1', `${BASE}/apple.txt`))
      );
      assert.strictEqual(files.text('c2', '/srv/apple.txt'), 'original');
    });

    test('accepting the overwrite prompt replaces the destination', async () => {
      const { provider, files } = fixture(async () => true);
      files.file('c2', '/srv/apple.txt', 'original');
      const target = await provider.nodeFor('c2', '/srv');
      await provider.handleDrop(
        target,
        transfer(containerUri('c1', `${BASE}/apple.txt`))
      );
      assert.strictEqual(files.text('c2', '/srv/apple.txt'), 'apple');
    });

    test('a directory cannot be dropped into its own subtree', async () => {
      const { provider, files } = fixture();
      const target = await provider.nodeFor('c1', `${BASE}/src`);
      await provider.handleDrop(target, transfer(containerUri('c1', BASE)));
      assert.ok(files.has('c1', BASE), 'source should be untouched');
      assert.ok(!files.has('c1', `${BASE}/src/app`), 'no nested copy');
    });
  });

  suite('helpers', () => {
    test('parseUriList splits on CRLF and skips comments', () => {
      const uris = parseUriList(
        '# comment\r\ndevc-vscode://c1/a.txt\r\ndevc-vscode://c1/b.txt\r\n'
      );
      assert.deepStrictEqual(
        uris.map(u => u.path),
        ['/a.txt', '/b.txt']
      );
    });

    test('parseUriList tolerates bare LF', () => {
      assert.strictEqual(parseUriList('file:///a\nfile:///b').length, 2);
    });

    test('rootLabel names a workspace-folder container by its basename', () => {
      assert.strictEqual(
        rootLabel('/Users/me/code/app', '/Users/me/code/app'),
        'app'
      );
      assert.strictEqual(
        rootLabel('/Users/me/code/app/', '/Users/me/code/app'),
        'app'
      );
    });

    test('rootLabel names a subfolder container relative to the folder', () => {
      assert.strictEqual(
        rootLabel('/Users/me/code/app', '/Users/me/code/app/services/api'),
        'app/services/api'
      );
    });

    test('isPathWithin scopes containers to workspace folders and children', () => {
      // The rule listRunning applies to devcontainer.local_folder.
      const folder = '/Users/me/code/app';
      assert.ok(isPathWithin(folder, folder));
      assert.ok(isPathWithin(folder, '/Users/me/code/app/services/api'));
      assert.ok(!isPathWithin(folder, '/Users/me/code/other'));
      assert.ok(!isPathWithin(folder, '/Users/me/code/app-sibling'));
    });

    test('isPathWithin does not match sibling prefixes', () => {
      assert.ok(isPathWithin('/a', '/a/b'));
      assert.ok(isPathWithin('/a', '/a'));
      assert.ok(isPathWithin('/', '/anything'));
      assert.ok(!isPathWithin('/a', '/ab'));
      assert.ok(!isPathWithin('/a/b', '/a'));
    });
  });
});
