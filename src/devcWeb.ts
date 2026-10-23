import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { WatchdogOptions } from './devcWebWatchdog';

/**
 * The extension's `devc web`: one server on one port for every window,
 * started on first use under a watchdog that stops it when no window uses it,
 * its URL read from the ready line, and the pages built from that URL. No
 * vscode import, so all of it tests under plain mocha.
 *
 * The ready line carries the server's token. stdout is read only for that
 * line and is otherwise discarded: nothing from it reaches a log, an output
 * channel, a notification or a file. Other windows get it from the secret
 * store (RecordStore).
 */

/** devc web's ready line, as devc-desktop matches it. */
const READY_LINE =
  /^devc web: (http:\/\/127\.0\.0\.1:\d{1,5}\/#token=[0-9a-f]{64})$/;

/** stderr lines kept for a failed start. */
const STDERR_LINES = 50;
/** How long devc web has to print its ready line. */
export const READY_TIMEOUT_MS = 10000;
/** How long a stopping devc web has after SIGTERM before SIGKILL. */
export const STOP_TIMEOUT_MS = 5000;

export type DevcWebPage = 'sidebar' | 'main';

/**
 * The URL in a stdout line when it is devc web's ready line. A trailing
 * `\r` or other trailing whitespace is ignored; anything else must match
 * exactly.
 */
export function parseReadyLine(line: string): string | undefined {
  return READY_LINE.exec(line.trimEnd())?.[1];
}

/** A view id pairing this window's sidebar with its tiles. */
export function newViewId(): string {
  return `vscode-${crypto.randomBytes(6).toString('hex')}`;
}

/** The ready URL's origin, `http://127.0.0.1:<port>`. */
export function readyOrigin(ready: string): string {
  return new URL(ready).origin;
}

/**
 * `http://127.0.0.1:<port>/<page>#token=<t>&view=<view>` from the ready
 * line's `http://127.0.0.1:<port>/#token=<t>`. `origin` replaces the ready
 * URL's own, for a port mapped by `asExternalUri`.
 */
export function pageUrl(
  ready: string,
  page: DevcWebPage,
  view: string,
  origin: string = readyOrigin(ready)
): string {
  const url = new URL(ready);
  const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? '';
  return `${origin.replace(/\/+$/, '')}/${page}#token=${token}&view=${encodeURIComponent(view)}`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_STYLE =
  'html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }';

/**
 * The view's page: one full-size iframe of `src`. The webview's own
 * document runs no script (its CSP has no `script-src`); the framed page
 * runs its own, under its own CSP.
 */
export function sidebarHtml(src: string, frameOrigins: string[]): string {
  const origins = [...new Set(frameOrigins)].join(' ');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(origins)}; style-src 'unsafe-inline'">
<style>${BASE_STYLE} iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body><iframe src="${escapeHtml(src)}" allow="clipboard-read; clipboard-write"></iframe></body>
</html>`;
}

/**
 * The view's page while there is no sidebar to show: `text`, then `detail`
 * (such as an stderr tail) and, with `restart`, a link to the restart
 * command.
 */
export function messageHtml(
  text: string,
  options: { detail?: string; restart?: string } = {}
): string {
  const detail = options.detail
    ? `<pre>${escapeHtml(options.detail)}</pre>`
    : '';
  const restart = options.restart
    ? `<p><a href="command:${escapeHtml(options.restart)}">Restart</a></p>`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body { padding: 0 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); } pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); opacity: 0.8; }</style>
</head>
<body><p>${escapeHtml(text)}</p>${detail}${restart}</body>
</html>`;
}

/**
 * Which devc runs devc web, as devc-desktop's `desktopDevc` picks it:
 * `installed` (devc on PATH), `devc2` (the checkout from source, through
 * `$DEVC_BIN`) or an absolute path to a devc binary.
 */
export type DevcChoice =
  | { kind: 'installed' }
  | { kind: 'devc2' }
  | { kind: 'path'; path: string };

/** A devc to run: its command words, and a PATH for the child when set. */
export interface DevcCommand {
  cmd: string[];
  path?: string;
}

/** The `devc-vscode.devcWebDevc` setting's value as a choice. */
export function devcChoice(setting: unknown): DevcChoice {
  if (setting === 'devc2') {
    return { kind: 'devc2' };
  }
  if (typeof setting === 'string' && setting.startsWith('/')) {
    return { kind: 'path', path: setting };
  }
  return { kind: 'installed' };
}

/** `$DEVC_BIN`'s words: a multi-word command, split on whitespace. */
export function commandWords(s: string): string[] {
  return s.trim().split(/\s+/).filter(w => w !== '');
}

export interface LoginEnv {
  path: string;
  devcBin?: string;
}

/** Brackets the values in the login shell's output, which rc files may add to. */
const MARK = '__devc_vscode__';
/** How long the login shell gets to answer. */
const LOGIN_SHELL_MS = 5000;

/**
 * `PATH` and `$DEVC_BIN` as the user's login shell sets them, interactive
 * too so rc files (where `bash_aliases.sh` is sourced) count. Undefined on
 * failure or after 5 s.
 */
export function loginEnv(
  shell = process.env.SHELL || '/bin/sh'
): Promise<LoginEnv | undefined> {
  return new Promise(resolve => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(
        shell,
        ['-ilc', `printf '${MARK}%s${MARK}%s${MARK}' "$PATH" "\${DEVC_BIN:-}"`],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: LOGIN_SHELL_MS }
      );
    } catch {
      return resolve(undefined);
    }
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (text += d));
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      const m = new RegExp(`${MARK}(.*?)${MARK}(.*?)${MARK}`, 's').exec(text);
      if (!m?.[1]) {
        return resolve(undefined);
      }
      resolve(m[2] ? { path: m[1], devcBin: m[2] } : { path: m[1] });
    });
  });
}

export interface ResolveDevcDeps {
  /** The installed devc, as tools.findDevc finds it. */
  installed(): Promise<string | undefined>;
  env(name: string): string | undefined;
  loginEnv(): Promise<LoginEnv | undefined>;
  /** The first executable `name` on `path`. */
  onPath(name: string, path: string): Promise<string | undefined>;
}

/**
 * The devc that `choice` asks for. `devc2` is `$DEVC_BIN` from the
 * extension host's environment, else the login shell's, its first word
 * resolved on the login shell's PATH, which the child gets too. Rejects
 * with a DevcWebError saying where it looked.
 */
export async function resolveDevc(
  choice: DevcChoice,
  deps: ResolveDevcDeps
): Promise<DevcCommand> {
  if (choice.kind === 'path') {
    return { cmd: [choice.path] };
  }
  if (choice.kind === 'installed') {
    const devc = await deps.installed();
    if (devc) {
      return { cmd: [devc] };
    }
    throw new DevcWebError(
      'devc web needs devc: install it or put it on PATH',
      ''
    );
  }
  const own = commandWords(deps.env('DEVC_BIN') ?? '');
  if (own.length) {
    return { cmd: own };
  }
  const login = await deps.loginEnv();
  const bin = commandWords(login?.devcBin ?? '');
  const first =
    login && bin.length
      ? bin[0].includes('/')
        ? bin[0]
        : await deps.onPath(bin[0], login.path)
      : undefined;
  if (!login || !first) {
    throw new DevcWebError(
      "devc web is set to run devc2, but $DEVC_BIN is not set: source devc-tools' scripts/bash_aliases.sh in your shell's rc file",
      ''
    );
  }
  return { cmd: [first, ...bin.slice(1)], path: login.path };
}

export type DevcWebState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'ready'; url: string }
  | { kind: 'stopped'; message: string; stderr: string };

/** A failed start: what happened, with devc web's last stderr lines. */
export class DevcWebError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

/**
 * Where the windows find the shared devc web: its watchdog's pid and its
 * ready URL, which holds the token. Kept in a secret store, never a file.
 */
export interface SharedRecord {
  pid: number;
  url: string;
}

/** One value shared by every window, such as a SecretStorage key. */
export interface RecordStore {
  get(): Promise<string | undefined>;
  store(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** The record in `text`, when it is one. */
export function parseRecord(text: string | undefined): SharedRecord | undefined {
  try {
    const value = JSON.parse(text ?? '') as Partial<SharedRecord>;
    return typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.url === 'string' &&
      parseReadyLine(`devc web: ${value.url}`) === value.url
      ? { pid: value.pid, url: value.url }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface DevcWebTimeouts {
  /** How long devc web has to print its ready line. */
  readyMs: number;
  /** How long a stopping devc web has after SIGTERM before SIGKILL. */
  stopMs: number;
  /** How often a window checks the shared server is still the one it uses. */
  pollMs: number;
  /** How long the watchdog keeps devc web with no client window alive. */
  graceMs: number;
  /** How often the watchdog checks the client windows. */
  watchdogPollMs: number;
}

export const DEFAULT_TIMEOUTS: DevcWebTimeouts = {
  readyMs: READY_TIMEOUT_MS,
  stopMs: STOP_TIMEOUT_MS,
  pollMs: 2000,
  graceMs: 10000,
  watchdogPollMs: 2000,
};

export interface DevcWebServerOptions {
  /** The devc to run; rejects with a DevcWebError saying why there is none. */
  command(): Promise<DevcCommand>;
  args(): string[];
  /** The port devc web listens on, unless `args` names one. */
  port(): number;
  /** The directory every window shares: `clients/` and `start.lock`. */
  dir: string;
  store: RecordStore;
  /** This window's pid, its client file's name: the extension host's. */
  pid?: number;
  timeouts?: Partial<DevcWebTimeouts>;
}

/** The watchdog script, next to this module in `out/`. */
const WATCHDOG = path.join(__dirname, 'devcWebWatchdog.js');
/** How often a window waiting on another's start looks for its record. */
const WAIT_POLL_MS = 200;

/**
 * This window's handle on the one `devc web` every window shares, on one
 * port. `url()` adopts the running one or starts it under the watchdog
 * (devcWebWatchdog.ts), and registers the window as a client; the watchdog
 * stops devc web once no client window is alive. `stop()` stops it for every
 * window (Restart); `dispose()` only unregisters this one.
 */
export class DevcWebServer {
  /** The shared server this window uses. */
  private record: SharedRecord | undefined;
  private starting: Promise<string> | undefined;
  private current: DevcWebState = { kind: 'idle' };
  private readonly listeners = new Set<(state: DevcWebState) => void>();
  private monitor: NodeJS.Timeout | undefined;
  private checking = false;
  /** In stop(): the exit it causes is not news. */
  private stopping = false;
  private disposed = false;
  private readonly pid: number;
  private readonly timeouts: DevcWebTimeouts;

  constructor(private readonly options: DevcWebServerOptions) {
    this.pid = options.pid ?? process.pid;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  get state(): DevcWebState {
    return this.current;
  }

  onDidChangeState(listener: (state: DevcWebState) => void): {
    dispose(): void;
  } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The ready URL, starting devc web first when no window runs it. */
  url(): Promise<string> {
    if (this.current.kind === 'ready') {
      return Promise.resolve(this.current.url);
    }
    this.starting ??= this.connect().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /**
   * Stops the shared devc web, for every window: SIGTERM to its watchdog,
   * SIGKILL to its process group when it has not exited in time.
   */
  async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    this.stopping = true;
    try {
      const record = this.record ?? (await this.liveRecord());
      this.record = undefined;
      if (record) {
        await killGroup(record.pid, this.timeouts.stopMs + 2000);
        await this.forget(record);
      }
    } finally {
      this.stopping = false;
    }
    this.setState({ kind: 'idle' });
  }

  /** Unregisters this window, leaving devc web to the others or the watchdog. */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.monitor);
    this.monitor = undefined;
    fs.rmSync(this.clientFile, { force: true });
    this.listeners.clear();
  }

  private get clientFile(): string {
    return path.join(this.options.dir, 'clients', String(this.pid));
  }

  private get lockFile(): string {
    return path.join(this.options.dir, 'start.lock');
  }

  private setState(state: DevcWebState): void {
    this.current = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private register(): void {
    if (!this.disposed && !fs.existsSync(this.clientFile)) {
      fs.mkdirSync(path.dirname(this.clientFile), { recursive: true });
      fs.writeFileSync(this.clientFile, '');
    }
  }

  private async connect(): Promise<string> {
    this.setState({ kind: 'starting' });
    try {
      // Before looking, so the watchdog never sees a moment without us.
      this.register();
      const record = await this.findOrStart();
      this.record = record;
      this.setState({ kind: 'ready', url: record.url });
      this.monitor ??= setInterval(
        () => void this.check(),
        this.timeouts.pollMs
      ).unref();
      return record.url;
    } catch (err) {
      const error =
        err instanceof DevcWebError
          ? err
          : new DevcWebError(err instanceof Error ? err.message : String(err), '');
      this.setState({
        kind: 'stopped',
        message: error.message,
        stderr: error.stderr,
      });
      throw error;
    }
  }

  /** The live shared server, else one this window starts while holding the lock. */
  private async findOrStart(): Promise<SharedRecord> {
    const t = this.timeouts;
    const deadline = Date.now() + t.readyMs + t.stopMs + 2000;
    for (;;) {
      const live = await this.liveRecord();
      if (live) {
        return live;
      }
      if (this.lock()) {
        try {
          return (await this.liveRecord()) ?? (await this.startShared());
        } finally {
          this.unlock();
        }
      }
      if (Date.now() > deadline) {
        throw new DevcWebError(
          'devc web is being started by another window, but did not come up',
          ''
        );
      }
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS));
    }
  }

  /** The stored record when its watchdog is alive and its port answers; a dead one is deleted. */
  private async liveRecord(): Promise<SharedRecord | undefined> {
    const text = await this.options.store.get().catch(() => undefined);
    if (text === undefined) {
      return undefined;
    }
    const record = parseRecord(text);
    if (record && isAlive(record.pid) && (await reachable(record.url))) {
      return record;
    }
    // Unless another window stored a new one meanwhile.
    if ((await this.options.store.get().catch(() => undefined)) === text) {
      await this.options.store.delete().catch(() => {});
    }
    return undefined;
  }

  private async forget(record: SharedRecord): Promise<void> {
    const text = await this.options.store.get().catch(() => undefined);
    if (parseRecord(text)?.pid === record.pid) {
      await this.options.store.delete().catch(() => {});
    }
  }

  /** Takes `start.lock`, removing one left by a dead window. */
  private lock(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(this.options.dir, { recursive: true });
        fs.writeFileSync(this.lockFile, String(this.pid), { flag: 'wx' });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }
      let holder = NaN;
      try {
        holder = Number(fs.readFileSync(this.lockFile, 'utf8'));
      } catch {
        // Removed meanwhile: try again.
        continue;
      }
      if (Number.isSafeInteger(holder) && holder > 0 && isAlive(holder)) {
        return false;
      }
      fs.rmSync(this.lockFile, { force: true });
    }
    return false;
  }

  private unlock(): void {
    try {
      if (fs.readFileSync(this.lockFile, 'utf8') === String(this.pid)) {
        fs.rmSync(this.lockFile, { force: true });
      }
    } catch {
      // Already gone.
    }
  }

  /** Starts devc web under the watchdog and stores its record. */
  private async startShared(): Promise<SharedRecord> {
    const command = await this.options.command();
    const args = this.options.args();
    const ownPort = !args.some(a => a === '--port' || a.startsWith('--port='));
    const port = ownPort ? ['--port', String(this.options.port())] : [];
    const watchdog: WatchdogOptions = {
      clientsDir: path.dirname(this.clientFile),
      cmd: [...command.cmd, 'web', '--no-open', ...port, ...args],
      graceMs: this.timeouts.graceMs,
      pollMs: this.timeouts.watchdogPollMs,
      stopMs: this.timeouts.stopMs,
    };
    const child = cp.spawn(
      process.execPath,
      [WATCHDOG, JSON.stringify(watchdog)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(command.path ? { PATH: command.path } : {}),
          // The extension host's execPath is Electron's.
          ELECTRON_RUN_AS_NODE: '1',
        },
        // Its own process group: it outlives this window, and a stop
        // reaches devc web and the server devc runs.
        detached: true,
        windowsHide: true,
      }
    );
    let url: string;
    try {
      url = await this.readReady(child);
    } catch (err) {
      if (
        ownPort &&
        err instanceof DevcWebError &&
        /already in use/.test(err.stderr)
      ) {
        throw new DevcWebError(
          `devc web's port ${port[1]} is in use: free it or set devc-vscode.devcWebPort`,
          err.stderr
        );
      }
      throw err;
    }
    // Nothing more is read: the watchdog stops forwarding at the ready line.
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    const record = { pid: child.pid!, url };
    child.once('exit', () => void this.check());
    await this.options.store
      .store(JSON.stringify(record))
      .catch(() => {
        // Without the store, other windows can't find it and fail on the
        // port; this one still works.
      });
    return record;
  }

  /**
   * Whether the shared server is still the one this window uses: one another
   * window restarted is adopted, one that is gone leaves the view stopped.
   */
  private async check(): Promise<void> {
    if (this.disposed || this.checking || this.stopping || this.starting) {
      return;
    }
    this.register();
    if (this.record && isAlive(this.record.pid)) {
      return;
    }
    this.checking = true;
    try {
      const live = await this.liveRecord();
      if (this.disposed || this.stopping || this.starting) {
        return;
      }
      if (live) {
        if (live.url !== this.record?.url || this.current.kind !== 'ready') {
          this.record = live;
          this.setState({ kind: 'ready', url: live.url });
        }
      } else if (this.current.kind === 'ready') {
        this.setState({
          kind: 'stopped',
          message: 'devc web stopped',
          stderr: '',
        });
      }
    } finally {
      this.checking = false;
    }
  }

  /** The watchdog's ready URL, or a rejection without it. */
  private readReady(child: cp.ChildProcess): Promise<string> {
    const stderr = tailLines(STDERR_LINES);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

    return new Promise<string>((resolve, reject) => {
      let ready = false;
      let failed = false;
      const fail = (message: string) => {
        clearTimeout(timer);
        if (ready || failed) {
          return;
        }
        failed = true;
        reject(new DevcWebError(message, stderr.text()));
      };
      const timer = setTimeout(() => {
        fail(
          `devc web did not print its URL within ${this.timeouts.readyMs / 1000} s`
        );
        void terminate(child, this.timeouts.stopMs);
      }, this.timeouts.readyMs);

      let pending = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (ready || failed) {
          return;
        }
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const url = parseReadyLine(line);
          if (url) {
            ready = true;
            pending = '';
            clearTimeout(timer);
            resolve(url);
            return;
          }
        }
      });
      child.on('error', err => fail(`devc web could not start: ${err.message}`));
      child.on('exit', (code, signal) => {
        const how = signal ? `was killed (${signal})` : `exited (${code})`;
        fail(`devc web ${how} before it was ready`);
      });
    });
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether something accepts a connection on the URL's port on 127.0.0.1. */
function reachable(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({
      host: '127.0.0.1',
      port: Number(new URL(url).port),
    });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * SIGTERM to `pid`, then SIGKILL to its process group when it is still alive
 * after `stopMs`; resolves once it is gone.
 */
async function killGroup(pid: number, stopMs: number): Promise<void> {
  const kill = (target: number, sig: NodeJS.Signals) => {
    try {
      process.kill(target, sig);
    } catch {
      // Already gone.
    }
  };
  kill(pid, 'SIGTERM');
  const deadline = Date.now() + stopMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (isAlive(pid)) {
    kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  }
}

/** The last `max` lines of a stream, fed in chunks. */
function tailLines(max: number): {
  push(chunk: string): void;
  text(): string;
} {
  const lines: string[] = [];
  let partial = '';
  return {
    push(chunk) {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop() ?? '';
      lines.push(...parts);
      lines.splice(0, Math.max(0, lines.length - max));
    },
    text() {
      return [...lines, ...(partial ? [partial] : [])]
        .slice(-max)
        .join('\n')
        .trimEnd();
    },
  };
}

function signal(child: cp.ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(sig === 'SIGKILL' ? -child.pid : child.pid, sig);
    } else {
      child.kill(sig);
    }
  } catch {
    // Already gone.
  }
}

/**
 * SIGTERM to devc, then SIGKILL to its whole process group when it has not
 * exited after `stopMs`.
 */
function terminate(child: cp.ChildProcess, stopMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => signal(child, 'SIGKILL'), stopMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    signal(child, 'SIGTERM');
  });
}
