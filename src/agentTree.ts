import * as path from 'path';
import * as vscode from 'vscode';
import { ContainerInfo, ContainerSource } from './containerTree';
import { AgentInfo, AgentStatus } from './herdr';
import { HostSession, sessionFromClientArgs } from './hostHerdr';
import {
  PublishedAgent,
  PublishedGroup,
  WindowSnapshot,
} from './windowRegistry';

interface AgentNodeBase {
  kind: 'agent';
  agent: AgentInfo;
  /** Set for an agent another window owns. */
  remote?: { window: WindowSnapshot; published: PublishedAgent };
}

export type AgentNode =
  /** Holds this window's environments. */
  | { kind: 'workspace' }
  /** Holds other VS Code windows' environments. */
  | { kind: 'otherWorkspaces' }
  /**
   * A window's host: its host herdr sessions and plain host terminals. Its
   * actions act on the window's workspace session.
   */
  | {
      kind: 'host';
      /** The window's workspace folder name. */
      name: string;
      remote?: WindowSnapshot;
    }
  /** A running dev container, with its herdr's and terminals' agents. */
  | {
      kind: 'container';
      container: ContainerInfo;
      remote?: WindowSnapshot;
    }
  | (AgentNodeBase & {
      container: ContainerInfo;
      session?: undefined;
      local?: undefined;
      /** Set when detected from a terminal's output rather than by herdr. */
      terminal?: vscode.Terminal;
    })
  | (AgentNodeBase & {
      /** The host herdr session the agent runs in. */
      session: string;
      container?: undefined;
      local?: undefined;
      terminal?: undefined;
    })
  | (AgentNodeBase & {
      /**
       * Runs in a plain host terminal. Another window's host agents are all
       * published this way, herdr's included, since only that window can act
       * on them.
       */
      local: true;
      container?: undefined;
      session?: undefined;
      /** Always set for this window's agents. */
      terminal?: vscode.Terminal;
    });

/** A host or container under one of the roots. */
type EnvNode = Extract<AgentNode, { kind: 'host' | 'container' }>;

export const WORKSPACE: AgentNode = { kind: 'workspace' };
export const OTHER_WORKSPACES: AgentNode = { kind: 'otherWorkspaces' };

/**
 * Starts streaming one container's agents. Injected so the tree can be
 * exercised without Docker — see watchHerdr for the real thing.
 */
export type WatchAgents = (
  containerId: string,
  /** `running` is false while herdr's server is not up; true if omitted. */
  onAgents: (agents: AgentInfo[], running?: boolean) => void,
  onExit: () => void
) => { dispose(): void };

interface Watched {
  container: ContainerInfo;
  agents: AgentInfo[];
  /** herdr's server is up in the container. */
  running: boolean;
  watcher: { dispose(): void };
}

/**
 * herdr sessions on the host, and what this window can see of them. Injected
 * so the tree can be exercised without herdr — see hostHerdr.ts and
 * hostProcesses.ts for the real thing.
 */
export interface HostSessionSource {
  /** Running host sessions. */
  list(): Promise<HostSession[]>;
  /** Foreground command lines of this window's host terminals. */
  foregrounds(): Promise<string[]>;
  /** This window's file:// workspace folders, as host paths. */
  folders(): string[];
  /**
   * The session that belongs to this window whether or not it has agents —
   * see workspaceSessionName — if any.
   */
  workspaceSession(): string | undefined;
  /** One reading of a session's agents; undefined when it cannot be read. */
  read(session: HostSession): Promise<AgentInfo[] | undefined>;
  /** Stream a session's agents, as WatchAgents does for a container. */
  watch(
    session: HostSession,
    onAgents: (agents: AgentInfo[]) => void,
    onExit: () => void
  ): { dispose(): void };
}

interface WatchedSession {
  session: HostSession;
  agents: AgentInfo[];
  /** A terminal in this window is a client of the session. */
  attached: boolean;
  /** This window's workspace session. */
  workspace: boolean;
  watcher: { dispose(): void };
}

/** Whether `p` is `folder` or somewhere under it. */
function isUnder(p: string, folder: string): boolean {
  const rel = path.relative(folder, p);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/** The workspace folder an agent is working in, if any. */
export function folderOf(
  agent: AgentInfo,
  folders: string[]
): string | undefined {
  const cwd = agent.cwd;
  return cwd === undefined ? undefined : folders.find(f => isUnder(cwd, f));
}

/**
 * The agents of a host session this window shows. A window attached to the
 * session shows all of them; otherwise only those working in one of its
 * folders, since a session (the default one especially) can span many
 * projects. None means the window does not own the session.
 */
export function ownedAgents(
  agents: AgentInfo[],
  attached: boolean,
  folders: string[]
): AgentInfo[] {
  return attached
    ? agents
    : agents.filter(agent => folderOf(agent, folders) !== undefined);
}

/**
 * An agent's tree label: what it is working on, as its terminal title says,
 * else the folder it is in, else what it is.
 */
export function taskLabel(agent: AgentInfo): string {
  return (
    agent.title?.trim() ||
    (agent.cwd && path.posix.basename(agent.cwd)) ||
    agent.agent
  );
}

/**
 * Environment icons, shared with the terminals the extension opens so a
 * terminal tab matches the environment its agents appear under.
 */
export const CONTAINER_ICON = new vscode.ThemeIcon('remote-explorer');
export const HOST_ICON = new vscode.ThemeIcon('device-desktop');
/** Host herdr client terminals. */
export const SESSION_ICON = new vscode.ThemeIcon('terminal-tmux');
/** For a container with no herdr running to show agents from. */
const CONTAINER_ICON_IDLE = new vscode.ThemeIcon(
  'remote-explorer',
  new vscode.ThemeColor('disabledForeground')
);

/** Whether herdr manages an agent, rather than it being found in a terminal. */
function isHerdrAgent(node: AgentNode): boolean {
  if (node.kind !== 'agent') {
    return false;
  }
  return node.remote ? node.remote.published.herdr : !node.terminal;
}

/** An environment only gets a twistie when it has agents to show. */
function groupState(agents: AgentInfo[]): vscode.TreeItemCollapsibleState {
  return agents.length
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.None;
}

const STATUS_ICONS: Record<AgentStatus, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon(
    'loading~spin',
    new vscode.ThemeColor('charts.blue')
  ),
  blocked: new vscode.ThemeIcon(
    'bell-dot',
    new vscode.ThemeColor('charts.yellow')
  ),
  done: new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
  idle: new vscode.ThemeIcon('circle-outline'),
  unknown: new vscode.ThemeIcon('question'),
};

/** Statuses that want the user's attention, counted into the view badge. */
const ATTENTION: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'blocked',
  'done',
]);

/** "2 working, 1 blocked" — counts in a fixed order, zeros left out. */
export function summarize(agents: AgentInfo[]): string {
  const order: AgentStatus[] = [
    'blocked',
    'done',
    'working',
    'idle',
    'unknown',
  ];
  return order
    .map(status => [status, agents.filter(a => a.status === status).length])
    .filter(([, count]) => count)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
}

/**
 * Agents herdr is tracking in each of the workspace's dev containers, one
 * watcher per container, and in the host herdr sessions this window owns, one
 * watcher per session. A container shows while its herdr is running or it has
 * agents; a session while it is attached here, is this window's workspace
 * session, or has agents in this window's folders.
 *
 * The tree has two roots, Workspace and Other Workspaces, each holding
 * environments: a host, then the running dev containers. The host holds every
 * host session's agents and the plain host terminals' in one list.
 */
export class AgentTreeDataProvider
  implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable
{
  private readonly watched = new Map<string, Watched>();
  /** Owned host sessions, by name. */
  private readonly sessions = new Map<string, WatchedSession>();
  private folders: string[] = [];
  private defaultSession: string | undefined;
  private workspaceSession: string | undefined;
  /** The host environment's label: this window's workspace folder name. */
  private hostName = 'Host';
  /** Containers with a terminal open on them in this window. */
  private attachedContainers = new Set<string>();
  private sessionSync: Promise<void> | undefined;
  private sessionSyncAgain = false;
  private disposed = false;
  /** Agents detected from terminal output, by container then terminal. */
  private readonly terminalAgents = new Map<
    string,
    Map<vscode.Terminal, AgentInfo>
  >();
  /** Agents detected in plain host terminals, by terminal. */
  private readonly localAgents = new Map<vscode.Terminal, AgentInfo>();
  private readonly terminalIds = new WeakMap<vscode.Terminal, number>();
  private nextTerminalId = 1;
  /** Other VS Code windows' published views. */
  private others: WindowSnapshot[] = [];
  /**
   * Set by Expand All or Collapse All: every group's state until the next
   * one. Each bumps `generation`, which is folded into item ids so VS Code
   * forgets the states it remembered and takes the new ones.
   */
  private expansion?: 'expanded' | 'collapsed';
  private generation = 0;
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    AgentNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly source: ContainerSource,
    private readonly watch: WatchAgents,
    private readonly hosts?: HostSessionSource
  ) {}

  /** Start watching new containers and stop watching ones that are gone. */
  async sync(): Promise<void> {
    const containers = await this.source.listRunning();
    const live = new Set(containers.map(c => c.id));
    let changed = false;

    for (const [id, entry] of this.watched) {
      if (!live.has(id)) {
        entry.watcher.dispose();
        this.watched.delete(id);
        changed = true;
      }
    }
    for (const container of containers) {
      const existing = this.watched.get(container.id);
      if (existing) {
        existing.container = container;
        continue;
      }
      const entry: Watched = {
        container,
        agents: [],
        running: false,
        watcher: { dispose() {} },
      };
      this.watched.set(container.id, entry);
      entry.watcher = this.watch(
        container.id,
        (agents, running = true) => {
          if (
            running !== entry.running ||
            JSON.stringify(agents) !== JSON.stringify(entry.agents)
          ) {
            entry.agents = agents;
            entry.running = running;
            this._onDidChangeTreeData.fire(undefined);
          }
        },
        () => {
          // The next sync (docker events, folder changes) retries it.
          if (this.watched.get(container.id) === entry) {
            this.watched.delete(container.id);
            this._onDidChangeTreeData.fire(undefined);
          }
        }
      );
    }
    if (changed) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  /**
   * Re-check which host sessions this window owns: stream the owned ones and
   * stop streaming the rest. Sessions not yet owned are read once here to look
   * for agents in this window's folders, so the caller sets how often that
   * happens. Overlapping calls coalesce into one more pass.
   */
  syncSessions(): Promise<void> {
    if (this.sessionSync) {
      this.sessionSyncAgain = true;
      return this.sessionSync;
    }
    this.sessionSync = (async () => {
      do {
        this.sessionSyncAgain = false;
        await this.syncSessionsOnce();
      } while (this.sessionSyncAgain && !this.disposed);
    })().finally(() => {
      this.sessionSync = undefined;
    });
    return this.sessionSync;
  }

  private async syncSessionsOnce(): Promise<void> {
    const hosts = this.hosts;
    if (!hosts) {
      return;
    }
    const sessions = await hosts.list();
    const defaultSession = sessions.find(s => s.default)?.name;
    const attached = new Set(
      (await hosts.foregrounds()).flatMap(
        args => sessionFromClientArgs(args, defaultSession) ?? []
      )
    );
    const folders = hosts.folders();
    const workspaceSession = hosts.workspaceSession();
    if (this.disposed) {
      return;
    }
    let changed =
      JSON.stringify(folders) !== JSON.stringify(this.folders) ||
      workspaceSession !== this.workspaceSession ||
      defaultSession !== this.defaultSession;
    this.folders = folders;
    this.workspaceSession = workspaceSession;
    this.defaultSession = defaultSession;

    const live = new Map(sessions.map(s => [s.name, s]));
    for (const [name, entry] of this.sessions) {
      const session = live.get(name);
      const isAttached = attached.has(name);
      const isWorkspace = !!session && this.isWorkspaceSession(session);
      if (
        !session ||
        session.socketPath !== entry.session.socketPath ||
        (!isAttached &&
          !isWorkspace &&
          ownedAgents(entry.agents, false, folders).length === 0)
      ) {
        entry.watcher.dispose();
        this.sessions.delete(name);
        changed = true;
        continue;
      }
      if (
        entry.attached !== isAttached ||
        entry.workspace !== isWorkspace ||
        entry.session.default !== session.default
      ) {
        changed = true;
      }
      entry.session = session;
      entry.attached = isAttached;
      entry.workspace = isWorkspace;
    }
    for (const session of sessions) {
      if (this.sessions.has(session.name)) {
        continue;
      }
      const isAttached = attached.has(session.name);
      const isWorkspace = this.isWorkspaceSession(session);
      let agents: AgentInfo[] = [];
      if (!isAttached && !isWorkspace) {
        const read = await hosts.read(session);
        if (!read || ownedAgents(read, false, folders).length === 0) {
          continue;
        }
        agents = read;
      }
      if (this.disposed || this.sessions.has(session.name)) {
        return;
      }
      this.watchSession(session, isAttached, isWorkspace, agents);
      changed = true;
    }
    if (changed) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private isWorkspaceSession(session: HostSession): boolean {
    return session.name === this.workspaceSession;
  }

  private watchSession(
    session: HostSession,
    attached: boolean,
    workspace: boolean,
    agents: AgentInfo[]
  ): void {
    const entry: WatchedSession = {
      session,
      agents,
      attached,
      workspace,
      watcher: { dispose() {} },
    };
    this.sessions.set(session.name, entry);
    entry.watcher = this.hosts!.watch(
      session,
      agents => {
        if (JSON.stringify(agents) !== JSON.stringify(entry.agents)) {
          entry.agents = agents;
          this._onDidChangeTreeData.fire(undefined);
        }
      },
      () => {
        // The session stopped; the next sync picks it up again if it returns.
        if (this.sessions.get(session.name) === entry) {
          this.sessions.delete(session.name);
          this._onDidChangeTreeData.fire(undefined);
        }
      }
    );
  }

  /** An owned host session by name, for focusing its agents. */
  hostSession(name: string): HostSession | undefined {
    return this.sessions.get(name)?.session;
  }

  /** The name a bare `herdr` attaches to, as of the last session sync. */
  defaultSessionName(): string | undefined {
    return this.defaultSession;
  }

  /** Set the host environment's label. */
  setHostName(name: string): void {
    if (name !== this.hostName) {
      this.hostName = name;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  /** This window's workspace session, while it is running. */
  workspaceHostSession(): HostSession | undefined {
    const name = this.workspaceSession;
    return name === undefined ? undefined : this.sessions.get(name)?.session;
  }

  /**
   * A running container serving a host folder, and whether its herdr is up,
   * as of the last sync.
   */
  containerFor(
    folder: string
  ): { container: ContainerInfo; herdrRunning: boolean } | undefined {
    const resolved = path.resolve(folder);
    for (const entry of this.watched.values()) {
      if (path.resolve(entry.container.localFolder) === resolved) {
        return { container: entry.container, herdrRunning: entry.running };
      }
    }
    return undefined;
  }

  /** Record which containers have a terminal open on them in this window. */
  setAttachedContainers(ids: Set<string>): void {
    if (
      ids.size === this.attachedContainers.size &&
      [...ids].every(id => this.attachedContainers.has(id))
    ) {
      return;
    }
    this.attachedContainers = new Set(ids);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Record (or clear, with undefined) the agent a terminal is showing. */
  setTerminalAgent(
    containerId: string,
    terminal: vscode.Terminal,
    agent: AgentInfo | undefined
  ): void {
    let byTerminal = this.terminalAgents.get(containerId);
    const previous = byTerminal?.get(terminal);
    if (JSON.stringify(previous) === JSON.stringify(agent)) {
      return;
    }
    if (agent) {
      if (!byTerminal) {
        byTerminal = new Map();
        this.terminalAgents.set(containerId, byTerminal);
      }
      byTerminal.set(terminal, agent);
    } else {
      byTerminal?.delete(terminal);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Record (or clear, with undefined) the agent a host terminal is showing. */
  setLocalTerminalAgent(
    terminal: vscode.Terminal,
    agent: AgentInfo | undefined
  ): void {
    const previous = this.localAgents.get(terminal);
    if (JSON.stringify(previous) === JSON.stringify(agent)) {
      return;
    }
    if (agent) {
      this.localAgents.set(terminal, agent);
    } else {
      this.localAgents.delete(terminal);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Expand or collapse every group, as the view's title actions do. */
  setExpansion(expansion: 'expanded' | 'collapsed'): void {
    this.expansion = expansion;
    this.generation++;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Replace what other windows show; fires only when it changed. */
  setOtherWindows(windows: WindowSnapshot[]): void {
    if (JSON.stringify(windows) === JSON.stringify(this.others)) {
      return;
    }
    this.others = windows;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** This window's view, for other windows to show. */
  snapshotGroups(): PublishedGroup[] {
    return this.localEnvs().map((env): PublishedGroup => {
      const agents = this.getChildren(env).flatMap(node =>
        node.kind === 'agent'
          ? [
              {
                key: this.keyOf(node),
                agent: node.agent,
                herdr: isHerdrAgent(node),
              },
            ]
          : []
      );
      return env.kind === 'host'
        ? { kind: 'host', name: env.name, agents }
        : { kind: 'container', container: env.container, agents };
    });
  }

  /** This window's agent with a key from snapshotGroups. */
  findLocal(key: string): AgentNode | undefined {
    return this.localEnvs()
      .flatMap(env => this.getChildren(env))
      .find(node => node.kind === 'agent' && this.keyOf(node) === key);
  }

  private keyOf(node: AgentNode & { kind: 'agent' }): string {
    if (node.local) {
      return `local-terminal:${this.terminalId(node.terminal!)}`;
    }
    if (node.session !== undefined) {
      // Pane ids repeat across sessions, so the session is part of the key.
      return `host-herdr:${node.session}:${node.agent.paneId}`;
    }
    return node.terminal
      ? `terminal:${node.container.id}:${this.terminalId(node.terminal)}`
      : `herdr:${node.container.id}:${node.agent.paneId}`;
  }

  /**
   * This window's environments: the host while its workspace session runs or
   * it has agents, then every running container by label.
   */
  private localEnvs(): EnvNode[] {
    const containers = [...this.watched.values()]
      .map(w => w.container)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((container): EnvNode => ({ kind: 'container', container }));
    return this.workspaceHostSession() || this.hostAgentNodes().length
      ? [{ kind: 'host', name: this.hostName }, ...containers]
      : containers;
  }

  /**
   * This window's host agents: its host sessions', the workspace session's
   * first, then its plain host terminals'.
   */
  private hostAgentNodes(): AgentNode[] {
    const sessions = [...this.sessions.values()].sort(
      (a, b) =>
        Number(b.workspace) - Number(a.workspace) ||
        a.session.name.localeCompare(b.session.name)
    );
    return [
      ...sessions.flatMap(entry => this.nodesForSession(entry)),
      ...this.nodesForLocal(),
    ];
  }

  private nodesForLocal(): AgentNode[] {
    return [...this.localAgents].map(([terminal, agent]) => ({
      kind: 'agent',
      local: true,
      agent,
      terminal,
    }));
  }

  private nodesForSession(entry: WatchedSession): AgentNode[] {
    return ownedAgents(entry.agents, entry.attached, this.folders).map(
      agent => ({ kind: 'agent', session: entry.session.name, agent })
    );
  }

  private nodesFor(container: ContainerInfo): AgentNode[] {
    const fromHerdr: AgentNode[] = (
      this.watched.get(container.id)?.agents ?? []
    ).map(agent => ({ kind: 'agent', container, agent }));
    const fromTerminals: AgentNode[] = [
      ...(this.terminalAgents.get(container.id) ?? []),
    ].map(([terminal, agent]) => ({
      kind: 'agent',
      container,
      agent,
      terminal,
    }));
    return [...fromHerdr, ...fromTerminals];
  }

  private terminalId(terminal: vscode.Terminal): number {
    let id = this.terminalIds.get(terminal);
    if (id === undefined) {
      id = this.nextTerminalId++;
      this.terminalIds.set(terminal, id);
    }
    return id;
  }

  /** This window's agents, for tests. */
  allAgents(): AgentInfo[] {
    return [
      ...[...this.watched.values()].flatMap(w => w.agents),
      ...[...this.terminalAgents.values()].flatMap(m => [...m.values()]),
      ...this.localAgents.values(),
      ...[...this.sessions.values()].flatMap(s =>
        ownedAgents(s.agents, s.attached, this.folders)
      ),
    ];
  }

  /** Agents needing attention in every window, for the view badge. */
  attentionCount(): number {
    const remote = this.others.flatMap(w =>
      w.groups.flatMap(g => g.agents.map(a => a.agent))
    );
    return [...this.allAgents(), ...remote].filter(a => ATTENTION.has(a.status))
      .length;
  }

  getChildren(node?: AgentNode): AgentNode[] {
    if (!node) {
      return [WORKSPACE, OTHER_WORKSPACES];
    }
    switch (node.kind) {
      case 'workspace':
        return this.localEnvs();
      case 'otherWorkspaces':
        return this.remoteEnvs();
      case 'host':
        return node.remote
          ? this.remoteAgents(node, node.remote)
          : this.hostAgentNodes();
      case 'container':
        return node.remote
          ? this.remoteAgents(node, node.remote)
          : this.nodesFor(node.container);
      default:
        return [];
    }
  }

  /**
   * Other windows' environments with agents: by window name, then as a
   * window lists its own.
   */
  private remoteEnvs(): EnvNode[] {
    return [...this.others]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap(remote => {
        const groups = remote.groups.filter(g => g.agents.length);
        return [
          ...groups.flatMap((g): EnvNode[] =>
            g.kind === 'host' ? [{ kind: 'host', name: g.name, remote }] : []
          ),
          ...groups
            .flatMap(g => (g.kind === 'container' ? [g.container] : []))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((container): EnvNode => ({
              kind: 'container',
              container,
              remote,
            })),
        ];
      });
  }

  /** Another window's agents in one of its environments. */
  private remoteAgents(env: EnvNode, window: WindowSnapshot): AgentNode[] {
    const group = window.groups.find(g =>
      env.kind === 'host'
        ? g.kind === 'host'
        : g.kind === 'container' && g.container.id === env.container.id
    );
    return (group?.agents ?? []).map((published): AgentNode => {
      const remote = { window, published };
      return env.kind === 'host'
        ? { kind: 'agent', local: true, agent: published.agent, remote }
        : {
            kind: 'agent',
            container: env.container,
            agent: published.agent,
            remote,
          };
    });
  }

  private agentsUnder(node: AgentNode): AgentInfo[] {
    return this.getChildren(node).flatMap(child =>
      child.kind === 'agent' ? [child.agent] : this.agentsUnder(child)
    );
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    const item = this.buildTreeItem(node);
    if (this.generation > 0) {
      item.id = `${item.id}#${this.generation}`;
    }
    if (
      this.expansion &&
      item.collapsibleState !== vscode.TreeItemCollapsibleState.None
    ) {
      item.collapsibleState =
        this.expansion === 'expanded'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
    }
    return item;
  }

  private buildTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === 'workspace' || node.kind === 'otherWorkspaces') {
      const own = node.kind === 'workspace';
      const item = new vscode.TreeItem(
        own ? 'Workspace' : 'Other Workspaces',
        // Other windows' agents stay out of the way until wanted.
        own
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = node.kind;
      item.description = summarize(this.agentsUnder(node));
      item.tooltip = own
        ? 'Agents in this VS Code window'
        : 'Agents in other VS Code windows';
      item.contextValue = own ? 'agentWorkspace' : 'agentOtherWorkspaces';
      return item;
    }

    const remotePid =
      node.kind === 'agent' ? node.remote?.window.pid : node.remote?.pid;
    const scope = remotePid === undefined ? '' : `w${remotePid}:`;
    if (node.kind === 'host') {
      const agents = this.agentsUnder(node);
      const item = new vscode.TreeItem(node.name, groupState(agents));
      item.id = `${scope}host`;
      item.iconPath = HOST_ICON;
      item.description = summarize(agents);
      if (node.remote) {
        item.tooltip = `The host, in window "${node.remote.name}"`;
        item.contextValue = 'agentHostRemote';
        return item;
      }
      // Its actions act on the workspace session.
      const session = this.workspaceHostSession();
      item.tooltip = [
        'The host',
        this.workspaceSession !== undefined &&
          `herdr session "${this.workspaceSession}"${session ? '' : ', not running'}`,
        session?.socketPath,
      ]
        .filter(Boolean)
        .join('\n');
      // Only a running session can be stopped; herdr will not delete the
      // default one.
      item.contextValue = [
        'agentHost',
        session && '.running',
        session?.default && '.default',
        session && this.sessions.get(session.name)?.attached && '.attached',
      ]
        .filter(Boolean)
        .join('');
      return item;
    }
    if (node.kind === 'container') {
      const agents = this.agentsUnder(node);
      const item = new vscode.TreeItem(node.container.name, groupState(agents));
      item.id = `${scope}container:${node.container.id}`;
      const herdrDown =
        !node.remote &&
        agents.length === 0 &&
        !this.watched.get(node.container.id)?.running;
      item.iconPath = herdrDown ? CONTAINER_ICON_IDLE : CONTAINER_ICON;
      item.description = herdrDown ? 'herdr not running' : summarize(agents);
      item.tooltip = [
        node.container.containerName,
        node.remote && `In window "${node.remote.name}"`,
        herdrDown && 'Attach Terminal runs herdr in it',
      ]
        .filter(Boolean)
        .join('\n');
      // Only this window's containers can be stopped: their terminals are here.
      item.contextValue = node.remote
        ? 'agentContainerRemote'
        : this.attachedContainers.has(node.container.id)
          ? 'agentContainer.attached'
          : 'agentContainer';
      return item;
    }
    const { agent } = node;
    const herdr = isHerdrAgent(node);
    const item = new vscode.TreeItem(
      taskLabel(agent),
      vscode.TreeItemCollapsibleState.None
    );
    item.id = node.remote
      ? `${scope}${node.remote.published.key}`
      : this.keyOf(node);
    item.iconPath = STATUS_ICONS[agent.status];
    item.description = agent.agent;
    const terminalName = node.terminal ? ` "${node.terminal.name}"` : '';
    item.tooltip = [
      `${agent.agent} — ${agent.status}`,
      herdr
        ? `herdr workspace ${agent.workspace ?? '?'}, pane ${agent.paneId}`
        : `terminal${terminalName}${node.local ? ' on the host' : ' (detected from its output)'}`,
      agent.title,
      agent.cwd,
      node.remote &&
        (node.remote.window.workspaceUri
          ? `In window "${node.remote.window.name}" — click to switch to it`
          : `In window "${node.remote.window.name}", which has no saved workspace to switch to`),
    ]
      .filter(Boolean)
      .join('\n');
    item.contextValue = node.remote ? 'agentRemote' : 'agent';
    item.command = {
      command: 'devc-vscode.focusAgent',
      title: 'Focus Agent',
      arguments: [node],
    };
    return item;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.watched.values()) {
      entry.watcher.dispose();
    }
    this.watched.clear();
    for (const entry of this.sessions.values()) {
      entry.watcher.dispose();
    }
    this.sessions.clear();
    this.terminalAgents.clear();
    this.localAgents.clear();
    this._onDidChangeTreeData.dispose();
  }
}
