import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Feature,
  featureAt,
  featureLabel,
  planFolders,
  removalRuns,
  worktreeFolderName,
} from './features';
import { Git, makeGit } from './git';
import {
  PinnedRepo,
  desiredOpen,
  planMove,
  prunePending,
  readPinnedRepo,
  resolvePin,
  rootPin,
  sortPinned,
  togglePending,
  unpinnedFolders,
} from './workspaceRepos';

const VIEW_ID = 'workspaceFolders.view';
const PINNED_REPOS_KEY = 'workspaceFolders.pinnedRepos';
const PENDING_CONTEXT = 'workspaceFolders.pending';
/** How long Apply waits for Source Control to show the repos it opened. */
const SOURCE_CONTROL_WAIT_MS = 3000;
/** How long a workspace folder change may take to be reported. */
const FOLDER_CHANGE_TIMEOUT_MS = 10000;

let log: vscode.LogOutputChannel;
let workspaceRepos: WorkspaceReposProvider;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Workspace Folders', { log: true });
  workspaceRepos = new WorkspaceReposProvider(context.globalState);
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: workspaceRepos,
    dragAndDropController: workspaceRepos,
    canSelectMany: true,
    manageCheckboxStateManually: true,
  });
  workspaceRepos.view = view;
  context.subscriptions.push(
    log,
    workspaceRepos,
    view,
    view.onDidChangeCheckboxState(e => workspaceRepos.toggle(e.items)),
    view.onDidChangeVisibility(e => e.visible && workspaceRepos.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => workspaceRepos.refresh()),
    vscode.commands.registerCommand('workspaceFolders.pin', () => pinRepo()),
    vscode.commands.registerCommand('workspaceFolders.unpin', (row?: RepoRow) =>
      unpinRepo(row)
    ),
    vscode.commands.registerCommand(
      'workspaceFolders.pinWorkspaceFolder',
      (row?: RepoRow, rows?: RepoRow[]) => pinUnpinned(row, rows)
    ),
    vscode.commands.registerCommand('workspaceFolders.rename', (row?: RepoRow) =>
      renameFolder(row)
    ),
    vscode.commands.registerCommand('workspaceFolders.apply', () =>
      applyWorkspaceRepos()
    ),
    vscode.commands.registerCommand('workspaceFolders.discard', () =>
      workspaceRepos.discard()
    ),
    vscode.commands.registerCommand('workspaceFolders.refresh', () =>
      workspaceRepos.refresh()
    )
  );
}

export function deactivate(): void {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Whether `target` is `base` or sits underneath it. */
function isPathWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `p` with the home directory written as `~`, as pickers show paths. */
function tildePath(p: string): string {
  const home = realpathOr(os.homedir());
  return isPathWithin(home, p) ? `~${p.slice(home.length)}` : p;
}

function localGit(): Git {
  return makeGit(process.env, line => log.debug(line));
}

/** The workspace folders as realpath'd host paths, in order. */
function openFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f =>
    f.uri.scheme === 'file' ? realpathOr(f.uri.fsPath) : f.uri.toString()
  );
}

/**
 * The window's first folder, which keys its pinned repos: it never changes,
 * while the workspace's identity does when a single-folder window gains a
 * second folder.
 */
function pinKey(): string | undefined {
  const first = vscode.workspace.workspaceFolders?.[0];
  return first?.uri.scheme === 'file' ? realpathOr(first.uri.fsPath) : undefined;
}

// ── View ────────────────────────────────────────────────────────────────────

type Section = 'current' | 'pinned';

const SECTION_LABELS: Record<Section, string> = {
  current: 'Current Workspace',
  pinned: 'Pinned',
};

/** A workspace folder as the view sees it. */
interface OpenFolder {
  index: number;
  uri: vscode.Uri;
  name: string;
  /** Realpath'd for a `file:` folder, else the URI as a string. */
  path: string;
}

type RepoRow =
  | { kind: 'section'; section: Section }
  | { kind: 'repo'; repo: PinnedRepo }
  | { kind: 'worktree'; feature: Feature }
  | { kind: 'folder'; folder: OpenFolder };

function rowPath(row: RepoRow): string | undefined {
  switch (row.kind) {
    case 'repo':
      return row.repo.main;
    case 'worktree':
      return row.feature.path;
    case 'folder':
      return row.folder.path;
    default:
      return undefined;
  }
}

/** The workspace folders, in order. */
function readOpenFolders(): OpenFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => ({
    index: f.index,
    uri: f.uri,
    name: f.name,
    path: f.uri.scheme === 'file' ? realpathOr(f.uri.fsPath) : f.uri.toString(),
  }));
}

/** A folder to re-add as it is, its name kept only when it was given one. */
function folderSpec(f: OpenFolder): { uri: vscode.Uri; name?: string } {
  return f.name === path.posix.basename(f.uri.path)
    ? { uri: f.uri }
    : { uri: f.uri, name: f.name };
}

/** Carries the paths of dragged Current Workspace rows; other rows don't set it. */
const DRAG_MIME = 'application/vnd.workspacefolders.current';

/**
 * Two sections: the pinned folders and repos with their worktrees, and the
 * workspace folders in order (drag to reorder). Every row but the window's
 * first folder has a checkbox for whether it is a workspace folder; a path
 * in both sections shares one. The first folder is pinned without being
 * asked, and listed first. Toggles wait in `pending` until Apply.
 */
class WorkspaceReposProvider
  implements vscode.TreeDataProvider<RepoRow>, vscode.TreeDragAndDropController<RepoRow>
{
  private readonly changed = new vscode.EventEmitter<RepoRow | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];
  private readonly pending = new Map<string, boolean>();
  private repos: PinnedRepo[] = [];
  private folders: OpenFolder[] = [];
  /** Open folders no pin lists. */
  private unpinned = new Set<string>();
  /** The rows shown for each path, to redraw both when one is toggled. */
  private rows = new Map<string, RepoRow[]>();
  private open = new Set<string>();
  private first: string | undefined;
  /** What the first folder pins: its repo, or itself. */
  private root: string | undefined;
  view?: vscode.TreeView<RepoRow>;

  constructor(private readonly globalState: vscode.Memento) {}

  pinned(): string[] {
    const key = pinKey();
    return key
      ? (this.globalState.get<Record<string, string[]>>(PINNED_REPOS_KEY, {})[key] ?? [])
      : [];
  }

  async setPinned(mains: string[]): Promise<void> {
    const key = pinKey();
    if (!key) {
      return;
    }
    const all = { ...this.globalState.get<Record<string, string[]>>(PINNED_REPOS_KEY, {}) };
    if (mains.length) {
      all[key] = mains;
    } else {
      delete all[key];
    }
    await this.globalState.update(PINNED_REPOS_KEY, all);
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  discard(): void {
    this.pending.clear();
    this.syncPending();
    this.refresh();
  }

  /** The pin the first folder makes, which can't be unpinned. */
  rootPin(): string | undefined {
    return this.root;
  }

  /** The paths the pins list, open or not. */
  private covered(): string[] {
    return this.repos
      .filter(r => !r.missing)
      .flatMap(r => [r.main, ...r.worktrees.map(w => w.path)]);
  }

  /** The paths with a checkbox: what Apply manages. */
  listed(): string[] {
    return [...new Set([...this.covered(), ...this.folders.map(f => f.path)])].filter(
      p => p !== this.first
    );
  }

  /** The listed paths that are Git repos or worktrees. */
  listedRepos(): Set<string> {
    return new Set(
      this.repos
        .filter(r => r.git)
        .flatMap(r => [r.main, ...r.worktrees.map(w => w.path)])
    );
  }

  /** Every listed path to be open once the pending toggles apply. */
  desired(): string[] {
    return desiredOpen(this.listed(), this.open, this.pending);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  toggle(changes: readonly (readonly [RepoRow, vscode.TreeItemCheckboxState])[]): void {
    for (const [row, state] of changes) {
      const p = rowPath(row);
      if (p === undefined) {
        continue;
      }
      togglePending(
        this.pending,
        p,
        state === vscode.TreeItemCheckboxState.Checked,
        this.open.has(p)
      );
    }
    this.syncPending();
    const redraw = new Set<RepoRow>();
    for (const [row] of changes) {
      const p = rowPath(row);
      for (const shown of (p !== undefined && this.rows.get(p)) || [row]) {
        redraw.add(shown);
      }
    }
    for (const row of redraw) {
      this.changed.fire(row);
    }
  }

  private syncPending(): void {
    vscode.commands.executeCommand('setContext', PENDING_CONTEXT, this.hasPending());
  }

  async getChildren(row?: RepoRow): Promise<RepoRow[]> {
    if (!row) {
      return this.load();
    }
    return this.remember(this.children(row));
  }

  private children(row: RepoRow): RepoRow[] {
    switch (row.kind) {
      case 'repo':
        return row.repo.worktrees.map(feature => ({ kind: 'worktree', feature }));
      case 'section':
        return row.section === 'current'
          ? this.folders.map(folder => ({ kind: 'folder', folder }))
          : this.repos.map(repo => ({ kind: 'repo', repo }));
    }
    return [];
  }

  private remember(rows: RepoRow[]): RepoRow[] {
    for (const row of rows) {
      const p = rowPath(row);
      if (p !== undefined) {
        const shown = (this.rows.get(p) ?? []).filter(r => r.kind !== row.kind);
        this.rows.set(p, [...shown, row]);
      }
    }
    return rows;
  }

  /** Read the pins and the workspace folders; the sections to show. */
  private async load(): Promise<RepoRow[]> {
    this.first = pinKey();
    if (this.view) {
      this.view.message = this.first
        ? undefined
        : 'Open a folder in this window to pin others.';
    }
    if (!this.first) {
      this.repos = [];
      this.folders = [];
      this.unpinned.clear();
      this.rows.clear();
      return [];
    }
    const git = localGit();
    this.root = await rootPin(this.first, git);
    const root = this.root;
    this.repos = await Promise.all(
      [root, ...this.pinned().filter(m => m !== root)].map(main =>
        readPinnedRepo(main, git)
      )
    );
    this.repos = [
      ...this.repos.filter(r => r.main === root),
      ...sortPinned(this.repos.filter(r => r.main !== root)),
    ];
    this.folders = readOpenFolders();
    const paths = this.folders.map(f => f.path);
    this.open = new Set(paths);
    this.unpinned = new Set(unpinnedFolders(paths, new Set(this.covered())));
    this.rows.clear();
    prunePending(this.pending, this.open, new Set(this.listed()));
    this.syncPending();
    const sections: Section[] = ['pinned', 'current'];
    return sections.map(section => ({ kind: 'section', section }));
  }

  getTreeItem(row: RepoRow): vscode.TreeItem {
    switch (row.kind) {
      case 'section': {
        const item = new vscode.TreeItem(
          SECTION_LABELS[row.section],
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `section:${row.section}`;
        item.contextValue = `section-${row.section}`;
        return item;
      }
      case 'folder':
        return this.currentItem(row.folder);
    }
    const p = row.kind === 'repo' ? row.repo.main : row.feature.path;
    const item = new vscode.TreeItem(
      row.kind === 'repo' ? path.basename(row.repo.main) : featureLabel(row.feature),
      row.kind === 'repo' && row.repo.worktrees.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = `${row.kind}:${p}`;
    item.tooltip = p;
    if (row.kind === 'worktree') {
      item.iconPath = new vscode.ThemeIcon('git-branch');
      item.contextValue = 'repoWorktree';
    } else if (row.repo.missing) {
      item.iconPath = new vscode.ThemeIcon('warning');
      item.description = 'not found';
      item.contextValue = 'pinnedMissing';
      return item;
    } else {
      item.iconPath = new vscode.ThemeIcon(row.repo.git ? 'repo' : 'folder');
      item.contextValue =
        (row.repo.main === this.root ? 'root' : 'pinned') +
        (row.repo.git ? 'Repo' : 'Folder');
    }
    if (p === this.first) {
      item.description = 'workspace root';
      return item;
    }
    this.check(item, p, tildePath(p));
    return item;
  }

  /**
   * A row of Current Workspace: the folder's workspace name and path, and a
   * checkbox, draggable; the first folder has neither.
   */
  private currentItem(folder: OpenFolder): vscode.TreeItem {
    const item = new vscode.TreeItem(folder.name);
    item.id = `current:${folder.path}`;
    item.tooltip = `${folder.name}\n${folder.path}`;
    item.iconPath = vscode.ThemeIcon.Folder;
    if (folder.index === 0) {
      item.description = 'workspace root';
      item.contextValue = 'workspaceFolderRoot';
      return item;
    }
    const unpinned = this.unpinned.has(folder.path);
    const where =
      (folder.uri.scheme === 'file' ? tildePath(folder.path) : folder.path) +
      (unpinned ? ' • not pinned' : '');
    item.contextValue =
      unpinned && folder.uri.scheme === 'file' ? 'workspaceFolderUnpinned' : 'workspaceFolder';
    this.check(item, folder.path, where);
    return item;
  }

  /** Give a row the checkbox for `p` and its pending state. */
  private check(item: vscode.TreeItem, p: string, where: string): void {
    const isOpen = this.open.has(p);
    const wantOpen = this.pending.get(p) ?? isOpen;
    item.checkboxState = wantOpen
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.description =
      where + (wantOpen === isOpen ? '' : wantOpen ? ' • will open' : ' • will close');
  }

  handleDrag(rows: readonly RepoRow[], data: vscode.DataTransfer): void {
    const paths = rows.flatMap(r =>
      r.kind === 'folder' && r.folder.index > 0 ? [r.folder.path] : []
    );
    if (paths.length) {
      data.set(DRAG_MIME, new vscode.DataTransferItem(paths));
    }
  }

  async handleDrop(target: RepoRow | undefined, data: vscode.DataTransfer): Promise<void> {
    const paths: unknown = data.get(DRAG_MIME)?.value;
    if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string')) {
      return;
    }
    let onto: string | undefined;
    if (target?.kind === 'folder') {
      onto = target.folder.path;
    } else if (!(target?.kind === 'section' && target.section === 'current')) {
      return;
    }
    await moveFolders(paths, onto);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Pin the folders the user picks, or the repos they are worktrees of. */
async function pinRepo(): Promise<void> {
  const first = pinKey();
  if (!first) {
    vscode.window.showErrorMessage('Open a folder in this window to pin others.');
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: true,
    openLabel: 'Pin',
    defaultUri: vscode.Uri.file(path.dirname(first)),
  });
  if (picked?.length) {
    await pinPaths(picked.map(uri => uri.fsPath));
  }
}

/** Pin a workspace folder no pin lists, or the repo it is a worktree of. */
async function pinUnpinned(row?: RepoRow, rows?: readonly RepoRow[]): Promise<void> {
  const picked = (rows?.length ? rows : row ? [row] : []).flatMap(r =>
    r.kind === 'folder' && r.folder.uri.scheme === 'file' ? [r.folder.path] : []
  );
  if (picked.length) {
    await pinPaths(picked);
  }
}

async function pinPaths(dirs: string[]): Promise<void> {
  const git = localGit();
  const results = await Promise.all(dirs.map(dir => resolvePin(dir, git)));
  const errors = results.flatMap(r => ('error' in r ? [r.error] : []));
  if (errors.length) {
    vscode.window.showErrorMessage(errors.join(' '));
  }
  const mains = results.flatMap(r => ('main' in r ? [r.main] : []));
  const pinned = workspaceRepos.pinned();
  const added = mains.filter(
    m => !pinned.includes(m) && m !== workspaceRepos.rootPin()
  );
  if (added.length) {
    await workspaceRepos.setPinned([...pinned, ...new Set(added)]);
  }
}

/** Take a pin off the list; its folders stay as they are. */
async function unpinRepo(row?: RepoRow): Promise<void> {
  if (row?.kind !== 'repo') {
    return;
  }
  await workspaceRepos.setPinned(
    workspaceRepos.pinned().filter(m => m !== row.repo.main)
  );
}

/**
 * Rename the workspace folder a row stands for (the selected row with none
 * given), not the folder on disk. An empty name goes back to the folder's
 * own.
 */
async function renameFolder(row?: RepoRow): Promise<void> {
  const target = row ?? workspaceRepos.view?.selection[0];
  const p = target && rowPath(target);
  const folder = readOpenFolders().find(f => f.path === p);
  if (!folder) {
    if (target) {
      vscode.window.showInformationMessage('Only a workspace folder can be renamed.');
    }
    return;
  }
  if (!vscode.workspace.workspaceFile) {
    vscode.window.showErrorMessage(
      'A single-folder window can’t rename its folder. Add another folder first.'
    );
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Rename Workspace Folder',
    prompt: `The name ${tildePath(folder.path)} has in this workspace; the folder itself keeps its name. Leave empty for the folder's own name.`,
    value: folder.name,
    valueSelection: [0, folder.name.length],
  });
  if (name === undefined) {
    return;
  }
  const trimmed = name.trim();
  const own = path.posix.basename(folder.uri.path);
  if ((trimmed || own) === folder.name) {
    return;
  }
  const spec =
    trimmed && trimmed !== own ? { uri: folder.uri, name: trimmed } : { uri: folder.uri };
  if (!(await changeWorkspaceFolders(folder.index, 1, spec))) {
    vscode.window.showErrorMessage('Could not rename the workspace folder.');
  }
}

/**
 * Move the workspace folders at `paths` onto the one at `onto` (to the end
 * when undefined), by replacing the folders from the first that moves on.
 */
async function moveFolders(paths: string[], onto: string | undefined): Promise<void> {
  const folders = readOpenFolders();
  const index = (p: string) => folders.findIndex(f => f.path === p);
  const target = onto === undefined ? undefined : index(onto);
  if (target === -1) {
    return;
  }
  const plan = planMove(
    folders.length,
    paths.map(index).filter(i => i >= 0),
    target
  );
  if (!plan) {
    return;
  }
  const specs = plan.order.map(i => folderSpec(folders[i]));
  if (!(await changeWorkspaceFolders(plan.start, specs.length, ...specs))) {
    vscode.window.showErrorMessage('Could not reorder the workspace folders.');
  }
}

/** Make the ticked repos and worktrees the workspace folders among those listed. */
async function applyWorkspaceRepos(): Promise<void> {
  if (!workspaceRepos.hasPending()) {
    return;
  }
  const open = openFolders();
  const listed = workspaceRepos.listed();
  const picked = workspaceRepos.desired();
  const repos = workspaceRepos.listedRepos();
  workspaceRepos.discard();
  await applyFolderChange(open, planFolders(open, listed, picked));
  await checkSourceControl(picked.filter(p => repos.has(p)));
}

// ── Workspace folder changes ────────────────────────────────────────────────

/** Resolves once the workspace folders change, or false when they don't. */
function changeWorkspaceFolders(
  start: number,
  deleteCount: number,
  ...add: { uri: vscode.Uri; name?: string }[]
): Promise<boolean> {
  return new Promise(resolve => {
    const done = (changed: boolean) => {
      clearTimeout(timer);
      listener.dispose();
      resolve(changed);
    };
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() =>
      done(true)
    );
    const timer = setTimeout(() => done(false), FOLDER_CHANGE_TIMEOUT_MS);
    if (!vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...add)) {
      done(false);
    }
  });
}

/**
 * Make `plan`'s changes to the workspace folders, `open` being what they
 * are now. The Git extension's repositories follow: it opens and disposes a
 * folder's own repo as the folder comes and goes, but leaves a repo open
 * while one of its files is visible and skips one closed by hand, so both
 * are done here too.
 */
async function applyFolderChange(
  open: string[],
  plan: ReturnType<typeof planFolders>
): Promise<void> {
  if (!plan.added.length && !plan.removed.length) {
    return;
  }
  const gone = new Set(plan.removed.map(f => f.index));
  const staying = open.filter((_, index) => !gone.has(index));
  const api = await gitApi();
  for (const { path: root } of plan.removed) {
    // `git.close` asks which repository when it is given one that isn't open.
    if (
      api?.repositories.some(r => realpathOr(r.rootUri.fsPath) === root) &&
      !staying.some(f => isPathWithin(root, f))
    ) {
      await vscode.commands.executeCommand('git.close', root);
    }
  }
  for (const run of removalRuns([...gone])) {
    if (!(await changeWorkspaceFolders(run.start, run.count))) {
      vscode.window.showErrorMessage('Could not remove workspace folders.');
      return;
    }
  }
  if (!plan.added.length) {
    return;
  }
  // Before the folders: adding the second folder of a single-folder window
  // restarts the extension host.
  for (const root of plan.added) {
    try {
      await api?.openRepository(vscode.Uri.file(root));
    } catch (err) {
      log.info(`could not open the repository at ${root}: ${err}`);
    }
  }
  // A linked worktree's folder is named `project/folder`.
  const git = localGit();
  const folders = await Promise.all(
    plan.added.map(async root => {
      const feature = await featureAt(root, git).catch(() => undefined);
      const name =
        feature && realpathOr(feature.path) === root
          ? worktreeFolderName(feature)
          : undefined;
      return { uri: vscode.Uri.file(root), ...(name ? { name } : {}) };
    })
  );
  const count = vscode.workspace.workspaceFolders?.length ?? 0;
  if (!(await changeWorkspaceFolders(count, 0, ...folders))) {
    vscode.window.showErrorMessage('Could not add workspace folders.');
  }
}

/** The slice of the built-in Git extension's API (git.d.ts) used here. */
interface GitExtensionApi {
  readonly repositories: { readonly rootUri: vscode.Uri }[];
  openRepository(root: vscode.Uri): Promise<unknown>;
}

/** The built-in Git extension's API, or undefined when it is disabled. */
async function gitApi(): Promise<GitExtensionApi | undefined> {
  const extension = vscode.extensions.getExtension<{
    getAPI(version: 1): GitExtensionApi;
  }>('vscode.git');
  try {
    return (extension?.isActive
      ? extension.exports
      : await extension?.activate()
    )?.getAPI(1);
  } catch {
    return undefined;
  }
}

/**
 * Warn when Source Control has not opened every repo in `roots` shortly
 * after they became workspace folders, with ways to bring them back.
 */
async function checkSourceControl(roots: string[]): Promise<void> {
  const api = await gitApi();
  if (!api || !roots.length) {
    return;
  }
  const missing = () => {
    const shown = new Set(api.repositories.map(r => realpathOr(r.rootUri.fsPath)));
    return roots.filter(root => !shown.has(root));
  };
  const deadline = Date.now() + SOURCE_CONTROL_WAIT_MS;
  while (missing().length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const left = missing();
  if (!left.length) {
    return;
  }
  const reopen = 'Reopen Closed Repositories';
  const reload = 'Reload Window';
  const choice = await vscode.window.showWarningMessage(
    `Source Control has not opened: ${left.map(r => path.basename(r)).join(', ')}.`,
    reopen,
    reload
  );
  if (choice === reopen) {
    await vscode.commands.executeCommand('git.reopenClosedRepositories');
  } else if (choice === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
