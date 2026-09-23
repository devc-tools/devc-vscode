import * as vscode from 'vscode';
import { ContainerInfo, ContainerSource } from './containerTree';
import { AgentInfo, AgentStatus } from './herdr';

export type AgentNode =
  | { kind: 'container'; container: ContainerInfo }
  | {
      kind: 'agent';
      container: ContainerInfo;
      agent: AgentInfo;
      /** Set when detected from a terminal's output rather than by herdr. */
      terminal?: vscode.Terminal;
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

  /** Every tracked agent, for the badge and for tests. */
  allAgents(): AgentInfo[] {
    return [
      ...[...this.watched.values()].flatMap(w => w.agents),
      ...[...this.terminalAgents.values()].flatMap(m => [...m.values()]),
    ];
  }

  attentionCount(): number {
    return this.allAgents().filter(a => ATTENTION.has(a.status)).length;
  }

  getChildren(node?: AgentNode): AgentNode[] {
    if (!node) {
      return [...this.watched.values()]
        .filter(w => this.nodesFor(w.container).length > 0)
        .sort((a, b) => a.container.name.localeCompare(b.container.name))
        .map(w => ({ kind: 'container', container: w.container }));
    }
    if (node.kind === 'container') {
      return this.nodesFor(node.container);
    }
    return [];
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === 'container') {
      const item = new vscode.TreeItem(
        node.container.name,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = `container:${node.container.id}`;
      item.iconPath = new vscode.ThemeIcon('vm');
      item.description = summarize(
        this.nodesFor(node.container).map(n =>
          n.kind === 'agent' ? n.agent : undefined!
        )
      );
      item.tooltip = node.container.containerName;
      item.contextValue = 'agentContainer';
      return item;
    }

    const { agent } = node;
    const item = new vscode.TreeItem(
      node.terminal ? agent.agent : `${agent.agent} (herdr)`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = node.terminal
      ? `terminal:${node.container.id}:${this.terminalId(node.terminal)}`
      : `agent:${node.container.id}:${agent.paneId}`;
    item.iconPath = STATUS_ICONS[agent.status];
    item.description = agent.status;
    item.tooltip = [
      `${agent.agent} — ${agent.status}`,
      node.terminal
        ? `terminal "${node.terminal.name}" (detected from its output)`
        : `herdr workspace ${agent.workspace ?? '?'}, pane ${agent.paneId}`,
      agent.title,
      agent.cwd,
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
