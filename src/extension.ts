import * as cp from 'child_process';
import * as path from 'path';
import * as posix from 'path/posix';
import * as vscode from 'vscode';
import {
  AgentNode,
  AgentTreeDataProvider,
  CONTAINER_ICON,
  SESSION_ICON,
  folderOf,
} from './agentTree';
import { DevContainerFileSystemProvider } from './devcontainerFs';
import {
  ContainerNode,
  ContainerTreeDataProvider,
  DockerContainerSource,
  SCHEME,
  WorkspaceFileOps,
  containerUri,
  findContainerForHostFolder,
  findMatchingBindMount,
  getContainerHome,
} from './containerTree';
import {
  AgentInfo,
  closeHerdrPane,
  focusHerdrAgent,
  getRemoteUser,
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

class DevContainerTerminalLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    length: number,
    tooltip: string,
    /** `path` is already absolute inside the container. */
    public readonly data: {
      path: string;
      containerId: string;
      line?: number;
      column?: number;
    }
  ) {
    super(startIndex, length, tooltip);
  }
}

let provider: DevContainerFileSystemProvider;
let treeProvider: ContainerTreeDataProvider;
let treeView: vscode.TreeView<ContainerNode>;
let agentTree: AgentTreeDataProvider;
let terminalAgents: TerminalAgentTracker;
let windows: WindowRegistry;
let dockerEventsProcess: cp.ChildProcess | undefined;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  provider = new DevContainerFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
    })
  );

  treeProvider = new ContainerTreeDataProvider(
    new DockerContainerSource(getDockerCommand, getHostFolders),
    new WorkspaceFileOps()
  );
  treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const agentLog = vscode.window.createOutputChannel('Agents', {
    log: true,
  });
  context.subscriptions.push(agentLog);
  // Session ownership and host terminal agent detection both poll host
  // terminals' foregrounds; they share one reading per terminal.
  const hostForegrounds = new HostForegroundCache();
  agentTree = new AgentTreeDataProvider(
    new DockerContainerSource(getDockerCommand, getHostFolders),
    watchContainerAgents,
    {
      list: listHostSessions,
      async foregrounds() {
        const found = await Promise.all(
          vscode.window.terminals
            .filter(t => !isContainerTerminal(t))
            .map(t => hostForegrounds.get(t))
        );
        return found.flatMap(fg => (fg ? [fg.args] : []));
      },
      folders: getHostFolders,
      workspaceSession: workspaceSessionName,
      read: readHostSession,
      watch: watchHostSession,
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
      syncAgents();
      syncSessions();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('devc-vscode.herdrSession')) {
        syncSessions();
      }
    }),
    // Which host sessions this window owns follows its terminals: re-check
    // when one opens, closes, or starts or ends a command (e.g. `herdr`).
    vscode.window.onDidOpenTerminal(() => {
      scheduleSessionSync();
      syncAttached();
    }),
    vscode.window.onDidCloseTerminal(() => {
      scheduleSessionSync();
      syncAttached();
    }),
    vscode.window.onDidStartTerminalShellExecution(() =>
      scheduleSessionSync()
    ),
    vscode.window.onDidEndTerminalShellExecution(() => scheduleSessionSync()),
    (terminalAgents = new TerminalAgentTracker({
      isContainerTerminal,
      async resolveContainer(terminal) {
        const context = await resolveTerminalContext(terminal);
        return context
          ? {
              id: context.containerId,
              user: await getRemoteUser(
                context.containerId,
                getDockerCommand()
              ),
            }
          : undefined;
      },
      probe: (id, user) => probeContainer(id, user, getDockerCommand()),
      classify: (id, user, agent, screen) =>
        classifyScreen(id, user, agent, screen, getDockerCommand()),
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
  syncAgents();
  syncSessions();
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

  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler as never)
    );

  register('devc-vscode.refresh', () => treeProvider.refresh());
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
  register('devc-vscode.attachAgentGroup', (node?: AgentNode) =>
    attachAgentGroup(node)
  );
  register('devc-vscode.attachTerminal', (node?: ContainerNode) =>
    attachTerminal(node)
  );
  register('devc-vscode.openFolderInContainer', (uri: vscode.Uri) =>
    openFolderInContainer(uri)
  );

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      async provideTerminalLinks(context) {
        // Only activate for terminals created by our "Open in Dev Container" command.
        if (!isContainerTerminal(context.terminal)) {
          return [];
        }
        const terminalContext = await resolveTerminalContext(context.terminal);
        if (!terminalContext) {
          return [];
        }
        // Relative paths resolve against the shell's real working directory
        // once the tracker has found the terminal's pty, and against the
        // project mount until then.
        const liveCwd = terminalAgents.cwdFor(context.terminal);
        const pathContext = liveCwd
          ? { ...terminalContext, cwd: liveCwd }
          : terminalContext;
        const { containerId } = terminalContext;
        const links: DevContainerTerminalLink[] = [];
        for (const candidate of findPathCandidates(context.line)) {
          const resolved = resolveCandidatePath(candidate.raw, pathContext);
          if (resolved === undefined) {
            // A ~ with no known home, or a relative path with no known base.
            continue;
          }
          try {
            await provider.stat(containerUri(containerId, resolved));
          } catch {
            // Not a path in this container — leave it as plain text.
            continue;
          }
          links.push(
            new DevContainerTerminalLink(
              candidate.startIndex,
              candidate.length,
              'Open in Dev Container',
              {
                path: resolved,
                containerId,
                line: candidate.line,
                column: candidate.column,
              }
            )
          );
        }
        return links;
      },
      async handleTerminalLink(link) {
        const {
          path: filePath,
          containerId,
          line,
          column,
        } = (link as DevContainerTerminalLink).data;
        const uri = containerUri(containerId, filePath);
        try {
          const stat = await provider.stat(uri);
          if (stat.type === vscode.FileType.Directory) {
            await revealInTree(containerId, filePath);
            return;
          }
        } catch {
          // Fall through and let the editor report the failure.
        }
        vscode.window.showTextDocument(uri, {
          selection: selectionFor(line, column),
        });
      },
    })
  );

  // Watch for container start/stop events so roots appear and vanish live.
  startDockerEventsWatcher();
  syncAttached();
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
function directoryOf(node: ContainerNode): vscode.Uri {
  if (node.kind === 'file') {
    return containerUri(node.containerId, posix.dirname(node.uri.path));
  }
  return node.uri;
}

async function createEntry(
  node: ContainerNode | undefined,
  kind: 'file' | 'folder'
): Promise<void> {
  const target = targetNode(node);
  if (!target) {
    return;
  }
  const parent = directoryOf(target);
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
  if (!target || target.kind === 'container') {
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
  if (!target || target.kind === 'container') {
    return;
  }
  // Multi-select only applies when the invoked node is part of the selection —
  // a context menu on an unselected node acts on that node alone.
  const selection = treeView.selection.filter(n => n.kind !== 'container');
  const nodes = selection.some(n => n.uri.toString() === target.uri.toString())
    ? selection
    : [target];

  const label =
    nodes.length === 1
      ? `'${posix.basename(nodes[0].uri.path)}'`
      : `${nodes.length} items`;
  const answer = await vscode.window.showWarningMessage(
    `Delete ${label}? This cannot be undone — the container has no trash.`,
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
  if (!target) {
    return;
  }
  await vscode.env.clipboard.writeText(target.uri.path);
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

/** Focus the container tree and select `targetPath` in it. */
async function revealInTree(
  containerId: string,
  targetPath: string
): Promise<void> {
  // reveal needs the view resolved first; `<viewId>.focus` is generated by
  // VS Code from the view contribution and is not declared in package.json.
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  const node = await treeProvider.nodeFor(containerId, targetPath);
  try {
    await treeView.reveal(node, { select: true, focus: true, expand: true });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not show ${targetPath}: ${(err as Error).message}`
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

/**
 * Open a container terminal in an editor tab, running `command` from the host
 * folder `cwd`. The terminal is recognised by its name and resolved to its
 * container by its cwd.
 */
function openContainerTerminal(
  cwd: string | undefined,
  command: string
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
  return t;
}

/**
 * Show a container's terminal, opening one from its host folder when there
 * is none.
 */
async function attachTerminal(node?: ContainerNode): Promise<void> {
  const target = node ?? treeView.selection[0];
  if (target?.kind !== 'container') {
    return;
  }
  const existing = await containerTerminals(target.containerId);
  if (existing.length) {
    existing[0].show();
    return;
  }
  openContainerTerminal(target.localFolder, getOpenFolderCommand());
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

/** Tell the container tree which containers have a terminal open on them. */
function syncAttached(): void {
  const run = ++attachedSync;
  (async () => {
    const ids = new Set<string>();
    for (const terminal of vscode.window.terminals) {
      if (isContainerTerminal(terminal) && !terminal.exitStatus) {
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
  onAgents: Parameters<typeof watchHerdr>[3],
  onExit: () => void
): { dispose(): void } {
  const docker = getDockerCommand();
  let watcher: { dispose(): void } | undefined;
  let disposed = false;
  getRemoteUser(containerId, docker).then(user => {
    if (!disposed) {
      watcher = watchHerdr(containerId, user, docker, onAgents, onExit);
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
  // Reveal the terminal attached to herdr in that container: the one whose
  // pty has herdr in the foreground. Before the tracker has found a
  // terminal's pty (or for terminals opened before the extension loaded), its
  // foreground is unknown and it is the best guess. Terminals known to be
  // running something else cannot show herdr.
  const containerId = node.container.id;
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
    const terminal = openContainerTerminal(
      node.container.localFolder,
      getHerdrAttachCommand()
    );
    await waitForForeground(terminal, 'herdr', HERDR_ATTACH_TIMEOUT_MS);
  }
  const docker = getDockerCommand();
  const user = await getRemoteUser(containerId, docker);
  if (!(await focusHerdrAgent(containerId, user, node.agent, docker))) {
    vscode.window.showErrorMessage(
      `Could not focus ${node.agent.agent} in herdr.`
    );
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
 * Show a terminal on an Agents view group: a client of a host session, or a
 * container terminal, opening one attached to herdr when there is none.
 */
async function attachAgentGroup(node?: AgentNode): Promise<void> {
  if (node?.kind === 'session' && node.host) {
    const session = node.host;
    const existing = await findHostClient(session);
    if (existing) {
      existing.show();
      return;
    }
    openHostHerdrTerminal(session, workspaceDir());
  } else if (node?.kind === 'container' && !node.remote) {
    const existing = await containerTerminals(node.container.id);
    if (existing.length) {
      existing[0].show();
      return;
    }
    openContainerTerminal(node.container.localFolder, getHerdrAttachCommand());
  }
}

/** A host terminal in this window with a client of `session` in front. */
async function findHostClient(
  session: HostSession
): Promise<vscode.Terminal | undefined> {
  for (const terminal of vscode.window.terminals) {
    if (
      !isContainerTerminal(terminal) &&
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
  return t;
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
  } else if (node.container) {
    const docker = getDockerCommand();
    const user = await getRemoteUser(node.container.id, docker);
    closed = await closeHerdrPane(
      node.container.id,
      user,
      agent.paneId,
      docker
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
  if (node?.kind !== 'session' || !node.host) {
    return;
  }
  const session = node.host;
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
      !isContainerTerminal(terminal) &&
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

/**
 * The host herdr session that belongs to this window: the herdrSession
 * setting when set, else the name `herdrs` gives workspaceDir.
 */
function workspaceSessionName(): string | undefined {
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
