import * as path from 'path';
import { Git, findLocalRepos, localWorktrees } from './workspaceSync';

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
 * The worktrees of the local repos behind `roots`: the repo each root is in,
 * and each immediate child of a root with a `.git` entry — so a
 * `project.worktrees` folder finds `project`. Ordered by project name, main
 * worktree first and detached ones last.
 */
export async function listFeatures(roots: string[], git: Git): Promise<Feature[]> {
  const mains = await findLocalRepos(roots, git);
  const features = (
    await Promise.all(
      mains.map(async main =>
        (await localWorktrees(git, main)).map(w => ({
          path: w.path,
          main,
          branch: w.branch,
        }))
      )
    )
  ).flat();
  const rank = (f: Feature) => (f.path === f.main ? 0 : 1);
  return features.sort(
    (a, b) =>
      projectOf(a).localeCompare(projectOf(b)) ||
      a.main.localeCompare(b.main) ||
      rank(a) - rank(b) ||
      Number(a.branch === undefined) - Number(b.branch === undefined) ||
      featureLabel(a).localeCompare(featureLabel(b)) ||
      a.path.localeCompare(b.path)
  );
}

/** The name of the project a feature belongs to. */
export function projectOf(feature: Feature): string {
  return path.basename(feature.main);
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
