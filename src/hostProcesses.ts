import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { hostHerdrSupported } from './hostHerdr';

/**
 * What a host (non-container) VS Code terminal is running, read from `ps`.
 * The terminal's shell pid gives its tty, and the tty's foreground process
 * group gives the program in front — exact, with none of the timing-based
 * pty adoption container terminals need.
 */

export interface HostForeground {
  /** The terminal's tty as `ps` names it, e.g. "ttys004" or "pts/3". */
  tty: string;
  pid: number;
  /** The foreground process's full command line. */
  args: string;
}

/**
 * The foreground process in `ps -t <tty> -o pid=,pgid=,tpgid=,command=`
 * output: the process whose group is the tty's foreground group, preferring
 * that group's leader.
 */
export function foregroundFromPs(
  output: string
): { pid: number; args: string } | undefined {
  let found: { pid: number; args: string; leader: boolean } | undefined;
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (!m || m[2] !== m[3]) {
      continue;
    }
    const leader = m[1] === m[3];
    if (!found || (leader && !found.leader)) {
      found = { pid: Number(m[1]), args: m[4].trim(), leader };
    }
  }
  return found && { pid: found.pid, args: found.args };
}

/** A host terminal's pty and the program in its foreground, or undefined off macOS/Linux or when unknown. */
export async function hostTerminalForeground(
  terminal: vscode.Terminal
): Promise<HostForeground | undefined> {
  if (!hostHerdrSupported()) {
    return undefined;
  }
  const shellPid = await terminal.processId;
  if (!shellPid) {
    return undefined;
  }
  const tty = (await ps(['-o', 'tty=', '-p', String(shellPid)]))?.trim();
  // "??" (macOS) and "?" (Linux) mean no controlling terminal.
  if (!tty || tty.startsWith('?')) {
    return undefined;
  }
  const output = await ps(['-t', tty, '-o', 'pid=,pgid=,tpgid=,command=']);
  const fg = output === undefined ? undefined : foregroundFromPs(output);
  return fg && { tty, ...fg };
}

/** How long a foreground reading is reused before `ps` is asked again. */
const FOREGROUND_TTL_MS = 1000;

/**
 * hostTerminalForeground, shared by everything that polls host terminals —
 * session ownership and agent detection — so a terminal is read by `ps` at
 * most once per second however many callers ask.
 */
export class HostForegroundCache {
  private readonly cache = new WeakMap<
    vscode.Terminal,
    { at: number; result: Promise<HostForeground | undefined> }
  >();

  constructor(
    private readonly read: (
      terminal: vscode.Terminal
    ) => Promise<HostForeground | undefined> = hostTerminalForeground,
    private readonly ttlMs = FOREGROUND_TTL_MS
  ) {}

  get(terminal: vscode.Terminal): Promise<HostForeground | undefined> {
    const hit = this.cache.get(terminal);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return hit.result;
    }
    const result = this.read(terminal);
    this.cache.set(terminal, { at: Date.now(), result });
    return result;
  }
}

/** The rows and columns in `stty size` output ("43 181"). */
export function parseSttySize(
  output: string
): { rows: number; cols: number } | undefined {
  const m = /^(\d+) (\d+)$/.exec(output.trim());
  return m && Number(m[1]) > 0 && Number(m[2]) > 0
    ? { rows: Number(m[1]), cols: Number(m[2]) }
    : undefined;
}

/**
 * A host tty's size, which tracks its VS Code terminal's. `tty` is as `ps`
 * names it; BSD stty names the device with -f, GNU stty with -F.
 */
export function hostTtySize(
  tty: string
): Promise<{ rows: number; cols: number } | undefined> {
  const flag = process.platform === 'darwin' ? '-f' : '-F';
  return new Promise(resolve => {
    cp.execFile(
      'stty',
      [flag, `/dev/${tty}`, 'size'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? undefined : parseSttySize(stdout))
    );
  });
}

/**
 * The agents host herdr knows how to detect: one cached manifest per agent
 * id. Empty when herdr is not installed, which turns host terminal detection
 * off.
 */
export async function hostAgentIds(): Promise<ReadonlySet<string>> {
  const dir = path.join(
    os.homedir(),
    '.local',
    'state',
    'herdr',
    'agent-detection',
    'remote'
  );
  try {
    const names = await fs.promises.readdir(dir);
    return new Set(
      names.filter(n => n.endsWith('.toml')).map(n => n.slice(0, -5))
    );
  } catch {
    return new Set();
  }
}

function ps(args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.execFile('ps', args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? undefined : stdout)
    );
  });
}
