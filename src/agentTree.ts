import * as vscode from 'vscode';
import { ContainerInfo, ContainerSource } from './containerTree';
import { AgentInfo, AgentStatus } from './herdr';
import {
  PublishedAgent,
  PublishedContainer,
  WindowSnapshot,
} from './windowRegistry';

export type AgentNode =
  /** A VS Code window's group, this window first; `remote` unset for it. */
  | { kind: 'window'; remote?: WindowSnapshot }
  | { kind: 'container'; container: ContainerInfo; remote?: WindowSnapshot }
  | {
      kind: 'agent';
      container: ContainerInfo;
      agent: AgentInfo;
      /** Set when detected from a terminal's output rather than by herdr. */
      terminal?: vscode.Terminal;
      /** Set for an agent another window owns. */
      remote?: { window: WindowSnapshot; published: PublishedAgent };
    };

/**
 * Starts streaming one container's agents. Injected so the tree can be
 * exercised without Docker — see watchHerdr for the real thing.
 */
export type WatchAgents = (
  containerId: string,
  onAgents: (agents: AgentInfo[]) => void,
  onExit: () => void
) => { dispose(): void };

interface Watched {
  container: ContainerInfo;
  agents: AgentInfo[];
  watcher: { dispose(): void };
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
 * watcher per container. Containers without a running herdr or without any
 * detected agent are left out.
 */
export class AgentTreeDataProvider
  implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable
{
  private readonly watched = new Map<string, Watched>();
  /** Agents detected from terminal output, by container then terminal. */
  private readonly terminalAgents = new Map<
    string,
    Map<vscode.Terminal, AgentInfo>
  >();
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
    private readonly watch: WatchAgents
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
        watcher: { dispose() {} },
      };
      this.watched.set(container.id, entry);
      entry.watcher = this.watch(
        container.id,
        agents => {
          if (JSON.stringify(agents) !== JSON.stringify(entry.agents)) {
            entry.agents = agents;
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

  /** Replace what other windows show; fires only when it changed. */
  setOtherWindows(windows: WindowSnapshot[]): void {
    if (JSON.stringify(windows) === JSON.stringify(this.others)) {
      return;
    }
    this.others = windows;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** This window's view, for other windows to show. */
  snapshotContainers(): PublishedContainer[] {
    return this.localContainers().map(container => ({
      container,
      agents: this.nodesFor(container).flatMap(node =>
        node.kind === 'agent'
          ? [
              {
                key: this.keyOf(node),
                agent: node.agent,
                herdr: !node.terminal,
              },
            ]
          : []
      ),
    }));
  }

  /** This window's agent with a key from snapshotContainers. */
  findLocal(key: string): AgentNode | undefined {
    return this.localContainers()
      .flatMap(container => this.nodesFor(container))
      .find(node => node.kind === 'agent' && this.keyOf(node) === key);
  }

  private keyOf(node: AgentNode & { kind: 'agent' }): string {
    return node.terminal
      ? `terminal:${node.container.id}:${this.terminalId(node.terminal)}`
      : `herdr:${node.container.id}:${node.agent.paneId}`;
  }

  private localContainers(): ContainerInfo[] {
    return [...this.watched.values()]
      .filter(w => this.nodesFor(w.container).length > 0)
      .map(w => w.container)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private othersWithAgents(): WindowSnapshot[] {
    return this.others.filter(w => w.containers.some(c => c.agents.length));
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
    ];
  }

  /** Agents needing attention in every window, for the view badge. */
  attentionCount(): number {
    const remote = this.others.flatMap(w =>
      w.containers.flatMap(c => c.agents.map(a => a.agent))
    );
    return [...this.allAgents(), ...remote].filter(a => ATTENTION.has(a.status))
      .length;
  }

  getChildren(node?: AgentNode): AgentNode[] {
    if (!node) {
      const others = this.othersWithAgents();
      const local: AgentNode[] = this.localContainers().map(container => ({
        kind: 'container',
        container,
      }));
      // Grouped by window only once another window has agents; this window
      // always comes first.
      return others.length === 0
        ? local
        : [
            { kind: 'window' },
            ...others.map(remote => ({ kind: 'window' as const, remote })),
          ];
    }
    if (node.kind === 'window') {
      if (!node.remote) {
        return this.localContainers().map(container => ({
          kind: 'container',
          container,
        }));
      }
      const remote = node.remote;
      return remote.containers
        .filter(c => c.agents.length)
        .map(c => ({ kind: 'container', container: c.container, remote }));
    }
    if (node.kind === 'container') {
      if (!node.remote) {
        return this.nodesFor(node.container);
      }
      const window = node.remote;
      const published =
        window.containers.find(c => c.container.id === node.container.id)
          ?.agents ?? [];
      return published.map(p => ({
        kind: 'agent',
        container: node.container,
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
    if (node.kind === 'window') {
      const item = new vscode.TreeItem(
        (node.remote ? node.remote.name : vscode.workspace.name) ||
          'Untitled window',
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = node.remote ? `window:${node.remote.pid}` : 'window:current';
      item.iconPath = new vscode.ThemeIcon('window');
      item.description = summarize(this.agentsUnder(node));
      item.contextValue = 'agentWindow';
      return item;
    }

    const remotePid =
      node.kind === 'agent' ? node.remote?.window.pid : node.remote?.pid;
    const scope = remotePid === undefined ? '' : `w${remotePid}:`;
    if (node.kind === 'container') {
      const item = new vscode.TreeItem(
        node.container.name,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `${scope}container:${node.container.id}`;
      item.iconPath = new vscode.ThemeIcon('vm');
      item.description = summarize(this.agentsUnder(node));
      item.tooltip = node.container.containerName;
      item.contextValue = 'agentContainer';
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
    item.tooltip = [
      `${agent.agent} — ${agent.status}`,
      herdr
        ? `herdr workspace ${agent.workspace ?? '?'}, pane ${agent.paneId}`
        : `terminal${node.terminal ? ` "${node.terminal.name}"` : ''} (detected from its output)`,
      agent.title,
      agent.cwd,
      node.remote &&
        (node.remote.window.workspaceUri
          ? `In window "${node.remote.window.name}" — click to switch to it`
          : `In window "${node.remote.window.name}", which has no saved workspace to switch to`),
    ]
      .filter(Boolean)
      .join('\n');
    item.contextValue = 'agent';
    item.command = {
      command: 'devc-vscode.focusAgent',
      title: 'Focus Agent',
      arguments: [node],
    };
    return item;
  }

  dispose(): void {
    for (const entry of this.watched.values()) {
      entry.watcher.dispose();
    }
    this.watched.clear();
    this.terminalAgents.clear();
    this._onDidChangeTreeData.dispose();
  }
}
