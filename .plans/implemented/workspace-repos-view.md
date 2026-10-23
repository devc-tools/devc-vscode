# Workspace Repos view: pinned repos and their worktrees as workspace-folder toggles

Requested by the user on 2026-10-23. A view in the Explorer where the user pins primary Git repos
and plain folders (the set to choose from) and ticks which folders, repo main worktrees and linked
worktrees are workspace folders. The window's first folder is pinned automatically. **Apply** makes the change; Source Control follows.

It is **Focus Features…** with a standing list instead of a one-shot picker, and reuses its code:
`planFolders`, `removalRuns`, `applyFolderChange` (which already closes removed repos with
`git.close` and opens added ones with the Git API's `openRepository`), `featureAt`,
`localWorktrees`, `featureLabel`, `projectOf`.

## Checklist

- [x] 1. `src/workspaceRepos.ts` (new, no `vscode` import): pin resolution and the pending-change logic; tests in `src/test/workspaceRepos.test.ts`
- [x] 2. Pinned-repo storage in `globalState`, keyed by the window's first folder
- [x] 3. The **Workspace Repos** tree view: repo and worktree rows with checkboxes, pending state, refresh
- [x] 4. Commands: Pin Folder…, Unpin, Apply, Discard, Refresh; `package.json` menus and view
- [x] 5. Apply: folder change through `applyFolderChange`, then the Source Control check
- [x] 6. README, CHANGELOG, `docs/how-it-works.md`
- [x] 7. Validation (below), then commit (in-VS Code check left to the user)

## Contracts

### Gating

None. The view and its commands are always available and do **not** follow
`devc-vscode.featureFolders` (changed with the user on 2026-10-23: that setting also turns on
Focus Features…, Focus on Active Agents and Add Active herdr Space to Workspace, which they
don't want). The setting's description does not mention the view.

### The view

- `package.json` `views.explorer`: `{ "id": "devc-vscode.workspaceRepos", "name": "Workspace Repos" }`, listed after `devc-vscode.containers`.
- Created with `vscode.window.createTreeView('devc-vscode.workspaceRepos', { treeDataProvider, manageCheckboxStateManually: true })`.
  **Gotcha:** without `manageCheckboxStateManually`, ticking a repo row ticks all its children
  and VS Code derives the parent's state from them. Here a repo row's box means its main worktree
  only.
- No `viewsWelcome`: with a folder open the root pin is always listed, so the view is never
  empty.
- With no workspace folder, or a first folder that is not `file:`, the root returns `[]` and the
  view's `message` is `Open a folder in this window to pin others.` (clear it otherwise).

Rows: the root pin first, then the other pins by `projectOf` then path (the order of
`listFeatures`). Icons are `ThemeIcon`s: `repo`, `folder`, `git-branch`, `warning`.

| Row | `label` | `description` | `contextValue` | Checkbox | Children |
| --- | --- | --- | --- | --- | --- |
| Repo | `basename(main)` | home-shortened main path (`~/…`, as Focus Features… shows it) | `pinnedRepo` (`rootRepo` for the root pin) | main worktree | its linked worktrees; `Collapsed` when it has any (VS Code then remembers the row's expansion by its `id`), else `None` |
| Worktree | `featureLabel(feature)` (branch, or `name (detached)`) | home-shortened path | `repoWorktree` | that worktree | none |
| Folder | `basename(path)` | home-shortened path | `pinnedFolder` (`rootFolder` for the root pin) | that folder | none |
| Missing | `basename(main)` | `not found` | `pinnedMissing` | none | none |

- **Repo or folder**: a pin is a repo when its own `git worktree list` lists it; otherwise
  (outside any repo, a folder inside a repo, git failing) it is a plain folder.
- **Missing**: the pinned path no longer exists. It stays pinned until unpinned.
- **The root pin**: `rootPin(first)`, what pin resolution makes of the window's first folder. Not
  stored, listed first, never unpinnable (its `contextValue` starts with `root`); a stored pin
  equal to it is not listed twice, and **Pin Folder…** doesn't store it.
- **The window's first folder** never changes (`planFolders` skips index 0). Its row has no
  checkbox and its description is `workspace root` instead of the path.
- Worktrees: `localWorktrees(git, main)` minus the main worktree itself, ordered as `listFeatures`
  orders them (named branches by label, detached last). Prunable worktrees whose path is gone are
  already dropped by `localWorktrees`.
- Checkbox state shows the **desired** state: open, unless toggled since the last apply.
- A row whose desired state differs from the current one gets ` • will open` / ` • will close`
  appended to its description.
- `tooltip`: the full path.

### Pending state

- In memory only: a `Map<path, boolean>` of toggles since the last Apply / Discard. A toggle back
  to the current state deletes the entry.
- `onDidChangeCheckboxState` records toggles (it delivers every changed item; handle all).
- Context key `devc-vscode.workspaceReposPending` (`setContext`) is `true` while the map is
  non-empty.
- On `onDidChangeWorkspaceFolders`, drop entries whose desired state now equals the current one,
  then refresh.

### Pinned storage

- `context.globalState`, key `devc-vscode.pinnedRepos`, value
  `Record<string, string[]>`: the realpath of the window's first folder → realpath'd pinned
  paths (repo main worktrees and plain folders), in pin order.
- **Why not `workspaceState`:** adding a second folder to a single-folder window turns it into an
  untitled multi-root workspace with a new identity (and restarts the extension host), so
  `workspaceState` would lose the pins on the first Apply. The first folder never changes, so it
  is a stable key.
- Pinning an already-pinned repo is a no-op. Writes go through `globalState.update`.

### Commands

| Command | Title | Where | Behaviour |
| --- | --- | --- | --- |
| `devc-vscode.pinRepo` | Pin Folder… | `view/title` `navigation@1`, icon `$(add)`; palette | `showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Pin' })`, default URI the first folder's parent. Each pick goes through pin resolution (below); failures are listed in one error message, successes are pinned. |
| `devc-vscode.applyWorkspaceRepos` | Apply | `view/title` `navigation@2`, icon `$(check)`, `when` `view == devc-vscode.workspaceRepos && devc-vscode.workspaceReposPending` | See Apply. |
| `devc-vscode.discardWorkspaceRepos` | Discard Changes | `view/title` `navigation@3`, icon `$(discard)`, same `when` | Clears the pending map, refreshes. |
| `devc-vscode.refreshWorkspaceRepos` | Refresh | `view/title` `navigation@4`, icon `$(refresh)` | Re-reads worktree lists; keeps pending toggles for paths still listed. |
| `devc-vscode.unpinRepo` | Unpin | `view/item/context` `inline` and context menu, icon `$(close)`, `when` `view == devc-vscode.workspaceRepos && viewItem =~ /^pinned/` | Removes it from the pinned list and drops its pending toggles. **Does not touch workspace folders**: its open folders stay open (and, no longer pinned, are no longer managed by Apply). |

In the palette, Apply and Discard need `devc-vscode.workspaceReposPending`; Unpin is never in
the palette.

### Pin resolution

`resolvePin(dir, git)` in `src/workspaceRepos.ts`, from `featureAt(realpath(dir), git)`:

- not a directory → error `<dir> is not a folder.`;
- the top of a repo or a linked worktree (`feature.path === realpath(dir)`) → pins `feature.main`;
- otherwise (outside any repo, a folder inside a repo, a bare repo) → pins `realpath(dir)` as a
  plain folder.

### Apply

1. Nothing pending → return.
2. `catalog` = every path the view lists with a checkbox (pinned folders, repos' main worktrees
   and their worktrees, minus missing pins and the first folder). `picked` = catalog paths whose desired state is open.
3. `applyFolderChange(openFolders(), planFolders(openFolders(), catalog, picked))`, unchanged.
   Folders outside the catalog (unpinned folders, the first folder) are never
   touched; that is `planFolders`' existing contract.
4. Clear the pending map (folders that failed to change show as such after the refresh, because
   rows show the real state again).
5. Source Control check: after the change, wait for the Git API (`gitApi()`) to report each
   picked repo or worktree path, not plain folders (compare `realpathOr(r.rootUri.fsPath)`), polling `api.repositories` every 250 ms
   for up to 3 s. If any are still missing, show a warning
   `Source Control has not opened: <basenames, comma-separated>.` with buttons
   **Reopen Closed Repositories** (`git.reopenClosedRepositories`) and **Reload Window**
   (`workbench.action.reloadWindow`). No automatic reload.

**Gotcha:** when the window has a single folder, the first added folder restarts the extension
host mid-Apply. `applyFolderChange` already does adds last for this reason; the Source Control
check (step 5) simply does not run in that case, which is acceptable.

### Refresh triggers

`onDidChangeWorkspaceFolders`, the refresh command, a pin or unpin, Apply / Discard, and the view
becoming visible (`onDidChangeVisibility` with `visible`). No file watchers on worktree folders.
Worktree lists are read with `featureGit()` and may run in parallel per repo.

## Concept boundaries

- **Focus Features…** stays as is: it offers repos found from workspace folders and container
  mounts; this view offers only what the user pinned. They act on the same workspace folders, so
  a Focus Features… change shows up here via `onDidChangeWorkspaceFolders`.
- **Pinning is per window root, not per workspace file.** Two `.code-workspace` files with the
  same first folder share pins. Accepted.
- **No container mounts** here. Pinned paths are host paths.

## Relevant Files

| File | Role |
| --- | --- |
| `src/workspaceRepos.ts` (new) | `resolvePin` and any other pure logic (row ordering, pending-map helpers); no `vscode` import. |
| `src/test/workspaceRepos.test.ts` (new) | Tests under plain mocha, with real git repos in a temp dir like `features.test.ts`. |
| `src/extension.ts` | The tree data provider, the view, the commands, Apply and the Source Control check, next to the `// ── Features` section, reusing `applyFolderChange`, `openFolders`, `featureGit`, `gitApi`, `realpathOr`. |
| `src/features.ts` | Exports `compareFeatures`. |
| `package.json` | `views.explorer` entry, five `commands`, `menus` (`view/title`, `view/item/context`, `commandPalette`). The `devc-vscode.featureFolders` description is unchanged. |
| `README.md` | A **Workspace Repos** subsection under "Focus on features". |
| `CHANGELOG.md` | An Unreleased entry. |
| `docs/how-it-works.md` | Pin storage (and why not `workspaceState`), the Source Control check. |
| `.plans/PLAN.md` | This plan's row. |

## Validation

- [x] `npm run compile` and `npm run lint` pass.
- [x] `npx mocha --ui tdd out/test/workspaceRepos.test.js` passes, covering `resolvePin` on: a
      main worktree (pins itself), a linked worktree (pins its main), a subfolder of a repo
      (pins itself), a non-repo folder (pins itself), a missing folder (error), a symlink to a
      repo (pins the realpath); `rootPin`; `readPinnedRepo` on a repo, a plain folder and a
      missing one.
- [x] `npx mocha --ui tdd out/test/features.test.js` still passes.
- [ ] In VS Code with `devc-vscode.featureFolders` off (the user; say plainly in the report that
      the agent could not run these): the view appears in the Explorer with the setting off;
      it lists the first folder (or its repo) first as *workspace root* with no checkbox and no
      Unpin; **Pin Folder…** on a plain folder lists it with a checkbox and no children;
      **Pin Folder…** on a repo with two worktrees shows the repo row
      and two worktree rows; ticking one worktree shows ` • will open` and the Apply button;
      **Apply** adds it as a workspace folder and its repo appears in Source Control; unticking
      it and applying removes the folder and its repo leaves Source Control; **Discard** restores
      the boxes; **Unpin** leaves folders as they are; pins survive a window reload and the
      single-folder → multi-root transition.

Commit in this repo's style, with the `Co-Authored-By` line.

## Implementation notes

- **`compareFeatures`** is now exported from `src/features.ts` (extracted from `listFeatures`, which uses it) so pinned repos and their worktrees sort as Focus Features… sorts them.
- **A pin is a repo** when `git worktree list` in it lists the pin itself: `localWorktrees` returns `[]` on failure, so its result alone can't tell.
- Changed with the user on 2026-10-23: the first folder is pinned automatically, plain folders can be pinned, and repo rows start collapsed. The welcome content went with the first change.
- **`tildePath`** in `src/extension.ts` replaces Focus Features…' inline home shortening; both use it.
- The in-VS Code validation was not run: `npm test` cannot start VS Code in this container (`libglib-2.0.so.0` missing), and there is no display for a manual check.
- After this plan was written the view was renamed **Workspace Folders** (ids unchanged: `devc-vscode.workspaceRepos`), and a linked worktree added as a workspace folder by any of these commands is named `project/folder` (`worktreeFolderName` in `src/features.ts`).
