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
  /** Holds a window node per other VS Code window with agents. */
  | { kind: 'otherWindows' }
  /** Another VS Code window's groups. */
  | { kind: 'window'; remote: WindowSnapshot }
  | {
      kind: 'container';
      container: ContainerInfo;
      remote?: WindowSnapshot;
      /**
       * Unset for a running container. `absent` is the primary folder's
       * placeholder when it has no container, with a made-up id.
       */
      state?: 'stopped' | 'absent';
    }
  | {
      kind: 'session';
      /** The host herdr session's name. */
      session: string;
      /** This window's view of the session; unset for another window's. */
      host?: HostSession;
      remote?: WindowSnapshot;
      /** This window's workspace session, while it is not running. */
      placeholder?: true;
    }
  /** A window's plain host terminals with agents in them. */
  | { kind: 'local'; remote?: WindowSnapshot }
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
      /** Runs in a plain host terminal. */
      local: true;
      container?: undefined;
      session?: undefined;
      /** Always set for this window's agents. */
      terminal?: vscode.Terminal;
    });

/** A container, host session, or the host terminals, under a window. */
type GroupNode = Extract<
  AgentNode,
  { kind: 'container' | 'session' | 'local' }
>;

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

/** How a host session is labelled: its name, or `default`. */
function sessionLabel(session: HostSession): string {
  return session.default ? 'default' : session.name;
}

/**
 * Group icons, shared with the terminals the extension opens so a terminal tab
 * matches the group its agents appear under.
 */
export const CONTAINER_ICON = new vscode.ThemeIcon('vm');
export const SESSION_ICON = new vscode.ThemeIcon('terminal-tmux');
/** For a group with no herdr running to show agents from. */
const IDLE = new vscode.ThemeColor('disabledForeground');
const CONTAINER_ICON_IDLE = new vscode.ThemeIcon('vm', IDLE);
const SESSION_ICON_IDLE = new vscode.ThemeIcon('terminal-tmux', IDLE);

/** A group only gets a twistie when it has agents to show. */
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
 * session, or has agents in this window's folders. Other windows' agents sit
 * under one Other Windows node after this window's groups.
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
  /** Stopped containers serving the workspace, as of the last sync. */
  private stopped: ContainerInfo[] = [];
  /** The folder that always shows a container, real or placeholder. */
  private primaryFolder: string | undefined;
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
    const [containers, stopped] = await Promise.all([
      this.source.listRunning(),
      this.source.listStopped?.() ?? [],
    ]);
    const live = new Set(containers.map(c => c.id));
    let changed = JSON.stringify(stopped) !== JSON.stringify(this.stopped);
    this.stopped = stopped;

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

  /**
   * Set the folder whose container always shows: a placeholder to attach
   * from when it has none.
   */
  setPrimaryFolder(folder: string | undefined): void {
    if (folder !== this.primaryFolder) {
      this.primaryFolder = folder;
      this._onDidChangeTreeData.fire(undefined);
    }
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
    // Other windows show only groups with agents, which these never have.
    const real = this.localGroups().filter(
      group =>
        !(group.kind === 'container' && group.state) &&
        !(group.kind === 'session' && group.placeholder)
    );
    return real.map(group => {
      const agents = this.getChildren(group).flatMap(node =>
        node.kind === 'agent'
          ? [
              {
                key: this.keyOf(node),
                agent: node.agent,
                herdr: !node.terminal,
              },
            ]
          : []
      );
      switch (group.kind) {
        case 'session':
          return { kind: 'session', session: group.session, agents };
        case 'local':
          return { kind: 'local', agents };
        case 'container':
          return { kind: 'container', container: group.container, agents };
      }
    });
  }

  /** This window's agent with a key from snapshotGroups. */
  findLocal(key: string): AgentNode | undefined {
    return this.localGroups()
      .flatMap(group => this.getChildren(group))
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
   * This window's groups: containers and sessions by label, then the host
   * terminals. Every running or stopped container shows, plus a placeholder
   * for the primary folder's when it has none, and one for the workspace
   * session when it is not running.
   */
  private localGroups(): GroupNode[] {
    const running = [...this.watched.values()].map(w => w.container);
    const folders = new Set(running.map(c => path.resolve(c.localFolder)));
    const stopped = this.stopped.filter(
      c => !folders.has(path.resolve(c.localFolder))
    );
    stopped.forEach(c => folders.add(path.resolve(c.localFolder)));
    const containers: { label: string; node: GroupNode }[] = [
      ...running.map(container => ({
        label: container.name,
        node: { kind: 'container', container } as GroupNode,
      })),
      ...stopped.map(container => ({
        label: container.name,
        node: { kind: 'container', container, state: 'stopped' } as GroupNode,
      })),
    ];
    const primary = this.primaryFolder;
    if (primary !== undefined && !folders.has(path.resolve(primary))) {
      const name = path.basename(primary) || primary;
      containers.push({
        label: name,
        node: {
          kind: 'container',
          container: {
            id: `placeholder:${primary}`,
            name,
            containerName: '',
            localFolder: primary,
          },
          state: 'absent',
        },
      });
    }
    const sessions: { label: string; node: GroupNode }[] = [
      ...this.sessions.values(),
    ]
      .filter(
        s => s.attached || s.workspace || this.nodesForSession(s).length > 0
      )
      .map(s => ({
        label: sessionLabel(s.session),
        node: { kind: 'session', session: s.session.name, host: s.session },
      }));
    const own = this.workspaceSession;
    if (this.hosts && own !== undefined && !this.sessions.has(own)) {
      sessions.push({
        label: own,
        node: { kind: 'session', session: own, placeholder: true },
      });
    }
    const groups = [...containers, ...sessions]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(g => g.node);
    return this.localAgents.size > 0 ? [...groups, { kind: 'local' }] : groups;
  }

  private nodesForLocal(): AgentNode[] {
    return [...this.localAgents].map(([terminal, agent]) => ({
      kind: 'agent',
      local: true,
      agent,
      terminal,
    }));
  }

  private othersWithAgents(): WindowSnapshot[] {
    return this.others.filter(w => w.groups.some(g => g.agents.length));
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
      return this.othersWithAgents().length === 0
        ? this.localGroups()
        : [...this.localGroups(), { kind: 'otherWindows' }];
    }
    if (node.kind === 'otherWindows') {
      return this.othersWithAgents().map(remote => ({
        kind: 'window' as const,
        remote,
      }));
    }
    if (node.kind === 'window') {
      const remote = node.remote;
      return remote.groups
        .filter(g => g.agents.length)
        .map((g): GroupNode => {
          switch (g.kind) {
            case 'session':
              return { kind: 'session', session: g.session, remote };
            case 'local':
              return { kind: 'local', remote };
            case 'container':
              return { kind: 'container', container: g.container, remote };
          }
        });
    }
    if (node.kind === 'container') {
      if (!node.remote) {
        return this.nodesFor(node.container);
      }
      const window = node.remote;
      const published =
        window.groups.find(
          g => g.kind === 'container' && g.container.id === node.container.id
        )?.agents ?? [];
      return published.map(p => ({
        kind: 'agent',
        container: node.container,
        agent: p.agent,
        remote: { window, published: p },
      }));
    }
    if (node.kind === 'session') {
      if (!node.remote) {
        const entry = this.sessions.get(node.session);
        return entry ? this.nodesForSession(entry) : [];
      }
      const window = node.remote;
      const published =
        window.groups.find(
          g => g.kind === 'session' && g.session === node.session
        )?.agents ?? [];
      return published.map(p => ({
        kind: 'agent',
        session: node.session,
        agent: p.agent,
        remote: { window, published: p },
      }));
    }
    if (node.kind === 'local') {
      if (!node.remote) {
        return this.nodesForLocal();
      }
      const window = node.remote;
      const published =
        window.groups.find(g => g.kind === 'local')?.agents ?? [];
      return published.map(p => ({
        kind: 'agent',
        local: true,
        agent: p.agent,
        remote: { window, published: p },
      }));
    }
    return [];
  }

  private agentsUnder(node: AgentNode): AgentInfo[] {
    return this.getChildren(node).flatMap(child =>
      child.kind === 'agent' ? [child.agent] : this.agentsUnder(child)
    );
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === 'otherWindows') {
      const item = new vscode.TreeItem(
        'Other Windows',
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = 'otherWindows';
      item.iconPath = new vscode.ThemeIcon('multiple-windows');
      item.description = summarize(this.agentsUnder(node));
      item.tooltip = 'Agents in other VS Code windows';
      item.contextValue = 'agentOtherWindows';
      return item;
    }
    if (node.kind === 'window') {
      const item = new vscode.TreeItem(
        node.remote.name || 'Untitled window',
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `window:${node.remote.pid}`;
      item.iconPath = new vscode.ThemeIcon('window');
      item.description = summarize(this.agentsUnder(node));
      item.contextValue = 'agentWindow';
      return item;
    }

    const remotePid =
      node.kind === 'agent' ? node.remote?.window.pid : node.remote?.pid;
    const scope = remotePid === undefined ? '' : `w${remotePid}:`;
    if (node.kind === 'container') {
      const agents = this.agentsUnder(node);
      const item = new vscode.TreeItem(node.container.name, groupState(agents));
      item.id = `${scope}container:${node.container.id}`;
      const herdrDown =
        !node.remote &&
        !node.state &&
        agents.length === 0 &&
        !this.watched.get(node.container.id)?.running;
      item.iconPath =
        node.state || herdrDown ? CONTAINER_ICON_IDLE : CONTAINER_ICON;
      item.description =
        node.state === 'stopped'
          ? 'stopped'
          : node.state === 'absent'
            ? 'not created'
            : herdrDown
              ? 'herdr not running'
              : summarize(agents);
      item.tooltip = [
        node.container.containerName,
        node.state === 'absent' &&
          `No dev container for ${node.container.localFolder} yet`,
        node.state === 'stopped' && 'Stopped',
        (node.state || herdrDown) && 'Attach Terminal runs herdr in it',
      ]
        .filter(Boolean)
        .join('\n');
      // Only this window's containers can be stopped: their terminals are here.
      item.contextValue = node.remote
        ? 'agentContainerRemote'
        : node.state
          ? `agentContainer.${node.state}`
          : this.attachedContainers.has(node.container.id)
            ? 'agentContainer.attached'
            : 'agentContainer';
      return item;
    }
    if (node.kind === 'session' && node.placeholder) {
      const item = new vscode.TreeItem(
        node.session,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = `session:${node.session}`;
      item.iconPath = SESSION_ICON_IDLE;
      item.description = 'not running';
      item.tooltip = [
        `herdr session "${node.session}" on the host, this window's own`,
        'Attach Terminal starts it',
      ].join('\n');
      item.contextValue = 'agentSession.placeholder';
      return item;
    }
    if (node.kind === 'session') {
      const agents = this.agentsUnder(node);
      const item = new vscode.TreeItem(
        node.host ? sessionLabel(node.host) : node.session,
        groupState(agents)
      );
      item.id = `${scope}session:${node.session}`;
      item.iconPath = SESSION_ICON;
      item.description = summarize(agents);
      item.tooltip = [
        `herdr session "${node.session}" on the host`,
        node.host?.socketPath,
      ]
        .filter(Boolean)
        .join('\n');
      // Only this window's sessions can be stopped: their clients are here.
      // herdr will not delete the default session.
      item.contextValue = !node.host
        ? 'agentSessionRemote'
        : [
            'agentSession',
            node.host.default && '.default',
            this.sessions.get(node.session)?.attached && '.attached',
          ]
            .filter(Boolean)
            .join('');
      return item;
    }
    if (node.kind === 'local') {
      const item = new vscode.TreeItem(
        'Terminals',
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `${scope}local`;
      item.iconPath = new vscode.ThemeIcon('terminal');
      item.description = summarize(this.agentsUnder(node));
      item.tooltip = 'Agents in plain terminals on the host';
      item.contextValue = 'agentTerminals';
      return item;
    }

    const { agent } = node;
    const herdr = node.remote ? node.remote.published.herdr : !node.terminal;
    const item = new vscode.TreeItem(
      herdr ? `${agent.agent} (herdr)` : agent.agent,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = node.remote
      ? `${scope}${node.remote.published.key}`
      : this.keyOf(node);
    item.iconPath = STATUS_ICONS[agent.status];
    item.description = agent.status;
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
