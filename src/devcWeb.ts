import * as cp from 'child_process';
import * as crypto from 'crypto';

/**
 * The extension's own `devc web`: a child process started on first use, its
 * URL read from the ready line, and the pages built from that URL. No vscode
 * import, so all of it tests under plain mocha.
 *
 * The ready line carries the server's token. stdout is read only for that
 * line and is otherwise discarded: nothing from it reaches a log, an output
 * channel, a notification or a file.
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
 * One `devc web --no-open <args>` child, started by `url()` and stopped by
 * `stop()`. A later `url()` after a stop or a failure starts a new one, with
 * a new port and token.
 */
export class DevcWebServer {
  private child: cp.ChildProcess | undefined;
  private starting: Promise<string> | undefined;
  private current: DevcWebState = { kind: 'idle' };
  private readonly listeners = new Set<(state: DevcWebState) => void>();

  constructor(
    private readonly command: () => Promise<string | undefined>,
    private readonly args: () => string[],
    private readonly timeouts = {
      readyMs: READY_TIMEOUT_MS,
      stopMs: STOP_TIMEOUT_MS,
    }
  ) {}

  get state(): DevcWebState {
    return this.current;
  }

  onDidChangeState(listener: (state: DevcWebState) => void): {
    dispose(): void;
  } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The ready URL, starting devc web first when it is not running. */
  url(): Promise<string> {
    if (this.current.kind === 'ready') {
      return Promise.resolve(this.current.url);
    }
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** SIGTERM, then SIGKILL after the stop timeout; resolves once it exited. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) {
      await terminate(child, this.timeouts.stopMs);
    }
    this.setState({ kind: 'idle' });
  }

  private setState(state: DevcWebState): void {
    this.current = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private async start(): Promise<string> {
    this.setState({ kind: 'starting' });
    const command = await this.command();
    if (!command) {
      const err = new DevcWebError(
        'devc web needs devc: install it or put it on PATH',
        ''
      );
      this.setState({ kind: 'stopped', message: err.message, stderr: '' });
      throw err;
    }
    const child = cp.spawn(command, ['web', '--no-open', ...this.args()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a stop reaches the server devc runs.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    const stderr = tailLines(STDERR_LINES);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

    return new Promise<string>((resolve, reject) => {
      let ready = false;
      const fail = (message: string) => {
        clearTimeout(timer);
        const tail = stderr.text();
        if (this.child === child) {
          this.child = undefined;
          this.setState({ kind: 'stopped', message, stderr: tail });
        }
        reject(new DevcWebError(message, tail));
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
        if (ready) {
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
            if (this.child === child) {
              this.setState({ kind: 'ready', url });
            }
            resolve(url);
            return;
          }
        }
      });
      child.on('error', err => fail(`devc web could not start: ${err.message}`));
      child.on('exit', (code, signal) => {
        const how = signal ? `was killed (${signal})` : `exited (${code})`;
        if (!ready) {
          fail(`devc web ${how} before it was ready`);
        } else if (this.child === child) {
          this.child = undefined;
          this.setState({
            kind: 'stopped',
            message: `devc web ${how}`,
            // Its stderr is shown only for a failed start.
            stderr: '',
          });
        }
      });
    });
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
