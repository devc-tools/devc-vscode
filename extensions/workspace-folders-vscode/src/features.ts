// Copied from devc-vscode/src/features.ts at 9031682 (the parts Workspace Folders uses); maintained separately.
import * as path from 'path';
import { Git } from './git';

/**
 * A folder that can be worked on by itself: a local repo's main worktree or
 * one of its linked worktrees.
 */
export interface Feature {
  /** The worktree's root on this machine, realpath'd. */
  path: string;
  /** The repo's main worktree; equals `path` for the main worktree itself. */
  main: string;
  /** Undefined for a detached or unborn HEAD. */
  branch?: string;
}

/**
 * The order features are listed in: by project name, main worktree first and
 * detached ones last.
 */
export function compareFeatures(a: Feature, b: Feature): number {
  const rank = (f: Feature) => (f.path === f.main ? 0 : 1);
  return (
    projectOf(a).localeCompare(projectOf(b)) ||
    a.main.localeCompare(b.main) ||
    rank(a) - rank(b) ||
    Number(a.branch === undefined) - Number(b.branch === undefined) ||
    featureLabel(a).localeCompare(featureLabel(b)) ||
    a.path.localeCompare(b.path)
  );
}

/** The feature — repo or worktree — the folder `dir` is in, if any. */
export async function featureAt(dir: string, git: Git): Promise<Feature | undefined> {
  const res = await git(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
  ]);
  const [root, common] = res.stdout.split('\n').map(line => line.trim());
  if (res.code !== 0 || !root || !common) {
    return undefined;
  }
  const head = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    path: root,
    main: path.basename(common) === '.git' ? path.dirname(common) : root,
    branch: head.code === 0 ? head.stdout.trim() || undefined : undefined,
  };
}

/** The name of the project a feature belongs to. */
export function projectOf(feature: Feature): string {
  return path.basename(feature.main);
}

/**
 * The name a linked worktree's workspace folder is given,
 * `project/folder`; undefined for a repo's main worktree.
 */
export function worktreeFolderName(feature: Feature): string | undefined {
  return feature.path === feature.main
    ? undefined
    : `${projectOf(feature)}/${path.basename(feature.path)}`;
}

/** What a feature is called within its project. */
export function featureLabel(feature: Feature): string {
  return feature.branch ?? `${path.basename(feature.path)} (detached)`;
}

export interface FolderChange {
  /** Feature paths joining the workspace. */
  added: string[];
  /** Workspace folders leaving it, by index. */
  removed: { index: number; path: string }[];
}

/**
 * What to change so that exactly `picked` of `catalog` are workspace folders.
 * The first folder is never touched: it is the window's root, and changing it
 * restarts the extension host. Folders that are not features stay too.
 */
export function planFolders(
  current: string[],
  catalog: string[],
  picked: string[]
): FolderChange {
  const features = new Set(catalog);
  const wanted = new Set(picked.filter(p => features.has(p)));
  const open = new Set(current);
  return {
    added: [...wanted].filter(p => !open.has(p)),
    removed: current
      .map((folder, index) => ({ index, path: folder }))
      .filter(f => f.index > 0 && features.has(f.path) && !wanted.has(f.path)),
  };
}

/**
 * `indices` as runs of neighbours, highest first, so that removing one run
 * leaves the indices of the runs still to go unchanged.
 */
export function removalRuns(indices: number[]): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = [];
  for (const index of [...new Set(indices)].sort((a, b) => b - a)) {
    const last = runs[runs.length - 1];
    if (last && last.start === index + 1) {
      last.start = index;
      last.count++;
    } else {
      runs.push({ start: index, count: 1 });
    }
  }
  return runs;
}
