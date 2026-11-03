import * as posix from 'path/posix';
import { SSH_SAFETY_OPTIONS, controlOptions, shQuote } from './remoteShell';

/**
 * Terminal Here's commands, as argv for `createTerminal({ shellPath,
 * shellArgs })`: nothing goes through a local shell, so nothing on this side
 * needs quoting.
 */

/**
 * The login shell from passwd: `docker exec` rarely sets $SHELL. Runs in
 * the container's `sh -c`.
 */
export const CONTAINER_LOGIN_SHELL =
  's=$(getent passwd "$(id -u)" | cut -d: -f7); exec "${s:-sh}" -l';

/** `docker <args>`: an interactive login shell in `dir`, as `user` when given. */
export function containerTerminalArgs(
  containerId: string,
  user: string | undefined,
  dir: string
): string[] {
  return [
    'exec',
    '-it',
    ...(user ? ['-u', user] : []),
    '-w',
    dir,
    containerId,
    'sh',
    '-c',
    CONTAINER_LOGIN_SHELL,
  ];
}

/**
 * `ssh <args>`: an interactive login shell in `dir` on `host`, forwarding
 * forced off. The last word is the remote command the remote shell parses,
 * so `dir` is quoted there.
 */
export function sshTerminalArgs(
  host: string,
  dir: string,
  controlDir: string | undefined
): string[] {
  return [
    '-t',
    ...SSH_SAFETY_OPTIONS,
    ...controlOptions(controlDir),
    '--',
    host,
    `cd ${shQuote(dir)} && exec "\${SHELL:-sh}" -l`,
  ];
}

/** `<root label>: <folder name>`, or just the label at '/'. */
export function terminalName(rootLabel: string, dir: string): string {
  const base = posix.basename(dir);
  return base ? `${rootLabel}: ${base}` : rootLabel;
}
