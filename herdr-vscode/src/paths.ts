import * as path from 'path';
import * as vscode from 'vscode';
import { execDocker } from './docker';
import { Environment, Environments, readSettings } from './environments';
import { RemoteShell } from './remoteShell';

/** Files in a dev container, outside its bind mounts (`src/remoteFs.ts`). */
export const CONTAINER_SCHEME = 'herdr-container';
/** Files on an SSH host (`src/remoteFs.ts`). */
export const SSH_SCHEME = 'herdr-ssh';

export interface BindMount {
	source: string;
	destination: string;
}

/** What Docker Desktop puts before a path on the Mac: `/host_mnt/Users/me/code` for `/Users/me/code`. */
const DOCKER_DESKTOP_HOST_PREFIX = '/host_mnt/';

/** `docker inspect --format '{{json .Mounts}}'` output, bind mounts only; anything malformed gives none. */
export function parseBindMounts(stdout: string): BindMount[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const mounts: BindMount[] = [];
	for (const m of Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []) {
		if (m?.Type === 'bind' && typeof m.Source === 'string' && typeof m.Destination === 'string') {
			const source = m.Source.startsWith(DOCKER_DESKTOP_HOST_PREFIX) ? m.Source.slice(DOCKER_DESKTOP_HOST_PREFIX.length - 1) : m.Source;
			mounts.push({ source, destination: m.Destination });
		}
	}
	return mounts;
}

/** Whether `child` is `parent` or under it. */
export function isUnder(child: string, parent: string): boolean {
	const base = parent.replace(/\/+$/, '');
	return child === base || child.startsWith(`${base}/`);
}

/** A container path on the host, through the mount with the longest destination that holds it. */
export function hostPathOf(containerPath: string, mounts: readonly BindMount[]): string | undefined {
	const holder = mounts
		.filter((m) => isUnder(containerPath, m.destination))
		.sort((a, b) => b.destination.length - a.destination.length)[0];
	if (!holder) {
		return undefined;
	}
	const rest = containerPath.slice(holder.destination.replace(/\/+$/, '').length);
	return `${holder.source.replace(/\/+$/, '')}${rest}` || '/';
}

/** What {@link environmentUri} needs of an environment. */
export type UriEnvironment = Pick<Environment, 'kind' | 'alias' | 'containerId' | 'label'>;

/**
 * A path in an environment as a URI VS Code can open: a plain file wherever one
 * exists. A container URI carries the container's label as a JSON query,
 * `?{"label":"<label>"}`, for `resourceLabelFormatters` (`devc: <label> › <path>`);
 * its providers ignore the query. Two URIs differing only in query are two
 * documents, so every container URI must come from here.
 */
export function environmentUri(env: UriEnvironment, file: string, mounts: readonly BindMount[] = []): vscode.Uri {
	switch (env.kind) {
		case 'host':
			return vscode.Uri.file(file);
		case 'ssh':
			return vscode.Uri.from({ scheme: SSH_SCHEME, authority: env.alias, path: file });
		case 'container': {
			const host = hostPathOf(file, mounts);
			return host !== undefined ? vscode.Uri.file(host) : vscode.Uri.from({ scheme: CONTAINER_SCHEME, authority: env.containerId!.slice(0, 12), path: file, query: JSON.stringify({ label: env.label }) });
		}
	}
}

/** `src/a.ts:12:3` as the path and its 1-based position. */
export function parseLinkText(text: string): { file: string; line?: number; col?: number } {
	const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(text)!;
	return { file: match[1], line: match[2] ? Number(match[2]) : undefined, col: match[3] ? Number(match[3]) : undefined };
}

/** A printed path as an absolute one: `~/…` against the home, anything relative against the pane's directory. */
export function resolveLinkPath(file: string, dir: string | undefined, home: string | undefined): string | undefined {
	if (file.startsWith('/')) {
		return path.posix.normalize(file);
	}
	if (file.startsWith('~/')) {
		return home ? path.posix.join(home, file.slice(2)) : undefined;
	}
	return dir ? path.posix.join(dir, file) : undefined;
}

export type ReadMounts = (containerId: string) => Promise<BindMount[] | undefined>;

/** `docker inspect`, on this machine; undefined when it fails. */
async function inspectMounts(containerId: string): Promise<BindMount[] | undefined> {
	try {
		const res = await execDocker(['inspect', '--format', '{{json .Mounts}}', containerId], undefined, readSettings().dockerPath, 15000);
		return res.exitCode === 0 ? parseBindMounts(res.stdout.toString('utf8')) : undefined;
	} catch {
		return undefined;
	}
}

/** The `$HOME` of whoever a shell runs as. */
async function readHome(shell: RemoteShell): Promise<string | undefined> {
	try {
		const res = await shell.run(['printenv', 'HOME'], { timeoutMs: 15000 });
		return res.exitCode === 0 ? res.stdout.toString('utf8').trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

/** Per-environment facts about paths, cached: a container's mounts until it restarts, an environment's `$HOME`. */
export class EnvironmentPaths implements vscode.Disposable {
	private readonly mountCache = new Map<string, Promise<BindMount[] | undefined>>();
	private readonly homeCache = new Map<string, Promise<string | undefined>>();
	private readonly listeners: vscode.Disposable[];

	constructor(
		environments: Pick<Environments, 'onDidChange' | 'onDidContainerEvent'>,
		/** Injected for tests. */
		private readonly readMounts: ReadMounts = inspectMounts,
	) {
		this.listeners = [
			environments.onDidChange((change) => {
				for (const env of change.removed) {
					this.homeCache.delete(env.key);
					if (env.containerId) {
						this.mountCache.delete(env.containerId.slice(0, 12));
					}
				}
			}),
			environments.onDidContainerEvent((id) => this.mountCache.delete(id.slice(0, 12))),
		];
	}

	/** The environment's bind mounts; none outside a container. A failed read is not kept. */
	async mounts(env: Pick<Environment, 'containerId'>): Promise<BindMount[]> {
		if (!env.containerId) {
			return [];
		}
		const id = env.containerId.slice(0, 12);
		let cached = this.mountCache.get(id);
		if (!cached) {
			cached = this.readMounts(id);
			this.mountCache.set(id, cached);
		}
		const mounts = await cached;
		if (!mounts && this.mountCache.get(id) === cached) {
			this.mountCache.delete(id);
		}
		return mounts ?? [];
	}

	async uriFor(env: UriEnvironment, file: string): Promise<vscode.Uri> {
		return environmentUri(env, file, await this.mounts(env));
	}

	async home(env: Pick<Environment, 'key' | 'shell'>): Promise<string | undefined> {
		let cached = this.homeCache.get(env.key);
		if (!cached) {
			cached = readHome(env.shell);
			this.homeCache.set(env.key, cached);
		}
		const home = await cached;
		if (home === undefined && this.homeCache.get(env.key) === cached) {
			this.homeCache.delete(env.key);
		}
		return home;
	}

	dispose(): void {
		for (const listener of this.listeners) {
			listener.dispose();
		}
	}
}
