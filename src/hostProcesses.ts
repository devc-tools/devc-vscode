import * as cp from 'child_process';
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

function ps(args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.execFile('ps', args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? undefined : stdout)
    );
  });
}
