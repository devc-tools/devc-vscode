import * as fs from 'fs';
import { Feature, compareFeatures, featureAt } from './features';
import { Git, localWorktrees } from './workspaceSync';

// No vscode import: the Workspace Folders view's logic, tested under plain mocha.

/**
 * A pinned folder: a repo's main worktree with its linked worktrees, or a
 * folder outside one (`git` false), or `missing` when it is gone.
 */
export interface PinnedRepo {
  /** The pinned folder, realpath'd: for a repo, its main worktree. */
  main: string;
  /** Its linked worktrees, in `listFeatures` order; empty unless a repo. */
  worktrees: Feature[];
  git: boolean;
  missing: boolean;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * What to pin for a folder: its repo's main worktree when the folder is the
 * top of a repo or a linked worktree, else the folder itself. A folder that
 * doesn't exist is an error.
 */
export async function resolvePin(
  dir: string,
  git: Git
): Promise<{ main: string } | { error: string }> {
  const real = realpathOr(dir);
  if (!fs.statSync(real, { throwIfNoEntry: false })?.isDirectory()) {
    return { error: `${dir} is not a folder.` };
  }
  const feature = await featureAt(real, git).catch(() => undefined);
  return {
    main:
      feature && realpathOr(feature.path) === real
        ? realpathOr(feature.main)
        : real,
  };
}

/** A pinned folder with its linked worktrees when it is a repo. */
export async function readPinnedRepo(main: string, git: Git): Promise<PinnedRepo> {
  if (!fs.existsSync(main)) {
    return { main, worktrees: [], git: false, missing: true };
  }
  const worktrees = await localWorktrees(git, main).catch(() => []);
  // A repo's main worktree lists itself; a folder inside a repo, or outside
  // any, does not.
  if (!worktrees.some(w => w.path === main)) {
    return { main, worktrees: [], git: false, missing: false };
  }
  return {
    main,
    worktrees: worktrees
      .filter(w => w.path !== main)
      .map(w => ({ path: w.path, main, branch: w.branch }))
      .sort(compareFeatures),
    git: true,
    missing: false,
  };
}

/**
 * What the window's first folder pins without being asked: its repo when it
 * is the top of a repo or a linked worktree, else itself.
 */
export async function rootPin(first: string, git: Git): Promise<string> {
  const pin = await resolvePin(first, git);
  return 'main' in pin ? pin.main : first;
}

/** Pinned repos in the order the view lists them: by project name, then path. */
export function sortPinned(repos: PinnedRepo[]): PinnedRepo[] {
  return [...repos].sort((a, b) =>
    compareFeatures({ path: a.main, main: a.main }, { path: b.main, main: b.main })
  );
}

/**
 * Record a checkbox toggle in `pending`, the desired open state of each
 * path toggled since the last apply. Toggling back to how the folder is
 * now forgets it.
 */
export function togglePending(
  pending: Map<string, boolean>,
  path: string,
  wantOpen: boolean,
  isOpen: boolean
): void {
  if (wantOpen === isOpen) {
    pending.delete(path);
  } else {
    pending.set(path, wantOpen);
  }
}

/**
 * Forget toggles that the workspace now matches, or whose paths the view no
 * longer lists.
 */
export function prunePending(
  pending: Map<string, boolean>,
  open: ReadonlySet<string>,
  listed: ReadonlySet<string>
): void {
  for (const [path, wantOpen] of pending) {
    if (!listed.has(path) || open.has(path) === wantOpen) {
      pending.delete(path);
    }
  }
}

/** Every listed path that should be open once the pending toggles apply. */
export function desiredOpen(
  listed: Iterable<string>,
  open: ReadonlySet<string>,
  pending: ReadonlyMap<string, boolean>
): string[] {
  return [...listed].filter(p => pending.get(p) ?? open.has(p));
}
