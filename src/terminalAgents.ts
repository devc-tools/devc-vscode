import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { execDocker } from './docker';
import { AgentInfo, AgentStatus } from './herdr';
import { TerminalScreen } from './terminalScreen';

/**
 * Agent detection for agents run straight in a container terminal, without
 * herdr managing them. Agent-agnostic and nothing to configure in the
 * container:
 *
 *  1. Raw output: TerminalShellExecution.read() streams every byte the
 *     command the terminal was opened with (`devc ...`) writes, including
 *     whatever agent the user starts inside that container shell.
 *  2. Screen: a headless xterm rebuilds the rendered screen from it.
 *  3. Which agent: processes in the container whose program name matches one
 *     of herdr's detection manifests, excluding those herdr itself runs.
 *  4. What state: the container's herdr classifies the screen with
 *     `herdr agent explain --file`, using the same rules herdr's sidebar uses.
 */

/** A running agent the container's herdr has a manifest for. */
export interface AgentProcess {
  agent: string;
  pid: number;
  /** The size of the agent's pty, which tracks the VS Code terminal's. */
  size?: { rows: number; cols: number };
}

/**
 * Lists herdr's manifest ids, then every process. One exec for both; herdr
 * caches a manifest per agent it knows how to detect.
 */
const PROBE_SCRIPT = `
ls "$HOME/.local/state/herdr/agent-detection/remote" 2>/dev/null | sed -n 's/\\.toml$//p'
echo ---
ps -eo pid=,ppid=,args= 2>/dev/null
`;

/** Classifies stdin once per agent id given as an argument. */
const EXPLAIN_SCRIPT = `
PATH="$HOME/.local/bin:$PATH"
f=$(mktemp) || exit 1
cat > "$f"
for agent in "$@"; do
  herdr agent explain --file "$f" --agent "$agent" --format json 2>/dev/null | tr -d '\\n'
  echo
done
rm -f "$f"
`;

const INTERPRETERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'sh',
  'bash',
]);

/** The program a command line runs, looking through a script interpreter. */
function programName(args: string): string | undefined {
  const argv = args.trim().split(/\s+/);
  let name = posix.basename(argv[0] ?? '');
  if (INTERPRETERS.has(name) && argv[1] && !argv[1].startsWith('-')) {
    name = posix.basename(argv[1]).replace(/\.(m?js|py|ts)$/, '');
  }
  return name || undefined;
}

/**
 * Agents running in a container, from PROBE_SCRIPT output. Processes under a
 * herdr server are left out: herdr already reports those, and the terminal
 * attached to herdr shows herdr's UI rather than the agent's screen.
 */
export function parseProbe(output: string): AgentProcess[] {
  const [manifestPart, psPart = ''] = output.split(/^---$/m);
  const known = new Set(
    manifestPart
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  );
  const procs = new Map<number, { ppid: number; name?: string }>();
  for (const line of psPart.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      procs.set(Number(m[1]), { ppid: Number(m[2]), name: programName(m[3]) });
    }
  }
  const underHerdr = (pid: number): boolean => {
    for (let p = procs.get(pid)?.ppid; p && procs.has(p);) {
      const proc = procs.get(p)!;
      if (proc.name === 'herdr') {
        return true;
      }
      p = proc.ppid;
    }
    return false;
  };
  const found: AgentProcess[] = [];
  const seen = new Set<string>();
  for (const [pid, proc] of procs) {
    if (proc.name && known.has(proc.name) && !underHerdr(pid)) {
      if (!seen.has(proc.name)) {
        seen.add(proc.name);
        found.push({ agent: proc.name, pid });
      }
    }
  }
  return found;
}

export interface Classification {
  agent: string;
  status: AgentStatus;
  /** The manifest rule that matched; undefined when herdr fell back. */
  rule?: string;
  /** herdr's instruction to keep the previous state (e.g. transcript view). */
  keepPrevious: boolean;
}

export function parseExplain(line: string): Classification | undefined {
  try {
    const r = JSON.parse(line);
    if (typeof r?.agent !== 'string' || typeof r?.state !== 'string') {
      return undefined;
    }
    return {
      agent: r.agent,
      status: r.state as AgentStatus,
      rule: r.matched_rule?.id,
      keepPrevious: r.skip_state_update === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * The agent a screen belongs to. Only a matched rule counts: herdr falls back
 * to "idle" for any screen it cannot place, and a plain shell prompt next to
 * an agent in another terminal must not show up as that agent.
 */
export function pickClassification(
  results: Classification[]
): Classification | undefined {
  return results.find(r => r.rule !== undefined);
}

export async function probeAgents(
  containerId: string,
  user: string | undefined,
  dockerCommand: string
): Promise<AgentProcess[]> {
  const res = await execDocker(
    [
      'exec',
      ...(user ? ['-u', user] : []),
      containerId,
      'sh',
      '-c',
      PROBE_SCRIPT,
    ],
    undefined,
    dockerCommand
  );
  if (res.exitCode !== 0) {
    return [];
  }
  const agents = parseProbe(res.stdout.toString('utf8'));
  if (agents.length === 0) {
    return agents;
  }
  // Stable VS Code API exposes no terminal dimensions, but `docker exec -t`
  // forwards every resize to the pty inside, so ask the agent's own pty.
  const sizes = await execDocker(
    [
      'exec',
      ...(user ? ['-u', user] : []),
      containerId,
      'sh',
      '-c',
      'for pid in "$@"; do stty size < /proc/$pid/fd/0 2>/dev/null || echo; done',
      'sh',
      ...agents.map(a => String(a.pid)),
    ],
    undefined,
    dockerCommand
  );
  sizes.stdout
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      const m = /^(\d+) (\d+)$/.exec(line.trim());
      if (m && agents[i]) {
        agents[i].size = { rows: Number(m[1]), cols: Number(m[2]) };
      }
    });
  return agents;
}

export async function classifyScreen(
  containerId: string,
  user: string | undefined,
  agents: string[],
  screen: string,
  dockerCommand: string
): Promise<Classification[]> {
  const res = await execDocker(
    [
      'exec',
      '-i',
      ...(user ? ['-u', user] : []),
      containerId,
      'sh',
      '-c',
      EXPLAIN_SCRIPT,
      'sh',
      ...agents,
    ],
    Buffer.from(screen, 'utf8'),
    dockerCommand
  );
  return res.stdout
    .toString('utf8')
    .split('\n')
    .map(parseExplain)
    .filter((c): c is Classification => c !== undefined);
}

export interface TerminalAgentDeps {
  /** Only terminals this returns true for are read. */
  isContainerTerminal(terminal: vscode.Terminal): boolean;
  resolveContainer(
    terminal: vscode.Terminal
  ): Promise<{ id: string; user: string | undefined } | undefined>;
  probe(containerId: string, user: string | undefined): Promise<AgentProcess[]>;
  classify(
    containerId: string,
    user: string | undefined,
    agents: string[],
    screen: string
  ): Promise<Classification[]>;
  /** Called with the terminal's current agent, or undefined when it has none. */
  report(
    terminal: vscode.Terminal,
    containerId: string,
    agent?: AgentInfo
  ): void;
}

/** How long a container's process list is trusted. */
const PROBE_TTL_MS = 5000;
/** Output settles for this long before the screen is classified. */
const SETTLE_MS = 300;
/** Re-check a quiet screen this often, so a finished agent is noticed. */
const IDLE_RECHECK_MS = 5000;

/** Reads one command's output and keeps its agent status current. */
class TrackedExecution {
  private readonly screen: TerminalScreen;
  private timer: NodeJS.Timeout | undefined;
  private evaluating = false;
  private dirty = false;
  private disposed = false;
  private status: AgentStatus | undefined;
  private container: { id: string; user: string | undefined } | undefined;

  constructor(
    private readonly terminal: vscode.Terminal,
    execution: vscode.TerminalShellExecution,
    private readonly deps: TerminalAgentDeps,
    private readonly probes: Map<
      string,
      { at: number; agents: Promise<AgentProcess[]> }
    >
  ) {
    this.screen = new TerminalScreen();
    // read() only yields data written after it is first called.
    const stream = execution.read();
    this.pump(stream).finally(() => this.dispose());
  }

  private async pump(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      if (this.disposed) {
        return;
      }
      await this.screen.write(chunk);
      this.schedule(SETTLE_MS);
    }
  }

  private schedule(ms: number): void {
    this.dirty = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.evaluate(), ms);
  }

  private async evaluate(): Promise<void> {
    if (this.disposed || this.evaluating) {
      return;
    }
    this.evaluating = true;
    this.dirty = false;
    try {
      this.container ??= await this.deps.resolveContainer(this.terminal);
      if (!this.container) {
        return;
      }
      const { id, user } = this.container;
      const agents = await this.agentsIn(id, user);
      // With several agents the terminal's own is unknown; any size beats
      // the default until they differ.
      const size = agents.find(a => a.size)?.size;
      if (size) {
        this.screen.resize(size.cols, size.rows);
      }
      const pick = agents.length
        ? pickClassification(
            await this.deps.classify(
              id,
              user,
              agents.map(a => a.agent),
              this.screen.text()
            )
          )
        : undefined;
      if (this.disposed) {
        return;
      }
      if (pick?.keepPrevious && this.status) {
        return;
      }
      this.status = pick?.status;
      this.deps.report(
        this.terminal,
        id,
        pick && {
          paneId: `terminal:${pick.agent}`,
          agent: pick.agent,
          status: pick.status,
          title: this.screen.title || undefined,
          workspace: undefined,
        }
      );
    } finally {
      this.evaluating = false;
      if (!this.disposed) {
        // Output arrived mid-evaluation: go again. Otherwise re-check later so
        // an agent that exits without redrawing still disappears.
        this.schedule(this.dirty ? SETTLE_MS : IDLE_RECHECK_MS);
      }
    }
  }

  private agentsIn(id: string, user: string | undefined) {
    const cached = this.probes.get(id);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.agents;
    }
    const agents = this.deps.probe(id, user).catch(() => []);
    this.probes.set(id, { at: Date.now(), agents });
    return agents;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.screen.dispose();
    if (this.container) {
      this.deps.report(this.terminal, this.container.id, undefined);
    }
  }
}

/** Watches every container terminal's commands for agents. */
export class TerminalAgentTracker implements vscode.Disposable {
  private readonly tracked = new Map<vscode.Terminal, TrackedExecution>();
  private readonly probes = new Map<
    string,
    { at: number; agents: Promise<AgentProcess[]> }
  >();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly deps: TerminalAgentDeps) {
    this.subscriptions = [
      vscode.window.onDidStartTerminalShellExecution(e => {
        if (!deps.isContainerTerminal(e.terminal)) {
          return;
        }
        this.tracked.get(e.terminal)?.dispose();
        this.tracked.set(
          e.terminal,
          new TrackedExecution(e.terminal, e.execution, deps, this.probes)
        );
      }),
      vscode.window.onDidEndTerminalShellExecution(e => {
        this.tracked.get(e.terminal)?.dispose();
        this.tracked.delete(e.terminal);
      }),
      vscode.window.onDidCloseTerminal(t => {
        this.tracked.get(t)?.dispose();
        this.tracked.delete(t);
      }),
    ];
  }

  dispose(): void {
    for (const t of this.tracked.values()) {
      t.dispose();
    }
    this.tracked.clear();
    this.subscriptions.forEach(s => s.dispose());
  }
}
