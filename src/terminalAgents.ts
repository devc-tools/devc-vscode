import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { execDocker } from './docker';
import { AgentInfo, AgentStatus } from './herdr';
import type { HostForeground } from './hostProcesses';
import { TerminalScreen } from './terminalScreen';

/**
 * Agent detection for agents run straight in a terminal, without herdr
 * managing them — in a container terminal, or a plain host terminal. Agent-agnostic and nothing to configure in the
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
 *
 * Host terminals take the same path from step 2, except that their pty is
 * known exactly from the shell's pid (hostProcesses.ts), and the host's own
 * herdr classifies the screen.
 */

/** One pty in the container, as the probe saw it. */
export interface TtyInfo {
  /** Age of the pty's oldest process: when the session was opened. */
  ageSeconds: number;
  /** The pty's size, which tracks the VS Code terminal's (docker forwards resizes). */
  size?: { rows: number; cols: number };
  /** The agent running on it, preferring the foreground process group. */
  agent?: { agent: string; pid: number };
  /**
   * Working directory of the foreground process, else of the session's
   * oldest process (the shell). Read from /proc, so it follows every `cd`
   * without any shell integration in the container.
   */
  cwd?: string;
  /** Program name of the foreground process, e.g. "herdr" or "bash". */
  foreground?: string;
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
echo ---
ps -eo pid=,tty= | while read -r p t; do
  case $t in pts/*) printf '%s\\t%s\\n' "$p" "$(readlink /proc/$p/cwd 2>/dev/null)" ;; esac
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

/**
 * The agent a command line runs, when its program is one herdr has a
 * detection manifest for. herdr clients, `docker` and `devc` never are: the
 * agents behind those are reported by herdr or the container instead.
 */
export function agentName(
  args: string,
  known: ReadonlySet<string>
): string | undefined {
  const name = programName(args);
  return name && known.has(name) ? name : undefined;
}

/** Parse PROBE_SCRIPT output into the container's ptys. */
export function parseProbe(output: string): ContainerProbe {
  const [manifestPart = '', psPart = '', sizePart = '', cwdPart = ''] =
    output.split(/^---$/m);
  const known = new Set(
    manifestPart
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  );

  const ttys = new Map<string, TtyInfo>();
  const agents = new Map<string, { agent: string; pid: number; fg: boolean }>();
  /** Per tty: the foreground group leader, else a foreground process. */
  const foreground = new Map<
    string,
    { pid: string; leader: boolean; name?: string }
  >();
  /** Per tty: the oldest process, normally the shell docker exec started. */
  const oldest = new Map<string, { pid: string; age: number }>();
  for (const line of psPart.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].startsWith('pts/')) {
      continue;
    }
    const [, pid, tty, pgid, tpgid, etimes, args] = m;
    const info = ttys.get(tty) ?? { ageSeconds: 0 };
    info.ageSeconds = Math.max(info.ageSeconds, Number(etimes));
    ttys.set(tty, info);

    if (pgid === tpgid) {
      const leader = pid === tpgid;
      if (!foreground.get(tty)?.leader) {
        foreground.set(tty, { pid, leader, name: programName(args) });
      }
    }
    if (Number(etimes) >= (oldest.get(tty)?.age ?? -1)) {
      oldest.set(tty, { pid, age: Number(etimes) });
    }

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
  const cwds = new Map<string, string>();
  for (const line of cwdPart.split('\n')) {
    const tab = line.indexOf('\t');
    const cwd = tab >= 0 ? line.slice(tab + 1) : '';
    if (cwd.startsWith('/')) {
      cwds.set(line.slice(0, tab).trim(), cwd);
    }
  }
  for (const [tty, info] of ttys) {
    info.foreground = foreground.get(tty)?.name;
    info.cwd =
      cwds.get(foreground.get(tty)?.pid ?? '') ??
      cwds.get(oldest.get(tty)?.pid ?? '');
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

/** What agent detection needs from a plain host terminal's side. */
export interface HostTerminalDeps {
  /** The terminal's pty and foreground process; undefined when unknown. */
  foreground(terminal: vscode.Terminal): Promise<HostForeground | undefined>;
  /** The agent ids host herdr has detection manifests for. */
  agentIds(): Promise<ReadonlySet<string>>;
  size(tty: string): Promise<{ rows: number; cols: number } | undefined>;
  classify(agent: string, screen: string): Promise<Classification | undefined>;
  /** Called with the terminal's current agent, or undefined when it has none. */
  report(terminal: vscode.Terminal, agent?: AgentInfo): void;
}

export interface TerminalAgentDeps {
  /** Terminals this returns true for are read as container terminals. */
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
  /** Every other terminal is read as a host terminal, when given. */
  host?: HostTerminalDeps;
  log(message: string): void;
}

/** A probe or classification taking longer than this is abandoned. */
const EXEC_TIMEOUT_MS = 10000;
/** Output settles for this long before the screen is classified. */
const SETTLE_MS = 300;
/**
 * Re-check a quiet terminal this often: a pty to adopt, an agent exiting, an
 * agent in a host terminal with no output stream.
 */
const RECHECK_MS = 3000;

/** One look at the pty a terminal's command runs on. */
export interface PtyReading {
  /** The pty's name, e.g. "pts/3" or "ttys004". */
  tty: string;
  size?: { rows: number; cols: number };
  /** The agent running on it. */
  agent?: string;
  /** Working directory, where it can be read. */
  cwd?: string;
  /** Program name of the foreground process, e.g. "herdr" or "bash". */
  foreground?: string;
}

/**
 * Where a tracked terminal's command runs — a container pty or the host's —
 * and how its screen is classified there.
 */
export interface TerminalTarget {
  /** The pty now; undefined when it is not known (yet) or is gone. */
  read(): Promise<PtyReading | undefined>;
  classify(agent: string, screen: string): Promise<Classification | undefined>;
  report(agent: AgentInfo | undefined): void;
  /** Let go of the pty, e.g. a claim on it. */
  release(): void;
}

/**
 * A container terminal's pty: the one in its container opened after the
 * command started, found by probing the container.
 */
class ContainerTarget implements TerminalTarget {
  private readonly startedAt = Date.now();
  private container: { id: string; user: string | undefined } | undefined;
  private tty: string | undefined;

  constructor(
    private readonly terminal: vscode.Terminal,
    private readonly deps: TerminalAgentDeps,
    /** ptys already owned by some terminal, by container. */
    private readonly claims: Map<string, Set<string>>
  ) {}

  private claimed(id: string): Set<string> {
    let set = this.claims.get(id);
    if (!set) {
      set = new Set();
      this.claims.set(id, set);
    }
    return set;
  }

  async read(): Promise<PtyReading | undefined> {
    this.container ??= await this.deps.resolveContainer(this.terminal);
    if (!this.container) {
      return undefined;
    }
    const { id, user } = this.container;
    const probe = await this.deps.probe(id, user);
    if (!probe) {
      return undefined;
    }
    if (this.tty && !probe.ttys.has(this.tty)) {
      this.deps.log(`${this.terminal.name}: ${this.tty} closed`);
      this.release();
    }
    if (!this.tty) {
      const age = (Date.now() - this.startedAt) / 1000;
      this.tty = adoptTty(probe, age, this.claimed(id));
      if (!this.tty) {
        return undefined;
      }
      this.claimed(id).add(this.tty);
      this.deps.log(
        `${this.terminal.name}: adopted ${id.slice(0, 12)} ${this.tty}`
      );
    }
    const info = probe.ttys.get(this.tty)!;
    return {
      tty: this.tty,
      size: info.size,
      agent: info.agent?.agent,
      cwd: info.cwd,
      foreground: info.foreground,
    };
  }

  classify(agent: string, screen: string) {
    const container = this.container;
    return container
      ? this.deps.classify(container.id, container.user, agent, screen)
      : Promise.resolve(undefined);
  }

  report(agent: AgentInfo | undefined): void {
    if (this.container) {
      this.deps.report(this.terminal, this.container.id, agent);
    }
  }

  release(): void {
    if (this.container && this.tty) {
      this.claims.get(this.container.id)?.delete(this.tty);
    }
    this.tty = undefined;
  }
}

/**
 * The agent in a host terminal's foreground, if any. Reading the tty's size
 * is skipped when there is no agent to classify.
 */
async function readHostPty(
  terminal: vscode.Terminal,
  host: HostTerminalDeps,
  withSize: boolean
): Promise<PtyReading | undefined> {
  const fg = await host.foreground(terminal);
  if (!fg) {
    return undefined;
  }
  const agent = agentName(fg.args, await host.agentIds());
  return {
    tty: fg.tty,
    agent,
    size: agent && withSize ? await host.size(fg.tty) : undefined,
    foreground: programName(fg.args),
  };
}

/** A plain host terminal's pty, known exactly from its shell's pid. */
export class HostTarget implements TerminalTarget {
  constructor(
    private readonly terminal: vscode.Terminal,
    private readonly host: HostTerminalDeps
  ) {}

  read(): Promise<PtyReading | undefined> {
    return readHostPty(this.terminal, this.host, true);
  }

  classify(agent: string, screen: string) {
    return this.host.classify(agent, screen);
  }

  report(agent: AgentInfo | undefined): void {
    this.host.report(this.terminal, agent);
  }

  release(): void {}
}

/**
 * The agent in a host terminal whose output cannot be read — its command
 * started before the extension did, or it has no shell integration. Present,
 * but in an unknown state.
 */
export async function presentHostAgent(
  terminal: vscode.Terminal,
  host: HostTerminalDeps
): Promise<AgentInfo | undefined> {
  const pty = await readHostPty(terminal, host, false);
  return pty?.agent
    ? { paneId: `terminal:${pty.tty}`, agent: pty.agent, status: 'unknown' }
    : undefined;
}

/** The part of a shell execution that is read: its command and output. */
export type ExecutionOutput = Pick<
  vscode.TerminalShellExecution,
  'read' | 'commandLine'
>;

/** Reads one command's output and keeps its agent status current. */
export class TrackedExecution {
  private readonly screen = new TerminalScreen();
  private timer: NodeJS.Timeout | undefined;
  private evaluating = false;
  private dirty = false;
  private disposed = false;
  /** The terminal's working directory, as last read. */
  cwd: string | undefined;
  /** Program name in the foreground of the terminal's pty, as last read. */
  foreground: string | undefined;
  private last: string | undefined;

  constructor(
    private readonly terminal: vscode.Terminal,
    execution: ExecutionOutput,
    private readonly target: TerminalTarget,
    private readonly log: (message: string) => void
  ) {
    // read() only yields data written after it is first called.
    const stream = execution.read();
    log(`${terminal.name}: command started: ${execution.commandLine.value}`);
    this.pump(stream)
      .catch(err => log(`${terminal.name}: read failed: ${err}`))
      .finally(() => {
        log(`${terminal.name}: output stream ended`);
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

  private async evaluate(): Promise<void> {
    if (this.disposed || this.evaluating) {
      return;
    }
    this.evaluating = true;
    this.dirty = false;
    try {
      const info = await this.target.read();
      if (this.disposed) {
        return;
      }
      if (!info) {
        this.cwd = undefined;
        this.foreground = undefined;
        return;
      }

      this.foreground = info.foreground;
      if (info.cwd !== this.cwd) {
        this.cwd = info.cwd;
        this.log(`${this.terminal.name} ${info.tty}: cwd ${this.cwd}`);
      }
      if (info.size) {
        await this.screen.resize(info.size.cols, info.size.rows);
      }
      const screen = await this.screen.text();
      const result = info.agent
        ? await this.target.classify(info.agent, screen)
        : undefined;
      if (this.disposed || (result?.keepPrevious && this.last)) {
        return;
      }

      const summary = result
        ? `${result.agent} ${result.status} (${result.rule ?? 'no rule matched'}) ${info.size?.cols}x${info.size?.rows}`
        : 'no agent';
      if (summary !== this.last) {
        this.last = summary;
        this.log(`${this.terminal.name} ${info.tty}: ${summary}`);
        if (result && !result.rule) {
          this.log(`screen:\n${screen}`);
        }
      }
      // The agent is known from the pty's own processes, so herdr's fallback
      // state (no rule matched) is still that agent's state — as in herdr.
      this.target.report(
        result && {
          paneId: `terminal:${info.tty}`,
          agent: result.agent,
          status: result.status,
          title: this.screen.title || undefined,
        }
      );
    } catch (err) {
      this.log(`${this.terminal.name}: ${(err as Error).message}`);
    } finally {
      this.evaluating = false;
      if (!this.disposed) {
        // Output arrived mid-evaluation: go again. Otherwise re-check later so
        // a pty is adopted and an agent that exits quietly is noticed.
        this.schedule(this.dirty ? SETTLE_MS : RECHECK_MS);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.target.release();
    this.cwd = undefined;
    this.foreground = undefined;
    this.screen.dispose();
    this.target.report(undefined);
  }
}

/**
 * Watches every terminal's commands for agents: container terminals always,
 * other terminals as host terminals when host deps are given.
 */
export class TerminalAgentTracker implements vscode.Disposable {
  private readonly tracked = new Map<vscode.Terminal, TrackedExecution>();
  private readonly claims = new Map<string, Set<string>>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly presencePoll: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TerminalAgentDeps) {
    this.subscriptions = [
      vscode.window.onDidStartTerminalShellExecution(e => {
        const target = this.targetFor(e.terminal);
        if (!target) {
          return;
        }
        this.tracked.get(e.terminal)?.dispose();
        this.tracked.set(
          e.terminal,
          new TrackedExecution(e.terminal, e.execution, target, deps.log)
        );
      }),
      vscode.window.onDidEndTerminalShellExecution(e => {
        if (this.tracked.has(e.terminal)) {
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
        if (!deps.isContainerTerminal(t)) {
          deps.host?.report(t, undefined);
        }
      }),
    ];
    if (deps.host) {
      this.presencePoll = setInterval(() => this.checkPresence(), RECHECK_MS);
      this.checkPresence();
    }
  }

  private targetFor(terminal: vscode.Terminal): TerminalTarget | undefined {
    if (this.deps.isContainerTerminal(terminal)) {
      return new ContainerTarget(terminal, this.deps, this.claims);
    }
    return this.deps.host && new HostTarget(terminal, this.deps.host);
  }

  /** Host terminals whose output is not being read: agent present or not. */
  private checkPresence(): void {
    const host = this.deps.host;
    if (!host) {
      return;
    }
    for (const terminal of vscode.window.terminals) {
      if (
        this.tracked.has(terminal) ||
        this.deps.isContainerTerminal(terminal)
      ) {
        continue;
      }
      presentHostAgent(terminal, host).then(
        agent => {
          // A command started meanwhile reports for itself.
          if (!this.tracked.has(terminal) && !terminal.exitStatus) {
            host.report(terminal, agent);
          }
        },
        err => this.deps.log(`${terminal.name}: ${(err as Error).message}`)
      );
    }
  }

  /**
   * A container terminal's current working directory inside the container,
   * a few seconds stale at most; undefined until its pty has been found.
   */
  cwdFor(terminal: vscode.Terminal): string | undefined {
    return this.tracked.get(terminal)?.cwd;
  }

  /** The program in the foreground of a tracked terminal, when known. */
  foregroundFor(terminal: vscode.Terminal): string | undefined {
    return this.tracked.get(terminal)?.foreground;
  }

  dispose(): void {
    clearInterval(this.presencePoll);
    for (const t of this.tracked.values()) {
      t.dispose();
    }
    this.tracked.clear();
    this.subscriptions.forEach(s => s.dispose());
  }
}
