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

/** A repo or worktree: its toplevel, its main worktree, and its branch (undefined when detached). */
export interface RepoInfo {
	toplevel: string;
	main: string;
	branch?: string;
}

/**
 * The repo or worktree holding `dir`, read in its environment; undefined when
 * it is in none, git refuses, or the environment cannot be reached.
 */
export async function readRepo(shell: RemoteShell, dir: string): Promise<RepoInfo | undefined> {
	try {
		const res = await shell.run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
			timeoutMs: GIT_TIMEOUT_MS,
		});
		const [toplevel, common] = res.stdout
			.toString('utf8')
			.split('\n')
			.map((line) => line.replace(/\r$/, ''));
		if (res.exitCode !== 0 || !toplevel || !common) {
			return undefined;
		}
		const head = await shell.run(['git', '-C', toplevel, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
		const branch = head.exitCode === 0 ? head.stdout.toString('utf8').trim() || undefined : undefined;
		return { toplevel, main: path.posix.basename(common) === '.git' ? path.posix.dirname(common) : toplevel, branch };
	} catch {
		return undefined;
	}
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

// ── Times ───────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` today, else `Mon D HH:MM`, local time; no locale formatting. */
export function shortTime(at: number, now: number = Date.now()): string {
	const then = new Date(at);
	const today = new Date(now);
	const time = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
	const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
	return sameDay ? time : `${MONTHS[then.getMonth()]} ${then.getDate()} ${time}`;
}

/** ISO 8601 in local time with its offset: `2026-11-02T10:31:05+01:00`. */
export function isoLocal(at: number): string {
	const d = new Date(at);
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const abs = Math.abs(offset);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
	);
}

function firstLine(text: string): string | undefined {
	return text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l !== '');
}

// ── Tree diffs ──────────────────────────────────────────────────────────────

export type TreeStatus = 'A' | 'M' | 'D';

export interface TreeChange {
	status: TreeStatus;
	path: string;
}

/** `diff-tree -r -z --no-renames --name-status`: `<status>\0<path>\0` pairs; `T` is shown as `M`. Sorted by path. */
export function parseDiffTree(stdout: string): TreeChange[] {
	const parts = stdout.split('\0');
	const changes: TreeChange[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const letter = parts[i];
		const file = parts[i + 1];
		if (!letter || !file) {
			continue;
		}
		const status: TreeStatus = letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M';
		changes.push({ status, path: file });
	}
	return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ── Span snapshots: nothing is written to the repo's .git ───────────────────

/**
 * The whole working state (tracked and untracked, not ignored) as a tree,
 * written to the span directory `$2` (toplevel `$1`). Nothing reaches the
 * repo's `.git`: the index is a copy in the span directory, and new blobs and
 * trees go to `$2/objects`. The repo's own objects are not visible here at all
 * (no alternate, so `write-tree --missing-ok`): with them as an alternate, git
 * "freshens" (touches the mtime of) every existing object it would write
 * again, e.g. a racily clean file's blob or a reverted file's. The index is
 * copied from the real one only at span start, which keeps its stat cache so
 * `add -A` hashes only files that changed; `touch -r` keeps the copy's mtime,
 * since git judges a "racily clean" entry (a file written in the same second as
 * the index) against the index file's mtime. The end snapshot reuses the
 * span's index.
 */
export const SPAN_SNAPSHOT_SCRIPT = `set -e
top=$1; d=$2
mkdir -p "$d/objects"
gi=$(git -C "$top" rev-parse --git-path index); case $gi in /*) ;; *) gi=$top/$gi ;; esac
if [ ! -f "$d/index" ] && [ -f "$gi" ]; then cp "$gi" "$d/index"; touch -r "$gi" "$d/index"; fi
export GIT_INDEX_FILE="$d/index" GIT_OBJECT_DIRECTORY="$d/objects"
git -c core.fsmonitor=false -C "$top" add -A
git -c core.fsmonitor=false -C "$top" write-tree --missing-ok
`;

/**
 * What changed between the span's two trees (`$3`, `$4`): the span's objects,
 * and the repo's (`rev-parse --git-path objects`, relative in a plain repo,
 * absolute in a linked worktree) as an alternate for the subtrees the
 * snapshots did not rewrite. Reading never writes or freshens.
 */
export const SPAN_DIFF_SCRIPT = `set -e
top=$1; d=$2
o=$(git -C "$top" rev-parse --git-path objects); case $o in /*) ;; *) o=$top/$o ;; esac
export GIT_INDEX_FILE="$d/index" GIT_OBJECT_DIRECTORY="$d/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"
git -c core.fsmonitor=false -C "$top" diff-tree -r -z --no-renames --name-status "$3" "$4"
`;

/** Where span directories go, in the environment. */
const SPAN_MKTEMP_SCRIPT = 'mktemp -d "${TMPDIR:-/tmp}/herdr-vscode-span.XXXXXX"';

/** Span directories a closed or reloaded window left behind, a day old. */
export const SPAN_CLEANUP_SCRIPT = `find "\${TMPDIR:-/tmp}" -maxdepth 1 -name 'herdr-vscode-span.*' -mmin +1440 -exec rm -rf {} +`;

function failure(res: { exitCode: number; stderr: Buffer }, otherwise: string): Error {
	return new Error(firstLine(res.stderr.toString('utf8')) ?? (res.exitCode === 0 ? otherwise : `git exited with ${res.exitCode}`));
}

/** Takes a snapshot of `toplevel` into the span directory; the tree SHA. Throws with git's first stderr line. */
export async function spanSnapshot(shell: RemoteShell, toplevel: string, spanDir: string): Promise<string> {
	const res = await shell.run(['sh', '-c', SPAN_SNAPSHOT_SCRIPT, 'sh', toplevel, spanDir], { timeoutMs: GIT_TIMEOUT_MS });
	const tree = res.stdout.toString('utf8').trim();
	if (res.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
		throw failure(res, 'unexpected output from git');
	}
	return tree;
}

/** The span's two trees diffed, with its objects. Throws with git's first stderr line. */
export async function spanDiff(shell: RemoteShell, toplevel: string, spanDir: string, from: string, to: string): Promise<TreeChange[]> {
	const res = await shell.run(['sh', '-c', SPAN_DIFF_SCRIPT, 'sh', toplevel, spanDir, from, to], { timeoutMs: GIT_TIMEOUT_MS });
	if (res.exitCode !== 0) {
		throw failure(res, 'git failed');
	}
	return parseDiffTree(res.stdout.toString('utf8'));
}

/** A new span directory in the environment's temp directory. */
export async function makeSpanDir(shell: RemoteShell): Promise<string> {
	const res = await shell.run(['sh', '-c', SPAN_MKTEMP_SCRIPT], { timeoutMs: GIT_TIMEOUT_MS });
	const dir = res.stdout.toString('utf8').trim();
	if (res.exitCode !== 0 || !dir.startsWith('/')) {
		throw failure(res, 'mktemp failed');
	}
	return dir;
}

export async function removeSpanDir(shell: RemoteShell, spanDir: string): Promise<void> {
	await shell.run(['rm', '-rf', spanDir], { timeoutMs: GIT_TIMEOUT_MS });
}

export async function cleanupSpanDirs(shell: RemoteShell): Promise<void> {
	await shell.run(['sh', '-c', SPAN_CLEANUP_SCRIPT], { timeoutMs: GIT_TIMEOUT_MS });
}

// ── Commits ─────────────────────────────────────────────────────────────────

/** git's empty tree: the left side of a root commit's diff. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** How many commits the Commits section lists. */
export const MAX_COMMITS = 20;

export interface Commit {
	sha: string;
	/** Empty for a root commit. */
	parents: string[];
	author: string;
	/** ms since epoch (`%at` is seconds). */
	at: number;
	/** `%B`, untrimmed. */
	body: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `git log -z --format=%H%x1f%P%x1f%an%x1f%at%x1f%B`; malformed records are skipped. */
export function parseLog(stdout: string): Commit[] {
	const commits: Commit[] = [];
	for (const record of stdout.split('\0')) {
		const fields = record.split('\x1f');
		if (fields.length < 5) {
			continue;
		}
		const [sha, parents, author, at] = fields;
		if (!SHA.test(sha)) {
			continue;
		}
		commits.push({ sha, parents: parents.split(' ').filter(Boolean), author, at: Number(at) * 1000, body: fields.slice(4).join('\x1f') });
	}
	return commits;
}

/** A commit's first line, trimmed; `(no message)` when empty. */
export function commitSubject(commit: Pick<Commit, 'body'>): string {
	return commit.body.trim().split('\n')[0].trim() || '(no message)';
}

export interface CommitList {
	/** HEAD's full SHA. */
	head: string;
	/** `vs origin/main`, or `recent`. */
	description: string;
	commits: Commit[];
}

/** HEAD's full SHA; undefined when there is none. */
export async function readHeadSha(shell: RemoteShell, toplevel: string): Promise<string | undefined> {
	const res = await shell.run(['git', '-C', toplevel, 'rev-parse', '-q', '--verify', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
	const head = res.stdout.toString('utf8').trim();
	return res.exitCode === 0 && SHA.test(head) ? head : undefined;
}

/** The branch commits are counted against: `origin/HEAD`'s target, else `main` or `master`. */
export async function readBase(shell: RemoteShell, toplevel: string): Promise<string | undefined> {
	const origin = await shell.run(['git', '-C', toplevel, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
	const name = origin.stdout.toString('utf8').trim();
	if (origin.exitCode === 0 && name && name !== 'origin/HEAD') {
		return name;
	}
	for (const branch of ['main', 'master']) {
		const res = await shell.run(['git', '-C', toplevel, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`], { timeoutMs: GIT_TIMEOUT_MS });
		if (res.exitCode === 0) {
			return branch;
		}
	}
	return undefined;
}

/**
 * The commits on HEAD since it left the base (`vs <base>`), else the most
 * recent ones (`recent`), at most {@link MAX_COMMITS}; undefined when there is
 * no HEAD.
 */
export async function readCommits(shell: RemoteShell, toplevel: string): Promise<CommitList | undefined> {
	const head = await readHeadSha(shell, toplevel);
	if (!head) {
		return undefined;
	}
	let range = 'HEAD';
	let description = 'recent';
	const base = await readBase(shell, toplevel);
	if (base) {
		const mbRes = await shell.run(['git', '-C', toplevel, 'merge-base', 'HEAD', base], { timeoutMs: GIT_TIMEOUT_MS });
		const mb = mbRes.stdout.toString('utf8').trim();
		if (mbRes.exitCode === 0 && SHA.test(mb) && mb !== head) {
			range = `${mb}..HEAD`;
			description = `vs ${base}`;
		}
	}
	const log = await shell.run(['git', '-C', toplevel, 'log', '-z', '-n', String(MAX_COMMITS), '--format=%H%x1f%P%x1f%an%x1f%at%x1f%B', range], {
		timeoutMs: GIT_TIMEOUT_MS,
	});
	return { head, description, commits: log.exitCode === 0 ? parseLog(log.stdout.toString('utf8')) : [] };
}

/** The files a commit changed against its first parent (all of them for a root commit); undefined when git refuses. */
export async function readCommitFiles(shell: RemoteShell, toplevel: string, commit: Pick<Commit, 'sha' | 'parents'>): Promise<TreeChange[] | undefined> {
	const parent = commit.parents[0];
	// A single commit argument prints its SHA first unless --no-commit-id.
	const args = parent ? [parent, commit.sha] : ['--no-commit-id', '--root', commit.sha];
	const res = await shell.run(['git', '-C', toplevel, 'diff-tree', '-r', '-z', '--no-renames', '--name-status', ...args], { timeoutMs: GIT_TIMEOUT_MS });
	return res.exitCode === 0 ? parseDiffTree(res.stdout.toString('utf8')) : undefined;
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
