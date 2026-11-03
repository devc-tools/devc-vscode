import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The shared `devc web`'s parent, run by Node (`ELECTRON_RUN_AS_NODE`) in a
 * process group of its own, so it outlives the window that started it. It
 * runs devc web in the same group and stops it once no client window has
 * been alive for `graceMs`: a client is a file in `clientsDir` named by its
 * extension host pid, and a window that crashed leaves a dead pid behind.
 *
 * devc's stdout and stderr are forwarded until the ready line, for the
 * window reading it, and discarded after: the ready line carries the token.
 */

export interface WatchdogOptions {
  clientsDir: string;
  /** devc's command words, `devc web …` arguments included. */
  cmd: string[];
  graceMs: number;
  pollMs: number;
  stopMs: number;
}

/** Whether a stdout line is devc web's ready line, as devcWeb.ts matches it. */
const READY_PREFIX = /^devc web: http:\/\//;

/** The pids of the client files in `dir`; files of dead pids are deleted. */
export function liveClients(dir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const name of names) {
    const pid = /^\d+$/.test(name) ? Number(name) : NaN;
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
      live.push(pid);
    } else {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  return live;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(options: WatchdogOptions): void {
  // A window that went away mid-start leaves these pipes broken.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  const [file, ...args] = options.cmd;
  const child = cp.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let forwarding = true;
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (!forwarding) {
      return;
    }
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
      if (READY_PREFIX.test(line)) {
        forwarding = false;
        pending = '';
        return;
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (forwarding) {
      process.stderr.write(chunk);
    }
  });
  child.on('error', err => {
    process.stderr.write(`devc web could not start: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });

  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(poll);
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    setTimeout(() => {
      // devc and whatever it started share this group: this ends the
      // watchdog too.
      try {
        process.kill(process.platform === 'win32' ? child.pid! : -process.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      process.exit(1);
    }, options.stopMs);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, stop);
  }

  let idleSince: number | undefined;
  const poll = setInterval(() => {
    if (liveClients(options.clientsDir).length) {
      idleSince = undefined;
    } else if (idleSince === undefined) {
      idleSince = Date.now();
    } else if (Date.now() - idleSince >= options.graceMs) {
      stop();
    }
  }, options.pollMs);
}

if (require.main === module) {
  run(JSON.parse(process.argv[2]) as WatchdogOptions);
}
