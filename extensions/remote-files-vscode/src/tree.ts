// Ported from devc-vscode/src/containerTree.ts at 8f2844f; maintained separately.
// (The tree and drag-and-drop, without sync targets or attached-terminal state.)

import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { ContainerInfo, isPathWithin, normalizePath } from './containers';
import { SshHostInfo } from './sshHosts';

export const CONTAINER_SCHEME = 'remotefs-container';
export const SSH_SCHEME = 'remotefs-ssh';
export const VIEW_ID = 'remoteFiles.tree';

/**
 * A file in a dev container. The query carries the root's label for the
 * resource label formatter; the provider ignores it.
 */
export function containerUri(
  id: string,
  path: string,
  label: string
): vscode.Uri {
  return vscode.Uri.from({
    scheme: CONTAINER_SCHEME,
    authority: id,
    path: path === '' ? '/' : path,
    query: JSON.stringify({ label }),
  });
}

export function sshUri(host: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SSH_SCHEME,
    authority: host,
    path: path === '' ? '/' : path,
  });
}

/** Where the tree gets its container roots. Injected for tests. */
export interface ContainerSource {
  /** Running dev containers that are roots, in display order. */
  listRunning(): Promise<ContainerInfo[]>;
}

/** Where the tree gets its SSH roots. Injected for tests. */
export interface SshHostSource {
  /** Configured hosts, in settings order. */
  list(): SshHostInfo[];
  /**
   * A host's effective root: its configured root, else the remote home.
   * Rejects when the host cannot be reached.
   */
  root(host: string): Promise<string>;
}

/**
 * The file operations the tree performs. A thin seam over vscode.workspace.fs
 * so drops are testable against an in-memory fake.
 */
export interface FileOps {
  stat(uri: vscode.Uri): Promise<vscode.FileStat>;
  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]>;
  readFile(uri: vscode.Uri): Promise<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void>;
  createDirectory(uri: vscode.Uri): Promise<void>;
  delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void>;
  rename(
    source: vscode.Uri,
    target: vscode.Uri,
    options: { overwrite: boolean }
  ): Promise<void>;
}

export type RemoteNode =
  | {
      kind: 'container';
      containerId: string;
      name: string;
      containerName: string;
      /** The project folder on the host the container serves. */
      localFolder: string;
      uri: vscode.Uri;
    }
  | {
      kind: 'sshHost';
      host: string;
      label: string;
      /** The effective root, once known. */
      root?: string;
      /** At the root once it is known, else at '/'. */
      uri: vscode.Uri;
    }
  | {
      /** Why an SSH root cannot be listed: its only child. */
      kind: 'sshError';
      host: string;
      message: string;
      uri: vscode.Uri;
    }
  | {
      kind: 'directory' | 'file';
      uri: vscode.Uri;
    };

/** The directory a container root is narrowed to unless all files are shown. */
export const WORKSPACES_DIR = 'workspaces';

/** The key SSH roots use in `roots`. */
function sshRootKey(host: string): string {
  return `ssh:${host.toLowerCase()}`;
}

/** Asked before a drop overwrites an existing entry. Injected for tests. */
export type ConfirmOverwrite = (name: string) => Promise<boolean>;

/** Directories before files, then case-insensitive by name. */
export function sortEntries(
  entries: [string, vscode.FileType][]
): [string, vscode.FileType][] {
  return [...entries].sort((a, b) => {
    const aDir = a[1] === vscode.FileType.Directory;
    const bDir = b[1] === vscode.FileType.Directory;
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
  });
}

/** Whether a URI is one of this extension's. */
export function isRemoteScheme(scheme: string): boolean {
  return scheme === CONTAINER_SCHEME || scheme === SSH_SCHEME;
}

export class RemoteTreeDataProvider
  implements
    vscode.TreeDataProvider<RemoteNode>,
    vscode.TreeDragAndDropController<RemoteNode>
{
  // The view id, lowercased. VS Code lowercases the id when it builds this
  // mime type, so the two must match exactly or internal drags are dropped
  // with no error.
  readonly dropMimeTypes = [
    'text/uri-list',
    'application/vnd.code.tree.remotefiles.tree',
  ];
  readonly dragMimeTypes = ['text/uri-list'];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    RemoteNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Roots, cached so getParent can terminate without a docker call: by
   * container id, and by sshRootKey for SSH hosts.
   */
  private readonly roots = new Map<string, RemoteNode>();
  /** SSH hosts' effective roots, once resolved. */
  private readonly sshRoots = new Map<string, string>();
  /** Whether container roots list all of '/' rather than just /workspaces. */
  private showAll = false;

  constructor(
    private readonly containers: ContainerSource,
    private readonly ssh: SshHostSource,
    private readonly files: FileOps,
    private readonly confirmOverwrite: ConfirmOverwrite = defaultConfirmOverwrite
  ) {}

  /** Refresh one node, or with none every root and the SSH roots resolved so far. */
  refresh(node?: RemoteNode): void {
    if (!node) {
      this.roots.clear();
      this.sshRoots.clear();
    }
    this._onDidChangeTreeData.fire(node);
  }

  get showsAllFiles(): boolean {
    return this.showAll;
  }

  /** Show all of each container's '/', or only its /workspaces. */
  setShowAllFiles(showAll: boolean): void {
    if (showAll === this.showAll) {
      return;
    }
    this.showAll = showAll;
    for (const root of this.roots.values()) {
      if (root.kind === 'container') {
        this._onDidChangeTreeData.fire(root);
      }
    }
  }

  // --- tree data

  async getChildren(element?: RemoteNode): Promise<RemoteNode[]> {
    if (!element) {
      return this.listRoots();
    }
    if (element.kind === 'file' || element.kind === 'sshError') {
      return [];
    }
    let dir = element.uri;
    let entries: [string, vscode.FileType][];
    try {
      if (element.kind === 'sshHost') {
        dir = await this.baseUri(element);
      }
      entries = await this.files.readDirectory(dir);
    } catch (err) {
      if (element.kind === 'sshHost') {
        // Unreachable, or its root is gone: say why in the tree.
        return [
          {
            kind: 'sshError',
            host: element.host,
            message: (err as Error).message,
            uri: sshUri(element.host, '/'),
          },
        ];
      }
      // Container stopped mid-expand, or the path went away. An empty node is
      // better than an error toast on every refresh.
      return [];
    }
    if (element.kind === 'container' && !this.showAll) {
      const workspaces = entries.filter(
        ([name, type]) =>
          name === WORKSPACES_DIR && type === vscode.FileType.Directory
      );
      // A container without /workspaces would otherwise look empty.
      if (workspaces.length > 0) {
        entries = workspaces;
      }
    }
    return sortEntries(entries).map(([name, type]) => {
      const uri = dir.with({ path: posix.join(dir.path, name) });
      return type === vscode.FileType.Directory
        ? { kind: 'directory', uri }
        : { kind: 'file', uri };
    });
  }

  /**
   * The directory a node stands for. An SSH root's is its effective root,
   * resolved (and remembered) on first use. Rejects for an unreachable host.
   */
  async baseUri(node: RemoteNode): Promise<vscode.Uri> {
    if (node.kind !== 'sshHost') {
      return node.uri;
    }
    if (node.root === undefined) {
      const root = await this.ssh.root(node.host);
      this.sshRoots.set(sshRootKey(node.host), root);
      node.root = root;
      node.uri = sshUri(node.host, root);
      // The description shows the root now it is known.
      this._onDidChangeTreeData.fire(node);
    }
    return node.uri;
  }

  /** The root node a URI belongs under, if it is still a root. */
  async rootOf(uri: vscode.Uri): Promise<RemoteNode | undefined> {
    return this.ensureRoot(
      uri.scheme === SSH_SCHEME ? sshRootKey(uri.authority) : uri.authority
    );
  }

  getTreeItem(node: RemoteNode): vscode.TreeItem {
    if (node.kind === 'container') {
      const item = new vscode.TreeItem(
        node.name,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `container:${node.containerId}`;
      item.description =
        node.containerName && node.containerName !== node.name
          ? node.containerName
          : node.containerId;
      // No resourceUri: the file icon theme would paint a folder icon over this.
      item.iconPath = new vscode.ThemeIcon('vm-running');
      item.contextValue = 'container';
      item.tooltip = `${node.containerName || node.name} — ${node.localFolder}`;
      return item;
    }
    if (node.kind === 'sshHost') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `sshHost:${node.host}`;
      item.description = node.root ?? '~';
      // No resourceUri, as for container roots.
      item.iconPath = new vscode.ThemeIcon('remote');
      item.contextValue = 'sshHost';
      item.tooltip = `SSH host ${node.host}`;
      return item;
    }
    if (node.kind === 'sshError') {
      const item = new vscode.TreeItem(
        `Cannot reach ${node.host}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = `sshError:${node.host}`;
      item.iconPath = new vscode.ThemeIcon('error');
      item.contextValue = 'sshError';
      item.tooltip = node.message;
      return item;
    }

    const isDir = node.kind === 'directory';
    const item = new vscode.TreeItem(
      node.uri,
      isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = node.uri.toString();
    item.contextValue = node.kind;
    if (!isDir) {
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [node.uri],
      };
    }
    return item;
  }

  /**
   * Required for TreeView.reveal — without it reveal silently does nothing.
   * Walks one path segment up, terminating at the root.
   */
  async getParent(node: RemoteNode): Promise<RemoteNode | undefined> {
    if (node.kind === 'container' || node.kind === 'sshHost') {
      return undefined;
    }
    if (node.kind === 'sshError') {
      return this.ensureRoot(sshRootKey(node.host));
    }
    const parent = normalizePath(posix.dirname(normalizePath(node.uri.path)));
    if (node.uri.scheme === SSH_SCHEME) {
      // Terminates at the host's root: anything at or above it has the root
      // node as its parent.
      const root = await this.ensureRoot(sshRootKey(node.uri.authority));
      const base = root?.kind === 'sshHost' ? root.root : undefined;
      if (
        base === undefined ||
        !isPathWithin(base, parent) ||
        normalizePath(base) === parent
      ) {
        return root;
      }
      return { kind: 'directory', uri: node.uri.with({ path: parent }) };
    }
    if (normalizePath(node.uri.path) === '/' || parent === '/') {
      return this.ensureRoot(node.uri.authority);
    }
    return { kind: 'directory', uri: node.uri.with({ path: parent }) };
  }

  private async listRoots(): Promise<RemoteNode[]> {
    this.roots.clear();
    const nodes: RemoteNode[] = [];
    for (const c of await this.containers.listRunning()) {
      const node: RemoteNode = {
        kind: 'container',
        containerId: c.id,
        name: c.name,
        containerName: c.containerName,
        localFolder: c.localFolder,
        // One root per container, at its filesystem root.
        uri: containerUri(c.id, '/', c.name),
      };
      this.roots.set(c.id, node);
      nodes.push(node);
    }
    for (const info of this.ssh.list()) {
      const root = info.root ?? this.sshRoots.get(sshRootKey(info.host));
      const node: RemoteNode = {
        kind: 'sshHost',
        host: info.host,
        label: info.label,
        root,
        uri: sshUri(info.host, root ?? '/'),
      };
      this.roots.set(sshRootKey(info.host), node);
      nodes.push(node);
    }
    return nodes;
  }

  private async ensureRoot(key: string): Promise<RemoteNode | undefined> {
    const cached = this.roots.get(key);
    if (cached) {
      return cached;
    }
    await this.listRoots();
    return this.roots.get(key);
  }

  // --- drag and drop

  handleDrag(
    source: readonly RemoteNode[],
    dataTransfer: vscode.DataTransfer
  ): void {
    const entries = source.filter(
      n => n.kind === 'file' || n.kind === 'directory'
    );
    if (!entries.length) {
      return;
    }
    dataTransfer.set(
      'text/uri-list',
      // text/uri-list is CRLF-delimited per RFC 2483.
      new vscode.DataTransferItem(
        entries.map(n => n.uri.toString()).join('\r\n')
      )
    );
  }

  /** The directory a drop on `target` lands in. */
  dropDirectory(target: RemoteNode | undefined): vscode.Uri | undefined {
    if (!target || target.kind === 'sshError') {
      return undefined;
    }
    if (target.kind === 'file') {
      return target.uri.with({
        path: normalizePath(posix.dirname(target.uri.path)),
      });
    }
    return target.uri;
  }

  async handleDrop(
    target: RemoteNode | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    let destDir: vscode.Uri | undefined;
    try {
      destDir =
        target?.kind === 'sshHost'
          ? await this.baseUri(target)
          : this.dropDirectory(target);
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
      return;
    }
    if (!destDir) {
      return;
    }
    const item = dataTransfer.get('text/uri-list');
    if (!item) {
      return;
    }
    const sources = parseUriList(await item.asString());
    for (const source of sources) {
      const name = posix.basename(source.path);
      if (!name) {
        continue;
      }
      const dest = destDir.with({ path: posix.join(destDir.path, name) });
      if (sameEntry(source, dest)) {
        continue;
      }
      const sameRoot =
        isRemoteScheme(source.scheme) &&
        source.scheme === destDir.scheme &&
        source.authority.toLowerCase() === destDir.authority.toLowerCase();
      if (sameRoot && isPathWithin(source.path, destDir.path)) {
        // Refuse to move a directory into itself or its own subtree.
        continue;
      }
      try {
        if (!(await this.clearDestination(dest, name))) {
          continue;
        }
        if (sameRoot) {
          await this.files.rename(source, dest, { overwrite: true });
        } else {
          await this.copyInto(source, dest);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not ${sameRoot ? 'move' : 'copy'} ${name}: ${(err as Error).message}`
        );
      }
    }
    // A drop on a file landed in its parent directory, so refresh that instead.
    this.refresh(
      target && target.kind === 'file' ? await this.getParent(target) : target
    );
  }

  /** True if the drop may proceed: destination is free, or the user said overwrite. */
  private async clearDestination(
    dest: vscode.Uri,
    name: string
  ): Promise<boolean> {
    let exists = true;
    try {
      await this.files.stat(dest);
    } catch {
      exists = false;
    }
    if (!exists) {
      return true;
    }
    if (!(await this.confirmOverwrite(name))) {
      return false;
    }
    await this.files.delete(dest, { recursive: true });
    return true;
  }

  /**
   * Copy across providers. vscode.workspace.fs.copy cannot cross filesystem
   * providers, so this walks the tree by hand.
   */
  private async copyInto(source: vscode.Uri, dest: vscode.Uri): Promise<void> {
    const stat = await this.files.stat(source);
    if (stat.type === vscode.FileType.Directory) {
      await this.files.createDirectory(dest);
      for (const [name] of await this.files.readDirectory(source)) {
        await this.copyInto(
          source.with({ path: posix.join(source.path, name) }),
          dest.with({ path: posix.join(dest.path, name) })
        );
      }
      return;
    }
    await this.files.writeFile(dest, await this.files.readFile(source));
  }
}

/** Same scheme, authority (any case) and path: the query plays no part. */
function sameEntry(a: vscode.Uri, b: vscode.Uri): boolean {
  return (
    a.scheme === b.scheme &&
    a.authority.toLowerCase() === b.authority.toLowerCase() &&
    normalizePath(a.path) === normalizePath(b.path)
  );
}

/** Split a text/uri-list payload. CRLF per spec, but tolerate bare LF. */
export function parseUriList(raw: string): vscode.Uri[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => vscode.Uri.parse(line));
}

async function defaultConfirmOverwrite(name: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `${name} already exists. Overwrite?`,
    { modal: true },
    'Overwrite'
  );
  return answer === 'Overwrite';
}

/** The tree's file operations, through vscode.workspace.fs. */
export class WorkspaceFileOps implements FileOps {
  stat(uri: vscode.Uri) {
    return Promise.resolve(vscode.workspace.fs.stat(uri));
  }
  readDirectory(uri: vscode.Uri) {
    return Promise.resolve(vscode.workspace.fs.readDirectory(uri));
  }
  readFile(uri: vscode.Uri) {
    return Promise.resolve(vscode.workspace.fs.readFile(uri));
  }
  writeFile(uri: vscode.Uri, content: Uint8Array) {
    return Promise.resolve(vscode.workspace.fs.writeFile(uri, content));
  }
  createDirectory(uri: vscode.Uri) {
    return Promise.resolve(vscode.workspace.fs.createDirectory(uri));
  }
  delete(uri: vscode.Uri, options: { recursive: boolean }) {
    return Promise.resolve(vscode.workspace.fs.delete(uri, options));
  }
  rename(
    source: vscode.Uri,
    target: vscode.Uri,
    options: { overwrite: boolean }
  ) {
    return Promise.resolve(vscode.workspace.fs.rename(source, target, options));
  }
}
