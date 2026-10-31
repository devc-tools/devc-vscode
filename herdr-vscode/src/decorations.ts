import * as vscode from 'vscode';
import { sinceLetter, SinceStatus, statusLetter } from './git';

/**
 * Git markers for the followed repo: the status letter of each changed file
 * (in Files, editor tabs, anywhere VS Code shows that URI), and the
 * since-letters of Changed in This Pane rows. Plain files of a repo VS Code's
 * own Git has open are left to it.
 */

/** The fragment on Changed in This Pane rows' URIs: their since-letter, not the git status. */
export const SINCE_FRAGMENT = 'herdr-since';

/** The few members of the built-in Git extension's API (`vscode.git`, `getAPI(1)`) used here. */
export interface GitApiLike {
	readonly state: 'uninitialized' | 'initialized';
	getRepository(uri: vscode.Uri): unknown | null;
	openRepository?(root: vscode.Uri): Promise<unknown | null>;
	readonly onDidOpenRepository: vscode.Event<unknown>;
	readonly onDidCloseRepository: vscode.Event<unknown>;
	readonly onDidChangeState: vscode.Event<unknown>;
}

export interface GitExtensionLike {
	readonly enabled: boolean;
	getAPI(version: 1): GitApiLike;
}

export const GIT_EXTENSION_ID = 'vscode.git';

/** VS Code's Git API when its extension is already active and enabled; never activates it. */
export function activeGitApi(): GitApiLike | undefined {
	try {
		const ext = vscode.extensions.getExtension<GitExtensionLike>(GIT_EXTENSION_ID);
		return ext?.isActive && ext.exports?.enabled ? ext.exports.getAPI(1) : undefined;
	} catch {
		return undefined;
	}
}

/** What the followed repo looks like now. */
export interface RepoDecorations {
	/** Changed paths' URIs with their porcelain `XY`. */
	status: { uri: vscode.Uri; xy: string }[];
	/** Wholly untracked directories (`dir/` records): they and everything under them are `U`. */
	untrackedDirs: vscode.Uri[];
	/** Changed in This Pane rows' URIs (fragment {@link SINCE_FRAGMENT}). */
	since: { uri: vscode.Uri; status: SinceStatus }[];
	/** `HH:MM` (or `Mon D HH:MM`) of the baseline. */
	sinceTime?: string;
}

function decoration(badge: string, tooltip: string, color: string, propagate: boolean): vscode.FileDecoration {
	const d = new vscode.FileDecoration(badge, tooltip, new vscode.ThemeColor(color));
	d.propagate = propagate;
	return d;
}

function isUnderUri(uri: vscode.Uri, dir: vscode.Uri): boolean {
	return (
		uri.scheme === dir.scheme &&
		uri.authority === dir.authority &&
		uri.query === dir.query &&
		uri.fragment === '' &&
		(uri.path === dir.path || uri.path.startsWith(`${dir.path.replace(/\/+$/, '')}/`))
	);
}

export class PaneDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this.emitter.event;
	/** `toString()` → its URI and decoration. */
	private decorated = new Map<string, { uri: vscode.Uri; decoration: vscode.FileDecoration; key: string }>();
	private untrackedDirs: vscode.Uri[] = [];
	private git: GitApiLike | undefined;
	private gitListeners: vscode.Disposable[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		/** VS Code's Git API, if it is there to yield to. Injected for tests; re-asked on `extensions.onDidChange`. */
		private readonly gitApi: () => GitApiLike | undefined = activeGitApi,
	) {
		this.disposables.push(this.emitter, vscode.extensions.onDidChange(() => this.attachGit()));
		this.attachGit();
	}

	/** Follows the Git API: its repositories decide what is ours to decorate. */
	attachGit(): void {
		const api = this.gitApi();
		if (api === this.git) {
			return;
		}
		for (const d of this.gitListeners) {
			d.dispose();
		}
		this.git = api;
		this.gitListeners = api ? [api.onDidOpenRepository(() => this.refireAll()), api.onDidCloseRepository(() => this.refireAll()), api.onDidChangeState(() => this.refireAll())] : [];
		this.refireAll();
	}

	private refireAll(): void {
		const uris = [...this.decorated.values()].map((d) => d.uri);
		if (uris.length > 0) {
			this.emitter.fire(uris);
		}
	}

	/** The followed repo's markers; undefined clears them. */
	set(repo: RepoDecorations | undefined): void {
		const next = new Map<string, { uri: vscode.Uri; decoration: vscode.FileDecoration; key: string }>();
		for (const { uri, xy } of repo?.status ?? []) {
			const letter = statusLetter(xy);
			next.set(uri.toString(), { uri, decoration: decoration(letter.badge, letter.tooltip, letter.color, true), key: `${letter.badge}` });
		}
		for (const { uri, status } of repo?.since ?? []) {
			const letter = sinceLetter(status);
			const tooltip = `${letter.tooltip} since ${repo?.sinceTime ?? ''}`.trimEnd();
			next.set(uri.toString(), { uri, decoration: decoration(letter.badge, tooltip, letter.color, false), key: `${letter.badge}|${tooltip}` });
		}
		const dirs = repo?.untrackedDirs ?? [];
		const changed = new Map<string, vscode.Uri>();
		for (const [key, entry] of this.decorated) {
			if (next.get(key)?.key !== entry.key) {
				changed.set(key, entry.uri);
			}
		}
		for (const [key, entry] of next) {
			if (this.decorated.get(key)?.key !== entry.key) {
				changed.set(key, entry.uri);
			}
		}
		const dirKey = (list: vscode.Uri[]) => list.map((u) => u.toString()).sort().join('\n');
		if (dirKey(dirs) !== dirKey(this.untrackedDirs)) {
			for (const uri of [...this.untrackedDirs, ...dirs]) {
				changed.set(uri.toString(), uri);
			}
		}
		this.decorated = next;
		this.untrackedDirs = dirs;
		if (changed.size > 0) {
			this.emitter.fire([...changed.values()]);
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const found = this.decorated.get(uri.toString())?.decoration ?? (this.untrackedDirs.some((dir) => isUnderUri(uri, dir)) ? decoration('U', 'Untracked', 'gitDecoration.untrackedResourceForeground', true) : undefined);
		if (!found) {
			return undefined;
		}
		// VS Code's Git decorates the plain files of repos it has open, with the same letters.
		if (uri.scheme === 'file' && uri.fragment === '' && this.git && this.git.getRepository(uri) !== null) {
			return undefined;
		}
		return found;
	}

	dispose(): void {
		for (const d of [...this.gitListeners, ...this.disposables]) {
			d.dispose();
		}
	}
}
