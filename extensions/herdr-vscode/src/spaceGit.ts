import * as vscode from 'vscode';
import { GitInfo, readStatus } from './git';
import { RemoteShell } from './remoteShell';
import { spaceCwd } from './sessionControl';
import type { Snapshot } from './sessions';

/** Branch and git status on Spaces' space rows, for the selected session while Spaces is visible. */

const PASS_MS = 10000;
const DEBOUNCE_MS = 300;
const PARALLEL = 4;

/** Where a space's git status is read: its checkout, else where its panes are. */
export function spaceDirectory(snapshot: Snapshot, workspaceId: string): string | undefined {
	return snapshot.workspaces.find((w) => w.workspace_id === workspaceId)?.checkoutPath ?? spaceCwd(snapshot, workspaceId);
}

/**
 * `⎇ <head>` + ` ● <changes>` or ` · clean` + ` ↑<ahead>` + ` ↓<behind>`.
 * Plain text: a tree item's description does not render `$(codicon)`.
 */
export function gitDescription(info: Pick<GitInfo, 'head' | 'changes' | 'ahead' | 'behind'>): string {
	const changes = info.changes.length;
	return (
		`⎇ ${info.head}` +
		(changes > 0 ? ` ● ${changes}` : ' · clean') +
		(info.ahead > 0 ? ` ↑${info.ahead}` : '') +
		(info.behind > 0 ? ` ↓${info.behind}` : '')
	);
}

/**
 * A {@link gitDescription} as its branch part (`⎇ <head>`) and git status part
 * (`● 4 ↑1`, `clean ↓2`). A ref name never contains a space.
 */
export function splitGitDescription(description: string): { branch: string; status?: string } {
	const m = /^(⎇ \S+)(?: · | )(.+)$/.exec(description);
	return m ? { branch: m[1], status: m[2] } : { branch: description };
}

/** A space's git description, or undefined (not a repo, no git, a timeout). */
export async function readSpaceGit(shell: RemoteShell, dir: string, read: typeof readStatus = readStatus): Promise<string | undefined> {
	try {
		const info = await read(shell, dir);
		return info ? gitDescription(info) : undefined;
	} catch {
		return undefined;
	}
}

interface Cached {
	directory: string;
	description?: string;
}

/**
 * Polls git for the selected session's spaces: every 10 s while visible, and
 * once (debounced) when it becomes visible, the session changes, or a space is
 * added or changes directory. At most 4 runs at a time; a space whose run is
 * still going is skipped.
 */
export class SpaceGit implements vscode.Disposable {
	private readonly cache = new Map<string, Cached>();
	private readonly running = new Set<string>();
	private readonly emitter = new vscode.EventEmitter<void>();
	/** A description changed. */
	readonly onDidChange = this.emitter.event;
	private session: string | undefined;
	private dirs = new Map<string, string>();
	private visible = false;
	private debounce: NodeJS.Timeout | undefined;
	private interval: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(
		private readonly shellOf: (sessionKey: string) => RemoteShell | undefined,
		private readonly read: (shell: RemoteShell, dir: string) => Promise<string | undefined> = readSpaceGit,
		private readonly timing = { passMs: PASS_MS, debounceMs: DEBOUNCE_MS },
	) {}

	/** The view's state: the selected session, its snapshot, and whether Spaces is visible. */
	update(sessionKey: string | undefined, snapshot: Snapshot | undefined, visible: boolean): void {
		const dirs = new Map<string, string>();
		if (sessionKey && snapshot) {
			for (const w of snapshot.workspaces) {
				const dir = spaceDirectory(snapshot, w.workspace_id);
				if (dir) {
					dirs.set(w.workspace_id, dir);
				}
			}
		}
		const becameVisible = visible && !this.visible;
		const sessionChanged = sessionKey !== this.session;
		const moved = [...dirs].some(([id, dir]) => this.dirs.get(id) !== dir);
		this.session = sessionKey;
		this.dirs = dirs;
		this.visible = visible;
		if (!visible || !sessionKey || this.disposed) {
			this.stop();
			return;
		}
		if (this.interval === undefined) {
			this.interval = setInterval(() => void this.pass(), this.timing.passMs);
		}
		if (becameVisible || sessionChanged || moved) {
			clearTimeout(this.debounce);
			this.debounce = setTimeout(() => {
				this.debounce = undefined;
				void this.pass();
			}, this.timing.debounceMs);
		}
	}

	/** A space's git description, if one was taken in `directory`; one taken elsewhere is dropped. */
	description(sessionKey: string, workspaceId: string, directory: string | undefined): string | undefined {
		const key = `${sessionKey}|${workspaceId}`;
		const cached = this.cache.get(key);
		if (!cached) {
			return undefined;
		}
		if (cached.directory !== directory) {
			this.cache.delete(key);
			return undefined;
		}
		return cached.description;
	}

	/** Whether git runs are scheduled (for tests). */
	get polling(): boolean {
		return this.interval !== undefined;
	}

	/** One pass over the selected session's spaces. */
	async pass(): Promise<void> {
		const session = this.session;
		const shell = session && this.shellOf(session);
		if (!session || !shell || !this.visible || this.disposed) {
			return;
		}
		const queue = [...this.dirs].filter(([id]) => !this.running.has(`${session}|${id}`));
		let changed = false;
		const worker = async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				const [id, dir] = next;
				const key = `${session}|${id}`;
				if (this.running.has(key)) {
					continue;
				}
				this.running.add(key);
				try {
					const description = await this.read(shell, dir);
					const before = this.cache.get(key);
					if (!before || before.directory !== dir || before.description !== description) {
						changed ||= before?.description !== description;
						this.cache.set(key, { directory: dir, description });
					}
				} finally {
					this.running.delete(key);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
		if (changed && !this.disposed) {
			this.emitter.fire();
		}
	}

	private stop(): void {
		clearInterval(this.interval);
		clearTimeout(this.debounce);
		this.interval = undefined;
		this.debounce = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.emitter.dispose();
	}
}
