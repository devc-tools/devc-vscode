import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { execDocker } from './docker';
import { SSH_SCHEME, SshHostInfo, sshUri } from './sshFs';
import type { SyncTarget } from './workspaceSync';

export const SCHEME = 'devc-vscode';

export interface ContainerInfo {
  id: string;
  /** Display label: the basename of the host folder this container serves. */
  name: string;
  /** Docker's own name for the container. */
  containerName: string;
  /** The devcontainer.local_folder label: the project folder on the host. */
  localFolder: string;
}

/**
 * Where the tree gets its roots. Injected so the provider can be exercised
 * without a Docker socket — see DockerContainerSource for the real thing.
 */
export interface ContainerSource {
  /** Running dev containers that serve the current workspace, in display order. */
  listRunning(): Promise<ContainerInfo[]>;
}

/**
 * The file operations the tree performs. A thin seam over vscode.workspace.fs
 * so drops, renames and deletes are testable against an in-memory fake.
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

/**
 * Where the tree gets its SSH roots. Injected so the provider can be
 * exercised without ssh.
 */
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
 * Which SSH folders are worktrees of a local repo, by remote path. Injected
 * so the tree can be exercised without git or ssh.
 */
export interface SyncTargetSource {
  targets(host: string): Promise<Map<string, SyncTarget>>;
}

export type ContainerNode =
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
      containerId?: undefined;
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
      containerId?: undefined;
      host: string;
      message: string;
      uri: vscode.Uri;
    }
  | {
      kind: 'directory' | 'file';
      /** The URI's authority: a container id, or an SSH host. */
      containerId: string;
      uri: vscode.Uri;
      /** For an SSH directory: the local repo it syncs with. */
      sync?: SyncTarget;
    };

/** The key SSH roots use in `roots` and in the attached set. */
export function sshRootKey(host: string): string {
  return `ssh:${host}`;
}

/** Asked before a drop overwrites an existing entry. Injected for testability. */
export type ConfirmOverwrite = (name: string) => Promise<boolean>;

export function containerUri(containerId: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    authority: containerId,
    path: path === '' ? '/' : path,
  });
}

/** Drop a trailing slash so '/a/' and '/a' compare equal. '/' stays '/'. */
function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '') || '/';
  }
  return path === '' ? '/' : path;
}

/** Whether `target` is `base` or sits underneath it. */
export function isPathWithin(base: string, target: string): boolean {
  const b = normalizePath(base);
  const t = normalizePath(target);
  if (b === '/') {
    return true;
  }
  return t === b || t.startsWith(`${b}/`);
}

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

export class ContainerTreeDataProvider
  implements
    vscode.TreeDataProvider<ContainerNode>,
    vscode.TreeDragAndDropController<ContainerNode>
{
  // The view id, lowercased. VS Code lowercases the id when it builds this
  // mime type, so the two must match exactly or internal drags are dropped
  // with no error.
  readonly dropMimeTypes = [
    'text/uri-list',
    'application/vnd.code.tree.devc-vscode.containers',
  ];
  readonly dragMimeTypes = ['text/uri-list'];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ContainerNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Roots, cached so getParent can terminate without a docker call: by
   * container id, and by sshRootKey for SSH hosts.
   */
  private readonly roots = new Map<string, ContainerNode>();
  /** SSH hosts' effective roots, once resolved. */
  private readonly sshRoots = new Map<string, string>();
  /**
   * Roots with a terminal open on them in this window: container ids and
   * sshRootKeys.
   */
  private attached = new Set<string>();

  constructor(
    private readonly source: ContainerSource,
    private readonly files: FileOps,
    private readonly confirmOverwrite: ConfirmOverwrite = defaultConfirmOverwrite,
    private readonly ssh?: SshHostSource,
    private readonly syncTargets?: SyncTargetSource
  ) {}

  refresh(node?: ContainerNode): void {
    if (!node) {
      this.roots.clear();
    }
    this._onDidChangeTreeData.fire(node);
  }

  /** Re-read an SSH host's root, e.g. once it is reachable again. */
  refreshSshRoot(host: string): void {
    const root = this.roots.get(sshRootKey(host));
    if (root) {
      this._onDidChangeTreeData.fire(root);
    }
  }

  /**
   * Record which roots (container ids, sshRootKeys) have a terminal open on
   * them, refreshing the roots whose state changed.
   */
  setAttached(containerIds: Iterable<string>): void {
    const next = new Set(containerIds);
    const changed = [...next, ...this.attached].filter(
      id => next.has(id) !== this.attached.has(id)
    );
    this.attached = next;
    for (const id of changed) {
      const root = this.roots.get(id);
      if (root) {
        this._onDidChangeTreeData.fire(root);
      }
    }
  }

  // --- tree data

  async getChildren(element?: ContainerNode): Promise<ContainerNode[]> {
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
    const targets = await this.targetsFor(dir);
    return sortEntries(entries).map(([name, type]) => {
      const uri = dir.with({ path: posix.join(dir.path, name) });
      return type === vscode.FileType.Directory
        ? {
            kind: 'directory',
            containerId: dir.authority,
            uri,
            sync: targets?.get(normalizePath(uri.path)),
          }
        : { kind: 'file', containerId: dir.authority, uri };
    });
  }

  /** An SSH URI's host's sync targets; undefined when none can be known. */
  private async targetsFor(
    uri: vscode.Uri
  ): Promise<Map<string, SyncTarget> | undefined> {
    if (uri.scheme !== SSH_SCHEME || !this.syncTargets) {
      return undefined;
    }
    try {
      return await this.syncTargets.targets(uri.authority);
    } catch {
      // Unmarked beats unlisted.
      return undefined;
    }
  }

  /**
   * The directory a root or directory node stands for. An SSH root's is its
   * effective root, resolved (and remembered) on first use.
   */
  async baseUri(node: ContainerNode): Promise<vscode.Uri> {
    if (node.kind !== 'sshHost') {
      return node.uri;
    }
    if (node.root === undefined) {
      const root = await this.ssh!.root(node.host);
      this.sshRoots.set(node.host, root);
      node.root = root;
      node.uri = sshUri(node.host, root);
      // The description shows the root now it is known.
      this._onDidChangeTreeData.fire(node);
    }
    return node.uri;
  }

  getTreeItem(node: ContainerNode): vscode.TreeItem {
    if (node.kind === 'container') {
      const item = new vscode.TreeItem(
        node.name,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `container:${node.containerId}`;
      item.description =
        node.containerName && node.containerName !== node.name
          ? node.containerName
          : node.containerId.slice(0, 12);
      // No resourceUri: the file icon theme would paint a folder icon over this.
      item.iconPath = new vscode.ThemeIcon('vm-running');
      item.contextValue = this.attached.has(node.containerId)
        ? 'container.attached'
        : 'container';
      item.tooltip = node.containerName || node.name;
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
      item.contextValue = this.attached.has(sshRootKey(node.host))
        ? 'sshHost.attached'
        : 'sshHost';
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
    if (node.kind === 'directory' && node.sync) {
      const { sync } = node;
      const host = node.uri.authority;
      const remoteBranch = sync.remoteBranch ?? 'detached';
      item.contextValue = `directory.${sync.kind}`;
      if (sync.kind === 'sync') {
        item.description = remoteBranch;
        item.tooltip = `Worktree of ${sync.localPath} — ${host} has ${remoteBranch}, local has ${sync.localBranch ?? 'detached'}`;
      } else {
        item.description = `${remoteBranch} (not local)`;
        item.tooltip = `Worktree on ${host} only — Fetch brings it into ${sync.mainWorktree}`;
      }
    }
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
   * Walks one path segment up, terminating at the container's '/' root.
   */
  async getParent(node: ContainerNode): Promise<ContainerNode | undefined> {
    if (node.kind === 'container' || node.kind === 'sshHost') {
      return undefined;
    }
    if (node.kind === 'sshError') {
      return this.ensureRoot(sshRootKey(node.host));
    }
    if (node.uri.scheme === SSH_SCHEME) {
      // Terminates at the host's root: anything at or above it has the root
      // node as its parent.
      const key = sshRootKey(node.uri.authority);
      const root = await this.ensureRoot(key);
      const base = root?.kind === 'sshHost' ? root.root : undefined;
      const parent = normalizePath(posix.dirname(normalizePath(node.uri.path)));
      if (
        base === undefined ||
        !isPathWithin(base, parent) ||
        normalizePath(base) === parent
      ) {
        return root;
      }
      return {
        kind: 'directory',
        containerId: node.containerId,
        uri: node.uri.with({ path: parent }),
      };
    }
    const current = normalizePath(node.uri.path);
    if (current === '/') {
      return this.ensureRoot(node.containerId);
    }
    const parent = normalizePath(posix.dirname(current));
    if (parent === '/') {
      return this.ensureRoot(node.containerId);
    }
    return {
      kind: 'directory',
      containerId: node.containerId,
      uri: containerUri(node.containerId, parent),
    };
  }

  // --- reveal support

  /**
   * Build a node for an arbitrary container path. The getParent chain
   * terminates at the container's root, which listRoots supplies on demand.
   */
  async nodeFor(containerId: string, path: string): Promise<ContainerNode> {
    return this.nodeForUri(containerUri(containerId, path));
  }

  /** nodeFor, for a container or SSH URI. */
  async nodeForUri(uri: vscode.Uri): Promise<ContainerNode> {
    let type = vscode.FileType.Directory;
    try {
      type = (await this.files.stat(uri)).type;
    } catch {
      // Fall through as a directory; reveal fails cleanly if it isn't there.
    }
    if (type !== vscode.FileType.Directory) {
      return { kind: 'file', containerId: uri.authority, uri };
    }
    return {
      kind: 'directory',
      containerId: uri.authority,
      uri,
      sync: (await this.targetsFor(uri))?.get(normalizePath(uri.path)),
    };
  }

  /**
   * An SSH host's effective root, resolving it on its tree root when needed;
   * undefined when the host is not a root or cannot be reached.
   */
  async resolveSshRoot(host: string): Promise<string | undefined> {
    const root = await this.ensureRoot(sshRootKey(host));
    if (root?.kind !== 'sshHost') {
      return undefined;
    }
    try {
      return (await this.baseUri(root)).path;
    } catch {
      return undefined;
    }
  }

  private async listRoots(): Promise<ContainerNode[]> {
    this.roots.clear();
    const nodes: ContainerNode[] = [];
    for (const c of await this.source.listRunning()) {
      const node: ContainerNode = {
        kind: 'container',
        containerId: c.id,
        name: c.name || c.containerName || c.id.slice(0, 12),
        containerName: c.containerName,
        localFolder: c.localFolder,
        // One root per container, at its filesystem root.
        uri: containerUri(c.id, '/'),
      };
      this.roots.set(c.id, node);
      nodes.push(node);
    }
    for (const info of this.ssh?.list() ?? []) {
      const root = info.root ?? this.sshRoots.get(info.host);
      const node: ContainerNode = {
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

  private async ensureRoot(key: string): Promise<ContainerNode | undefined> {
    const cached = this.roots.get(key);
    if (cached) {
      return cached;
    }
    await this.listRoots();
    return this.roots.get(key);
  }

  // --- drag and drop

  handleDrag(
    source: readonly ContainerNode[],
    dataTransfer: vscode.DataTransfer
  ): void {
    dataTransfer.set(
      'text/uri-list',
      // text/uri-list is CRLF-delimited per RFC 2483.
      new vscode.DataTransferItem(
        source.map(n => n.uri.toString()).join('\r\n')
      )
    );
  }

  /** The directory a drop on `target` lands in. */
  dropDirectory(target: ContainerNode | undefined): vscode.Uri | undefined {
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
    target: ContainerNode | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const destDir =
      target?.kind === 'sshHost'
        ? await this.baseUri(target)
        : this.dropDirectory(target);
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
      if (source.toString() === dest.toString()) {
        continue;
      }
      const sameRoot =
        (source.scheme === SCHEME || source.scheme === SSH_SCHEME) &&
        source.scheme === destDir.scheme &&
        source.authority === destDir.authority;
      if (sameRoot && isPathWithin(source.path, destDir.path)) {
        // Refuse to move a directory into itself or its own subtree.
        continue;
      }
      if (!(await this.clearDestination(dest, name))) {
        continue;
      }
      if (sameRoot) {
        await this.files.rename(source, dest, { overwrite: true });
      } else {
        await this.copyInto(source, dest);
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

// ── Production implementations ──────────────────────────────────────────────

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

export interface BindMountMatch {
  containerName: string;
  destPath: string;
}

/**
 * Inspect a container and return its name plus the matching dest path if any
 * bind mount source matches `hostFolder`, undefined otherwise.
 */
export async function findMatchingBindMount(
  containerId: string,
  hostFolder: string,
  dockerCommand: string
): Promise<BindMountMatch | undefined> {
  const inspectRes = await execDocker(
    [
      'inspect',
      '--format',
      '{{.Name}}{{"\t"}}{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\t"}}{{end}}{{end}}',
      containerId,
    ],
    undefined,
    dockerCommand
  );
  if (inspectRes.exitCode !== 0) {
    return undefined;
  }

  for (const line of inspectRes.stdout.toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('/')) {
      continue;
    }
    const parts = trimmed.split('\t');
    const containerName = parts[0].replace(/^\//, '');
    for (let i = 1; i + 1 < parts.length; i += 2) {
      if (parts[i] === hostFolder) {
        return { containerName, destPath: parts[i + 1] || '/' };
      }
    }
  }
  return undefined;
}

/** A bind mount of a running container. */
export interface ContainerBindMount {
  containerId: string;
  /** Docker's own name for the container, without the leading `/`. */
  containerName: string;
  /** The devcontainer.local_folder label, or '' for an unlabelled container. */
  localFolder: string;
  source: string;
  destination: string;
}

/**
 * Every bind mount of every running container, in two docker calls.
 * Tab-delimited because host paths can contain spaces.
 */
export async function listBindMounts(
  dockerCommand: string
): Promise<ContainerBindMount[]> {
  const idsRes = await execDocker(['ps', '-q'], undefined, dockerCommand);
  if (idsRes.exitCode !== 0) {
    return [];
  }
  const ids = idsRes.stdout
    .toString('utf8')
    .split('\n')
    .map(id => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return [];
  }
  const inspectRes = await execDocker(
    [
      'inspect',
      '--format',
      '{{.ID}}{{"\t"}}{{.Name}}{{"\t"}}{{index .Config.Labels "devcontainer.local_folder"}}{{range .Mounts}}{{if eq .Type "bind"}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{end}}{{end}}',
      ...ids,
    ],
    undefined,
    dockerCommand
  );
  if (inspectRes.exitCode !== 0) {
    return [];
  }
  return parseBindMounts(inspectRes.stdout.toString('utf8'));
}

/** listBindMounts's `docker inspect` output, one container per line. */
export function parseBindMounts(output: string): ContainerBindMount[] {
  const mounts: ContainerBindMount[] = [];
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 5 || !parts[0]) {
      continue;
    }
    // The short id `docker ps` prints, which the Sandboxes tree uses too.
    const containerId = parts[0].slice(0, 12);
    for (let i = 3; i + 1 < parts.length; i += 2) {
      mounts.push({
        containerId,
        containerName: parts[1].replace(/^\//, ''),
        localFolder: parts[2],
        source: parts[i],
        destination: parts[i + 1] || '/',
      });
    }
  }
  return mounts;
}

/**
 * Map a host path to the container path it is mounted at. The most specific
 * mount source wins; between equally specific ones, a container whose project
 * folder holds the path is preferred over one that merely mounts it.
 */
export function mapHostPath(
  hostPath: string,
  mounts: ContainerBindMount[]
): { containerId: string; path: string } | undefined {
  const rank = (m: ContainerBindMount): number =>
    normalizePath(m.source).length * 2 +
    (m.localFolder && isPathWithin(m.localFolder, hostPath) ? 1 : 0);
  const best = mounts
    .filter(m => isPathWithin(m.source, hostPath))
    .sort((a, b) => rank(b) - rank(a))[0];
  if (!best) {
    return undefined;
  }
  const rel = posix.relative(
    normalizePath(best.source),
    normalizePath(hostPath)
  );
  return {
    containerId: best.containerId,
    path: rel ? posix.join(best.destination, rel) : best.destination,
  };
}

/**
 * Find a running container for a host folder: first by the devcontainer CLI's
 * local_folder label, then by scanning bind mounts.
 */
export async function findContainerForHostFolder(
  hostFolder: string,
  dockerCommand: string
): Promise<string | undefined> {
  const labelled = await execDocker(
    ['ps', '-q', '--filter', `label=devcontainer.local_folder=${hostFolder}`],
    undefined,
    dockerCommand
  );
  if (labelled.exitCode === 0) {
    const id = labelled.stdout.toString('utf8').split('\n')[0]?.trim();
    if (id) {
      return id;
    }
  }

  const idsRes = await execDocker(['ps', '-q'], undefined, dockerCommand);
  if (idsRes.exitCode !== 0) {
    return undefined;
  }
  for (const line of idsRes.stdout.toString('utf8').split('\n')) {
    const id = line.trim();
    if (!id) {
      continue;
    }
    if (await findMatchingBindMount(id, hostFolder, dockerCommand)) {
      return id;
    }
  }
  return undefined;
}

/**
 * The container user's home directory, for expanding ~ in terminal links.
 * Undefined when it cannot be read, which leaves ~ paths unresolved rather
 * than guessed.
 */
export async function getContainerHome(
  containerId: string,
  dockerCommand: string
): Promise<string | undefined> {
  let res;
  try {
    res = await execDocker(
      ['exec', containerId, 'sh', '-c', 'printf %s "$HOME"'],
      undefined,
      dockerCommand
    );
  } catch {
    return undefined;
  }
  if (res.exitCode !== 0) {
    return undefined;
  }
  const home = res.stdout.toString('utf8').trim();
  return home.startsWith('/') ? home : undefined;
}

/** A running dev container and the host folder its project lives in. */
interface LabelledContainer {
  id: string;
  containerName: string;
  /** The devcontainer.local_folder label: the project folder on the host. */
  localFolder: string;
}

/**
 * Every running dev container that records a project folder, in one call.
 * Tab-delimited because host paths can contain spaces.
 */
async function listLabelledDevContainers(
  docker: string
): Promise<LabelledContainer[]> {
  const res = await execDocker(
    [
      'ps',
      '--filter',
      'label=devcontainer.local_folder',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Label "devcontainer.local_folder"}}',
    ],
    undefined,
    docker
  );
  if (res.exitCode !== 0) {
    return [];
  }
  return res.stdout
    .toString('utf8')
    .split('\n')
    .map(line => line.split('\t').map(field => field.trim()))
    .filter(fields => fields.length >= 3 && fields[0] && fields[2])
    .map(([id, containerName, localFolder]) => ({
      id,
      containerName,
      localFolder,
    }));
}

/**
 * The tree label for a container's root: the workspace folder's basename, plus
 * the path down to the project when the container serves a subfolder rather
 * than the workspace folder itself.
 */
export function rootLabel(hostFolder: string, localFolder: string): string {
  const base = posix.basename(hostFolder) || hostFolder;
  if (normalizePath(hostFolder) === normalizePath(localFolder)) {
    return base;
  }
  return posix.join(base, posix.relative(hostFolder, localFolder));
}

/**
 * Resolves the containers serving the current workspace over the Docker CLI.
 *
 * A container is in scope when its project folder — the devcontainer.local_folder
 * label — is an open workspace folder or sits under one. That covers a container
 * started for a subfolder, and excludes every unrelated dev container on the
 * machine. Containers that carry no such label are not dev containers this
 * workspace owns, so they are left out rather than guessed at from their mounts.
 */
export class DockerContainerSource implements ContainerSource {
  constructor(
    private readonly dockerCommand: () => string,
    private readonly hostFolders: () => string[]
  ) {}

  async listRunning(): Promise<ContainerInfo[]> {
    const hostFolders = this.hostFolders();
    if (hostFolders.length === 0) {
      // Nothing to scope to, so nothing is in scope.
      return [];
    }

    let labelled: LabelledContainer[];
    try {
      labelled = await listLabelledDevContainers(this.dockerCommand());
    } catch {
      // Docker cannot be run at all: no containers, and SSH roots still list.
      return [];
    }
    const found = new Map<string, ContainerInfo>();
    for (const container of labelled) {
      // The most specific workspace folder wins, so a nested folder labels its
      // containers relative to itself rather than to its parent.
      const owner = hostFolders
        .filter(folder => isPathWithin(folder, container.localFolder))
        .sort((a, b) => b.length - a.length)[0];
      if (owner === undefined || found.has(container.id)) {
        continue;
      }
      found.set(container.id, {
        id: container.id,
        name: rootLabel(owner, container.localFolder),
        containerName: container.containerName,
        localFolder: container.localFolder,
      });
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
