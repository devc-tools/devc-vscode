import * as cp from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { Devcontainer, getRemoteUser, listDevcontainers } from './devcontainer';
import { DockerShell, ensureControlDir, LocalShell, RemoteShell, SshShell } from './remoteShell';

export type EnvironmentKind = 'host' | 'ssh' | 'container';

/** Somewhere herdr sessions can run: this machine, an SSH host or a dev container. */
export interface Environment {
	key: string;
	kind: EnvironmentKind;
	/** Row label: `this machine`, the ssh alias, or the container's folder name. */
	label: string;
	shell: RemoteShell;
	alias?: string;
	containerId?: string;
	/** The container's remote user, when it has one. */
	user?: string;
}

export const HOST_KEY = 'host';

export function sshKey(alias: string): string {
	return `ssh:${alias}`;
}

export function containerKey(containerId: string): string {
	return `container:${containerId.slice(0, 12)}`;
}

/** A dev container's display name: the basename of its `devcontainer.local_folder`. */
export function containerDisplayName(localFolder: string): string {
	const parts = localFolder.split(/[\\/]+/).filter(Boolean);
	return parts[parts.length - 1] ?? localFolder;
}

/** The pattern every `herdr.sshHosts` entry must match. */
export const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EnvironmentSettings {
	sshHosts: string[];
	sshPath: string;
	dockerPath: string;
}

export function readSettings(): EnvironmentSettings {
	const config = vscode.workspace.getConfiguration('herdr');
	const hosts = config.get<unknown>('sshHosts');
	return {
		sshHosts: Array.isArray(hosts)
			? [...new Set(hosts.filter((h): h is string => typeof h === 'string' && SSH_ALIAS_PATTERN.test(h)))]
			: [],
		sshPath: config.get<string>('sshPath') || 'ssh',
		dockerPath: config.get<string>('dockerPath') || 'docker',
	};
}

export const DOCKER_EVENTS_ARGS = [
	'events',
	'--filter',
	'type=container',
	'--filter',
	'event=start',
	'--filter',
	'event=die',
	'--format',
	'{{.ID}}',
];

const CONTAINER_DEBOUNCE_MS = 500;
const SSH_REDISCOVER_MS = 30000;
const DOCKER_EVENTS_RESTART_MS = 30000;

export interface EnvironmentsChange {
	added: Environment[];
	removed: Environment[];
	/** Environments to re-list now although unchanged (the 30 s SSH pass). */
	recheck: Environment[];
}

/**
 * Discovers environments and keeps the list current: SSH hosts from settings
 * (and every 30 s), dev containers from `docker ps` on Docker start/die events.
 */
export class Environments implements vscode.Disposable {
	private readonly envs = new Map<string, Environment>();
	private readonly changed = new vscode.EventEmitter<EnvironmentsChange>();
	readonly onDidChange = this.changed.event;

	private settings = readSettings();
	private readonly controlDir = ensureControlDir();
	private readonly users = new Map<string, string | undefined>();
	private dockerEvents: cp.ChildProcess | undefined;
	private dockerRestart: NodeJS.Timeout | undefined;
	private containerTimer: NodeJS.Timeout | undefined;
	private readonly sshTimer: NodeJS.Timeout;
	private disposed = false;
	private containerRun: Promise<void> = Promise.resolve();
	private readonly configListener: vscode.Disposable;

	constructor(private readonly log: (line: string) => void) {
		this.sshTimer = setInterval(() => this.rediscoverSsh(true), SSH_REDISCOVER_MS);
		this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('herdr')) {
				return;
			}
			const before = this.settings;
			this.settings = readSettings();
			// Shells hold the ssh path: a new one rebuilds every SSH environment.
			this.rediscoverSsh(false, before.sshPath !== this.settings.sshPath);
			if (before.dockerPath !== this.settings.dockerPath) {
				this.restartDockerEvents();
				void this.rediscoverContainers();
			}
		});
	}

	/** Every environment: this machine, SSH hosts in settings order, then containers by name. */
	list(): Environment[] {
		const all = [...this.envs.values()];
		const order = (k: EnvironmentKind) => (k === 'host' ? 0 : k === 'ssh' ? 1 : 2);
		return all.sort((a, b) => {
			if (a.kind !== b.kind) {
				return order(a.kind) - order(b.kind);
			}
			if (a.kind === 'ssh') {
				return this.settings.sshHosts.indexOf(a.alias!) - this.settings.sshHosts.indexOf(b.alias!);
			}
			return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
		});
	}

	get(key: string): Environment | undefined {
		return this.envs.get(key);
	}

	/** First discovery, and the Docker events watcher. */
	start(): void {
		if (process.platform !== 'win32') {
			this.apply({ added: [{ key: HOST_KEY, kind: 'host', label: 'this machine', shell: new LocalShell() }], removed: [], recheck: [] });
		}
		this.rediscoverSsh(false);
		this.restartDockerEvents();
		void this.rediscoverContainers();
	}

	/** Refresh: SSH hosts and containers again. */
	async rediscover(): Promise<void> {
		this.rediscoverSsh(false);
		await this.rediscoverContainers();
	}

	private apply(change: EnvironmentsChange): void {
		for (const env of change.removed) {
			this.envs.delete(env.key);
		}
		for (const env of change.added) {
			this.envs.set(env.key, env);
		}
		if (change.added.length || change.removed.length || change.recheck.length) {
			this.changed.fire(change);
		}
	}

	private rediscoverSsh(recheck: boolean, rebuild = false): void {
		if (this.disposed) {
			return;
		}
		const wanted = new Set(this.settings.sshHosts.map(sshKey));
		const removed = [...this.envs.values()].filter((e) => e.kind === 'ssh' && (rebuild || !wanted.has(e.key)));
		const added: Environment[] = [];
		for (const alias of this.settings.sshHosts) {
			if (this.envs.has(sshKey(alias)) && !rebuild) {
				continue;
			}
			added.push({
				key: sshKey(alias),
				kind: 'ssh',
				label: alias,
				alias,
				shell: new SshShell(alias, {
					sshPath: this.settings.sshPath,
					controlDir: this.controlDir,
					allowed: (host) => readSettings().sshHosts.includes(host),
				}),
			});
		}
		const recheckList =
			recheck && !rebuild ? [...this.envs.values()].filter((e) => e.kind === 'ssh' && wanted.has(e.key)) : [];
		this.apply({ added, removed, recheck: recheckList });
	}

	/** One container pass at a time; a request during one runs once it is done. */
	rediscoverContainers(): Promise<void> {
		this.containerRun = this.containerRun.then(() => this.discoverContainers());
		return this.containerRun;
	}

	private async discoverContainers(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const dockerPath = this.settings.dockerPath;
		const found: Devcontainer[] = await listDevcontainers(dockerPath);
		if (this.disposed) {
			return;
		}
		const wanted = new Map(found.map((c) => [containerKey(c.id), c]));
		const removed = [...this.envs.values()].filter((e) => e.kind === 'container' && !wanted.has(e.key));
		const added: Environment[] = [];
		for (const [key, c] of wanted) {
			if (this.envs.has(key)) {
				continue;
			}
			if (!this.users.has(c.id)) {
				this.users.set(c.id, await getRemoteUser(c.id, dockerPath));
			}
			const user = this.users.get(c.id);
			added.push({
				key,
				kind: 'container',
				label: containerDisplayName(c.localFolder),
				containerId: c.id,
				user,
				shell: new DockerShell(c.id, user, dockerPath),
			});
		}
		if (this.disposed) {
			return;
		}
		for (const env of removed) {
			this.users.delete(env.containerId!);
		}
		if (added.length || removed.length) {
			this.log(
				`containers: ${added.map((e) => `+${e.key}`).concat(removed.map((e) => `-${e.key}`)).join(' ')}`,
			);
		}
		this.apply({ added, removed, recheck: [] });
	}

	private scheduleContainers(): void {
		clearTimeout(this.containerTimer);
		this.containerTimer = setTimeout(() => void this.rediscoverContainers(), CONTAINER_DEBOUNCE_MS);
	}

	/** `docker events` for container start/die; any line means rediscover. No Docker: nothing, quietly. */
	private restartDockerEvents(): void {
		clearTimeout(this.dockerRestart);
		const old = this.dockerEvents;
		this.dockerEvents = undefined;
		old?.kill();
		if (this.disposed) {
			return;
		}
		let child: cp.ChildProcess;
		try {
			child = cp.spawn(this.settings.dockerPath, DOCKER_EVENTS_ARGS, { stdio: ['ignore', 'pipe', 'ignore'] });
		} catch {
			return;
		}
		this.dockerEvents = child;
		let failedToStart = false;
		child.on('error', () => {
			failedToStart = true;
		});
		if (child.stdout) {
			readline.createInterface({ input: child.stdout }).on('line', (line) => {
				if (line.trim()) {
					this.scheduleContainers();
				}
			});
		}
		child.on('close', () => {
			if (this.dockerEvents !== child || this.disposed) {
				return;
			}
			this.dockerEvents = undefined;
			// The daemon restarted, or there is no Docker: look again later.
			this.dockerRestart = setTimeout(() => {
				this.restartDockerEvents();
				if (!failedToStart) {
					void this.rediscoverContainers();
				}
			}, DOCKER_EVENTS_RESTART_MS);
		});
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.sshTimer);
		clearTimeout(this.containerTimer);
		clearTimeout(this.dockerRestart);
		this.dockerEvents?.kill();
		this.configListener.dispose();
		this.changed.dispose();
	}
}
