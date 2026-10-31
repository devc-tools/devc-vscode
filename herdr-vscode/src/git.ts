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

/**
 * `herdr-git://<env key>/<toplevel>/<path>?HEAD`: a file as HEAD has it. The
 * fragment is the length of `<toplevel>`, since nothing else in the URI says
 * where it ends and it must survive a window reload.
 */
export function gitHeadUri(envKey: string, toplevel: string, file: string): vscode.Uri {
	return vscode.Uri.from({ scheme: GIT_SCHEME, authority: envKey, path: `${toplevel}/${file}`, query: 'HEAD', fragment: String(toplevel.length) });
}

/** What {@link gitHeadUri} encoded. */
export function parseGitHeadUri(uri: vscode.Uri): { envKey: string; toplevel: string; file: string } | undefined {
	const length = Number(uri.fragment);
	if (!uri.authority || !Number.isInteger(length) || length <= 0 || uri.path[length] !== '/') {
		return undefined;
	}
	return { envKey: uri.authority, toplevel: uri.path.slice(0, length), file: uri.path.slice(length + 1) };
}

/** Left sides of **Open Changes**: `git show HEAD:<path>` in the environment; empty when HEAD has no such file. */
export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
	constructor(
		/** Environments are only ever the discovered ones: any URI of this scheme reaches this, from anywhere. */
		private readonly envOf: (key: string) => Pick<Environment, 'shell'> | undefined,
	) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const target = parseGitHeadUri(uri);
		const env = target && this.envOf(target.envKey);
		if (!target || !env) {
			return '';
		}
		const res = await env.shell.run(['git', '-C', target.toplevel, 'show', `HEAD:${target.file}`], { timeoutMs: GIT_TIMEOUT_MS });
		return res.exitCode === 0 ? res.stdout.toString('utf8') : '';
	}
}
