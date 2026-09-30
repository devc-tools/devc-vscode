import * as cp from 'child_process';
import * as fs from 'fs';
import { execDocker } from './docker';

/**
 * Running a command inside an environment — a dev container through
 * `docker exec`, or an SSH host through plain `ssh` — so the file system
 * provider, herdr and terminal agent detection work the same on either.
 */

export interface ShellResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface RunOptions {
  /** Piped to the command's stdin. */
  input?: Uint8Array;
  /** Keep stdin attached even with no input (`docker exec -i`). */
  interactive?: boolean;
  /** Kill the command and reject after this long. */
  timeoutMs?: number;
}

export interface RemoteShell {
  /**
   * Run `argv` in the environment. Never rejects on a non-zero exit; rejects
   * when the command cannot be started or `timeoutMs` passes.
   */
  run(argv: string[], options?: RunOptions): Promise<ShellResult>;
  /**
   * Start `argv` with stdin held open and stdout piped, for a long-lived
   * stream; ending stdin is how the caller asks it to stop.
   */
  spawn(argv: string[]): cp.ChildProcess;
}

/** A dev container, reached with `docker exec`, as `user` when given. */
export class DockerShell implements RemoteShell {
  constructor(
    private readonly containerId: string,
    private readonly user: string | undefined,
    private readonly dockerCommand: string
  ) {}

  private args(argv: string[], interactive: boolean): string[] {
    return [
      'exec',
      ...(interactive ? ['-i'] : []),
      ...(this.user ? ['-u', this.user] : []),
      this.containerId,
      ...argv,
    ];
  }

  run(argv: string[], options: RunOptions = {}): Promise<ShellResult> {
    return execDocker(
      this.args(argv, !!options.interactive || options.input !== undefined),
      options.input,
      this.dockerCommand,
      options.timeoutMs
    );
  }

  spawn(argv: string[]): cp.ChildProcess {
    return cp.spawn(this.dockerCommand, this.args(argv, true), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  }
}

// ── SSH ─────────────────────────────────────────────────────────────────────

/** ssh's own failures (connection, auth, host key) exit with this. */
export const SSH_FAILURE_EXIT = 255;

/** How long an ssh command gets when the caller sets no timeout. */
export const SSH_DEFAULT_TIMEOUT_MS = 30000;

/** Thrown before anything is spawned for a host that is not configured. */
export class SshHostNotAllowedError extends Error {
  constructor(readonly host: string) {
    super(`"${host}" is not a configured SSH host (devc-vscode.sshHosts)`);
  }
}

/**
 * Quote one word for a POSIX shell. ssh joins its trailing arguments into a
 * single string the remote login shell parses, so every word is quoted.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `argv` as one remote command string, every word quoted. */
export function remoteCommand(argv: string[]): string {
  return argv.map(shQuote).join(' ');
}

/** Forwarding options forced on every ssh this extension runs. */
export const SSH_SAFETY_OPTIONS = [
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'PermitLocalCommand=no',
];

/** Connection multiplexing through a socket in `controlDir`. */
export function controlOptions(controlDir: string | undefined): string[] {
  return controlDir
    ? [
        '-o',
        'ControlMaster=auto',
        '-o',
        `ControlPath=${controlDir}/%C`,
        '-o',
        'ControlPersist=60',
      ]
    : [];
}

/** The ssh arguments (after the ssh program) for a non-interactive command. */
export function sshArgs(
  host: string,
  argv: string[],
  controlDir: string | undefined
): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    ...SSH_SAFETY_OPTIONS,
    ...controlOptions(controlDir),
    '--',
    host,
    remoteCommand(argv),
  ];
}

/**
 * Why an ssh command failed, when ssh itself did (exit 255); undefined when
 * the remote command ran and exited on its own.
 */
export function sshFailure(
  host: string,
  result: Pick<ShellResult, 'exitCode' | 'stderr'>
): string | undefined {
  if (result.exitCode !== SSH_FAILURE_EXIT) {
    return undefined;
  }
  const stderr = result.stderr.toString('utf8').trim();
  if (stderr.includes('Host key verification failed')) {
    return `${host}: unknown host key — run "ssh ${host}" once in a terminal to accept it.`;
  }
  return stderr || `${host}: ssh failed`;
}

export type Spawn = (
  command: string,
  args: string[],
  options: cp.SpawnOptions
) => cp.ChildProcess;

export interface SshShellOptions {
  sshPath: string;
  /** Where multiplexing sockets go; undefined runs without multiplexing. */
  controlDir: string | undefined;
  /** Whether a host is configured. Checked before every spawn. */
  allowed(host: string): boolean;
  /** Injected for tests. */
  spawn?: Spawn;
}

/** An SSH host, reached with plain `ssh` and the user's ~/.ssh/config. */
export class SshShell implements RemoteShell {
  constructor(
    readonly host: string,
    private readonly options: SshShellOptions
  ) {}

  private start(argv: string[], stdio: cp.StdioOptions): cp.ChildProcess {
    if (!this.host || !this.options.allowed(this.host)) {
      throw new SshHostNotAllowedError(this.host);
    }
    const spawn = this.options.spawn ?? cp.spawn;
    return spawn(
      this.options.sshPath,
      sshArgs(this.host, argv, this.options.controlDir),
      { stdio }
    );
  }

  run(argv: string[], options: RunOptions = {}): Promise<ShellResult> {
    return new Promise((resolve, reject) => {
      let child: cp.ChildProcess;
      try {
        child = this.start(argv, ['pipe', 'pipe', 'pipe']);
      } catch (err) {
        reject(err);
        return;
      }
      const timeoutMs = options.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(`ssh ${this.host} timed out after ${timeoutMs / 1000}s`)
        );
      }, timeoutMs);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdin?.on('error', () => {
        /* the command already ended */
      });
      child.on('error', err => {
        clearTimeout(timer);
        reject(
          new Error(`Failed to start ${this.options.sshPath}: ${err.message}`)
        );
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: code ?? -1,
        });
      });
      if (options.input) {
        child.stdin?.write(options.input);
      }
      child.stdin?.end();
    });
  }

  spawn(argv: string[]): cp.ChildProcess {
    return this.start(argv, ['pipe', 'pipe', 'ignore']);
  }
}

/**
 * Whether `stat` describes a directory safe for ssh control sockets: owned by
 * this user and closed to everyone else.
 */
export function controlDirUsable(
  stat: Pick<fs.Stats, 'isDirectory' | 'uid' | 'mode'>,
  uid: number
): boolean {
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o777) === 0o700;
}

/**
 * Longest control directory that keeps sockets under the Unix socket path
 * limit (104 bytes on macOS, including the NUL): ssh appends `/%C` (41) and,
 * while starting a master, binds a temporary `.XXXXXXXXXXXXXXXX` (17) first.
 */
export const MAX_CONTROL_DIR_LENGTH = 103 - 41 - 17;

/**
 * The directory ssh control sockets go in, created when missing, or
 * undefined when it is not safe to use — then ssh runs without
 * multiplexing. `/tmp/devc-<uid>` rather than `os.tmpdir()`, which on macOS
 * (`/var/folders/…/T`) is too long for a socket path.
 */
export function ensureControlDir(): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return undefined;
  }
  const dir = `/tmp/devc-${uid}`;
  if (dir.length > MAX_CONTROL_DIR_LENGTH) {
    return undefined;
  }
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return undefined;
    }
  }
  try {
    return controlDirUsable(fs.lstatSync(dir), uid) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** One word for the host's shell: bare when that is safe, else quoted. */
function hostShellWord(value: string): string {
  return /^[\w.@%+=:,/-]+$/.test(value) ? value : shQuote(value);
}

/**
 * The command an SSH terminal types into its host shell: an interactive ssh
 * with forwarding forced off, that starts in `root` (the remote home when
 * undefined) and attaches to herdr `session` there — or, with no herdr on
 * the host, opens a login shell.
 */
export function sshTerminalCommand(
  sshPath: string,
  host: string,
  root: string | undefined,
  session: string,
  controlDir: string | undefined
): string {
  const remote = [
    root !== undefined && `cd ${shQuote(root)}`,
    'PATH="$HOME/.local/bin:$PATH"',
    `if command -v herdr >/dev/null 2>&1; then exec herdr --session ${shQuote(session)}; else exec "\${SHELL:-sh}" -l; fi`,
  ]
    .filter(Boolean)
    .join(' && ');
  return [
    sshPath,
    '-t',
    ...SSH_SAFETY_OPTIONS,
    ...controlOptions(controlDir),
    '--',
    host,
    remote,
  ]
    .map(hostShellWord)
    .join(' ');
}

// ── Container terminals without devc ────────────────────────────────────────

/**
 * The command a container terminal types into its host shell when there is
 * no devc to run: an interactive `docker exec` as `user` in `workdir` that
 * attaches to herdr `session` in the container — or, with no herdr there,
 * opens the user's login shell. `docker exec` rarely sets $SHELL, so the
 * login shell comes from passwd.
 */
export function containerTerminalCommand(
  dockerCommand: string,
  containerId: string,
  user: string | undefined,
  workdir: string | undefined,
  session: string
): string {
  const script =
    'PATH="$HOME/.local/bin:$PATH"; ' +
    'if command -v herdr >/dev/null 2>&1; then ' +
    `exec herdr --session=${hostShellWord(session)}; ` +
    'else s=$(getent passwd "$(id -u)" | cut -d: -f7); exec "${s:-sh}" -l; fi';
  return [
    dockerCommand,
    'exec',
    '-it',
    ...(user ? ['-u', user] : []),
    ...(workdir ? ['-w', workdir] : []),
    containerId,
    'sh',
    '-c',
    script,
  ]
    .map(hostShellWord)
    .join(' ');
}
