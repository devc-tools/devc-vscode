import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { execDocker } from './docker';

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
  /** Stopped (or created, never started) ones, likewise. */
  listStopped?(): Promise<ContainerInfo[]>;
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
      kind: 'directory' | 'file';
      containerId: string;
      uri: vscode.Uri;
    };

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

  /** Container roots, cached so getParent can terminate without a docker call. */
  private readonly roots = new Map<string, ContainerNode>();
  /** Containers with a terminal open on them in this window. */
  private attached = new Set<string>();

  constructor(
    private readonly source: ContainerSource,
    private readonly files: FileOps,
    private readonly confirmOverwrite: ConfirmOverwrite = defaultConfirmOverwrite
  ) {}

  refresh(node?: ContainerNode): void {
    if (!node) {
      this.roots.clear();
    }
    this._onDidChangeTreeData.fire(node);
  }

  /**
   * Record which containers have a terminal open on them, refreshing the
   * roots whose state changed.
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
    if (element.kind === 'file') {
      return [];
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await this.files.readDirectory(element.uri);
    } catch {
      // Container stopped mid-expand, or the path went away. An empty node is
      // better than an error toast on every refresh.
      return [];
    }
    return sortEntries(entries).map(([name, type]) => ({
      kind: type === vscode.FileType.Directory ? 'directory' : 'file',
      containerId: element.containerId,
      uri: containerUri(
        element.containerId,
        posix.join(element.uri.path, name)
      ),
    }));
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
   * Walks one path segment up, terminating at the container's '/' root.
   */
  async getParent(node: ContainerNode): Promise<ContainerNode | undefined> {
    if (node.kind === 'container') {
      return undefined;
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
    let type = vscode.FileType.Directory;
    try {
      type = (await this.files.stat(containerUri(containerId, path))).type;
    } catch {
      // Fall through as a directory; reveal fails cleanly if it isn't there.
    }
    return {
      kind: type === vscode.FileType.Directory ? 'directory' : 'file',
      containerId,
      uri: containerUri(containerId, path),
    };
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
    return nodes;
  }

  private async ensureRoot(
    containerId: string
  ): Promise<ContainerNode | undefined> {
    const cached = this.roots.get(containerId);
    if (cached) {
      return cached;
    }
    await this.listRoots();
    return this.roots.get(containerId);
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
    if (!target) {
      return undefined;
    }
    if (target.kind === 'file') {
      return containerUri(
        target.containerId,
        normalizePath(posix.dirname(target.uri.path))
      );
    }
    return target.uri;
  }

  async handleDrop(
    target: ContainerNode | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const destDir = this.dropDirectory(target);
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
      if (
        source.scheme === SCHEME &&
        isPathWithin(source.path, destDir.path) &&
        source.authority === destDir.authority
      ) {
        // Refuse to move a directory into itself or its own subtree.
        continue;
      }
      if (!(await this.clearDestination(dest, name))) {
        continue;
      }
      if (source.scheme === SCHEME && source.authority === destDir.authority) {
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
 * Every running dev container that records a project folder, in one call, or
 * with `stopped` every stopped one. Tab-delimited because host paths can
 * contain spaces.
 */
async function listLabelledDevContainers(
  docker: string,
  stopped = false
): Promise<LabelledContainer[]> {
  const res = await execDocker(
    [
      'ps',
      // Repeated status filters match either.
      ...(stopped
        ? ['-a', '--filter', 'status=exited', '--filter', 'status=created']
        : []),
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

  listRunning(): Promise<ContainerInfo[]> {
    return this.list(false);
  }

  listStopped(): Promise<ContainerInfo[]> {
    return this.list(true);
  }

  private async list(stopped: boolean): Promise<ContainerInfo[]> {
    const hostFolders = this.hostFolders();
    if (hostFolders.length === 0) {
      // Nothing to scope to, so nothing is in scope.
      return [];
    }

    const found = new Map<string, ContainerInfo>();
    for (const container of await listLabelledDevContainers(
      this.dockerCommand(),
      stopped
    )) {
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
