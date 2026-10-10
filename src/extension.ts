import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as posix from 'path/posix';
import * as vscode from 'vscode';
import {
  AgentNode,
  AgentTreeDataProvider,
  CONTAINER_ICON,
  SESSION_ICON,
  SSH_ICON,
  folderOf,
} from './agentTree';
import { AgentReviewController } from './agentReview';
import { DevContainerFileSystemProvider } from './devcontainerFs';
import {
  ContainerInfo,
  ContainerNode,
  ContainerTreeDataProvider,
  DockerContainerSource,
  SCHEME,
  WorkspaceFileOps,
  containerUri,
  findContainerForHostFolder,
  findMatchingBindMount,
  getContainerHome,
  WORKSPACES_DIR,
  isPathWithin,
  listBindMounts,
  mapHostPath,
  sshRootKey,
} from './containerTree';
import {
  AgentInfo,
  CONTAINER_SESSION,
  closeHerdrPane,
  focusHerdrAgent,
  getRemoteUser,
  runSessionCommand,
  startShellAgent,
  watchHerdr,
} from './herdr';
import {
  HostSession,
  attachCommand,
  classifyHostScreen,
  closeHostHerdrPane,
  deleteHostSession,
  focusHostHerdrAgent,
  listHostSessions,
  readHostSession,
  sessionFromClientArgs,
  sessionNameForDir,
  hostHerdrInstalled,
  hostHerdrSupported,
  startHostAgent,
  stopHostSession,
  watchHostSession,
} from './hostHerdr';
import {
  HostForegroundCache,
  hostAgentIds,
  hostTerminalForeground,
  hostTtySize,
} from './hostProcesses';
import { SNAPSHOT_VERSION, WindowRegistry } from './windowRegistry';
import {
  ReviewRequest,
  SyncDeps,
  SyncError,
  SyncTarget,
  fetchFromSshHost,
  findSyncTargets,
  gitEnv,
  makeGit,
  sendToSshHost,
} from './workspaceSync';
import {
  DockerShell,
  SshShell,
  containerTerminalCommand,
  ensureControlDir,
  sshTerminalCommand,
} from './remoteShell';
import { commandAvailable, dockerInstalled, findDevc } from './tools';
import {
  SSH_SCHEME,
  SshFileSystemProvider,
  SshHostInfo,
  parseSshHosts,
} from './sshFs';
import { sshConfigAliases } from './sshConfig';
import {
  TerminalAgentTracker,
  classifyScreen,
  probeContainer,
} from './terminalAgents';
import {
  PathContext,
  findPathCandidates,
  resolveCandidatePath,
} from './terminalLinks';

const VIEW_ID = 'devc-vscode.containers';
const AGENTS_VIEW_ID = 'devc-vscode.agents';

/** Everything a terminal needs before a path printed in it can be resolved. */
interface TerminalContext extends PathContext {
  containerId: string;
}

/** A path's URI in a remote terminal's environment. */
interface LinkContext extends PathContext {
  uriFor(path: string): vscode.Uri;
}

class DevContainerTerminalLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    length: number,
    tooltip: string,
    /** Absolute, in the terminal's container or SSH host. */
    public readonly data: {
      uri: vscode.Uri;
      line?: number;
      column?: number;
    }
  ) {
    super(startIndex, length, tooltip);
  }
}

let provider: DevContainerFileSystemProvider;
let sshProvider: SshFileSystemProvider;
let agentLog: vscode.LogOutputChannel;
let treeProvider: ContainerTreeDataProvider;
let treeView: vscode.TreeView<ContainerNode>;
let agentTree: AgentTreeDataProvider;
let terminalAgents: TerminalAgentTracker;
let windows: WindowRegistry;
let dockerEventsProcess: cp.ChildProcess | undefined;
let workspaceState: vscode.Memento;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  workspaceState = context.workspaceState;
  provider = new DevContainerFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
    })
  );

  sshProvider = new SshFileSystemProvider(sshShell, isConfiguredHost);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SSH_SCHEME, sshProvider, {
      isCaseSensitive: true,
    })
  );

  treeProvider = new ContainerTreeDataProvider(
    new DockerContainerSource(getDockerCommand, getHostFolders),
    new WorkspaceFileOps(),
    undefined,
    { list: getSshHosts, root: sshRoot },
    { targets: syncTargetsFor }
  );
  treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  setShowAllFiles(workspaceState.get(SHOW_ALL_FILES_KEY, false));

  agentLog = vscode.window.createOutputChannel('Devc', {
    log: true,
  });
  context.subscriptions.push(agentLog);
  // Session ownership and host terminal agent detection both poll host
  // terminals' foregrounds; they share one reading per terminal.
  const hostForegrounds = new HostForegroundCache();
  agentTree = new AgentTreeDataProvider(
    // The primary folder's container shows even when the workspace file's
    // directory is not itself one of the folders.
    new DockerContainerSource(getDockerCommand, () => {
      const dir = workspaceDir();
      const folders = getHostFolders();
      return dir && !folders.includes(dir) ? [...folders, dir] : folders;
    }),
    watchContainerAgents,
    {
      list: listHostSessions,
      async foregrounds() {
        const found = await Promise.all(
          vscode.window.terminals
            .filter(t => !isRemoteTerminal(t))
            .map(t => hostForegrounds.get(t))
        );
        return found.flatMap(fg => (fg ? [fg.args] : []));
      },
      folders: getHostFolders,
      workspaceSession: workspaceSessionName,
      read: readHostSession,
      watch: watchHostSession,
    },
    {
      list: getSshHosts,
      session: remoteSessionName,
      watch: (host, session, onAgents, onExit) =>
        watchHerdr(sshShell(host), session, onAgents, onExit),
      connected: host => treeProvider.refreshSshRoot(host),
    }
  );
  const agentView = vscode.window.createTreeView(AGENTS_VIEW_ID, {
    treeDataProvider: agentTree,
  });
  context.subscriptions.push(
    agentTree,
    agentView,
    agentTree.onDidChangeTreeData(() => {
      const count = agentTree.attentionCount();
      agentView.badge = count
        ? {
            value: count,
            tooltip: `${count} agent${count === 1 ? '' : 's'} need attention`,
          }
        : undefined;
      publishWindow();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      agentTree.setHostName(hostName());
      syncAgents();
      syncSessions();
      syncSsh();
      syncTargetCache.clear();
      treeProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('devc-vscode.herdrSession')) {
        syncSessions();
        syncSsh();
      }
      if (
        e.affectsConfiguration('devc-vscode.sshHosts') ||
        e.affectsConfiguration('devc-vscode.sshPath')
      ) {
        sshHomes.clear();
        syncTargetCache.clear();
        treeProvider.refresh();
        syncSsh();
        syncAttached();
      }
    }),
    // Which host sessions this window owns follows its terminals: re-check
    // when one opens, closes, or starts or ends a command (e.g. `herdr`).
    vscode.window.onDidOpenTerminal(() => {
      scheduleSessionSync();
      syncAttached();
    }),
    vscode.window.onDidCloseTerminal(terminal => {
      forgetTerminal(terminal);
      scheduleSessionSync();
      syncAttached();
    }),
    vscode.window.onDidStartTerminalShellExecution(() => scheduleSessionSync()),
    vscode.window.onDidEndTerminalShellExecution(() => scheduleSessionSync()),
    (terminalAgents = new TerminalAgentTracker({
      isRemoteTerminal,
      async resolveContainer(terminal) {
        const host = sshTerminalHost(terminal);
        if (host !== undefined) {
          return { id: sshRootKey(host), shell: sshShell(host) };
        }
        const context = await resolveTerminalContext(terminal);
        return context
          ? {
              id: context.containerId,
              shell: await containerShell(context.containerId),
            }
          : undefined;
      },
      probe: shell => probeContainer(shell),
      classify: (shell, agent, screen) => classifyScreen(shell, agent, screen),
      report: (terminal, id, agent) =>
        agentTree.setTerminalAgent(id, terminal, agent),
      host: {
        foreground: terminal => hostForegrounds.get(terminal),
        agentIds: hostAgentIds,
        size: hostTtySize,
        classify: classifyHostScreen,
        report: (terminal, agent) =>
          agentTree.setLocalTerminalAgent(terminal, agent),
      },
      log: message => agentLog.info(message),
    }))
  );
  agentTree.setHostName(hostName());
  syncAgents();
  syncSessions();
  if (guardWorkspaceFolders()) {
    syncSsh();
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => guardWorkspaceFolders())
  );
  // Also catches foreground changes no terminal event reports, and sessions
  // that start doing work in this window's folders.
  const sessionPoll = setInterval(syncSessions, SESSION_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(sessionPoll) });

  // Other VS Code windows' agents, shared through global storage.
  windows = new WindowRegistry(
    path.join(context.globalStorageUri.fsPath, 'windows'),
    process.pid,
    {
      onOthers: others => agentTree.setOtherWindows(others),
      onFocusRequest: key => {
        const node = agentTree.findLocal(key);
        if (node) {
          focusAgent(node);
        }
      },
    }
  );
  context.subscriptions.push(windows);
  try {
    windows.start();
    publishWindow();
  } catch (err) {
    console.error('devc-vscode: window registry unavailable', err);
  }

  context.subscriptions.push(
    new AgentReviewController({
      listMounts: () => listBindMounts(getDockerCommand()),
      containerShell,
      focusContainerAgent,
      log: message => agentLog.info(message),
    })
  );

  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler as never)
    );

  register('devc-vscode.refresh', () => {
    detectTools();
    syncTargetCache.clear();
    treeProvider.refresh();
  });
  register('devc-vscode.showAllFiles', () => setShowAllFiles(true));
  register('devc-vscode.showWorkspacesOnly', () => setShowAllFiles(false));
  register('devc-vscode.refreshAgents', () => {
    detectTools();
    syncAgents();
    syncSessions();
    syncSsh();
    syncAttached();
  });
  register('devc-vscode.expandAllAgents', () =>
    agentTree.setExpansion('expanded')
  );
  register('devc-vscode.collapseAllAgents', () =>
    agentTree.setExpansion('collapsed')
  );
  register('devc-vscode.focusAgent', (node?: AgentNode) => focusAgent(node));
  register('devc-vscode.closeAgent', (node?: AgentNode) => closeAgent(node));
  register('devc-vscode.stopContainer', (node?: AgentNode) =>
    shutDownContainer(node, 'stop')
  );
  register('devc-vscode.downContainer', (node?: AgentNode) =>
    shutDownContainer(node, 'down')
  );
  register('devc-vscode.stopSession', (node?: AgentNode) =>
    shutDownSession(node, false)
  );
  register('devc-vscode.deleteSession', (node?: AgentNode) =>
    shutDownSession(node, true)
  );
  register('devc-vscode.newFile', (node?: ContainerNode) =>
    createEntry(node, 'file')
  );
  register('devc-vscode.newFolder', (node?: ContainerNode) =>
    createEntry(node, 'folder')
  );
  register('devc-vscode.rename', (node?: ContainerNode) => renameEntry(node));
  register('devc-vscode.delete', (node?: ContainerNode) => deleteEntries(node));
  register('devc-vscode.copyPath', (node?: ContainerNode) => copyPath(node));
  register(
    'devc-vscode.copyHostContainerPath',
    (arg?: unknown, selected?: unknown) =>
      copyHostContainerPath(arg, selected)
  );
  register('devc-vscode.attachAgentGroup', (node?: AgentNode) =>
    attachAgentGroup(node)
  );
  register('devc-vscode.addAgent', (node?: AgentNode) => addAgent(node));
  register('devc-vscode.attachTerminal', (node?: ContainerNode) =>
    attachTerminal(node)
  );
  register('devc-vscode.openFolderInContainer', (uri: vscode.Uri) =>
    openFolderInContainer(uri)
  );
  register('devc-vscode.addSshHost', () => addSshHost());
  register('devc-vscode.sendToSshHost', (uri?: vscode.Uri) =>
    syncWithSshHost(uri, 'send')
  );
  register('devc-vscode.fetchFromSshHost', (uri?: vscode.Uri) =>
    syncWithSshHost(uri, 'fetch')
  );
  register('devc-vscode.sendFromTree', (node?: ContainerNode) =>
    syncFromTree(node, 'send')
  );
  register('devc-vscode.fetchFromTree', (node?: ContainerNode) =>
    syncFromTree(node, 'fetch')
  );

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      async provideTerminalLinks(context) {
        // Only activate for container terminals and SSH terminals.
        const terminalContext = await linkContext(context.terminal);
        if (!terminalContext) {
          return [];
        }
        // Relative paths resolve against the shell's real working directory
        // once the tracker has found the terminal's pty, and against the
        // project mount (or SSH root) until then.
        const liveCwd = terminalAgents.cwdFor(context.terminal);
        const pathContext = liveCwd
          ? { ...terminalContext, cwd: liveCwd }
          : terminalContext;
        const links: DevContainerTerminalLink[] = [];
        for (const candidate of findPathCandidates(context.line)) {
          const resolved = resolveCandidatePath(candidate.raw, pathContext);
          if (resolved === undefined) {
            // A ~ with no known home, or a relative path with no known base.
            continue;
          }
          const uri = terminalContext.uriFor(resolved);
          try {
            await vscode.workspace.fs.stat(uri);
          } catch {
            // Not a path in this environment — leave it as plain text.
            continue;
          }
          const suffix =
            candidate.line === undefined
              ? ''
              : `:${candidate.line}` +
                (candidate.column === undefined ? '' : `:${candidate.column}`);
          links.push(
            new DevContainerTerminalLink(
              candidate.startIndex,
              candidate.length,
              uri.toString(true) + suffix,
              { uri, line: candidate.line, column: candidate.column }
            )
          );
        }
        return links;
      },
      async handleTerminalLink(link) {
        const { uri, line, column } = (link as DevContainerTerminalLink).data;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.Directory) {
            await revealInTree(uri);
            return;
          }
        } catch {
          // Fall through and let the editor report the failure.
        }
        // vscode.open picks the editor for the file type, so binary files like
        // images open in their viewer instead of failing as text.
        await vscode.commands.executeCommand('vscode.open', uri, {
          selection: selectionFor(line, column),
        });
      },
    })
  );

  // Tools can be installed or removed while the window is open.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        TOOL_SETTINGS.some(key =>
          e.affectsConfiguration(`devc-vscode.${key}`)
        )
      ) {
        detectTools();
      }
    }),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused && Date.now() - lastToolDetection >= TOOL_RECHECK_MS) {
        detectTools();
      }
    })
  );
  detectTools();

  // Watch for container start/stop events so roots appear and vanish live.
  startDockerEventsWatcher();
  syncAttached();
  restoreTerminals().catch(err => {
    console.error('devc-vscode: terminal restore error', err);
  });
}

export function deactivate() {
  if (dockerEventsProcess) {
    dockerEventsProcess.kill();
    dockerEventsProcess = undefined;
  }
}

// ── Tree commands ───────────────────────────────────────────────────────────

/**
 * The node a command should act on: the one the menu passed, else the current
 * selection when invoked from the command palette.
 */
function targetNode(node?: ContainerNode): ContainerNode | undefined {
  const resolved = node ?? treeView.selection[0];
  if (!resolved) {
    vscode.window.showErrorMessage('No container file selected.');
    return undefined;
  }
  return resolved;
}

/** The directory a new entry created against `node` belongs in. */
async function directoryOf(node: ContainerNode): Promise<vscode.Uri> {
  if (node.kind === 'file') {
    return node.uri.with({ path: posix.dirname(node.uri.path) });
  }
  return treeProvider.baseUri(node);
}

/** A tree node that is a file or directory, not a root or an error. */
function isEntry(node: ContainerNode): boolean {
  return node.kind === 'file' || node.kind === 'directory';
}

async function createEntry(
  node: ContainerNode | undefined,
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
  // which case it lands beside it — refresh whichever directory now contains it.
  treeProvider.refresh(
    target.kind === 'file' ? await parentNodeOf(target) : target
  );
  if (kind === 'file') {
    vscode.window.showTextDocument(uri);
  }
}

async function renameEntry(node?: ContainerNode): Promise<void> {
  const target = targetNode(node);
  if (!target || !isEntry(target)) {
    return;
  }
  const current = posix.basename(target.uri.path);
  const name = await vscode.window.showInputBox({
    prompt: 'New name',
    value: current,
    valueSelection: [
      0,
      current.lastIndexOf('.') > 0 ? current.lastIndexOf('.') : current.length,
    ],
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
  treeProvider.refresh(await parentNodeOf(target));
}

async function deleteEntries(node?: ContainerNode): Promise<void> {
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
  treeProvider.refresh(await parentNodeOf(nodes[0]));
}

async function copyPath(node?: ContainerNode): Promise<void> {
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

/**
 * Copy the container path each host resource is mounted at. Called with an
 * Explorer or editor-tab URI, or with a GitHub Pull Requests file node, whose
 * resourceUri carries the host path in every scheme it uses (file, review, pr).
 */
async function copyHostContainerPath(
  arg?: unknown,
  selected?: unknown
): Promise<void> {
  const items =
    Array.isArray(selected) && selected.length > 0 ? selected : [arg];
  const hostUris = items
    .map(resourceOf)
    .filter((uri): uri is vscode.Uri => uri !== undefined);
  if (hostUris.length === 0) {
    return;
  }
  try {
    const mounts = hostUris.every(uri => uri.scheme === SCHEME)
      ? []
      : await listBindMounts(getDockerCommand());
    const lines: string[] = [];
    for (const uri of hostUris) {
      if (uri.scheme === SCHEME) {
        lines.push(uri.path);
        continue;
      }
      const mapped = mapHostPath(uri.path, mounts);
      if (!mapped) {
        vscode.window.showErrorMessage(
          `No running container mounts ${uri.path}`
        );
        return;
      }
      lines.push(mapped.path);
    }
    await vscode.env.clipboard.writeText(lines.join('\n'));
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
  }
}

/** A URI, or a tree node's resourceUri. Duck-typed: nodes come from other extensions. */
function resourceOf(item: unknown): vscode.Uri | undefined {
  const isUri = (v: unknown): v is vscode.Uri =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as vscode.Uri).scheme === 'string' &&
    typeof (v as vscode.Uri).path === 'string' &&
    (v as vscode.Uri).path.startsWith('/');
  if (isUri(item)) {
    return item;
  }
  const resourceUri = (item as { resourceUri?: unknown } | undefined)
    ?.resourceUri;
  return isUri(resourceUri) ? resourceUri : undefined;
}

async function parentNodeOf(
  node: ContainerNode
): Promise<ContainerNode | undefined> {
  return treeProvider.getParent(node);
}

function validateName(value: string): string | undefined {
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

// ── Reveal ──────────────────────────────────────────────────────────────────

/** Focus the container tree and select a container or SSH path in it. */
const SHOW_ALL_FILES_KEY = 'showAllFiles';

/** Show all of each container's '/' in the Sandboxes view, or only /workspaces. */
function setShowAllFiles(showAll: boolean): void {
  treeProvider.setShowAllFiles(showAll);
  workspaceState.update(SHOW_ALL_FILES_KEY, showAll);
  vscode.commands.executeCommand(
    'setContext',
    'devc-vscode.showAllFiles',
    showAll
  );
}

async function revealInTree(uri: vscode.Uri): Promise<void> {
  if (uri.scheme === SSH_SCHEME) {
    // The SSH tree starts at the host's root; nothing above it is shown.
    const root = await treeProvider.resolveSshRoot(uri.authority);
    if (root === undefined || !isPathWithin(root, uri.path)) {
      vscode.window.showInformationMessage(
        `${uri.path} is outside ${uri.authority}'s root in the Sandboxes view.`
      );
      return;
    }
  } else if (
    !treeProvider.showsAllFiles &&
    !isPathWithin(`/${WORKSPACES_DIR}`, uri.path)
  ) {
    // Filtered out of the tree, so reveal would find no path to it.
    setShowAllFiles(true);
  }
  // reveal needs the view resolved first; `<viewId>.focus` is generated by
  // VS Code from the view contribution and is not declared in package.json.
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  const node = await treeProvider.nodeForUri(uri);
  try {
    await treeView.reveal(node, { select: true, focus: true, expand: true });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not show ${uri.path}: ${(err as Error).message}`
    );
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function openFolderInContainer(uri: vscode.Uri): Promise<void> {
  // The menu's when clause tests `resourceScheme != devc-vscode` rather than
  // `== file`, because resource context keys are unset on the first explorer
  // right-click and a positive test hides the item on the root host folder.
  // That fails open, so reject container folders here.
  if (uri && uri.scheme !== 'file') {
    vscode.window.showErrorMessage(
      'Open Folder in Container works on host folders only.'
    );
    return;
  }
  openContainerTerminal(uri?.fsPath, getOpenFolderCommand());
}

// ── Workspace sync with SSH hosts ──────────────────────────────────────────

/** Hosts whose remote git version passed this session. */
const syncCheckedHosts = new Set<string>();

/**
 * Send to or fetch from an SSH host: the folder the Explorer passed (or one
 * picked from the workspace), then a host, then the flow in workspaceSync.
 */
async function syncWithSshHost(
  uri: vscode.Uri | undefined,
  direction: 'send' | 'fetch'
): Promise<void> {
  // The menu tests `resourceScheme != …` for the same reason as Open Folder
  // in Container (see openFolderInContainer), so reject remote folders here.
  if (uri && uri.scheme !== 'file') {
    vscode.window.showErrorMessage(
      'Send and Fetch work on local folders only.'
    );
    return;
  }
  const folder = uri?.fsPath ?? (await pickLocalFolder());
  if (!folder) {
    return;
  }
  const host = await pickSyncHost();
  if (!host) {
    return;
  }
  await runSync(folder, host.host, direction);
  // Send may have made the folder a sync target in the tree.
  treeProvider.refreshSshRoot(host.host);
}

/** Send or Fetch from the Sandboxes view: the folder comes from the node. */
async function syncFromTree(
  node: ContainerNode | undefined,
  direction: 'send' | 'fetch'
): Promise<void> {
  const sync = node?.kind === 'directory' ? node.sync : undefined;
  if (!node || !sync) {
    vscode.window.showErrorMessage(
      `${node?.uri.path ?? 'This folder'} is no longer a worktree of a local repo — refresh the Sandboxes view.`
    );
    return;
  }
  await runSync(sync.localPath, node.uri.authority, direction);
  // Send may have added a worktree or switched a branch.
  treeProvider.refresh(await treeProvider.getParent(node));
}

/** The Send / Fetch flow once folder and host are chosen. Never rejects. */
async function runSync(
  folder: string,
  host: string,
  direction: 'send' | 'fetch'
): Promise<void> {
  const verb = direction === 'send' ? 'Sending' : 'Fetching';
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${verb} ${path.basename(folder)} — ${sshLabel(host)}`,
      },
      () =>
        (direction === 'send' ? sendToSshHost : fetchFromSshHost)(
          folder,
          host,
          syncDeps()
        )
    );
  } catch (err) {
    showSyncError(err);
  } finally {
    syncTargetCache.delete(host);
  }
}

/**
 * Each SSH host's sync targets for the tree, filled on first use. Cleared
 * when folders, hosts or a host's repos may have changed; a failed fill is
 * not kept.
 */
const syncTargetCache = new Map<string, Promise<Map<string, SyncTarget>>>();

function syncTargetsFor(host: string): Promise<Map<string, SyncTarget>> {
  let targets = syncTargetCache.get(host);
  if (!targets) {
    const filling = findSyncTargets(getHostFolders(), host, syncDeps());
    filling.catch(() => {
      if (syncTargetCache.get(host) === filling) {
        syncTargetCache.delete(host);
      }
    });
    syncTargetCache.set(host, filling);
    targets = filling;
  }
  return targets;
}

async function pickLocalFolder(): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    f => f.uri.scheme === 'file'
  );
  if (folders.length <= 1) {
    if (!folders.length) {
      vscode.window.showErrorMessage('Open a folder to send or fetch.');
    }
    return folders[0]?.uri.fsPath;
  }
  return (await vscode.window.showWorkspaceFolderPick())?.uri.fsPath;
}

async function pickSyncHost(): Promise<SshHostInfo | undefined> {
  const hosts = getSshHosts();
  if (hosts.length <= 1) {
    if (!hosts.length) {
      vscode.window.showErrorMessage(
        'No SSH hosts configured — use Add SSH Host…'
      );
    }
    return hosts[0];
  }
  const picked = await vscode.window.showQuickPick(
    hosts.map(h => ({ label: h.label, description: h.host, host: h })),
    { placeHolder: 'SSH host' }
  );
  return picked?.host;
}

function showSyncError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const offerLog = !(err instanceof SyncError) || err.showLog;
  if (!(err instanceof SyncError)) {
    agentLog?.error(`workspace sync: ${message}`);
  }
  vscode.window
    .showErrorMessage(message, ...(offerLog ? ['Show Log'] : []))
    .then(choice => {
      if (choice === 'Show Log') {
        agentLog?.show();
      }
    });
}

function syncDeps(): SyncDeps {
  const log = (line: string) => agentLog?.info(line);
  return {
    shell: sshShell,
    sshHome,
    git: makeGit(gitEnv(getSshPath(), getControlDir()), log),
    localHome: fs.realpathSync(os.homedir()),
    checkedHosts: syncCheckedHosts,
    log,
    ui: {
      warn: (message, modal, ...buttons) =>
        vscode.window.showWarningMessage(message, { modal }, ...buttons),
      info: (message, ...buttons) =>
        vscode.window.showInformationMessage(message, ...buttons),
      pick: async (items, placeHolder) =>
        (await vscode.window.showQuickPick(items, { placeHolder }))?.label,
      openReview,
      error: showSyncError,
    },
  };
}

/** The slice of the built-in Git extension's API (git.d.ts) used here. */
interface GitExtensionApi {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

async function openReview(request: ReviewRequest): Promise<void> {
  const extension = vscode.extensions.getExtension<{
    getAPI(version: 1): GitExtensionApi;
  }>('vscode.git');
  let api: GitExtensionApi | undefined;
  try {
    api = (extension?.isActive
      ? extension.exports
      : await extension?.activate()
    )?.getAPI(1);
  } catch {
    api = undefined;
  }
  if (!api) {
    throw new SyncError(
      "The built-in Git extension is disabled — it's needed to show the review diff."
    );
  }
  const resources = request.files.map(file => {
    const uri = vscode.Uri.file(path.join(request.root, file.path));
    return [
      uri,
      file.status === 'A' ? undefined : api.toGitUri(uri, request.base),
      file.status === 'D' ? undefined : api.toGitUri(uri, request.ref),
    ];
  });
  await vscode.commands.executeCommand(
    'vscode.changes',
    request.title,
    resources
  );
}

/**
 * Open a container terminal in an editor tab, running `command` from the host
 * folder `cwd`. The terminal is recognised by its name and resolved to its
 * container by its cwd.
 */
function openContainerTerminal(
  cwd: string | undefined,
  command: string,
  fallback = false
): vscode.Terminal {
  // hideFromUser is the only creationOptions flag the Python extension checks
  // before injecting `source .../activate` into a new terminal (see
  // microsoft/vscode-python src/client/terminals/activation.ts). It reads
  // creationOptions, which never change, so revealing the terminal with show()
  // right away keeps the activation suppressed.
  const t = vscode.window.createTerminal({
    name: 'devcontainer',
    cwd,
    iconPath: CONTAINER_ICON,
    location: vscode.TerminalLocation.Editor,
    isTransient: true,
    hideFromUser: true,
  });
  t.show();
  t.sendText(command);
  // A fallback command names the container, so it is rebuilt on restore
  // rather than replayed: the container may have been recreated.
  rememberTerminal(
    t,
    fallback ? { kind: 'container', cwd } : { kind: 'container', cwd, command }
  );
  return t;
}

/**
 * Open a container terminal on a running container without devc: a
 * `docker exec` attached to its herdr, else a login shell, in the folder's
 * mount. `hostFolder` is the terminal's cwd, which resolves it to the
 * container.
 */
async function openFallbackTerminal(
  containerId: string,
  hostFolder: string | undefined
): Promise<vscode.Terminal> {
  const docker = getDockerCommand();
  const [user, mount] = await Promise.all([
    getRemoteUser(containerId, docker),
    hostFolder
      ? findMatchingBindMount(containerId, hostFolder, docker).catch(
          () => undefined
        )
      : undefined,
  ]);
  return openContainerTerminal(
    hostFolder,
    containerTerminalCommand(
      docker,
      containerId,
      user,
      mount?.destPath,
      CONTAINER_SESSION
    ),
    true
  );
}

/**
 * Open a terminal attached to a running container's herdr: the
 * herdrAttachCommand when it can run, else the docker exec fallback.
 */
async function openHerdrAttachTerminal(
  container: ContainerInfo
): Promise<vscode.Terminal> {
  return commandSettingAvailable('herdrAttachCommand', await currentTools())
    ? openContainerTerminal(container.localFolder, getHerdrAttachCommand())
    : openFallbackTerminal(container.id, container.localFolder);
}

/**
 * Show a container's or SSH host's terminal, opening one (from the
 * container's host folder) when there is none.
 */
async function attachTerminal(node?: ContainerNode): Promise<void> {
  const target = node ?? treeView.selection[0];
  if (target?.kind === 'sshHost') {
    showSshTerminal(target.host);
    return;
  }
  if (target?.kind !== 'container') {
    return;
  }
  const existing = await containerTerminals(target.containerId);
  if (existing.length) {
    existing[0].show();
    return;
  }
  if (commandSettingAvailable('openFolderCommand', await currentTools())) {
    openContainerTerminal(target.localFolder, getOpenFolderCommand());
  } else {
    await openFallbackTerminal(target.containerId, target.localFolder);
  }
}

/** This window's open terminals on a container, oldest first. */
async function containerTerminals(
  containerId: string
): Promise<vscode.Terminal[]> {
  const found: vscode.Terminal[] = [];
  for (const terminal of vscode.window.terminals) {
    if (
      isContainerTerminal(terminal) &&
      !terminal.exitStatus &&
      (await resolveTerminalContext(terminal))?.containerId === containerId
    ) {
      found.push(terminal);
    }
  }
  return found;
}

let attachedSync = 0;

/**
 * Tell the trees which containers and SSH hosts have a terminal open on
 * them.
 */
function syncAttached(): void {
  const run = ++attachedSync;
  (async () => {
    const ids = new Set<string>();
    for (const terminal of vscode.window.terminals) {
      const host = sshTerminalHost(terminal);
      if (host !== undefined && !terminal.exitStatus) {
        ids.add(sshRootKey(host));
      } else if (isContainerTerminal(terminal) && !terminal.exitStatus) {
        const id = (await resolveTerminalContext(terminal))?.containerId;
        if (id) {
          ids.add(id);
        }
      }
    }
    // A later sync saw newer terminals; its answer wins.
    if (run === attachedSync) {
      treeProvider.setAttached(ids);
      agentTree.setAttachedContainers(ids);
    }
  })().catch(err => {
    console.error('devc-vscode: terminal sync error', err);
  });
}

// ── Agents ──────────────────────────────────────────────────────────────────

function syncAgents(): void {
  agentTree.sync().catch(err => {
    console.error('devc-vscode: agent sync error', err);
  });
}

/** How often host sessions are re-checked for ownership without an event. */
const SESSION_POLL_MS = 5000;

function syncSessions(): void {
  agentTree.syncSessions().catch(err => {
    console.error('devc-vscode: host session sync error', err);
  });
}

let sessionSyncTimer: NodeJS.Timeout | undefined;

/**
 * Sync host sessions shortly after a terminal event, once a command it
 * reports has had a moment to become the foreground process.
 */
function scheduleSessionSync(): void {
  clearTimeout(sessionSyncTimer);
  sessionSyncTimer = setTimeout(syncSessions, 500);
}

/**
 * Stream a container's agents from the herdr server inside it, as the user
 * the devcontainer CLI execs as — the herdr socket lives in their home.
 */
function watchContainerAgents(
  containerId: string,
  onAgents: Parameters<typeof watchHerdr>[2],
  onExit: () => void
): { dispose(): void } {
  let watcher: { dispose(): void } | undefined;
  let disposed = false;
  containerShell(containerId).then(shell => {
    if (!disposed) {
      watcher = watchHerdr(shell, CONTAINER_SESSION, onAgents, onExit);
    }
  }, onExit);
  return {
    dispose() {
      disposed = true;
      watcher?.dispose();
    },
  };
}

/** Share this window's agents with the other windows. */
function publishWindow(): void {
  windows?.publish({
    version: SNAPSHOT_VERSION,
    pid: process.pid,
    name: vscode.workspace.name ?? '',
    workspaceUri: workspaceIdentity()?.toString(),
    groups: agentTree.snapshotGroups(),
  });
}

/**
 * What `vscode.openFolder` needs to bring this window to the front from
 * another: its saved workspace file, or its folder. An untitled multi-root
 * workspace has neither.
 */
function workspaceIdentity(): vscode.Uri | undefined {
  const file = vscode.workspace.workspaceFile;
  if (file) {
    return file.scheme === 'file' ? file : undefined;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Bring an agent into view: reveal the container's terminal, then have herdr
 * switch to the agent's pane inside it. With no terminal that could be showing
 * herdr, open one that attaches to it.
 */
async function focusAgent(node?: AgentNode): Promise<void> {
  if (node?.kind !== 'agent') {
    return;
  }
  if (node.remote) {
    // The owning window focuses its own terminal and herdr pane; opening its
    // workspace again brings that window to the front instead of opening a
    // second one.
    const { window, published } = node.remote;
    if (!window.workspaceUri) {
      vscode.window.showInformationMessage(
        `"${window.name}" has no saved workspace to switch to.`
      );
      return;
    }
    windows.requestFocus(window.pid, published.key);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(window.workspaceUri),
      { forceNewWindow: true }
    );
    return;
  }
  if (node.session !== undefined) {
    await focusHostAgent(node.session, node.agent);
    return;
  }
  if (node.local) {
    node.terminal?.show();
    return;
  }
  if (node.terminal) {
    node.terminal.show();
    return;
  }
  if (node.ssh) {
    await focusSshAgent(node.ssh.host, node.agent);
    return;
  }
  await focusContainerAgent(node.container, node.agent);
}

/**
 * Bring a container's herdr agent into view: reveal the terminal showing
 * herdr in that container, or open one that attaches to it, then have herdr
 * switch to the agent's pane.
 */
async function focusContainerAgent(
  container: ContainerInfo,
  agent: AgentInfo
): Promise<void> {
  // Reveal the terminal attached to herdr in that container: the one whose
  // pty has herdr in the foreground. Before the tracker has found a
  // terminal's pty (or for terminals opened before the extension loaded), its
  // foreground is unknown and it is the best guess. Terminals known to be
  // running something else cannot show herdr.
  const containerId = container.id;
  const candidates: vscode.Terminal[] = [];
  for (const terminal of vscode.window.terminals) {
    if (
      isContainerTerminal(terminal) &&
      (await resolveTerminalContext(terminal))?.containerId === containerId
    ) {
      candidates.push(terminal);
    }
  }
  const herdrTerminal =
    candidates.find(t => terminalAgents.foregroundFor(t) === 'herdr') ??
    candidates.find(t => terminalAgents.foregroundFor(t) === undefined);
  if (herdrTerminal) {
    herdrTerminal.show();
  } else {
    // Focus once herdr is up, so the pane switch lands in a client that is
    // showing. Without shell integration the tracker never sees the terminal,
    // so after the wait focus is tried regardless.
    const terminal = await openHerdrAttachTerminal(container);
    await waitForForeground(terminal, 'herdr', HERDR_ATTACH_TIMEOUT_MS);
  }
  const shell = await containerShell(containerId);
  if (!(await focusHerdrAgent(shell, CONTAINER_SESSION, agent))) {
    vscode.window.showErrorMessage(`Could not focus ${agent.agent} in herdr.`);
  }
}

/**
 * Bring an SSH host's herdr agent into view: reveal the SSH terminal showing
 * herdr, or open one that attaches to it, then have herdr switch to the
 * agent's pane — as for a container.
 */
async function focusSshAgent(host: string, agent: AgentInfo): Promise<void> {
  const candidates = sshTerminals(host);
  const herdrTerminal =
    candidates.find(t => terminalAgents.foregroundFor(t) === 'herdr') ??
    candidates.find(t => terminalAgents.foregroundFor(t) === undefined);
  if (herdrTerminal) {
    herdrTerminal.show();
  } else {
    const terminal = openSshTerminal(host);
    await waitForForeground(terminal, 'herdr', HERDR_ATTACH_TIMEOUT_MS);
  }
  if (!(await focusHerdrAgent(sshShell(host), remoteSessionName(), agent))) {
    vscode.window.showErrorMessage(`Could not focus ${agent.agent} in herdr.`);
  }
}

/**
 * Bring a host herdr agent into view: reveal a terminal in this window that
 * is a client of the agent's session, or open one that attaches to it, then
 * have herdr switch to the agent's pane.
 */
async function focusHostAgent(
  sessionName: string,
  agent: AgentInfo
): Promise<void> {
  const session = agentTree.hostSession(sessionName);
  if (!session) {
    vscode.window.showErrorMessage(
      `herdr session "${sessionName}" is no longer running.`
    );
    return;
  }
  const terminal = await findHostClient(session);
  if (terminal) {
    terminal.show();
  } else {
    const folders = getHostFolders();
    const opened = openHostHerdrTerminal(
      session,
      folderOf(agent, folders) ?? folders[0]
    );
    await waitForHostClient(opened, session, HERDR_ATTACH_TIMEOUT_MS);
  }
  if (!(await focusHostHerdrAgent(session, agent))) {
    vscode.window.showErrorMessage(`Could not focus ${agent.agent} in herdr.`);
  }
}

/**
 * Show a terminal on an Agents view environment: a client of the workspace
 * session for the host, or a container terminal, opening one attached to
 * herdr when there is none.
 */
async function attachAgentGroup(node?: AgentNode): Promise<void> {
  if (node?.kind === 'host' && !node.remote) {
    await attachWorkspaceSession();
  } else if (node?.kind === 'ssh' && !node.remote) {
    showSshTerminal(node.host);
  } else if (node?.kind === 'container' && !node.remote) {
    const existing = await containerTerminals(node.container.id);
    if (existing.length) {
      existing[0].show();
      return;
    }
    await openHerdrAttachTerminal(node.container);
  }
}

/**
 * Show a terminal attached to this window's workspace session, opening one
 * when there is none; that starts the session if it is not running, as
 * `herdrs` would from the workspace. Resolves whether a client is up.
 */
async function attachWorkspaceSession(): Promise<boolean> {
  const name = workspaceSessionName();
  if (name === undefined) {
    return false;
  }
  const running = agentTree.workspaceHostSession();
  const existing = running && (await findHostClient(running));
  if (existing) {
    existing.show();
    return true;
  }
  const session = running ?? {
    name,
    default: name === agentTree.defaultSessionName(),
    socketPath: '',
  };
  const terminal = openHostHerdrTerminal(session, workspaceDir());
  return waitForHostClient(terminal, session, HERDR_ATTACH_TIMEOUT_MS);
}

/** Where Add Agent starts an agent. */
type LaunchTarget =
  | { kind: 'host' }
  | {
      kind: 'container';
      /** The workspace folder it serves. */ folder: string;
    }
  | { kind: 'ssh'; host: string };

/**
 * Start an agent: pick where — unless `node` is the environment to start it
 * in, or there is only one — then which.
 */
async function addAgent(node?: AgentNode): Promise<void> {
  let target: LaunchTarget | undefined;
  if (node?.kind === 'host' && !node.remote) {
    target = { kind: 'host' };
  } else if (node?.kind === 'container' && !node.remote) {
    target = { kind: 'container', folder: node.container.localFolder };
  } else if (node?.kind === 'ssh' && !node.remote) {
    target = { kind: 'ssh', host: node.host };
  } else if (node && node.kind !== 'workspace') {
    return;
  }
  target ??= await pickLaunchTarget();
  if (!target) {
    return;
  }
  const kind = await pickAgentKind();
  if (!kind) {
    return;
  }
  const chosen = target;
  const where =
    chosen.kind === 'host'
      ? `${hostName()} on the host`
      : chosen.kind === 'container'
        ? `the ${path.basename(chosen.folder)} dev container`
        : `${sshLabel(chosen.host)} over SSH`;
  const error = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting ${kind} in ${where}`,
      cancellable: true,
    },
    (_progress, token) =>
      chosen.kind === 'host'
        ? launchOnHost(kind)
        : chosen.kind === 'container'
          ? launchInContainer(chosen.folder, kind, token)
          : launchOnSsh(chosen.host, kind, token)
  );
  if (error) {
    vscode.window.showErrorMessage(`Could not start ${kind}: ${error}`);
  }
}

async function pickAgentKind(): Promise<string | undefined> {
  const kinds = getAgentKinds();
  if (kinds.length <= 1) {
    return kinds[0];
  }
  return vscode.window.showQuickPick(kinds, { placeHolder: 'Agent to start' });
}

async function pickLaunchTarget(): Promise<LaunchTarget | undefined> {
  const items: (vscode.QuickPickItem & {
    target?: LaunchTarget;
    addSshHost?: true;
  })[] = [];
  const tools = await currentTools();
  if (workspaceSessionName() !== undefined && tools.hostHerdr) {
    items.push({
      label: `$(device-desktop) ${hostName()}`,
      target: { kind: 'host' },
    });
  }
  // Without the herdrAttachCommand, only a running container can have its
  // herdr brought up (by the docker exec fallback).
  const canCreate = commandSettingAvailable('herdrAttachCommand', tools);
  const folders = tools.docker
    ? getHostFolders().filter(
        folder => canCreate || agentTree.containerFor(folder)
      )
    : [];
  if (folders.length) {
    items.push({
      label: 'Dev Containers',
      kind: vscode.QuickPickItemKind.Separator,
    });
  }
  for (const folder of folders) {
    items.push({
      label: `$(vm-running) ${path.basename(folder)}`,
      target: { kind: 'container', folder },
    });
  }
  const sshHosts = getSshHosts();
  if (sshHosts.length) {
    items.push({ label: 'SSH Hosts', kind: vscode.QuickPickItemKind.Separator });
  }
  for (const { host, label } of sshHosts) {
    items.push({ label: `$(remote) ${label}`, target: { kind: 'ssh', host } });
  }
  const targets = items.filter(item => item.target);
  if (targets.length <= 1) {
    if (!targets.length) {
      vscode.window.showErrorMessage('There is nowhere to start an agent.');
    }
    return targets[0]?.target;
  }
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add SSH Host…', addSshHost: true }
  );
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Where to start it',
  });
  if (picked?.addSshHost) {
    // Adding a host ends this Add Agent; it starts nothing.
    await addSshHost();
    return undefined;
  }
  return picked?.target;
}

/**
 * Start an agent in the workspace session, attaching to it (and so starting
 * it) first. Resolves why it failed, if it did.
 */
async function launchOnHost(kind: string): Promise<string | undefined> {
  const name = workspaceSessionName();
  if (name === undefined || !(await attachWorkspaceSession())) {
    return 'the host herdr session did not start';
  }
  const session = await waitFor(
    async () => (await listHostSessions()).find(s => s.name === name),
    HERDR_ATTACH_TIMEOUT_MS
  );
  if (!session) {
    return `herdr session "${name}" is not running`;
  }
  const result = await startHostAgent(session, workspaceDir(), kind);
  if ('error' in result) {
    return result.error;
  }
  scheduleSessionSync();
  await focusHostHerdrAgent(session, result.pane);
  return undefined;
}

/**
 * Start an agent in the herdr of a folder's dev container, first bringing
 * the container and its herdr up with a terminal attached when they are not,
 * then show it. Resolves why it failed, if it did.
 */
async function launchInContainer(
  folder: string,
  kind: string,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const entry = agentTree.containerFor(folder);
  if (!entry?.herdrRunning) {
    if (commandSettingAvailable('herdrAttachCommand', await currentTools())) {
      // Brings the container, and herdr in it, up.
      openContainerTerminal(folder, getHerdrAttachCommand());
    } else if (entry) {
      // Brings herdr up in the running container, if it has herdr.
      await openFallbackTerminal(entry.container.id, folder);
    } else {
      return 'devc not found — install devc or set devc-vscode.herdrAttachCommand';
    }
  }
  const found = await waitFor(
    () => {
      const entry = agentTree.containerFor(folder);
      return entry?.herdrRunning ? entry.container : undefined;
    },
    CONTAINER_START_TIMEOUT_MS,
    token
  );
  if (!found) {
    return token.isCancellationRequested
      ? undefined
      : `herdr did not come up in the ${path.basename(folder)} dev container`;
  }
  const docker = getDockerCommand();
  const cwd = (await findMatchingBindMount(found.id, folder, docker))?.destPath;
  const result = await startShellAgent(
    await containerShell(found.id),
    CONTAINER_SESSION,
    cwd,
    kind
  );
  if ('error' in result) {
    return result.error;
  }
  await focusAgent({
    kind: 'agent',
    container: found,
    agent: { ...result.pane, agent: kind, status: 'unknown' },
  });
  return undefined;
}

/**
 * Start an agent in this window's herdr session on an SSH host, first
 * opening an SSH terminal to start the session when it is not running, then
 * show it. Resolves why it failed, if it did.
 */
async function launchOnSsh(
  host: string,
  kind: string,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const label = sshLabel(host);
  if (!agentTree.sshState(host)?.running) {
    // Starts `herdr --session <session>` on the host. A new terminal, as for
    // containers: an existing one may be running anything.
    openSshTerminal(host);
    const up = await waitFor(
      () => (agentTree.sshState(host)?.running ? true : undefined),
      SSH_HERDR_START_TIMEOUT_MS,
      token
    );
    if (!up) {
      return token.isCancellationRequested
        ? undefined
        : `herdr did not come up on ${label}`;
    }
  }
  let root: string;
  try {
    root = await sshRoot(host);
  } catch (err) {
    return (err as Error).message;
  }
  const session = remoteSessionName();
  const result = await startShellAgent(sshShell(host), session, root, kind);
  if ('error' in result) {
    return result.error;
  }
  await focusSshAgent(host, { ...result.pane, agent: kind, status: 'unknown' });
  return undefined;
}

/** How long an SSH host's herdr session gets to start. */
const SSH_HERDR_START_TIMEOUT_MS = 60000;

/** How long a dev container gets to be created and bring herdr up. */
const CONTAINER_START_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Resolves `check`'s first defined answer, polled until `timeoutMs` passes or
 * `token` is cancelled, and undefined then.
 */
async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  token?: vscode.CancellationToken
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline || token?.isCancellationRequested) {
      return undefined;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/** A host terminal in this window with a client of `session` in front. */
async function findHostClient(
  session: HostSession
): Promise<vscode.Terminal | undefined> {
  for (const terminal of vscode.window.terminals) {
    if (
      !isRemoteTerminal(terminal) &&
      (await isHostClient(terminal, session))
    ) {
      return terminal;
    }
  }
  return undefined;
}

async function isHostClient(
  terminal: vscode.Terminal,
  session: HostSession
): Promise<boolean> {
  const fg = await hostTerminalForeground(terminal);
  return (
    !!fg &&
    sessionFromClientArgs(fg.args, agentTree.defaultSessionName()) ===
      session.name
  );
}

/**
 * Open a host terminal attached to a herdr session, in an editor tab as
 * container terminals are. The HERDR_* variables this extension host may have
 * inherited from a herdr pane are unset, so the client attaches as asked
 * rather than to that pane's session.
 */
function openHostHerdrTerminal(
  session: HostSession,
  cwd: string | undefined
): vscode.Terminal {
  const t = vscode.window.createTerminal({
    name: `herdr ${session.default ? 'default' : session.name}`,
    cwd,
    iconPath: SESSION_ICON,
    location: vscode.TerminalLocation.Editor,
    isTransient: true,
    // See openContainerTerminal.
    hideFromUser: true,
    env: Object.fromEntries(
      Object.keys(process.env)
        .filter(key => key.startsWith('HERDR_'))
        .map(key => [key, null])
    ),
  });
  t.show();
  t.sendText(attachCommand(session));
  rememberTerminal(t, { kind: 'host', session: session.name, cwd });
  return t;
}

// ── Terminal restore ────────────────────────────────────────────────────────

/**
 * A terminal this extension opened, as needed to open it again. They are
 * transient, so VS Code drops them on restart while the herdr sessions and
 * containers they were attached to keep running.
 */
type SavedTerminal =
  // No command: the docker exec fallback, rebuilt for the container found.
  | { kind: 'container'; cwd?: string; command?: string }
  | { kind: 'host'; session: string; cwd?: string }
  | { kind: 'ssh'; host: string };

const SAVED_TERMINALS_KEY = 'devc-vscode.terminals';

/** This window's managed terminals, in the order they were opened. */
const savedTerminals = new Map<vscode.Terminal, SavedTerminal>();

function rememberTerminal(terminal: vscode.Terminal, saved: SavedTerminal) {
  savedTerminals.set(terminal, saved);
  persistTerminals();
}

/**
 * Drop a closed terminal from what is restored — unless the window closing
 * is what closed it, which is exactly when it should come back.
 */
function forgetTerminal(terminal: vscode.Terminal): void {
  const reason = terminal.exitStatus?.reason;
  if (
    reason === vscode.TerminalExitReason.Shutdown ||
    reason === vscode.TerminalExitReason.Unknown
  ) {
    return;
  }
  if (savedTerminals.delete(terminal)) {
    persistTerminals();
  }
}

function persistTerminals(): void {
  workspaceState
    .update(SAVED_TERMINALS_KEY, [...savedTerminals.values()])
    .then(undefined, err => {
      console.error('devc-vscode: could not save terminals', err);
    });
}

/**
 * Reopen the terminals open when this workspace was last closed, for the
 * containers and herdr sessions still running. A target that already has a
 * terminal (the extension host restarted, not the window) keeps that one.
 * Those not reopened are forgotten.
 */
async function restoreTerminals(): Promise<void> {
  const saved = workspaceState.get<SavedTerminal[]>(SAVED_TERMINALS_KEY, []);
  if (!saved.length) {
    return;
  }
  const docker = getDockerCommand();
  const sessions = saved.some(s => s.kind === 'host')
    ? await listHostSessions()
    : [];
  const adopted = new Set<vscode.Terminal>();
  // Opened one at a time, so they come back in their original order.
  for (const entry of saved) {
    if (entry.kind === 'container') {
      const containerId = entry.cwd
        ? await findContainerForHostFolder(entry.cwd, docker).catch(
            () => undefined
          )
        : undefined;
      if (!containerId) {
        continue;
      }
      const existing = (await containerTerminals(containerId)).find(
        t => !adopted.has(t) && !savedTerminals.has(t)
      );
      if (existing) {
        adopted.add(existing);
        rememberTerminal(existing, entry);
      } else if (entry.command === undefined) {
        await openFallbackTerminal(containerId, entry.cwd);
      } else {
        openContainerTerminal(entry.cwd, entry.command);
      }
    } else if (entry.kind === 'ssh') {
      if (!isConfiguredHost(entry.host) || !(await sshReachable(entry.host))) {
        continue;
      }
      const existing = sshTerminals(entry.host).find(
        t => !adopted.has(t) && !savedTerminals.has(t)
      );
      if (existing) {
        adopted.add(existing);
        rememberTerminal(existing, entry);
      } else {
        openSshTerminal(entry.host);
      }
    } else {
      const session = sessions.find(s => s.name === entry.session);
      if (!session) {
        continue;
      }
      const existing = await findHostClient(session);
      if (existing && !savedTerminals.has(existing)) {
        rememberTerminal(existing, entry);
      } else {
        openHostHerdrTerminal(session, entry.cwd);
      }
    }
  }
  // Nothing reopened still writes the list, so forgotten entries go.
  persistTerminals();
}

/**
 * Resolves true once a host terminal has a client of `session` in front,
 * false if the terminal closes or `timeoutMs` passes first.
 */
function waitForHostClient(
  terminal: vscode.Terminal,
  session: HostSession,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const check = async () => {
      if (await isHostClient(terminal, session)) {
        resolve(true);
      } else if (terminal.exitStatus || Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(check, 250);
      }
    };
    check();
  });
}

/**
 * End an agent's session: close its herdr pane, or the terminal it was
 * detected in. Only this window's agents can be closed.
 */
async function closeAgent(node?: AgentNode): Promise<void> {
  if (node?.kind !== 'agent' || node.remote) {
    return;
  }
  const { agent } = node;
  const what = node.terminal
    ? `the terminal "${node.terminal.name}"`
    : 'its herdr pane';
  const answer = await vscode.window.showWarningMessage(
    `Close ${agent.agent}? This ends ${what} and anything running in it.`,
    { modal: true },
    'Close'
  );
  if (answer !== 'Close') {
    return;
  }
  if (node.terminal) {
    node.terminal.dispose();
    return;
  }
  let closed = false;
  if (node.session !== undefined) {
    const session = agentTree.hostSession(node.session);
    closed = !!session && (await closeHostHerdrPane(session, agent.paneId));
  } else if (node.ssh) {
    closed = await closeHerdrPane(
      sshShell(node.ssh.host),
      remoteSessionName(),
      agent.paneId
    );
  } else if (node.container) {
    closed = await closeHerdrPane(
      await containerShell(node.container.id),
      CONTAINER_SESSION,
      agent.paneId
    );
  }
  if (!closed) {
    vscode.window.showErrorMessage(`Could not close ${agent.agent} in herdr.`);
  }
}

/**
 * Close a container's terminals, then run `devc stop` or `devc down` for it
 * from the host folder they were opened in. devc is usually a shell function,
 * so it runs in a terminal's interactive shell rather than as a child process.
 */
async function shutDownContainer(
  node: AgentNode | undefined,
  action: 'stop' | 'down'
): Promise<void> {
  if (node?.kind !== 'container' || node.remote) {
    return;
  }
  const { container } = node;
  const answer = await vscode.window.showWarningMessage(
    action === 'stop'
      ? `Stop ${container.name}? Its terminals are closed and every agent in it ends.`
      : `Take down ${container.name}? Its terminals are closed, every agent in it ends, and the container is removed.`,
    { modal: true },
    action === 'stop' ? 'Stop' : 'Down'
  );
  if (!answer) {
    return;
  }
  let cwd: string | undefined;
  for (const terminal of [...vscode.window.terminals]) {
    if (
      isContainerTerminal(terminal) &&
      (await resolveTerminalContext(terminal))?.containerId === container.id
    ) {
      cwd ??= terminalCwd(terminal);
      terminal.dispose();
    }
  }
  const t = vscode.window.createTerminal({
    name: `devc ${action}`,
    cwd: cwd ?? container.localFolder,
    iconPath: CONTAINER_ICON,
    // See openContainerTerminal.
    hideFromUser: true,
  });
  t.show();
  t.sendText(getContainerCommand(action));
}

/**
 * Close this window's terminals attached to a host herdr session, stop the
 * session, and with `remove`, delete it too.
 */
async function shutDownSession(
  node: AgentNode | undefined,
  remove: boolean
): Promise<void> {
  if (node?.kind === 'ssh' && !node.remote) {
    await shutDownSshSession(node.host, remove);
    return;
  }
  const session =
    node?.kind === 'host' && !node.remote
      ? agentTree.workspaceHostSession()
      : undefined;
  if (!session) {
    return;
  }
  const label = session.default
    ? 'the default herdr session'
    : `herdr session "${session.name}"`;
  const answer = await vscode.window.showWarningMessage(
    remove
      ? `Delete ${label}? Its terminals are closed, every agent in it ends, and its saved state is removed.`
      : `Stop ${label}? Its terminals are closed and every agent in it ends.`,
    { modal: true },
    remove ? 'Delete' : 'Stop'
  );
  if (!answer) {
    return;
  }
  for (const terminal of [...vscode.window.terminals]) {
    if (
      !isRemoteTerminal(terminal) &&
      (await isHostClient(terminal, session))
    ) {
      terminal.dispose();
    }
  }
  const stopError = await stopHostSession(session.name);
  const deleteError =
    !stopError && remove ? await deleteHostSession(session.name) : undefined;
  if (stopError) {
    vscode.window.showErrorMessage(`Could not stop ${label}: ${stopError}`);
  } else if (deleteError) {
    vscode.window.showErrorMessage(
      `Stopped ${label} but could not delete it: ${deleteError}`
    );
  }
  scheduleSessionSync();
}

/**
 * Close this window's SSH terminals to a host, stop this window's herdr
 * session there, and with `remove`, delete it too. The host itself is left
 * as it is.
 */
async function shutDownSshSession(host: string, remove: boolean): Promise<void> {
  const name = remoteSessionName();
  const label = `herdr session "${name}" on ${sshLabel(host)}`;
  const answer = await vscode.window.showWarningMessage(
    remove
      ? `Delete ${label}? Its terminals are closed, every agent in it ends, and its saved state is removed.`
      : `Stop ${label}? Its terminals are closed and every agent in it ends.`,
    { modal: true },
    remove ? 'Delete' : 'Stop'
  );
  if (!answer) {
    return;
  }
  for (const terminal of sshTerminals(host)) {
    terminal.dispose();
  }
  const shell = sshShell(host);
  const stopError = await runSessionCommand(shell, ['session', 'stop', name]);
  const deleteError =
    !stopError && remove
      ? await runSessionCommand(shell, ['session', 'delete', name])
      : undefined;
  if (stopError) {
    vscode.window.showErrorMessage(`Could not stop ${label}: ${stopError}`);
  } else if (deleteError) {
    vscode.window.showErrorMessage(
      `Stopped ${label} but could not delete it: ${deleteError}`
    );
  }
}

/** How long a newly opened terminal gets to bring herdr up. */
const HERDR_ATTACH_TIMEOUT_MS = 20000;

/**
 * Resolves true once `program` is in the foreground of a terminal's pty,
 * false if the terminal closes or `timeoutMs` passes first.
 */
function waitForForeground(
  terminal: vscode.Terminal,
  program: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const check = () => {
      if (terminalAgents.foregroundFor(terminal) === program) {
        resolve(true);
      } else if (terminal.exitStatus || Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(check, 250);
      }
    };
    check();
  });
}

// ── Tool detection ──────────────────────────────────────────────────────────

/** Which optional host tools are here, as of the last check. */
interface ToolState {
  docker: boolean;
  hostHerdr: boolean;
  devc: boolean;
}

/** Settings holding a command typed into a terminal; each defaults to devc. */
const COMMAND_SETTINGS = [
  'openFolderCommand',
  'herdrAttachCommand',
  'stopCommand',
  'downCommand',
] as const;

/** Settings that change what the checks find or what they mean. */
const TOOL_SETTINGS = ['dockerPath', 'sshHosts', ...COMMAND_SETTINGS];

/** Regaining focus re-checks the tools at most this often. */
const TOOL_RECHECK_MS = 30000;

let toolDetection: Promise<ToolState> | undefined;
let lastToolDetection = 0;

/**
 * Check which tools are here, then publish the result to menus (context
 * keys) and the Agents view. A later check's result wins.
 */
function detectTools(): Promise<ToolState> {
  lastToolDetection = Date.now();
  const run = (async (): Promise<ToolState> => {
    const [docker, hostHerdr, devcPath] = await Promise.all([
      dockerInstalled(getDockerCommand()),
      hostHerdrInstalled(),
      findDevc(),
    ]);
    return { docker, hostHerdr, devc: devcPath !== undefined };
  })();
  toolDetection = run;
  run.then(state => {
    if (toolDetection === run) {
      applyTools(state);
    }
  });
  return run;
}

/** The latest tool check, starting one if none has run. */
function currentTools(): Promise<ToolState> {
  return toolDetection ?? detectTools();
}

function applyTools(state: ToolState): void {
  const keys: Record<string, boolean> = {
    'devc-vscode.hasDocker': state.docker,
    'devc-vscode.hasHostHerdr': state.hostHerdr,
    'devc-vscode.hasSshHosts': getSshHosts().length > 0,
    'devc-vscode.canOpenFolder': commandSettingAvailable(
      'openFolderCommand',
      state
    ),
    'devc-vscode.canStop': commandSettingAvailable('stopCommand', state),
    'devc-vscode.canDown': commandSettingAvailable('downCommand', state),
  };
  for (const [key, value] of Object.entries(keys)) {
    vscode.commands.executeCommand('setContext', key, value);
  }
  agentTree.setMissingTools({
    hostHerdr: hostHerdrSupported() && !state.hostHerdr,
    docker: !state.docker,
  });
}

/**
 * Whether a command setting will run: set by the user, or the default with
 * devc here to run it.
 */
function commandSettingAvailable(
  key: (typeof COMMAND_SETTINGS)[number],
  state: ToolState
): boolean {
  return commandAvailable(
    vscode.workspace.getConfiguration('devc-vscode').inspect<string>(key),
    state.devc
  );
}

// ── Docker events watcher ───────────────────────────────────────────────────

function startDockerEventsWatcher(): void {
  const docker = getDockerCommand();
  const child = cp.spawn(
    docker,
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
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  dockerEventsProcess = child;

  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        handleDockerEvent(line).catch(err => {
          console.error('devc-vscode: event handling error', err);
        });
      }
    }
  });

  child.on('error', err => {
    console.error('devc-vscode: docker events error', err.message);
  });

  child.on('close', () => {
    dockerEventsProcess = undefined;
  });
}

async function handleDockerEvent(jsonLine: string): Promise<void> {
  let event: { Type?: string; Action?: string };
  try {
    event = JSON.parse(jsonLine);
  } catch {
    return;
  }
  if (event.Type !== 'container') {
    return;
  }

  // The container set changed — cached terminal lookups are no longer trusted.
  terminalContainerCache.clear();

  if (event.Action === 'start') {
    // A container may not accept `exec` the instant it reports as started.
    await new Promise(r => setTimeout(r, 500));
  }
  treeProvider.refresh();
  syncAgents();
  syncAttached();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Whether a terminal was opened by "Open Folder in Container". */
function isContainerTerminal(terminal: vscode.Terminal): boolean {
  const opts = terminal.creationOptions;
  return 'name' in opts && opts.name === 'devcontainer';
}

/**
 * Whether a terminal's command runs in a container or on an SSH host,
 * rather than on the host — its foreground there is not the host's.
 */
function isRemoteTerminal(terminal: vscode.Terminal): boolean {
  return isContainerTerminal(terminal) || isSshTerminal(terminal);
}

/**
 * A shell in a container as the user the devcontainer CLI execs as — herdr's
 * socket lives in their home.
 */
async function containerShell(containerId: string): Promise<DockerShell> {
  const docker = getDockerCommand();
  return new DockerShell(
    containerId,
    await getRemoteUser(containerId, docker),
    docker
  );
}

function getDockerCommand(): string {
  return (
    vscode.workspace
      .getConfiguration('devc-vscode')
      .get<string>('dockerPath') || 'docker'
  );
}

/** Command sent to the terminal by "Open Folder in Container". */
function getOpenFolderCommand(): string {
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string>('openFolderCommand');
  return configured && configured.trim() !== '' ? configured : 'devc herdr';
}

/**
 * Command that opens a terminal attached to herdr in the container, used when
 * a herdr agent is focused and no terminal is showing herdr.
 */
function getHerdrAttachCommand(): string {
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string>('herdrAttachCommand');
  return configured && configured.trim() !== '' ? configured : 'devc herdr';
}

/** Agents Add Agent offers, as herdr `--kind` values. */
function getAgentKinds(): string[] {
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string[]>('agentKinds');
  return (configured ?? []).map(kind => kind.trim()).filter(Boolean);
}

/** Command run by the Agents view's stop or down action on a container. */
function getContainerCommand(action: 'stop' | 'down'): string {
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string>(`${action}Command`);
  return configured && configured.trim() !== '' ? configured : `devc ${action}`;
}

/** The host folder a terminal was opened in. */
function terminalCwd(terminal: vscode.Terminal): string | undefined {
  const opts = terminal.creationOptions;
  const cwd = 'cwd' in opts ? opts.cwd : undefined;
  return typeof cwd === 'string' ? cwd : cwd?.fsPath;
}

/** Return the fsPath of all file:// workspace folders. */
function getHostFolders(): string[] {
  return (
    vscode.workspace.workspaceFolders
      ?.filter(f => f.uri.scheme === 'file')
      .map(f => f.uri.fsPath) ?? []
  );
}

/**
 * The directory that stands for this window on the host: the one its saved
 * workspace file is in, else its first folder.
 */
function workspaceDir(): string | undefined {
  const file = vscode.workspace.workspaceFile;
  return file?.scheme === 'file'
    ? path.dirname(file.fsPath)
    : getHostFolders()[0];
}

/** The host environment's label: the name of workspaceDir. */
function hostName(): string {
  const dir = workspaceDir();
  return (dir && path.basename(dir)) || 'Host';
}

/**
 * The host herdr session that belongs to this window: the herdrSession
 * setting when set, else the name `herdrs` gives workspaceDir.
 */
function workspaceSessionName(): string | undefined {
  if (!hostHerdrSupported()) {
    return undefined;
  }
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string>('herdrSession')
    ?.trim();
  if (configured) {
    return configured;
  }
  const dir = workspaceDir();
  return dir ? sessionNameForDir(dir) : undefined;
}

/** Cache of host folder -> terminal context, cleared on docker events. */
const terminalContainerCache = new Map<string, TerminalContext | undefined>();

/**
 * The container backing a "devcontainer" terminal plus the facts needed to
 * resolve paths printed in it, resolved from the terminal's host cwd.
 */
async function resolveTerminalContext(
  terminal: vscode.Terminal
): Promise<TerminalContext | undefined> {
  const hostFolder = terminalCwd(terminal);
  if (!hostFolder) {
    return undefined;
  }

  if (terminalContainerCache.has(hostFolder)) {
    return terminalContainerCache.get(hostFolder);
  }

  const docker = getDockerCommand();
  const containerId = await findContainerForHostFolder(hostFolder, docker);
  const resolved = containerId
    ? {
        containerId,
        // Relative paths resolve against wherever this host folder is mounted
        // inside the container. The terminal's own shell may have cd'd
        // elsewhere, which we cannot see — that is an accepted edge case.
        cwd: (await findMatchingBindMount(containerId, hostFolder, docker))
          ?.destPath,
        home: await getContainerHome(containerId, docker),
      }
    : undefined;

  // A miss is only cached while docker events can invalidate it. Without that
  // watcher the cache would never clear and links would stay dead all session.
  if (resolved || dockerEventsProcess) {
    terminalContainerCache.set(hostFolder, resolved);
  }
  return resolved;
}

/** Where to put the cursor for a link carrying a :line:col suffix. */
function selectionFor(
  line: number | undefined,
  column: number | undefined
): vscode.Range | undefined {
  if (line === undefined) {
    return undefined;
  }
  // Terminal output counts from 1, vscode.Position counts from 0.
  const position = new vscode.Position(
    Math.max(0, line - 1),
    Math.max(0, (column ?? 1) - 1)
  );
  return new vscode.Range(position, position);
}

// ── SSH hosts ───────────────────────────────────────────────────────────────

/** Marks an SSH terminal, naming its host, in its creation options. */
const SSH_HOST_ENV = 'DEVC_SSH_HOST';

/** Invalid devc-vscode.sshHosts entries already reported this session. */
const reportedSshEntries = new Set<string>();

/**
 * The configured SSH hosts. sshHosts is application-scoped, so this is only
 * ever the user's settings — a workspace cannot add a host.
 */
function getSshHosts(): SshHostInfo[] {
  const { hosts, invalid } = parseSshHosts(
    vscode.workspace.getConfiguration('devc-vscode').get('sshHosts')
  );
  for (const host of invalid) {
    if (!reportedSshEntries.has(host)) {
      reportedSshEntries.add(host);
      vscode.window.showWarningMessage(
        `devc-vscode.sshHosts: ignoring invalid entry "${host}"`
      );
    }
  }
  return hosts;
}

/** A configured host, compared case-insensitively. */
function sshHostInfo(host: string): SshHostInfo | undefined {
  const key = host.toLowerCase();
  return getSshHosts().find(info => info.host.toLowerCase() === key);
}

function isConfiguredHost(host: string): boolean {
  return !!host && sshHostInfo(host) !== undefined;
}

function sshLabel(host: string): string {
  return sshHostInfo(host)?.label ?? host;
}

function getSshPath(): string {
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string>('sshPath');
  return configured && configured.trim() !== '' ? configured.trim() : 'ssh';
}

let controlDir: { dir: string | undefined } | undefined;

/** Where ssh multiplexing sockets go; undefined runs without multiplexing. */
function getControlDir(): string | undefined {
  if (!controlDir) {
    controlDir = { dir: ensureControlDir() };
    if (!controlDir.dir) {
      agentLog?.warn(
        'ssh control directory is missing or not private to this user; ssh runs without connection sharing'
      );
    }
  }
  return controlDir.dir;
}

/** A shell on a configured SSH host; it refuses any other host. */
function sshShell(host: string): SshShell {
  return new SshShell(sshHostInfo(host)?.host ?? host, {
    sshPath: getSshPath(),
    controlDir: getControlDir(),
    allowed: isConfiguredHost,
  });
}

/** Remote homes, by host, resolved once per session. */
const sshHomes = new Map<string, Promise<string>>();

function sshHome(host: string): Promise<string> {
  let home = sshHomes.get(host);
  if (!home) {
    home = (async () => {
      const res = await sshShell(host).run(['sh', '-c', 'printf %s "$HOME"']);
      const out = res.stdout.toString('utf8').trim();
      if (res.exitCode !== 0 || !out.startsWith('/')) {
        throw new Error(
          res.stderr.toString('utf8').trim() ||
            `${host}: could not read the remote home`
        );
      }
      return out;
    })();
    sshHomes.set(host, home);
    // A failure is not remembered: the host may come back.
    home.catch(() => sshHomes.delete(host));
  }
  return home;
}

/** A host's effective root: its configured root, else the remote home. */
async function sshRoot(host: string): Promise<string> {
  const info = sshHostInfo(host);
  if (!info) {
    throw new Error(`"${host}" is not a configured SSH host`);
  }
  return info.root ?? sshHome(info.host);
}

async function sshReachable(host: string): Promise<boolean> {
  try {
    return (
      (await sshShell(host).run(['true'], { timeoutMs: 10000 })).exitCode === 0
    );
  } catch {
    return false;
  }
}

/**
 * The herdr session this window uses on every SSH host: the herdrSession
 * setting, else the name `herdrs` gives workspaceDir — like the host's
 * workspace session, since one host serves many windows — else devc.
 */
function remoteSessionName(): string {
  const configured = vscode.workspace
    .getConfiguration('devc-vscode')
    .get<string>('herdrSession')
    ?.trim();
  if (configured) {
    return configured;
  }
  const dir = workspaceDir();
  return (dir && sessionNameForDir(dir)) || CONTAINER_SESSION;
}

let sshAllowed = true;

function syncSsh(): void {
  if (sshAllowed) {
    agentTree.syncSsh();
  }
}

/** The configured host an SSH terminal is on, if it is one. */
function sshTerminalHost(terminal: vscode.Terminal): string | undefined {
  const opts = terminal.creationOptions;
  const host = 'env' in opts ? opts.env?.[SSH_HOST_ENV] : undefined;
  return typeof host === 'string' ? sshHostInfo(host)?.host : undefined;
}

function isSshTerminal(terminal: vscode.Terminal): boolean {
  return sshTerminalHost(terminal) !== undefined;
}

/** This window's open SSH terminals to a host, oldest first. */
function sshTerminals(host: string): vscode.Terminal[] {
  const key = host.toLowerCase();
  return vscode.window.terminals.filter(
    t => !t.exitStatus && sshTerminalHost(t)?.toLowerCase() === key
  );
}

/**
 * Open an SSH terminal in an editor tab, attached to this window's herdr
 * session on the host, as container terminals are.
 */
function openSshTerminal(host: string): vscode.Terminal {
  const info = sshHostInfo(host) ?? { host, label: host };
  const t = vscode.window.createTerminal({
    name: `ssh ${info.label}`,
    iconPath: SSH_ICON,
    location: vscode.TerminalLocation.Editor,
    isTransient: true,
    // See openContainerTerminal.
    hideFromUser: true,
    env: { [SSH_HOST_ENV]: info.host },
  });
  t.show();
  t.sendText(
    sshTerminalCommand(
      getSshPath(),
      info.host,
      info.root,
      remoteSessionName(),
      getControlDir()
    )
  );
  rememberTerminal(t, { kind: 'ssh', host: info.host });
  return t;
}

/** Show this window's oldest SSH terminal to a host, else open one. */
function showSshTerminal(host: string): void {
  const existing = sshTerminals(host)[0];
  if (existing) {
    existing.show();
  } else {
    openSshTerminal(host);
  }
}

/** Resolve paths printed in a container or SSH terminal. */
async function linkContext(
  terminal: vscode.Terminal
): Promise<LinkContext | undefined> {
  const host = sshTerminalHost(terminal);
  if (host !== undefined) {
    const [home, cwd] = await Promise.all([
      sshHome(host).catch(() => undefined),
      sshRoot(host).catch(() => undefined),
    ]);
    return {
      home,
      cwd,
      uriFor: p =>
        vscode.Uri.from({ scheme: SSH_SCHEME, authority: host, path: p }),
    };
  }
  if (!isContainerTerminal(terminal)) {
    return undefined;
  }
  const context = await resolveTerminalContext(terminal);
  return (
    context && {
      home: context.home,
      cwd: context.cwd,
      uriFor: p => containerUri(context.containerId, p),
    }
  );
}

/**
 * Pick an alias from ~/.ssh/config that is not configured yet and add it to
 * the user-level devc-vscode.sshHosts.
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
  const config = vscode.workspace.getConfiguration('devc-vscode');
  // Not get(): that would fold in the default.
  const current = config.inspect<unknown[]>('sshHosts')?.globalValue ?? [];
  await config.update(
    'sshHosts',
    [...current, root.trim() ? { host, root: root.trim() } : { host }],
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Remove devc-ssh workspace folders someone added by hand. This is cleanup,
 * not prevention: VS Code may already have read the folder's settings.
 * Resolves whether SSH may be used in this window — not when its only folder
 * is an SSH folder, which cannot be removed.
 */
function guardWorkspaceFolders(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const ssh = folders.filter(f => f.uri.scheme === SSH_SCHEME);
  if (!ssh.length) {
    return sshAllowed;
  }
  if (folders.length === 1) {
    sshAllowed = false;
    vscode.window.showErrorMessage(
      'This window has an SSH folder as its workspace. Close it and browse the host from the Sandboxes view.',
      { modal: true }
    );
    return false;
  }
  // One at a time, highest index first: only one folder change can be
  // pending, and the change event runs this again for the next. Removing
  // folder 0 restarts the extension host, which runs this again and finds
  // nothing.
  const last = ssh.reduce((a, b) => (b.index > a.index ? b : a));
  vscode.workspace.updateWorkspaceFolders(last.index, 1);
  vscode.window.showWarningMessage(
    'SSH folders cannot be workspace folders — use the Sandboxes view instead.'
  );
  return sshAllowed;
}
