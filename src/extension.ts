import * as cp from 'child_process';
import * as path from 'path';
import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { AgentNode, AgentTreeDataProvider } from './agentTree';
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
import { focusHerdrAgent, getRemoteUser, watchHerdr } from './herdr';
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

  const agentLog = vscode.window.createOutputChannel('Dev Container Agents', {
    log: true,
  });
  context.subscriptions.push(agentLog);
  agentTree = new AgentTreeDataProvider(
    new DockerContainerSource(getDockerCommand, getHostFolders),
    watchContainerAgents
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncAgents()),
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
      log: message => agentLog.info(message),
    }))
  );
  syncAgents();

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
  register('devc-vscode.newFile', (node?: ContainerNode) =>
    createEntry(node, 'file')
  );
  register('devc-vscode.newFolder', (node?: ContainerNode) =>
    createEntry(node, 'folder')
  );
  register('devc-vscode.rename', (node?: ContainerNode) => renameEntry(node));
  register('devc-vscode.delete', (node?: ContainerNode) => deleteEntries(node));
  register('devc-vscode.copyPath', (node?: ContainerNode) => copyPath(node));
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
    location: vscode.TerminalLocation.Editor,
    isTransient: true,
    hideFromUser: true,
  });
  t.show();
  t.sendText(command);
  return t;
}

// ── Agents ──────────────────────────────────────────────────────────────────

function syncAgents(): void {
  agentTree.sync().catch(err => {
    console.error('devc-vscode: agent sync error', err);
  });
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
    containers: agentTree.snapshotContainers(),
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
  if (!(await focusHerdrAgent(containerId, user, node.agent.paneId, docker))) {
    vscode.window.showErrorMessage(
      `Could not focus ${node.agent.agent} in herdr.`
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

/** Return the fsPath of all file:// workspace folders. */
function getHostFolders(): string[] {
  return (
    vscode.workspace.workspaceFolders
      ?.filter(f => f.uri.scheme === 'file')
      .map(f => f.uri.fsPath) ?? []
  );
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
  const opts = terminal.creationOptions;
  const cwd = 'cwd' in opts ? opts.cwd : undefined;
  if (!cwd) {
    return undefined;
  }
  const hostFolder = typeof cwd === 'string' ? cwd : cwd.fsPath;

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
