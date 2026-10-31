import * as path from 'path';
import * as vscode from 'vscode';
import { Environment } from './environments';
import { RemoteShell } from './remoteShell';

const GIT_TIMEOUT_MS = 15000;

export const GIT_SCHEME = 'herdr-git';

export interface GitChange {
	/** The two status letters, e.g. ` M`, `??`, `R `. */
	xy: string;
	path: string;
}

export interface GitStatus {
	/** The branch; undefined when detached. */
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	changes: GitChange[];
}

/** The `## …` record: `<branch>[...<upstream>][ [ahead N][, behind M]]`. */
function parseBranchRecord(record: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> {
	const line = record.slice(3);
	if (line === 'HEAD (no branch)') {
		return { ahead: 0, behind: 0 };
	}
	const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(line);
	if (unborn) {
		return { branch: unborn[1], ahead: 0, behind: 0 };
	}
	const [, names, track] = /^(\S+)(?: \[(.*)\])?$/.exec(line) ?? [undefined, line, undefined];
	const [branch, upstream] = (names ?? line).split('...');
	return {
		branch,
		upstream,
		ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
		behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
	};
}

/**
 * `git status --porcelain=v1 -z --branch`. A rename or copy has its original
 * path as a second record: git puts one after `R` or `C` in either column
 * (` R` comes from `git add -N` of the new name).
 */
export function parseStatus(stdout: string): GitStatus {
	const records = stdout.split('\0');
	const status: GitStatus = { ahead: 0, behind: 0, changes: [] };
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.startsWith('## ')) {
			Object.assign(status, parseBranchRecord(record));
		} else if (record.length > 3) {
			const xy = record.slice(0, 2);
			status.changes.push({ xy, path: record.slice(3) });
			if (/[RC]/.test(xy)) {
				i++;
			}
		}
	}
	return status;
}

/** The repo holding `dir`; undefined when it is in none. */
export async function readToplevel(shell: RemoteShell, dir: string): Promise<string | undefined> {
	const res = await shell.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS });
	return res.exitCode === 0 ? res.stdout.toString('utf8').replace(/\r?\n$/, '') || undefined : undefined;
}

export interface GitInfo extends GitStatus {
	/** What to call HEAD: the branch, or the short SHA when detached. */
	head: string;
}

/**
 * A repo's status; undefined when git refuses. `--no-optional-locks`: this runs
 * every 5 s in a repo an agent is working in, and must not hold the index lock.
 */
export async function readStatus(shell: RemoteShell, toplevel: string): Promise<GitInfo | undefined> {
	const res = await shell.run(['git', '--no-optional-locks', '-C', toplevel, 'status', '--porcelain=v1', '-z', '--branch'], { timeoutMs: GIT_TIMEOUT_MS });
	if (res.exitCode !== 0) {
		return undefined;
	}
	const status = parseStatus(res.stdout.toString('utf8'));
	if (status.branch !== undefined) {
		return { ...status, head: status.branch };
	}
	const sha = await shell.run(['git', '-C', toplevel, 'rev-parse', '--short', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
	return { ...status, head: sha.stdout.toString('utf8').trim() };
}

/** What `herdr-git` URIs may ask for: HEAD, or a tree or commit SHA (SHA-1 or SHA-256). */
const REVISION = /^(?:HEAD|[0-9a-f]{40,64})$/;

/**
 * `herdr-git://<env key>/<toplevel>/<path>?<revision>`: a file as a revision has
 * it, `HEAD` or a tree SHA. The fragment is the length of `<toplevel>`, since
 * nothing else in the URI says where it ends and it must survive a window reload.
 */
export function gitRevisionUri(envKey: string, toplevel: string, file: string, revision: string): vscode.Uri {
	return vscode.Uri.from({ scheme: GIT_SCHEME, authority: envKey, path: `${toplevel}/${file}`, query: revision, fragment: String(toplevel.length) });
}

/** A file as HEAD has it. */
export function gitHeadUri(envKey: string, toplevel: string, file: string): vscode.Uri {
	return gitRevisionUri(envKey, toplevel, file, 'HEAD');
}

/** What {@link gitRevisionUri} encoded, but the revision (`uri.query`). */
export function parseGitHeadUri(uri: vscode.Uri): { envKey: string; toplevel: string; file: string } | undefined {
	const length = Number(uri.fragment);
	if (!uri.authority || !Number.isInteger(length) || length <= 0 || uri.path[length] !== '/') {
		return undefined;
	}
	return { envKey: uri.authority, toplevel: uri.path.slice(0, length), file: uri.path.slice(length + 1) };
}

/**
 * Left sides of **Open Changes**: `git show <revision>:<path>` in the
 * environment; empty when the revision has no such file. The query reaches
 * argv, so anything but `HEAD` or a SHA returns empty without running anything.
 */
export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
	constructor(
		/** Environments are only ever the discovered ones: any URI of this scheme reaches this, from anywhere. */
		private readonly envOf: (key: string) => Pick<Environment, 'shell'> | undefined,
	) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const target = parseGitHeadUri(uri);
		if (!target || !REVISION.test(uri.query)) {
			return '';
		}
		const env = this.envOf(target.envKey);
		if (!env) {
			return '';
		}
		const res = await env.shell.run(['git', '-C', target.toplevel, 'show', `${uri.query}:${target.file}`], { timeoutMs: GIT_TIMEOUT_MS });
		return res.exitCode === 0 ? res.stdout.toString('utf8') : '';
	}
}

// ── Baselines: what changed since ───────────────────────────────────────────

/**
 * The whole working state (tracked and untracked, not ignored) as a tree, and
 * HEAD, through a temporary copy of the index: the user's index, working tree,
 * refs and stash are never touched. Copying the real index keeps its stat
 * cache, so `add -A` hashes only files that changed. `touch -r` keeps the
 * copy's mtime: git judges a "racily clean" entry (a file written in the same
 * second as the index) against the index file's mtime, and a fresh mtime would
 * make it trust a stale stat and record the old content. The toplevel is `$1`.
 */
export const SNAPSHOT_SCRIPT = `set -e
top=$1
d=$(mktemp -d "\${TMPDIR:-/tmp}/herdr-vscode.XXXXXX")
trap 'rm -rf "$d"' EXIT
gi=$(git -C "$top" rev-parse --git-path index)
case $gi in /*) ;; *) gi=$top/$gi ;; esac
if [ -f "$gi" ]; then cp "$gi" "$d/index"; touch -r "$gi" "$d/index"; fi
GIT_INDEX_FILE=$d/index git -C "$top" add -A
GIT_INDEX_FILE=$d/index git -C "$top" write-tree
git -C "$top" rev-parse -q --verify HEAD || true
`;

export interface TreeSnapshot {
	/** The working state's tree SHA. */
	tree: string;
	/** HEAD's full SHA; empty in a repo with no commits. */
	head: string;
}

/** The snapshot script's stdout; undefined when it is anything else. */
export function parseSnapshot(stdout: string): TreeSnapshot | undefined {
	const match = /^([0-9a-f]{40,64})\n([0-9a-f]{40,64})?\n?$/.exec(stdout);
	return match ? { tree: match[1], head: match[2] ?? '' } : undefined;
}

function firstLine(text: string): string | undefined {
	return text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l !== '');
}

/** Takes a snapshot of `toplevel`'s working state; throws with git's first stderr line when it fails. */
export async function takeSnapshot(shell: RemoteShell, toplevel: string): Promise<TreeSnapshot> {
	const res = await shell.run(['sh', '-c', SNAPSHOT_SCRIPT, 'sh', toplevel], { timeoutMs: GIT_TIMEOUT_MS });
	const snapshot = res.exitCode === 0 ? parseSnapshot(res.stdout.toString('utf8')) : undefined;
	if (!snapshot) {
		throw new Error(firstLine(res.stderr.toString('utf8')) ?? (res.exitCode === 0 ? 'unexpected output from git' : `git exited with ${res.exitCode}`));
	}
	return snapshot;
}

export type SinceStatus = 'A' | 'M' | 'D';

export interface SinceChange {
	status: SinceStatus;
	path: string;
}

/** `diff-tree -r -z --no-renames --name-status`: `<status>\0<path>\0` pairs; `T` is shown as `M`. Sorted by path. */
export function parseDiffTree(stdout: string): SinceChange[] {
	const parts = stdout.split('\0');
	const changes: SinceChange[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const letter = parts[i];
		const file = parts[i + 1];
		if (!letter || !file) {
			continue;
		}
		const status: SinceStatus = letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M';
		changes.push({ status, path: file });
	}
	return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What changed between two trees; undefined when git refuses (the old tree was pruned). */
export async function diffTrees(shell: RemoteShell, toplevel: string, from: string, to: string): Promise<SinceChange[] | undefined> {
	const res = await shell.run(['git', '-C', toplevel, 'diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to], { timeoutMs: GIT_TIMEOUT_MS });
	return res.exitCode === 0 ? parseDiffTree(res.stdout.toString('utf8')) : undefined;
}

/** Commits on HEAD since `baseHead` (all of them when it is empty); undefined when git cannot say. */
export async function countCommits(shell: RemoteShell, toplevel: string, baseHead: string): Promise<number | undefined> {
	const range = baseHead ? `${baseHead}..HEAD` : 'HEAD';
	const res = await shell.run(['git', '-C', toplevel, 'rev-list', '--count', range], { timeoutMs: GIT_TIMEOUT_MS });
	const count = Number(res.stdout.toString('utf8').trim());
	return res.exitCode === 0 && Number.isInteger(count) ? count : undefined;
}

// ── Worktrees ───────────────────────────────────────────────────────────────

export interface WorktreeId {
	toplevel: string;
	/** The repository's common dir, absolute. */
	commonDir: string;
}

/** `rev-parse --show-toplevel --git-common-dir` from `dir`; the common dir may be relative to `dir`. */
export async function readWorktreeId(shell: RemoteShell, dir: string): Promise<WorktreeId | undefined> {
	const res = await shell.run(['git', '-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], { timeoutMs: GIT_TIMEOUT_MS });
	if (res.exitCode !== 0) {
		return undefined;
	}
	const [toplevel, common] = res.stdout.toString('utf8').split('\n');
	return toplevel && common ? { toplevel, commonDir: path.posix.resolve(dir, common) } : undefined;
}

export type WorktreeMarker = 'same worktree' | 'other worktree';

/** Same toplevel: `same worktree`; another worktree of the same repo: `other worktree`; else none. */
export function worktreeMarker(a: WorktreeId | undefined, b: WorktreeId | undefined): WorktreeMarker | undefined {
	if (!a || !b) {
		return undefined;
	}
	if (a.toplevel === b.toplevel) {
		return 'same worktree';
	}
	return a.commonDir === b.commonDir ? 'other worktree' : undefined;
}

// ── Decorations ─────────────────────────────────────────────────────────────

export interface StatusLetter {
	badge: string;
	tooltip: string;
	/** A `gitDecoration.*` colour id. */
	color: string;
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Porcelain `XY` as a badge, the first rule that matches. */
export function statusLetter(xy: string): StatusLetter {
	if (CONFLICTS.has(xy)) {
		return { badge: '!', tooltip: 'Conflict', color: 'gitDecoration.conflictingResourceForeground' };
	}
	if (xy === '??') {
		return { badge: 'U', tooltip: 'Untracked', color: 'gitDecoration.untrackedResourceForeground' };
	}
	if (xy.includes('D')) {
		return { badge: 'D', tooltip: 'Deleted', color: 'gitDecoration.deletedResourceForeground' };
	}
	if (xy.includes('R')) {
		return { badge: 'R', tooltip: 'Renamed', color: 'gitDecoration.renamedResourceForeground' };
	}
	if (/[AC]/.test(xy)) {
		return { badge: 'A', tooltip: 'Added', color: 'gitDecoration.addedResourceForeground' };
	}
	return { badge: 'M', tooltip: 'Modified', color: 'gitDecoration.modifiedResourceForeground' };
}

/** A since-letter as a badge. */
export function sinceLetter(status: SinceStatus): StatusLetter {
	switch (status) {
		case 'A':
			return { badge: 'A', tooltip: 'Added', color: 'gitDecoration.addedResourceForeground' };
		case 'D':
			return { badge: 'D', tooltip: 'Deleted', color: 'gitDecoration.deletedResourceForeground' };
		default:
			return { badge: 'M', tooltip: 'Modified', color: 'gitDecoration.modifiedResourceForeground' };
	}
}
