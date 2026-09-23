import * as fs from 'fs';
import * as path from 'path';
import { ContainerInfo } from './containerTree';
import { AgentInfo } from './herdr';

/**
 * Sharing agent status between VS Code windows. Each window's extension host
 * writes what its own Agents view shows to a file in a directory every window
 * shares (the extension's global storage), and watches that directory for
 * the other windows' files. A window can also drop a focus request addressed
 * to another window, which that window acts on in its own UI.
 *
 * Files are written to a temp name and renamed, so a reader never sees half a
 * file. A window's file is removed when it shuts down; one left by a window
 * that crashed is recognised by its extension host pid no longer running.
 */

export const SNAPSHOT_VERSION = 1;

export interface PublishedAgent {
  /** Identifies the agent to its own window, for focus requests. */
  key: string;
  agent: AgentInfo;
  /** Managed by herdr, rather than detected from a terminal's output. */
  herdr: boolean;
}

export interface PublishedContainer {
  container: ContainerInfo;
  agents: PublishedAgent[];
}

export interface WindowSnapshot {
  version: number;
  /** The window's extension host pid: its identity and liveness check. */
  pid: number;
  /** The window's workspace name, as its title bar shows it. */
  name: string;
  /**
   * What `vscode.openFolder` needs to bring the window to the front: its saved
   * workspace file or single folder. Undefined when it has neither, e.g. an
   * untitled multi-root workspace.
   */
  workspaceUri?: string;
  containers: PublishedContainer[];
}

export interface WindowRegistryEvents {
  /** The other live windows changed. */
  onOthers(windows: WindowSnapshot[]): void;
  /** Another window asked this one to focus the agent with this key. */
  onFocusRequest(key: string): void;
}

/** A focus request older than this is a leftover, not a click. */
const REQUEST_TTL_MS = 10000;
/** Re-read on a timer too, in case a file event is ever missed. */
const RESCAN_MS = 10000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class WindowRegistry {
  private watcher: fs.FSWatcher | undefined;
  private rescan: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private published: string | undefined;
  private lastOthers = '[]';
  private disposed = false;

  constructor(
    private readonly dir: string,
    private readonly pid: number,
    private readonly events: WindowRegistryEvents,
    private readonly isAlive: (pid: number) => boolean = isProcessAlive
  ) {}

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.watcher = fs.watch(this.dir, () => this.scheduleScan());
    this.watcher.on('error', () => {
      /* the timer still rescans */
    });
    this.rescan = setInterval(() => this.scan(), RESCAN_MS);
    this.scan();
  }

  /** Publish this window's view. Identical content is not rewritten. */
  publish(snapshot: WindowSnapshot): void {
    const json = JSON.stringify(snapshot);
    if (this.disposed || json === this.published) {
      return;
    }
    this.published = json;
    this.writeAtomic(this.windowFile(this.pid), json);
  }

  /** Ask another window to focus one of its agents. */
  requestFocus(pid: number, key: string): void {
    const name = `focus-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    this.writeAtomic(path.join(this.dir, name), JSON.stringify({ key }));
  }

  /** Read the directory now: other windows, and requests for this one. */
  scan(): void {
    if (this.disposed) {
      return;
    }
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const others: WindowSnapshot[] = [];
    for (const name of names) {
      const window = /^window-(\d+)\.json$/.exec(name);
      if (window && Number(window[1]) !== this.pid) {
        const snapshot = this.readWindow(name, Number(window[1]));
        if (snapshot) {
          others.push(snapshot);
        }
        continue;
      }
      if (name.startsWith(`focus-${this.pid}-`)) {
        this.takeRequest(name);
      }
    }
    others.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
    const json = JSON.stringify(others);
    if (json !== this.lastOthers) {
      this.lastOthers = json;
      this.events.onOthers(others);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    clearInterval(this.rescan);
    clearTimeout(this.debounce);
    try {
      fs.unlinkSync(this.windowFile(this.pid));
    } catch {
      /* never published */
    }
  }

  private readWindow(name: string, pid: number): WindowSnapshot | undefined {
    const file = path.join(this.dir, name);
    if (!this.isAlive(pid)) {
      // Left behind by a window that did not shut down cleanly.
      try {
        fs.unlinkSync(file);
      } catch {
        /* another window removed it first */
      }
      return undefined;
    }
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      return snapshot?.version === SNAPSHOT_VERSION && snapshot.pid === pid
        ? (snapshot as WindowSnapshot)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private takeRequest(name: string): void {
    const file = path.join(this.dir, name);
    let key: unknown;
    let fresh = false;
    try {
      fresh = Date.now() - fs.statSync(file).mtimeMs < REQUEST_TTL_MS;
      key = JSON.parse(fs.readFileSync(file, 'utf8'))?.key;
      fs.unlinkSync(file);
    } catch {
      return;
    }
    if (fresh && typeof key === 'string') {
      this.events.onFocusRequest(key);
    }
  }

  private scheduleScan(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan(), 50);
  }

  private windowFile(pid: number): string {
    return path.join(this.dir, `window-${pid}.json`);
  }

  private writeAtomic(file: string, content: string): void {
    const tmp = path.join(
      this.dir,
      `.tmp-${this.pid}-${Math.random().toString(36).slice(2)}`
    );
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('devc-vscode: window registry write failed', err);
    }
  }
}
