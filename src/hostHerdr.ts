import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentInfo, isErrorResponse, parseSnapshot } from './herdr';
import { Classification, parseExplain } from './terminalAgents';

/**
 * herdr running on the host, outside any container. Unlike a container's
 * herdr, the host usually runs several named sessions — one per project
 * folder — each with its own server and socket, so every command here names
 * the session it is for.
 */

export interface HostSession {
  name: string;
  /** The session a bare `herdr` attaches to. */
  default: boolean;
  socketPath: string;
}

/** How often an owned session's snapshot is read. */
const WATCH_INTERVAL_MS = 1000;
/** A herdr command that takes longer than this is treated as failed. */
const COMMAND_TIMEOUT_MS = 10000;

/** Whether host herdr is supported here at all; off on Windows. */
export function hostHerdrSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

/**
 * The environment a host herdr command runs with. VS Code launched from
 * inside a herdr pane passes that pane's HERDR_* variables down to the
 * extension host; left in, they would point every command at that pane's
 * session instead of the one asked for. `$HOME/.local/bin` is prepended
 * because VS Code launched from the Dock may not have it on PATH.
 */
export function herdrEnv(
  socketPath: string | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('HERDR_')) {
      env[key] = value;
    }
  }
  const home = base.HOME ?? os.homedir();
  env.PATH = [path.join(home, '.local', 'bin'), base.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  if (socketPath) {
    env.HERDR_SOCKET_PATH = socketPath;
  }
  return env;
}

/**
 * Run `herdr <args>` on the host, against one session's socket when given.
 * Undefined when herdr cannot be run at all (not installed, timed out).
 */
function runHerdr(
  args: string[],
  socketPath?: string
): Promise<{ exitCode: number; stdout: string } | undefined> {
  return new Promise(resolve => {
    cp.execFile(
      'herdr',
      args,
      {
        env: herdrEnv(socketPath),
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err && typeof err.code !== 'number') {
          // Not an exit status: spawn failure or the timeout's kill.
          resolve(undefined);
          return;
        }
        resolve({ exitCode: err ? Number(err.code) : 0, stdout });
      }
    );
  });
}

/** The running sessions in `herdr session list --json` output. */
export function parseSessionList(output: string): HostSession[] {
  let response: unknown;
  try {
    response = JSON.parse(output);
  } catch {
    return [];
  }
  const sessions =
    isObject(response) && Array.isArray(response.sessions)
      ? response.sessions
      : [];
  const result: HostSession[] = [];
  for (const s of sessions) {
    if (
      isObject(s) &&
      s.running === true &&
      typeof s.name === 'string' &&
      typeof s.socket_path === 'string'
    ) {
      result.push({
        name: s.name,
        default: s.default === true,
        socketPath: s.socket_path,
      });
    }
  }
  return result;
}

/** Running host sessions; [] when herdr is missing or the host is Windows. */
export async function listHostSessions(): Promise<HostSession[]> {
  if (!hostHerdrSupported()) {
    return [];
  }
  const res = await runHerdr(['session', 'list', '--json']);
  return res?.exitCode === 0 ? parseSessionList(res.stdout) : [];
}

/**
 * One reading of a session's agents. Undefined when the session cannot be
 * read — stopped since it was listed, or herdr failed.
 */
export async function readHostSession(
  session: HostSession
): Promise<AgentInfo[] | undefined> {
  const res = await runHerdr(['api', 'snapshot'], session.socketPath);
  const line = res?.stdout.trim() ?? '';
  if (res?.exitCode !== 0 || isErrorResponse(line)) {
    return undefined;
  }
  return parseSnapshot(line);
}

/**
 * Stream one session's agents, like watchHerdr, until disposed or the session
 * stops. `onAgents` fires once per change in herdr's snapshot; `onExit` fires
 * when the session can no longer be read.
 */
export function watchHostSession(
  session: HostSession,
  onAgents: (agents: AgentInfo[]) => void,
  onExit: () => void
): { dispose(): void } {
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  let previous: string | undefined;
  const tick = async () => {
    const agents = await readHostSession(session);
    if (disposed) {
      return;
    }
    if (!agents) {
      disposed = true;
      onExit();
      return;
    }
    const json = JSON.stringify(agents);
    if (json !== previous) {
      previous = json;
      onAgents(agents);
    }
    timer = setTimeout(tick, WATCH_INTERVAL_MS);
  };
  tick();
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Switch a session's herdr to an agent's pane: the tab first, which is what
 * attached clients follow, then the pane within it — as focusHerdrAgent does
 * in containers.
 */
export async function focusHostHerdrAgent(
  session: HostSession,
  agent: Pick<AgentInfo, 'paneId' | 'tabId'>
): Promise<boolean> {
  if (agent.tabId) {
    const tab = await runHerdr(
      ['tab', 'focus', agent.tabId],
      session.socketPath
    );
    if (tab?.exitCode !== 0) {
      return false;
    }
  }
  const res = await runHerdr(
    ['agent', 'focus', agent.paneId],
    session.socketPath
  );
  return res?.exitCode === 0;
}

/** Close an agent's pane in a host session, as closeHerdrPane does in containers. */
export async function closeHostHerdrPane(
  session: HostSession,
  paneId: string
): Promise<boolean> {
  const res = await runHerdr(['pane', 'close', paneId], session.socketPath);
  return res?.exitCode === 0;
}

/**
 * Stop a host session's server, ending every pane in it; clients attached to
 * it exit. Undefined on success, else why it failed.
 */
export function stopHostSession(name: string): Promise<string | undefined> {
  return runSessionCommand(['session', 'stop', name]);
}

/**
 * Delete a stopped host session, removing its saved state. herdr refuses
 * the default session. Undefined on success, else why it failed.
 */
export function deleteHostSession(name: string): Promise<string | undefined> {
  return runSessionCommand(['session', 'delete', name]);
}

async function runSessionCommand(args: string[]): Promise<string | undefined> {
  const res = await runHerdr(args);
  if (!res) {
    return 'herdr could not be run';
  }
  return res.exitCode === 0
    ? undefined
    : (errorMessage(res.stdout) ?? `herdr exited with ${res.exitCode}`);
}

/** The message in a herdr `{"error":{...}}` response. */
export function errorMessage(output: string): string | undefined {
  try {
    const message = JSON.parse(output)?.error?.message;
    return typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify an agent's screen with the host's herdr, as classifyScreen does
 * with a container's. Undefined when herdr is missing or cannot tell.
 */
export async function classifyHostScreen(
  agent: string,
  screen: string
): Promise<Classification | undefined> {
  let dir: string | undefined;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devc-screen-'));
    const file = path.join(dir, 'screen.txt');
    await fs.promises.writeFile(file, screen, 'utf8');
    const res = await runHerdr([
      'agent',
      'explain',
      '--file',
      file,
      '--agent',
      agent,
      '--format',
      'json',
    ]);
    return res?.exitCode === 0 ? parseExplain(res.stdout.trim()) : undefined;
  } catch {
    return undefined;
  } finally {
    if (dir) {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * The session a foreground command line is a herdr client for, or undefined
 * if it is not a herdr client. `herdr --session <name>` and `herdr session
 * attach <name>` name it; a bare `herdr` is the default session, whose name
 * the caller supplies. `herdr server` and other subcommands are not clients.
 */
export function sessionFromClientArgs(
  args: string,
  defaultSession: string | undefined
): string | undefined {
  const argv = args.trim().split(/\s+/);
  if (path.posix.basename(argv[0] ?? '') !== 'herdr') {
    return undefined;
  }
  const rest = argv.slice(1);
  if (rest.length === 0) {
    return defaultSession;
  }
  if (rest[0] === '--session' && rest[1]) {
    return rest[1];
  }
  const eq = /^--session=(.+)$/.exec(rest[0]);
  if (eq) {
    return eq[1];
  }
  if (rest[0] === 'session' && rest[1] === 'attach' && rest[2]) {
    return rest[2];
  }
  return undefined;
}

/**
 * Longest session name sessionNameForDir gives. herdr's sockets live at
 * `~/.config/herdr/sessions/<name>/herdr-client.sock`, and a socket path must
 * fit in about 104 bytes.
 */
const MAX_SESSION_NAME = 40;

/**
 * The session name `herdrs` gives a directory: its path relative to `home`
 * (or its absolute path, outside it or for `home` itself), one part per
 * folder joined with `.`. Each folder name is lowercased, `.` in it made `_`,
 * each run of other characters outside `[a-z0-9_-]` made one `-`, and `-`
 * trimmed from both ends; folders left empty are dropped. A name over
 * MAX_SESSION_NAME keeps the whole folders at its end that fit and gains a
 * hash of the whole name.
 * herdr-plugins' scripts/bash_aliases.sh applies the same rule, so keep the
 * two in step. Undefined when nothing is left.
 */
export function sessionNameForDir(
  dir: string,
  home: string = os.homedir()
): string | undefined {
  const abs = path.resolve(dir);
  const rel = path.relative(path.resolve(home), abs);
  const underHome =
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel);
  const name = (underHome ? rel : abs)
    .split(/[\\/]+/)
    .map(part =>
      part
        .toLowerCase()
        .replace(/\./g, '_')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter(Boolean)
    .join('.');
  if (name.length <= MAX_SESSION_NAME) {
    return name || undefined;
  }
  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 6);
  const keep = MAX_SESSION_NAME - hash.length - 1;
  let tail = name.slice(-keep);
  // Start at a folder boundary rather than partway through a folder's name.
  if (name[name.length - keep - 1] !== '.' && tail.includes('.')) {
    tail = tail.slice(tail.indexOf('.') + 1);
  }
  return `${tail.replace(/^[^a-z0-9]+/, '')}-${hash}`;
}

/** The shell command that opens a client on a session. */
export function attachCommand(session: HostSession): string {
  return session.default
    ? 'herdr'
    : `herdr --session ${shellQuote(session.name)}`;
}

function shellQuote(value: string): string {
  return /^[\w.@%+=:,/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
