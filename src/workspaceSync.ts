import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as posix from 'path/posix';
import {
  RemoteShell,
  SSH_SAFETY_OPTIONS,
  controlOptions,
  shQuote,
  sshFailure,
} from './remoteShell';

/**
 * Send a local Git repo to an SSH host and fetch the agent's commits back,
 * with the repo at the same home-relative path on both sides.
 *
 * No vscode import: the UI arrives as SyncUi, so every flow here runs under
 * plain mocha against a fake ssh.
 */

/** A failure to show the user as is; `showLog` offers the Devc channel. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly showLog = false
  ) {
    super(message);
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Characters no path may contain to be sent: they break ssh/git quoting. */
const UNSENDABLE = /['\\\u0000-\u001f\u007f]/;

export function checkSendablePath(p: string): void {
  if (UNSENDABLE.test(p)) {
    throw new SyncError(`${p} contains characters that can't be sent over ssh.`);
  }
}

/**
 * The remote path for `localPath`: the same path relative to home. Both
 * `localPath` and `localHome` must already be realpaths.
 */
export function mirror(
  localPath: string,
  localHome: string,
  remoteHome: string
): string {
  if (localPath !== localHome && !localPath.startsWith(localHome + '/')) {
    throw new SyncError(
      `${localPath} is outside your home folder — only folders under ~ can be sent.`
    );
  }
  checkSendablePath(localPath);
  const remote = remoteHome + localPath.slice(localHome.length);
  checkSendablePath(remote);
  return remote;
}

/** Arguments that must be on git's ssh, so it forwards nothing either. */
export function gitSshCommand(
  sshPath: string,
  controlDir: string | undefined
): string {
  return [
    sshPath,
    ...SSH_SAFETY_OPTIONS,
    '-o',
    'BatchMode=yes',
    ...controlOptions(controlDir),
  ]
    .map(shQuote)
    .join(' ');
}

/** The environment every git process runs with. */
export function gitEnv(
  sshPath: string,
  controlDir: string | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_SSH_COMMAND: gitSshCommand(sshPath, controlDir),
    GIT_SSH_VARIANT: 'ssh',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export interface RemoteWorktree {
  path: string;
  /** Undefined for a detached HEAD. */
  branch?: string;
}

/**
 * Parse the `worktrees` script's output: `git worktree list --porcelain -z`,
 * a `\0REFS\0` marker, then the branches that exist. An unborn branch is
 * listed on its worktree but not in `refs`.
 */
export function parseWorktrees(out: string): {
  worktrees: RemoteWorktree[];
  refs: Set<string>;
} {
  const marker = out.indexOf('\0REFS\0');
  const listing = marker < 0 ? out : out.slice(0, marker);
  const refsPart = marker < 0 ? '' : out.slice(marker + '\0REFS\0'.length);

  const worktrees: RemoteWorktree[] = [];
  for (const field of listing.split('\0')) {
    if (field.startsWith('worktree ')) {
      worktrees.push({ path: field.slice('worktree '.length) });
    } else if (field.startsWith('branch refs/heads/') && worktrees.length) {
      worktrees[worktrees.length - 1].branch = field.slice(
        'branch refs/heads/'.length
      );
    }
  }
  const refs = new Set(refsPart.split(/[\0\n]/).filter(Boolean));
  return { worktrees, refs };
}

const SENSITIVE_ROOT_DIRS = ['.vscode/', '.devcontainer/', '.github/', '.husky/'];
const SENSITIVE_ROOT_FILES = ['.gitmodules', '.gitattributes', '.envrc'];
const SENSITIVE_BASENAMES = [
  'package.json',
  '.npmrc',
  'Makefile',
  '.pre-commit-config.yaml',
];

/**
 * Whether a repo-relative path is one that can run code on the host once
 * merged into an open, trusted folder — without the user running it.
 */
export function isSensitivePath(p: string): boolean {
  const base = posix.basename(p);
  return (
    SENSITIVE_ROOT_DIRS.some(dir => p.startsWith(dir)) ||
    SENSITIVE_ROOT_FILES.includes(p) ||
    SENSITIVE_BASENAMES.includes(base) ||
    base.endsWith('.code-workspace')
  );
}

export interface ChangedFile {
  path: string;
  /** git's name-status letter: A, M, D, T, … */
  status: string;
}

/** Parse `git diff --name-status -z --no-renames`. */
export function parseNameStatus(out: string): ChangedFile[] {
  const fields = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i]) {
      files.push({ status: fields[i], path: fields[i + 1] });
    }
  }
  return files;
}

/** Sensitive files first, each group in git's order. */
export function orderForReview(files: ChangedFile[]): ChangedFile[] {
  return [
    ...files.filter(f => isSensitivePath(f.path)),
    ...files.filter(f => !isSensitivePath(f.path)),
  ];
}

/** "a, b, c, d, e and N more" */
function listPaths(paths: string[]): string {
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

// ── Git ─────────────────────────────────────────────────────────────────────

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
export const GIT_NETWORK_TIMEOUT_MS = 120000;

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
              new SyncError(
                (err as { killed?: boolean }).killed
                  ? `git ${args[0]} timed out after ${timeoutMs / 1000}s`
                  : `Failed to run git: ${err.message}`,
                true
              )
            );
            return;
          }
          resolve({ stdout, stderr, code: err ? (code as number) : 0 });
        }
      );
    });
}

/** The line of git's stderr that says why a push or fetch failed. */
export function gitFailureLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return (
    lines.find(l => /\[(remote )?rejected\]/.test(l)) ??
    lines[lines.length - 1] ??
    'git failed'
  );
}

// ── Remote scripts ──────────────────────────────────────────────────────────

export const ENSURE_REPO_SCRIPT = `repo="$1"; host_path="$2"; branch="$3"
if [ -e "$repo" ]; then
  [ -d "$repo/.git" ] || exit 3
  [ "$(git -C "$repo" config --get devc.hostPath)" = "$host_path" ] || exit 4
  exit 0
fi
[ -n "$branch" ] || exit 6
mkdir -p "$(dirname "$repo")" &&
git init -q -b "$branch" "$repo" &&
git -C "$repo" config receive.denyCurrentBranch updateInstead &&
git -C "$repo" config devc.hostPath "$host_path"`;

export const WORKTREES_SCRIPT = `git -C "$1" worktree list --porcelain -z && printf '\\0\\0REFS\\0' &&
git -C "$1" for-each-ref --format='%(refname:short)%00' refs/heads/`;

export const ADD_WORKTREE_SCRIPT = `if [ -e "$2" ]; then exit 5; fi
mkdir -p "$(dirname "$2")" && git -C "$1" worktree add -q "$2" "$3"`;

export const DIRTY_SCRIPT = `git -C "$1" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
  n=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && printf '%s\\t%s\\n' "$n" "$wt"
done; true`;

export const SWITCH_SCRIPT = `git -C "$1" switch -q "$2"`;

export const GIT_VERSION_SCRIPT = `git --version`;

/** Oldest remote git with `worktree list -z`. */
const MIN_REMOTE_GIT: [number, number] = [2, 36];

// ── Flows ───────────────────────────────────────────────────────────────────

export interface ReviewRequest {
  /** Editor title: `<host>/<branch> vs <local branch or HEAD>`. */
  title: string;
  /** Local worktree root; resources are `<root>/<path>`. */
  root: string;
  /** Original side. */
  base: string;
  /** Modified side, `refs/remotes/<host>/<branch>`. */
  ref: string;
  /** In display order: sensitive paths first. */
  files: ChangedFile[];
}

export interface SyncUi {
  /** A warning; modal ones are awaited for the button clicked. */
  warn(message: string, modal: boolean, ...buttons: string[]): Thenable<string | undefined>;
  info(message: string, ...buttons: string[]): Thenable<string | undefined>;
  pick(
    items: { label: string; description: string }[],
    placeholder: string
  ): Thenable<string | undefined>;
  openReview(request: ReviewRequest): Thenable<unknown>;
  /** Report an error from a follow-up action (a button) after the flow ended. */
  error(err: unknown): void;
}

export interface SyncDeps {
  shell(host: string): RemoteShell;
  sshHome(host: string): Promise<string>;
  git: Git;
  /** Realpath of the local home folder. */
  localHome: string;
  /** Hosts whose git version already passed, for this session. */
  checkedHosts: Set<string>;
  log(line: string): void;
  ui: SyncUi;
}

interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function remote(
  deps: SyncDeps,
  host: string,
  script: string,
  args: string[]
): Promise<RemoteResult> {
  const res = await deps.shell(host).run(['sh', '-c', script, 'sh', ...args]);
  const failure = sshFailure(host, res);
  if (failure) {
    throw new SyncError(failure, true);
  }
  const stderr = res.stderr.toString('utf8');
  if (stderr.trim()) {
    deps.log(`${host}: ${stderr.trim()}`);
  }
  return { code: res.exitCode, stdout: res.stdout.toString('utf8'), stderr };
}

/** A remote script failed in a way the flow has no message for. */
function remoteError(host: string, res: RemoteResult): SyncError {
  return new SyncError(
    res.stderr.trim().split('\n').pop() || `${host}: command failed (exit ${res.code})`,
    true
  );
}

async function checkRemoteGit(deps: SyncDeps, host: string): Promise<void> {
  if (deps.checkedHosts.has(host)) {
    return;
  }
  const res = await remote(deps, host, GIT_VERSION_SCRIPT, []);
  const match = /(\d+)\.(\d+)/.exec(res.stdout);
  if (res.code !== 0 || !match) {
    throw new SyncError(`${host} doesn't have Git installed.`);
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (
    major < MIN_REMOTE_GIT[0] ||
    (major === MIN_REMOTE_GIT[0] && minor < MIN_REMOTE_GIT[1])
  ) {
    throw new SyncError(
      `${host} has Git ${match[0]}; ${MIN_REMOTE_GIT.join('.')} or newer is needed.`
    );
  }
  deps.checkedHosts.add(host);
}

interface RepoPaths {
  /** Local worktree root (the folder). */
  T: string;
  /** Local main worktree. */
  P: string;
  RP: string;
  RT: string;
}

async function resolveRepo(
  deps: SyncDeps,
  folder: string,
  remoteHome: string
): Promise<RepoPaths> {
  const notRoot = new SyncError(
    `${folder} is not the root of a Git repository or worktree.`
  );
  let F: string;
  try {
    F = fs.realpathSync(folder);
  } catch {
    throw notRoot;
  }
  const top = await deps.git(F, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || fs.realpathSync(top.stdout.trim()) !== F) {
    throw notRoot;
  }
  const common = await deps.git(F, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (common.code !== 0) {
    throw notRoot;
  }
  const C = fs.realpathSync(common.stdout.trim());
  if (path.basename(C) !== '.git') {
    throw new SyncError('Bare repositories are not supported.');
  }
  const P = path.dirname(C);
  return {
    T: F,
    P,
    RP: mirror(P, deps.localHome, remoteHome),
    RT: mirror(F, deps.localHome, remoteHome),
  };
}

async function currentBranch(git: Git, dir: string): Promise<string | undefined> {
  const res = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

async function ensureRepo(
  deps: SyncDeps,
  host: string,
  repo: RepoPaths,
  branch: string
): Promise<void> {
  const res = await remote(deps, host, ENSURE_REPO_SCRIPT, [repo.RP, repo.P, branch]);
  switch (res.code) {
    case 0:
      return;
    case 3:
      throw new SyncError(`${host}:${repo.RP} exists and is not a Git repository.`);
    case 4:
      throw new SyncError(
        `${host}:${repo.RP} exists but wasn't created from ${repo.P} — move it aside on ${host} to sync.`
      );
    case 6:
      throw new SyncError(`${host}:${repo.RP} no longer exists.`);
    default:
      throw remoteError(host, res);
  }
}

/** The local remote named `host`, when it exists: its URL. */
async function remoteUrl(git: Git, dir: string, host: string): Promise<string | undefined> {
  const res = await git(dir, ['remote', 'get-url', host]);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

function wrongRemote(host: string, url: string): SyncError {
  return new SyncError(
    `Remote "${host}" already points at ${url} — rename or remove it to sync with ${host}.`
  );
}

async function remoteWorktrees(deps: SyncDeps, host: string, repo: string) {
  const res = await remote(deps, host, WORKTREES_SCRIPT, [repo]);
  if (res.code !== 0) {
    throw remoteError(host, res);
  }
  return parseWorktrees(res.stdout);
}

export async function sendToSshHost(
  folder: string,
  host: string,
  deps: SyncDeps
): Promise<void> {
  await checkRemoteGit(deps, host);
  const repo = await resolveRepo(deps, folder, await deps.sshHome(host));
  const { T, P, RP, RT } = repo;

  const B = await currentBranch(deps.git, T);
  if (B === undefined) {
    throw new SyncError(`${T} is on a detached HEAD — check out a branch to send it.`);
  }
  // A new remote repo's main worktree starts on the local main worktree's
  // branch: starting it on B would block B's own worktree there.
  const initBranch = T === P ? B : await currentBranch(deps.git, P);
  if (initBranch === undefined) {
    throw new SyncError(
      `${P} (the main worktree) is on a detached HEAD — check out a branch there first.`
    );
  }
  await ensureRepo(deps, host, repo, initBranch);

  const expectedUrl = `${host}:${RP}`;
  const url = await remoteUrl(deps.git, T, host);
  if (url === undefined) {
    const added = await deps.git(T, ['remote', 'add', host, expectedUrl]);
    if (added.code !== 0) {
      throw new SyncError(gitFailureLine(added.stderr), true);
    }
  } else if (url !== expectedUrl) {
    throw wrongRemote(host, url);
  }

  const before = await remoteWorktrees(deps, host, RP);
  const holding = before.worktrees.filter(w => w.branch === B);
  if (holding.length && before.refs.has(B)) {
    const choice = await deps.ui.warn(
      `${B} is checked out on ${host} at ${holding[0].path}. Pushing updates the files there if that checkout is clean. Continue?`,
      true,
      'Push'
    );
    if (choice !== 'Push') {
      return;
    }
  }

  const pushed = await deps.git(
    T,
    ['push', host, `refs/heads/${B}:refs/heads/${B}`],
    GIT_NETWORK_TIMEOUT_MS
  );
  if (pushed.code !== 0) {
    throw new SyncError(gitFailureLine(pushed.stderr), true);
  }

  if (T !== P && !before.worktrees.some(w => w.path === RT)) {
    const added = await remote(deps, host, ADD_WORKTREE_SCRIPT, [RP, RT, B]);
    if (added.code === 5) {
      throw new SyncError(`${host}:${RT} already exists and is not a worktree of ${RP}.`);
    }
    if (added.code !== 0) {
      throw remoteError(host, added);
    }
  }

  const status = await deps.git(T, ['status', '--porcelain']);
  const unsent =
    status.code === 0 && status.stdout.trim()
      ? ' Uncommitted local changes were not sent.'
      : '';

  const after = await remoteWorktrees(deps, host, RP);
  const atRT = after.worktrees.find(w => w.path === RT);
  if (atRT && atRT.branch !== B) {
    const button = `Check Out ${B} on ${host}`;
    // Not awaited: an information message stays until dismissed.
    void Promise.resolve(
      deps.ui.info(
        `Sent ${B}. ${host} has ${atRT.branch ?? 'a detached HEAD'} checked out at ${RT}.${unsent}`,
        button
      )
    ).then(async choice => {
      if (choice !== button) {
        return;
      }
      try {
        const switched = await remote(deps, host, SWITCH_SCRIPT, [RT, B]);
        if (switched.code !== 0) {
          throw remoteError(host, switched);
        }
      } catch (err) {
        deps.ui.error(err);
      }
    });
    return;
  }
  void deps.ui.info(`Sent ${B} to ${host}.${unsent}`);
}

async function refSnapshot(git: Git, dir: string, host: string): Promise<Map<string, string>> {
  const res = await git(dir, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    `refs/remotes/${host}/`,
  ]);
  const refs = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (ref && sha && !ref.endsWith('/HEAD')) {
      refs.set(ref, sha);
    }
  }
  return refs;
}

export async function fetchFromSshHost(
  folder: string,
  host: string,
  deps: SyncDeps
): Promise<void> {
  await checkRemoteGit(deps, host);
  const repo = await resolveRepo(deps, folder, await deps.sshHome(host));
  const { T, P, RP } = repo;

  const url = await remoteUrl(deps.git, T, host);
  if (url === undefined) {
    throw new SyncError(
      `${path.basename(P)} hasn't been sent to ${host} yet — use Send to SSH Host first.`
    );
  }
  if (url !== `${host}:${RP}`) {
    throw wrongRemote(host, url);
  }
  await ensureRepo(deps, host, repo, '');

  const dirtyRes = await remote(deps, host, DIRTY_SCRIPT, [RP]);
  const dirty = dirtyRes.stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([count, wt]) => count && wt)
    .map(([count, wt]) => `${wt} (${count} files)`);
  const dirtyWarning = dirty.length
    ? `${host} has uncommitted changes that weren't fetched: ${dirty.join(', ')}`
    : undefined;

  const before = await refSnapshot(deps.git, T, host);
  const fetched = await deps.git(T, ['fetch', '--prune', host], GIT_NETWORK_TIMEOUT_MS);
  if (fetched.code !== 0) {
    throw new SyncError(gitFailureLine(fetched.stderr), true);
  }
  const after = await refSnapshot(deps.git, T, host);
  const prefix = `refs/remotes/${host}/`;
  const changed = [...after]
    .filter(([ref, sha]) => before.get(ref) !== sha)
    .map(([ref]) => ({
      branch: ref.slice(prefix.length),
      description: before.has(ref) ? 'updated' : 'new',
    }));

  if (!changed.length) {
    void deps.ui.info(`No new commits on ${host}.`);
    if (dirtyWarning) {
      void deps.ui.warn(dirtyWarning, false);
    }
    return;
  }

  let branch: string | undefined = changed[0].branch;
  if (changed.length > 1) {
    branch = await deps.ui.pick(
      changed.map(c => ({ label: c.branch, description: c.description })),
      `Branch from ${host} to review`
    );
    if (branch === undefined) {
      return;
    }
  }
  if (dirtyWarning) {
    void deps.ui.warn(dirtyWarning, false);
  }

  const ref = `${prefix}${branch}`;
  const hasLocal =
    (await deps.git(T, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]))
      .code === 0;
  const local = hasLocal ? `refs/heads/${branch}` : 'HEAD';
  const localLabel = hasLocal ? branch : 'HEAD';
  const mergeBase = await deps.git(T, ['merge-base', local, ref]);
  if (mergeBase.code !== 0) {
    throw new SyncError(`${host}/${branch} shares no history with ${localLabel}.`);
  }
  const base = mergeBase.stdout.trim();

  const diff = await deps.git(T, ['diff', '--name-status', '-z', '--no-renames', base, ref]);
  if (diff.code !== 0) {
    throw new SyncError(gitFailureLine(diff.stderr), true);
  }
  const files = orderForReview(parseNameStatus(diff.stdout));
  if (!files.length) {
    void deps.ui.info(`${host}/${branch} has no file changes compared with ${localLabel}.`);
    return;
  }
  const sensitive = files.filter(f => isSensitivePath(f.path)).map(f => f.path);
  if (sensitive.length) {
    void deps.ui.warn(
      `These changes touch files that can run code on this machine — review them before merging: ${listPaths(sensitive)}`,
      false
    );
  }
  await deps.ui.openReview({
    title: `${host}/${branch} vs ${localLabel}`,
    root: T,
    base,
    ref,
    files,
  });
}
