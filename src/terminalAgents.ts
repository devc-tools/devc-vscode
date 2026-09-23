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
 *  3. Which pty: the one in the container opened after the command started —
 *     the terminal's own session, so identity and size are per terminal.
 *  4. Which agent: that pty's foreground process, when its program name
 *     matches one of herdr's detection manifests.
 *  5. What state: the container's herdr classifies the screen with
 *     `herdr agent explain --file`, using the same rules herdr's sidebar uses.
 */

/** One pty in the container, as the probe saw it. */
export interface TtyInfo {
  /** Age of the pty's oldest process: when the session was opened. */
  ageSeconds: number;
  /** The pty's size, which tracks the VS Code terminal's (docker forwards resizes). */
  size?: { rows: number; cols: number };
  /** The agent running on it, preferring the foreground process group. */
  agent?: { agent: string; pid: number };
}

export interface ContainerProbe {
  ttys: Map<string, TtyInfo>;
}

/**
 * herdr's manifest ids, every process with its tty and foreground group, and
 * each pty's size, in one exec. herdr caches a manifest per agent it knows how
 * to detect, so those ids are the agents worth looking for.
 */
const PROBE_SCRIPT = `
ls "$HOME/.local/state/herdr/agent-detection/remote" 2>/dev/null | sed -n 's/\\.toml$//p'
echo ---
ps -eo pid=,tty=,pgid=,tpgid=,etimes=,args= 2>/dev/null
echo ---
for t in $(ps -eo tty= | sort -u); do
  case $t in pts/*) printf '%s %s\\n' "$t" "$(stty size < /dev/$t 2>/dev/null)" ;; esac
done
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

/** Parse PROBE_SCRIPT output into the container's ptys. */
export function parseProbe(output: string): ContainerProbe {
  const [manifestPart = '', psPart = '', sizePart = ''] =
    output.split(/^---$/m);
  const known = new Set(
    manifestPart
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  );

  const ttys = new Map<string, TtyInfo>();
  const agents = new Map<string, { agent: string; pid: number; fg: boolean }>();
  for (const line of psPart.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].startsWith('pts/')) {
      continue;
    }
    const [, pid, tty, pgid, tpgid, etimes, args] = m;
    const info = ttys.get(tty) ?? { ageSeconds: 0 };
    info.ageSeconds = Math.max(info.ageSeconds, Number(etimes));
    ttys.set(tty, info);

    const name = programName(args);
    if (name && known.has(name)) {
      const fg = pgid === tpgid;
      const current = agents.get(tty);
      if (!current || (fg && !current.fg)) {
        agents.set(tty, { agent: name, pid: Number(pid), fg });
      }
    }
  }
  for (const [tty, { agent, pid }] of agents) {
    ttys.get(tty)!.agent = { agent, pid };
  }
  for (const line of sizePart.split('\n')) {
    const m = /^(pts\/\d+) (\d+) (\d+)$/.exec(line.trim());
    const info = m && ttys.get(m[1]);
    if (info) {
      info.size = { rows: Number(m[2]), cols: Number(m[3]) };
    }
  }
  return { ttys };
}

/**
 * The pty a terminal's command opened: one whose oldest process is no older
 * than the command, and not already claimed by another terminal. Ages are
 * relative, so host and container clocks never need to agree.
 */
export function adoptTty(
  probe: ContainerProbe,
  commandAgeSeconds: number,
  claimed: ReadonlySet<string>
): string | undefined {
  const candidates = [...probe.ttys]
    .filter(
      ([tty, info]) =>
        !claimed.has(tty) && info.ageSeconds <= commandAgeSeconds + 1
    )
    // The oldest qualifying session opened closest to the command.
    .sort(([, a], [, b]) => b.ageSeconds - a.ageSeconds);
  return candidates[0]?.[0];
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

function userArgs(user: string | undefined): string[] {
  return user ? ['-u', user] : [];
}

export async function probeContainer(
  containerId: string,
  user: string | undefined,
  dockerCommand: string
): Promise<ContainerProbe | undefined> {
  const res = await execDocker(
    ['exec', ...userArgs(user), containerId, 'sh', '-c', PROBE_SCRIPT],
    undefined,
    dockerCommand,
    EXEC_TIMEOUT_MS
  );
  return res.exitCode === 0
    ? parseProbe(res.stdout.toString('utf8'))
    : undefined;
}

export async function classifyScreen(
  containerId: string,
  user: string | undefined,
  agent: string,
  screen: string,
  dockerCommand: string
): Promise<Classification | undefined> {
  const res = await execDocker(
    [
      'exec',
      '-i',
      ...userArgs(user),
      containerId,
      'sh',
      '-c',
      EXPLAIN_SCRIPT,
      'sh',
      agent,
    ],
    Buffer.from(screen, 'utf8'),
    dockerCommand,
    EXEC_TIMEOUT_MS
  );
  return parseExplain(res.stdout.toString('utf8').split('\n')[0] ?? '');
}

export interface TerminalAgentDeps {
  /** Only terminals this returns true for are read. */
  isContainerTerminal(terminal: vscode.Terminal): boolean;
  resolveContainer(
    terminal: vscode.Terminal
  ): Promise<{ id: string; user: string | undefined } | undefined>;
  probe(
    containerId: string,
    user: string | undefined
  ): Promise<ContainerProbe | undefined>;
  classify(
    containerId: string,
    user: string | undefined,
    agent: string,
    screen: string
  ): Promise<Classification | undefined>;
  /** Called with the terminal's current agent, or undefined when it has none. */
  report(
    terminal: vscode.Terminal,
    containerId: string,
    agent?: AgentInfo
  ): void;
  log(message: string): void;
}

/** A probe or classification taking longer than this is abandoned. */
const EXEC_TIMEOUT_MS = 10000;
/** Output settles for this long before the screen is classified. */
const SETTLE_MS = 300;
/** Re-check a quiet terminal this often: a pty to adopt, an agent exiting. */
const RECHECK_MS = 3000;

/** Reads one command's output and keeps its agent status current. */
class TrackedExecution {
  private readonly screen = new TerminalScreen();
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private evaluating = false;
  private dirty = false;
  private disposed = false;
  private container: { id: string; user: string | undefined } | undefined;
  private tty: string | undefined;
  private last: string | undefined;

  constructor(
    private readonly terminal: vscode.Terminal,
    execution: vscode.TerminalShellExecution,
    private readonly deps: TerminalAgentDeps,
    /** ptys already owned by some terminal, by container. */
    private readonly claims: Map<string, Set<string>>
  ) {
    // read() only yields data written after it is first called.
    const stream = execution.read();
    deps.log(
      `${terminal.name}: command started: ${execution.commandLine.value}`
    );
    this.pump(stream)
      .catch(err => deps.log(`${terminal.name}: read failed: ${err}`))
      .finally(() => {
        deps.log(`${terminal.name}: output stream ended`);
        this.dispose();
      });
    this.schedule(0);
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

  private claimed(id: string): Set<string> {
    let set = this.claims.get(id);
    if (!set) {
      set = new Set();
      this.claims.set(id, set);
    }
    return set;
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
      const probe = await this.deps.probe(id, user);
      if (!probe || this.disposed) {
        return;
      }

      if (this.tty && !probe.ttys.has(this.tty)) {
        this.deps.log(`${this.terminal.name}: ${this.tty} closed`);
        this.release();
      }
      if (!this.tty) {
        const age = (Date.now() - this.startedAt) / 1000;
        this.tty = adoptTty(probe, age, this.claimed(id));
        if (!this.tty) {
          return;
        }
        this.claimed(id).add(this.tty);
        this.deps.log(
          `${this.terminal.name}: adopted ${id.slice(0, 12)} ${this.tty}`
        );
      }

      const info = probe.ttys.get(this.tty)!;
      if (info.size) {
        await this.screen.resize(info.size.cols, info.size.rows);
      }
      const screen = await this.screen.text();
      const result = info.agent
        ? await this.deps.classify(id, user, info.agent.agent, screen)
        : undefined;
      if (this.disposed || (result?.keepPrevious && this.last)) {
        return;
      }

      const summary = result
        ? `${result.agent} ${result.status} (${result.rule ?? 'no rule matched'}) ${info.size?.cols}x${info.size?.rows}`
        : 'no agent';
      if (summary !== this.last) {
        this.last = summary;
        this.deps.log(`${this.terminal.name} ${this.tty}: ${summary}`);
        if (result && !result.rule) {
          this.deps.log(`screen:\n${screen}`);
        }
      }
      // The agent is known from the pty's own processes, so herdr's fallback
      // state (no rule matched) is still that agent's state — as in herdr.
      this.deps.report(
        this.terminal,
        id,
        result && {
          paneId: `terminal:${this.tty}`,
          agent: result.agent,
          status: result.status,
          title: this.screen.title || undefined,
        }
      );
    } catch (err) {
      this.deps.log(`${this.terminal.name}: ${(err as Error).message}`);
    } finally {
      this.evaluating = false;
      if (!this.disposed) {
        // Output arrived mid-evaluation: go again. Otherwise re-check later so
        // a pty is adopted and an agent that exits quietly is noticed.
        this.schedule(this.dirty ? SETTLE_MS : RECHECK_MS);
      }
    }
  }

  private release(): void {
    if (this.container && this.tty) {
      this.claims.get(this.container.id)?.delete(this.tty);
    }
    this.tty = undefined;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.release();
    this.screen.dispose();
    if (this.container) {
      this.deps.report(this.terminal, this.container.id, undefined);
    }
  }
}

/** Watches every container terminal's commands for agents. */
export class TerminalAgentTracker implements vscode.Disposable {
  private readonly tracked = new Map<vscode.Terminal, TrackedExecution>();
  private readonly claims = new Map<string, Set<string>>();
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
          new TrackedExecution(e.terminal, e.execution, deps, this.claims)
        );
      }),
      vscode.window.onDidEndTerminalShellExecution(e => {
        if (deps.isContainerTerminal(e.terminal)) {
          deps.log(
            `${e.terminal.name}: command ended (exit ${e.exitCode ?? '?'})`
          );
        }
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
