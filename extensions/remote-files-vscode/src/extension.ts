import * as cp from 'child_process';
import * as posix from 'path/posix';
import * as vscode from 'vscode';
import {
  ContainerInfo,
  ContainerScope,
  getRemoteUser,
  listDevContainers,
} from './containers';
import {
  ChangePoller,
  ContainerFileSystemProvider,
  PolledProvider,
  SshFileSystemProvider,
} from './remoteFs';
import {
  DockerShell,
  RemoteShell,
  RunOptions,
  ShellResult,
  SshShell,
  ensureControlDir,
} from './remoteShell';
import { reloadEditor } from './reload';
import { sshConfigAliases } from './sshConfig';
import { SshHostInfo, findSshHost, parseSshHosts } from './sshHosts';
import {
  containerTerminalArgs,
  sshTerminalArgs,
  terminalName,
} from './terminals';
import {
  CONTAINER_SCHEME,
  RemoteNode,
  RemoteTreeDataProvider,
  SSH_SCHEME,
  VIEW_ID,
  WorkspaceFileOps,
  isRemoteScheme,
} from './tree';

const CONFIG = 'remoteFiles';
const SHOW_ALL_FILES_KEY = 'showAllFiles';
const SHOW_ALL_FILES_CONTEXT = 'remoteFiles.showAllFiles';
/** Docker events arrive in bursts (stop, die, destroy): one refresh per burst. */
const DOCKER_EVENT_DEBOUNCE_MS = 500;

let treeProvider: RemoteTreeDataProvider;
let treeView: vscode.TreeView<RemoteNode>;
let containerFs: ContainerFileSystemProvider;
let sshFs: SshFileSystemProvider;
let containers: Containers;
let workspaceState: vscode.Memento;
let dockerEvents: cp.ChildProcess | undefined;
let dockerEventTimer: NodeJS.Timeout | undefined;
let disposed = false;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  disposed = false;
  workspaceState = context.workspaceState;
  containers = new Containers();

  containerFs = new ContainerFileSystemProvider(
    id => containerShell(id),
    () => containers.settled
  );
  sshFs = new SshFileSystemProvider(host =>
    findSshHost(getSshHosts(), host) ? sshShell(host) : undefined
  );

  treeProvider = new RemoteTreeDataProvider(
    { listRunning: () => containers.list() },
    { list: getSshHosts, root: sshRoot },
    new WorkspaceFileOps()
  );
  treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(CONTAINER_SCHEME, containerFs, {
      isCaseSensitive: true,
    }),
    vscode.workspace.registerFileSystemProvider(SSH_SCHEME, sshFs, {
      isCaseSensitive: true,
    }),
    new ChangePoller(
      new Map<string, PolledProvider>([
        [CONTAINER_SCHEME, containerFs],
        [SSH_SCHEME, sshFs],
      ])
    ),
    treeView,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      guardWorkspaceFolders();
      refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${CONFIG}.dockerPath`)) {
        stopDockerEvents();
        startDockerEvents();
      }
      if (
        e.affectsConfiguration(`${CONFIG}.sshHosts`) ||
        e.affectsConfiguration(`${CONFIG}.sshPath`) ||
        e.affectsConfiguration(`${CONFIG}.containers`) ||
        e.affectsConfiguration(`${CONFIG}.dockerPath`)
      ) {
        refreshAll();
      }
    })
  );

  setShowAllFiles(workspaceState.get(SHOW_ALL_FILES_KEY, false));

  const register = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('remoteFiles.refresh', () => refreshAll());
  register('remoteFiles.showAllFiles', () => setShowAllFiles(true));
  register('remoteFiles.showWorkspacesOnly', () => setShowAllFiles(false));
  register('remoteFiles.addSshHost', () => addSshHost());
  register('remoteFiles.terminalHere', (node?: RemoteNode) =>
    terminalHere(node)
  );
  register('remoteFiles.newFile', (node?: RemoteNode) =>
    createEntry(node, 'file')
  );
  register('remoteFiles.newFolder', (node?: RemoteNode) =>
    createEntry(node, 'folder')
  );
  register('remoteFiles.rename', (node?: RemoteNode) => renameEntry(node));
  register('remoteFiles.delete', (node?: RemoteNode) => deleteEntries(node));
  register('remoteFiles.copyPath', (node?: RemoteNode) => copyPath(node));
  register('remoteFiles.reloadEditor', (uri?: vscode.Uri) =>
    reloadRemoteEditor(uri)
  );

  guardWorkspaceFolders();
  containers.refresh();
  startDockerEvents();
}

export function deactivate(): void {
  disposed = true;
  stopDockerEvents();
}

/** Re-discover containers and re-read every root and SSH home. */
function refreshAll(): void {
  sshHomes.clear();
  containers.refresh();
  treeProvider.refresh();
}

// ── Settings ────────────────────────────────────────────────────────────────

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG);
}

/** A string setting, trimmed; blank means `fallback`. */
function stringSetting(key: string, fallback: string): string {
  const value = config().get<string>(key);
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function getDockerCommand(): string {
  return stringSetting('dockerPath', 'docker');
}

function getSshPath(): string {
  return stringSetting('sshPath', 'ssh');
}

function getScope(): ContainerScope {
  return config().get<string>('containers') === 'all' ? 'all' : 'workspace';
}

/** Invalid remoteFiles.sshHosts entries already reported this session. */
const reportedSshEntries = new Set<string>();

/** The configured SSH hosts, in settings order. */
function getSshHosts(): SshHostInfo[] {
  const { hosts, invalid } = parseSshHosts(config().get('sshHosts'));
  for (const host of invalid) {
    if (!reportedSshEntries.has(host)) {
      reportedSshEntries.add(host);
      vscode.window.showWarningMessage(
        `remoteFiles.sshHosts: ignoring invalid entry "${host}"`
      );
    }
  }
  return hosts;
}

/** The fsPath of every file:// workspace folder. */
function getHostFolders(): string[] {
  return (
    vscode.workspace.workspaceFolders
      ?.filter(f => f.uri.scheme === 'file')
      .map(f => f.uri.fsPath) ?? []
  );
}

// ── Containers ──────────────────────────────────────────────────────────────

/**
 * The running dev containers that are roots, from the latest discovery. The
 * container provider accepts only these, so discovery runs on activation
 * (an editor restored after a reload reads its file before the tree is
 * shown) and on every Docker event, not only when the tree lists.
 */
class Containers {
  private latest: Promise<ContainerInfo[]> = Promise.resolve([]);
  private current = new Map<string, ContainerInfo>();
  private generation = 0;
  /** Settles once the first discovery has. */
  settled: Promise<unknown> = Promise.resolve();

  refresh(): void {
    const generation = ++this.generation;
    remoteUsers.clear();
    this.latest = listDevContainers(
      getDockerCommand(),
      getScope(),
      getHostFolders()
    ).then(found => {
      if (generation === this.generation) {
        this.current = new Map(found.map(c => [c.id, c]));
      }
      return found;
    });
    if (generation === 1) {
      this.settled = this.latest;
    }
  }

  list(): Promise<ContainerInfo[]> {
    return this.latest;
  }

  get(id: string): ContainerInfo | undefined {
    return this.current.get(id);
  }
}

/** Each container's remote user, looked up on first use. */
const remoteUsers = new Map<string, Promise<string | undefined>>();

function remoteUser(id: string): Promise<string | undefined> {
  let user = remoteUsers.get(id);
  if (!user) {
    user = getRemoteUser(id, getDockerCommand());
    remoteUsers.set(id, user);
  }
  return user;
}

/** `docker exec` as the container's remote user, looked up before the first command. */
class ContainerShell implements RemoteShell {
  constructor(private readonly id: string) {}

  async run(argv: string[], options?: RunOptions): Promise<ShellResult> {
    const shell = new DockerShell(
      this.id,
      await remoteUser(this.id),
      getDockerCommand()
    );
    return shell.run(argv, options);
  }

  spawn(): cp.ChildProcess {
    throw new Error('Not supported for container files');
  }
}

/** The shell of a container that is currently a root. */
function containerShell(id: string): RemoteShell | undefined {
  return containers.get(id) ? new ContainerShell(id) : undefined;
}

// ── SSH ─────────────────────────────────────────────────────────────────────

let controlDir: string | undefined | null = null;

/** Where ssh multiplexing sockets go; undefined runs without multiplexing. */
function getControlDir(): string | undefined {
  if (controlDir === null) {
    controlDir = ensureControlDir();
    if (controlDir === undefined) {
      console.warn(
        'remote-files-vscode: ssh control directory is missing or not private to this user; ssh runs without connection sharing'
      );
    }
  }
  return controlDir;
}

/** A shell on a configured SSH host; it refuses any other host. */
function sshShell(host: string): SshShell {
  return new SshShell(findSshHost(getSshHosts(), host)?.host ?? host, {
    sshPath: getSshPath(),
    controlDir: getControlDir(),
    allowed: h => findSshHost(getSshHosts(), h) !== undefined,
  });
}

/** Each host's remote home, read on first use. */
const sshHomes = new Map<string, Promise<string>>();

function sshHome(host: string): Promise<string> {
  const key = host.toLowerCase();
  let home = sshHomes.get(key);
  if (!home) {
    home = (async () => {
      const res = await sshShell(host).run(['sh', '-c', 'printf %s "$HOME"']);
      const out = res.stdout.toString('utf8').trim();
      if (res.exitCode !== 0 || !out.startsWith('/')) {
        const err = res.stderr.toString('utf8').trim();
        throw new Error(err || `${host}: could not read the remote home`);
      }
      return out;
    })();
    sshHomes.set(key, home);
    // A failure is not remembered: the next expand tries again.
    home.catch(() => sshHomes.delete(key));
  }
  return home;
}

/** A host's effective root: its configured root, else the remote home. */
async function sshRoot(host: string): Promise<string> {
  const info = findSshHost(getSshHosts(), host);
  if (!info) {
    throw new Error(`"${host}" is not a configured SSH host (remoteFiles.sshHosts)`);
  }
  return info.root ?? sshHome(info.host);
}

/**
 * Pick an alias from ~/.ssh/config that is not configured yet and add it to
 * the user-level remoteFiles.sshHosts.
 */
async function addSshHost(): Promise<void> {
  const configured = new Set(getSshHosts().map(h => h.host.toLowerCase()));
  const aliases = sshConfigAliases().filter(
    alias => !configured.has(alias.toLowerCase())
  );
  if (!aliases.length) {
    vscode.window.showInformationMessage(
      'No other hosts found in ~/.ssh/config.'
    );
    return;
  }
  const host = await vscode.window.showQuickPick(aliases, {
    placeHolder: 'SSH host to add',
  });
  if (!host) {
    return;
  }
  const root = await vscode.window.showInputBox({
    prompt: 'Remote directory to start in (blank for the remote home)',
    validateInput: value =>
      value.trim() === '' || value.trim().startsWith('/')
        ? undefined
        : 'Enter an absolute path, or leave it blank',
  });
  if (root === undefined) {
    return;
  }
  // Not get(): that would fold in the default.
  const current = config().inspect<unknown[]>('sshHosts')?.globalValue ?? [];
  await config().update(
    'sshHosts',
    [...current, root.trim() ? { host, root: root.trim() } : { host }],
    vscode.ConfigurationTarget.Global
  );
}

// ── Tree commands ───────────────────────────────────────────────────────────

/**
 * The node a command acts on: the one the menu passed, else the current
 * selection when invoked from the command palette.
 */
function targetNode(node?: RemoteNode): RemoteNode | undefined {
  const resolved = node ?? treeView.selection[0];
  if (!resolved) {
    vscode.window.showErrorMessage(
      'Select a file or folder in Remote Files first.'
    );
  }
  return resolved;
}

/** A tree node that is a file or directory, not a root or an error. */
function isEntry(node: RemoteNode): boolean {
  return node.kind === 'file' || node.kind === 'directory';
}

/** The directory a node stands for; a file's is its parent. */
async function directoryOf(node: RemoteNode): Promise<vscode.Uri> {
  if (node.kind === 'file') {
    return node.uri.with({ path: posix.dirname(node.uri.path) });
  }
  return treeProvider.baseUri(node);
}

export function validateName(value: string): string | undefined {
  if (!value.trim()) {
    return 'Name cannot be empty';
  }
  if (value.includes('/')) {
    return 'Name cannot contain "/"';
  }
  if (value === '.' || value === '..') {
    return 'Invalid name';
  }
  return undefined;
}

async function createEntry(
  node: RemoteNode | undefined,
  kind: 'file' | 'folder'
): Promise<void> {
  const target = targetNode(node);
  if (!target || target.kind === 'sshError') {
    return;
  }
  let parent: vscode.Uri;
  try {
    parent = await directoryOf(target);
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: `New ${kind} in ${parent.path}`,
    validateInput: validateName,
  });
  if (!name) {
    return;
  }
  const uri = parent.with({ path: posix.join(parent.path, name) });
  try {
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(uri);
    } else {
      await vscode.workspace.fs.writeFile(uri, new Uint8Array(0));
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not create ${name}: ${(err as Error).message}`
    );
    return;
  }
  // The new entry lands inside `target` unless `target` is itself a file, in
  // which case it lands beside it — refresh whichever directory holds it.
  treeProvider.refresh(
    target.kind === 'file' ? await treeProvider.getParent(target) : target
  );
  if (kind === 'file') {
    await vscode.window.showTextDocument(uri);
  }
}

async function renameEntry(node?: RemoteNode): Promise<void> {
  const target = targetNode(node);
  if (!target || !isEntry(target)) {
    return;
  }
  const current = posix.basename(target.uri.path);
  const dot = current.lastIndexOf('.');
  const name = await vscode.window.showInputBox({
    prompt: 'New name',
    value: current,
    valueSelection: [0, dot > 0 ? dot : current.length],
    validateInput: validateName,
  });
  if (!name || name === current) {
    return;
  }
  const destination = target.uri.with({
    path: posix.join(posix.dirname(target.uri.path), name),
  });
  try {
    await vscode.workspace.fs.rename(target.uri, destination, {
      overwrite: false,
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not rename ${current}: ${(err as Error).message}`
    );
    return;
  }
  treeProvider.refresh(await treeProvider.getParent(target));
}

async function deleteEntries(node?: RemoteNode): Promise<void> {
  const target = targetNode(node);
  if (!target || !isEntry(target)) {
    return;
  }
  // Multi-select only applies when the invoked node is part of the selection —
  // a context menu on an unselected node acts on that node alone.
  const selection = treeView.selection.filter(isEntry);
  const nodes = selection.some(n => n.uri.toString() === target.uri.toString())
    ? selection
    : [target];

  const label =
    nodes.length === 1
      ? `'${posix.basename(nodes[0].uri.path)}'`
      : `${nodes.length} items`;
  const answer = await vscode.window.showWarningMessage(
    `Delete ${label}? This cannot be undone — there is no trash.`,
    { modal: true },
    'Delete'
  );
  if (answer !== 'Delete') {
    return;
  }

  for (const entry of nodes) {
    try {
      await vscode.workspace.fs.delete(entry.uri, { recursive: true });
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not delete ${posix.basename(entry.uri.path)}: ${(err as Error).message}`
      );
    }
  }
  const parents = new Set<RemoteNode | undefined>();
  for (const entry of nodes) {
    parents.add(await treeProvider.getParent(entry));
  }
  // getParent builds new directory nodes, so refreshing each one is safest.
  for (const parent of parents) {
    treeProvider.refresh(parent);
  }
}

async function copyPath(node?: RemoteNode): Promise<void> {
  const target = targetNode(node);
  if (!target || target.kind === 'sshError') {
    return;
  }
  try {
    const uri = await treeProvider.baseUri(target);
    await vscode.env.clipboard.writeText(uri.path);
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
  }
}

function setShowAllFiles(showAll: boolean): void {
  treeProvider.setShowAllFiles(showAll);
  void workspaceState.update(SHOW_ALL_FILES_KEY, showAll);
  void vscode.commands.executeCommand(
    'setContext',
    SHOW_ALL_FILES_CONTEXT,
    showAll
  );
}

// ── Reload Remote File ──────────────────────────────────────────────────────

/**
 * Re-read a remote editor's file: the tab the editor title or tab menu was
 * used on, else the active editor.
 */
async function reloadRemoteEditor(arg?: vscode.Uri): Promise<void> {
  const uri =
    arg instanceof vscode.Uri
      ? arg
      : vscode.window.activeTextEditor?.document.uri;
  if (!uri || !isRemoteScheme(uri.scheme)) {
    return;
  }
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find(
    d => d.uri.toString() === key
  );
  if (!doc) {
    return;
  }
  const name = posix.basename(uri.path);
  // The group the tab is in, so showing it doesn't open a second copy in
  // whichever group happens to be active.
  const group = vscode.window.tabGroups.all.find(g =>
    g.tabs.some(
      t =>
        t.input instanceof vscode.TabInputText &&
        t.input.uri.toString() === key
    )
  );
  try {
    await reloadEditor({
      isDirty: () => doc.isDirty,
      confirmDiscard: async () =>
        (await vscode.window.showWarningMessage(
          `Discard unsaved changes and reload ${name}?`,
          { modal: true },
          'Reload'
        )) === 'Reload',
      show: async () => {
        await vscode.window.showTextDocument(doc, {
          viewColumn: group?.viewColumn,
          preserveFocus: false,
        });
      },
      revert: async () => {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      },
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not reload ${name}: ${(err as Error).message}`
    );
  }
}

// ── Terminal Here ───────────────────────────────────────────────────────────

/** Open a login shell in the node's folder: a file's parent, a root's base. */
async function terminalHere(node?: RemoteNode): Promise<void> {
  const target = targetNode(node);
  if (!target || target.kind === 'sshError') {
    return;
  }
  let dir: vscode.Uri;
  try {
    dir = await directoryOf(target);
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }
  const root =
    target.kind === 'container' || target.kind === 'sshHost'
      ? target
      : await treeProvider.rootOf(target.uri);

  if (dir.scheme === SSH_SCHEME) {
    const info = findSshHost(getSshHosts(), dir.authority);
    if (!info) {
      vscode.window.showErrorMessage(
        `"${dir.authority}" is not a configured SSH host (remoteFiles.sshHosts)`
      );
      return;
    }
    vscode.window
      .createTerminal({
        name: terminalName(info.label, dir.path),
        shellPath: getSshPath(),
        shellArgs: sshTerminalArgs(info.host, dir.path, getControlDir()),
        iconPath: new vscode.ThemeIcon('remote'),
      })
      .show();
    return;
  }

  const container = containers.get(dir.authority);
  if (!container) {
    vscode.window.showErrorMessage(
      `${dir.authority} is not a running dev container`
    );
    return;
  }
  const label = root?.kind === 'container' ? root.name : container.name;
  vscode.window
    .createTerminal({
      name: terminalName(label, dir.path),
      shellPath: getDockerCommand(),
      shellArgs: containerTerminalArgs(
        container.id,
        await remoteUser(container.id),
        dir.path
      ),
      iconPath: new vscode.ThemeIcon('vm-running'),
    })
    .show();
}

// ── Docker events ───────────────────────────────────────────────────────────

/** Re-discover containers when one starts or stops, so roots come and go live. */
function startDockerEvents(): void {
  if (disposed) {
    return;
  }
  let child: cp.ChildProcess;
  try {
    child = cp.spawn(
      getDockerCommand(),
      [
        'events',
        '--filter',
        'type=container',
        '--filter',
        'event=start',
        '--filter',
        'event=stop',
        '--filter',
        'event=die',
        '--filter',
        'event=destroy',
        '--format',
        '{{json .}}',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    console.error('remote-files-vscode: docker events', err);
    return;
  }
  dockerEvents = child;

  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        handleDockerEvent(line);
      }
    }
  });
  child.on('error', err => {
    console.error('remote-files-vscode: docker events', err.message);
  });
  child.on('close', () => {
    if (dockerEvents === child) {
      dockerEvents = undefined;
    }
  });
}

function stopDockerEvents(): void {
  clearTimeout(dockerEventTimer);
  dockerEventTimer = undefined;
  dockerEvents?.kill();
  dockerEvents = undefined;
}

function handleDockerEvent(line: string): void {
  let event: { id?: string; Actor?: { ID?: string } };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const id = (event.id ?? event.Actor?.ID ?? '').slice(0, 12);
  if (id) {
    // A restarted container may run as a different user.
    remoteUsers.delete(id);
  }
  clearTimeout(dockerEventTimer);
  dockerEventTimer = setTimeout(() => {
    containers.refresh();
    treeProvider.refresh();
  }, DOCKER_EVENT_DEBOUNCE_MS);
}

// ── Workspace-folder guard ──────────────────────────────────────────────────

/**
 * Remove remote workspace folders someone added by hand: VS Code would read
 * their .vscode/settings.json. This is cleanup, not prevention. When a
 * remote folder is the window's only folder it cannot be removed, so both
 * providers refuse every call instead.
 */
function guardWorkspaceFolders(): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const remote = folders.filter(f => isRemoteScheme(f.uri.scheme));
  if (!remote.length) {
    return;
  }
  if (folders.length === 1) {
    if (!containerFs.disabled) {
      containerFs.disabled = true;
      sshFs.disabled = true;
      vscode.window.showErrorMessage(
        'This window has a remote folder as its workspace. Close it and browse from the Remote Files view.',
        { modal: true }
      );
    }
    return;
  }
  // One at a time, highest index first: only one folder change can be
  // pending, and the change event runs this again for the next. Removing
  // folder 0 restarts the extension host, which runs this again and finds
  // nothing.
  const last = remote.reduce((a, b) => (b.index > a.index ? b : a));
  vscode.workspace.updateWorkspaceFolders(last.index, 1);
  vscode.window.showWarningMessage(
    "Remote files can't be workspace folders — use the Remote Files view instead."
  );
}
