import * as path from 'path';
import type { ContainerBindMount } from './containerTree';
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
 * The worktrees of the local repos behind `roots`: each root and each
 * immediate child of a root with a `.git` entry — so a `project.worktrees`
 * folder finds `project`. A root without one finds nothing above it. Ordered by project name, main
 * worktree first and detached ones last.
 */
export async function listFeatures(roots: string[], git: Git): Promise<Feature[]> {
  const mains = await findLocalRepos(roots, git, { topLevelOnly: true });
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

/** Whether `target` is `base` or sits underneath it. */
function within(base: string, target: string): boolean {
  const rel = path.posix.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
}

/**
 * The host folders the containers serving a workspace bind-mount under
 * /workspaces, realpath'd by `real`. A container serves the workspace when
 * one of `anchors` — its folders and the directory of its workspace file —
 * holds the container's project folder, sits inside it, or is one of the
 * container's /workspaces mounts. The first folder and the workspace file
 * never leave, so what they find stays offered however few other folders
 * are open. Mounts inside a `.git` (devc's frozen config and hooks) are not
 * folders to work in.
 */
export function mountedFeatureRoots(
  anchors: string[],
  mounts: Pick<
    ContainerBindMount,
    'containerId' | 'localFolder' | 'source' | 'destination'
  >[],
  real: (p: string) => string
): string[] {
  const homes = anchors.map(real);
  const workspaceMounts = mounts.filter(
    m =>
      within('/workspaces', m.destination) &&
      !m.source.split(/[\\/]/).includes('.git')
  );
  const serving = new Set<string>();
  for (const m of mounts) {
    const project = m.localFolder && real(m.localFolder);
    if (project && homes.some(h => within(h, project) || within(project, h))) {
      serving.add(m.containerId);
    }
  }
  for (const m of workspaceMounts) {
    if (homes.some(h => within(real(m.source), h))) {
      serving.add(m.containerId);
    }
  }
  return [
    ...new Set(
      workspaceMounts
        .filter(m => serving.has(m.containerId))
        .map(m => real(m.source))
    ),
  ];
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
