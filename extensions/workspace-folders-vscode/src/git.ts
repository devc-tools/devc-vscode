// Copied from devc-vscode/src/workspaceSync.ts at 9031682 (local git only); maintained separately.
import * as cp from 'child_process';
import * as fs from 'fs';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run git in `cwd`. Resolves on any exit; rejects only when git can't run. */
export type Git = (
  cwd: string,
  args: string[],
  timeoutMs?: number
) => Promise<GitResult>;

export const GIT_TIMEOUT_MS = 30000;

export function makeGit(env: NodeJS.ProcessEnv, log: (line: string) => void): Git {
  return (cwd, args, timeoutMs = GIT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      log(`git ${args.join(' ')}  (in ${cwd})`);
      cp.execFile(
        'git',
        args,
        { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (stderr.trim()) {
            log(stderr.trim());
          }
          const code = (err as { code?: unknown } | null)?.code;
          if (err && typeof code !== 'number') {
            reject(
              new Error(
                (err as { killed?: boolean }).killed
                  ? `git ${args[0]} timed out after ${timeoutMs / 1000}s`
                  : `Failed to run git: ${err.message}`
              )
            );
            return;
          }
          resolve({ stdout, stderr, code: err ? (code as number) : 0 });
        }
      );
    });
}

export interface Worktree {
  path: string;
  /** Undefined for a detached HEAD. */
  branch?: string;
}

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktrees(out: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) {
      worktrees.push({ path: field.slice('worktree '.length) });
    } else if (field.startsWith('branch refs/heads/') && worktrees.length) {
      worktrees[worktrees.length - 1].branch = field.slice(
        'branch refs/heads/'.length
      );
    }
  }
  return worktrees;
}

function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/** The worktrees of the repo at `main`, realpath'd; ones that are gone are left out. */
export async function localWorktrees(git: Git, main: string): Promise<Worktree[]> {
  const res = await git(main, ['worktree', 'list', '--porcelain', '-z']);
  if (res.code !== 0) {
    return [];
  }
  return parseWorktrees(res.stdout).flatMap(w => {
    const real = realpathOrUndefined(w.path);
    return real ? [{ ...w, path: real }] : [];
  });
}
