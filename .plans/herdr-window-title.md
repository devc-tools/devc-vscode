# herdr-vscode: window title from the active editor tab's repo

Decided by the user on 2026-11-03:

1. herdr-vscode gets a window-title feature like devc-vscode's `devc-vscode.windowTitle`, and owns it alone
   (workspace-folders-vscode does not touch `window.title`).
2. The title follows the **active editor tab**, not herdr's own focus:
   - a herdr **space tab** → the repo or worktree of that tab's active pane (the pane's directory, in the pane's
     environment);
   - any **other editor tab with a file** → the nearest repo or worktree holding the file.

What devc-vscode does today (for reference, not to be changed): it polls `herdr api snapshot` in each dev
container, takes herdr's `focused_pane_id`, maps its cwd to a host path through bind mounts and runs host git
there. This plan instead runs git in the pane's own environment (host, container or SSH), so a container pane works
without a bind mount, and drives the title from VS Code's active tab.

Depends on phase 26 (space tabs). Paths are under `extensions/herdr-vscode/` unless they start with `.plans/`.

## Checklist

- [x] 1. Setting `herdr.windowTitle` in `package.json` (Contracts → Setting)
- [x] 2. `src/windowTitle.ts`: pure helpers — template expansion, pane title rule, repo parsing, tab → source
- [x] 3. Repo lookup in an environment: `readRepo(shell, dir)` in `src/git.ts` (Contracts → Repo lookup)
- [x] 4. `MirrorPanel` exposes its active pane; `TilesPanels` exposes the active space panel (Contracts → Source)
- [x] 5. Window title controller in `src/windowTitle.ts`: triggers, debounce, refresh, write / restore of
      `window.title` (Contracts → Writing the title)
- [x] 6. Wire the controller in `src/extension.ts`
- [x] 7. Tests (Validation)
- [x] 8. README (new **Window title** section + settings table row), CHANGELOG, `docs/how-it-works.md`

## Contracts

### Setting

`herdr.windowTitle`, in `contributes.configuration`:

```json
"herdr.windowTitle": {
  "type": ["string", "null"],
  "default": null,
  "scope": "window",
  "markdownDescription": "The window title while the active editor tab is in a Git repo or worktree: a herdr space tab's active pane's folder, or any other tab's file. `${branch}` is its branch (the folder name for a detached HEAD), `${project}` the repo's folder name, `${folder}` the worktree's folder name, `${space}` the herdr space's label and `${title}` the title the pane's program sets (what an agent is doing), empty when it only repeats the pane's name or folder; `${space}` and `${title}` are empty for a file. Put `${separator}` around them so the separator is dropped while they are empty. Anything else, such as `${rootNameShort}`, is one of `#window.title#`'s own variables. Applies only to a saved `.code-workspace`, whose `window.title` setting is rewritten as the active tab changes. Off (`null`) by default; set it, for example to `${branch} (${rootNameShort})`, to turn it on."
}
```

`null`, missing, or blank after trim = off.

### Template expansion

`expandTitle(template, repo, space?, title?)` — same rules as devc-vscode's `expandTitle` (`extensions/devc-vscode/src/features.ts`):

| Variable | Value |
| --- | --- |
| `${project}` | `basename(main)` |
| `${branch}` | the branch; `basename(toplevel)` when HEAD is detached |
| `${folder}` | `basename(toplevel)` |
| `${space}` | the space's `label` (pane source); `''` otherwise |
| `${title}` | the pane title (rule below); `''` otherwise |

- Match `/\$\{(\w+)\}/g`; any name not in the table is left exactly as written (VS Code expands it).
- Every `$` inside a filled-in value becomes `＄` (U+FF04): VS Code treats any `$` in `window.title` as the start of a
  variable and drops what follows.
- The result is trimmed. An empty result means "no title" (restore).
- Basenames use `path.posix.basename` (environment paths are POSIX; host paths on this project's platforms too).

### Pane title rule (`${title}`)

From the `SnapshotPane`, as devc-vscode's `focusTitle` (`extensions/devc-vscode/src/herdr.ts:187`):

- `title = trim(terminal_title_stripped)`; folders = `[basename(cwd), basename(foreground_cwd)]` (`''` when missing);
  `name = trim(label) || folders[1] || folders[0]`.
- Empty (`''`) when: `title` empty, or `name` empty, or `title === name`, or the pane has no `agent`
  (`!hasAgent(pane)`) and `folders` includes `title`.
- Otherwise `title`.

### Repo lookup (`readRepo(shell, dir)` in `src/git.ts`)

Run in the source's environment shell, 15 s timeout like the other git helpers:

1. `git -C <dir> rev-parse --path-format=absolute --show-toplevel --git-common-dir`
   - exit ≠ 0, or either of the two stdout lines empty → not in a repo (`undefined`).
   - Line 1 = `toplevel`, line 2 = `common` (strip a trailing `\r`).
2. `main = basename(common) === '.git' ? dirname(common) : toplevel` (POSIX `path.posix`).
3. `git -C <toplevel> symbolic-ref --short -q HEAD` → exit 0 and non-empty trimmed stdout = `branch`; otherwise
   detached (`branch` undefined).

Returns `{ toplevel, main, branch? }`. Git ≥ 2.31 is needed for `--path-format`; an older git exits ≠ 0, which reads
as "not in a repo" — acceptable. A shell `run` that throws (container gone, ssh down) also reads as "not in a repo".

### Source: what the active editor tab points at

`tab = vscode.window.tabGroups.activeTabGroup.activeTab`, then the first rule that applies:

1. **herdr space tab.** The `MirrorPanel` (from `TilesPanels`) whose `panel.active` is `true` and whose
   `panel.viewColumn === vscode.window.tabGroups.activeTabGroup.viewColumn`. Do **not** match on
   `TabInputWebview.viewType`: VS Code reports it as `mainThreadWebview-herdr.tiles`, not `herdr.tiles`.
   - Its active pane = the panel's focused tile if still shown, else herdr's focused pane if shown in the panel,
     else the first shown pane (today's private `actionPane()` order — expose it).
   - No active pane (space empty, not connected yet) → **keep** the current title.
   - Source = `{ env: connection(sessionKey).env, dir: pane.foreground_cwd ?? pane.cwd, space: label of the pane's
     workspace, title: pane title rule }`. No dir → **restore**.
2. **Tab with a file URI.** `uri` = `TabInputText.uri`, `TabInputTextDiff.modified`, `TabInputCustom.uri`,
   `TabInputNotebook.uri` or `TabInputNotebookDiff.modified`. `dir = posix dirname` of the environment path:

   | `uri.scheme` | Environment | Path |
   | --- | --- | --- |
   | `file`, `git` | this machine (`LocalShell`) | `uri.path` (`uri.fsPath` for `file`) |
   | `herdr-container` | `environments.find(containerKey(uri.authority))` | `uri.path` |
   | `herdr-ssh` | `environments.find(sshKey(uri.authority))` | `uri.path` |
   | `herdr-git` | `environments.find(parseGitHeadUri(uri).envKey)` | `${toplevel}/${file}` |

   Any other scheme (`untitled`, `vscode-userdata`, `output`, …) → **keep**. Environment not found → **keep**.
   `space` and `title` are `''`.
3. **Anything else** (no tab, Settings, extension page, terminal in the editor area, another extension's webview)
   → **keep** the current title.

Outcomes: **keep** = leave `window.title` as it is; **restore** = the "no title" path below; otherwise expand
the template with `readRepo(env.shell, dir)` — `undefined` from `readRepo` → **restore**.

The integrated terminal panel, herdr's own focus and the Active Pane view's followed pane play no part.

### Writing the title

Mirror devc-vscode's `updateTitle` (`extensions/devc-vscode/src/extension.ts:1676`), with herdr-vscode's keys:

- Workspace-state keys: `herdr.windowTitle.written` (string: what this extension last wrote) and
  `herdr.windowTitle.original` (`{ value?: string }`: the workspace's own `window.title`, `{}` when unset).
- Only when `vscode.workspace.workspaceFile?.scheme === 'file'` (a saved `.code-workspace`). Otherwise the
  feature does nothing (it never writes a folder's `.vscode/settings.json`).
- Each run: `current = getConfiguration('window').inspect<string>('title')?.workspaceValue`. If
  `current !== written`, the user changed it: store `{ value: current }` as the original.
- Title non-empty: store it as `written`; if it differs from `current`, `update('title', title, Workspace)`.
- No title (restore, or the setting turned off): if `written` is set, and `current === written`, write the
  original back (`undefined` removes the key); then clear `written`.
- **keep** returns before any of this.
- Runs are serialised by a run counter: a run whose counter is stale after its awaits does not write.

Triggers, all through one 300 ms debounce:

- `tabGroups.onDidChangeTabs`, `tabGroups.onDidChangeTabGroups`
- `FocusTracker.onDidReportFocus` (a tile clicked in a space tab)
- `TilesPanels.onDidChangeTiles`
- `SessionModel.onDidChange` (cwd, label and terminal-title changes arrive in snapshots) — the run compares and
  writes only on a change, so a busy snapshot stream does not rewrite the file
- `onDidChangeConfiguration` for `herdr.windowTitle` or `window.title`
- every 15 s while the setting is on: re-run (catches `git switch` in the same folder); for a pane source it first
  asks `pane.get` for the pane's directory, as `PaneContextView.checkDirectory` does, because herdr 0.9.5 sends no
  event for a `cd`
- 5 s after activation: one run, so a title left by the last window session is dropped when no source has a repo

## Validation

- [x] `cd extensions/herdr-vscode && npm run compile && npm run lint` succeed
- [x] `cd extensions/herdr-vscode && npm run bundle` succeeds (if the installed esbuild binary is for another
      platform, use `ESBUILD_BINARY_PATH=<linux esbuild>` from a scratch install; do not change `node_modules`)
- [x] `cd extensions/herdr-vscode && xvfb-run -a npx vscode-test` passes, including new tests in
      `src/test/windowTitle.test.ts`:
  - [x] `expandTitle`: each variable; unknown `${rootNameShort}` kept; `$` in a branch becomes `＄`; detached →
        folder name; blank template → `''`
  - [x] pane title rule: equal to label → `''`; equal to folder basename without agent → `''`; same with
        `agent: "claude"` → the title; distinct title → the title; whitespace-only → `''`
  - [x] `readRepo` with a fake shell: main worktree (`…/repo/.git` → main `…/repo`); linked worktree
        (`…/repo/.git` common, toplevel `…/wt` → main `…/repo`, folder `wt`); detached (symbolic-ref exit 1 →
        no branch); rev-parse exit 128 → `undefined`; `run` throwing → `undefined`
  - [x] tab → source: `TabInputText` `file:`, `TabInputTextDiff` uses `modified`, `herdr-container` / `herdr-ssh` /
        `herdr-git` pick the right environment, `untitled:` → keep, unknown environment → keep
  - [x] controller with a fake config / workspace state: writes the expanded title; a user edit of `window.title`
        becomes the original and is restored on "no title"; setting `null` restores; not a saved workspace →
        no write; **keep** leaves `window.title` untouched
  - [x] `package.json` has `herdr.windowTitle` with type `["string","null"]`, default `null`, scope `window`
- [x] Real git (a test in `windowTitle.test.ts`): `readRepo(new LocalShell(), <repo>/extensions)` gives the same
      toplevel as `git rev-parse --show-toplevel`, `main` = that toplevel (a main worktree) and the same branch as
      `git symbolic-ref --short -q HEAD`
- [ ] Manual (left to the user, record under Implementation notes), in a saved `.code-workspace` with
      `"herdr.windowTitle": "${project}:${branch}${separator}${title}"`:
  - [ ] clicking a tile in a space tab whose pane is in a worktree shows that worktree's branch
  - [ ] switching to a text editor of a file in another repo shows that repo's branch; a file in no repo restores the
        own title
  - [ ] switching to the Settings editor leaves the title as it was
  - [ ] `git switch` in the focused pane shows the new branch within ~15 s
  - [ ] setting `null` restores the workspace's own `window.title`

## Implementation notes

- 2026-11-03: compile, lint, bundle (scratch `@esbuild/linux-arm64@0.28.2` via `ESBUILD_BINARY_PATH`; `node_modules`
  has the darwin binary) and `xvfb-run -a npx vscode-test` (356 passing, 59 pending live suites; 30 new) pass.
- Manual checks not yet run.

## Relevant Files

- `extensions/herdr-vscode/package.json` (`herdr.windowTitle`)
- `extensions/herdr-vscode/src/windowTitle.ts` (new: helpers and controller)
- `extensions/herdr-vscode/src/git.ts` (`readRepo`)
- `extensions/herdr-vscode/src/tilesPanel.ts` (expose the active pane of a `MirrorPanel`, the active space panel)
- `extensions/herdr-vscode/src/extension.ts` (wiring)
- `extensions/herdr-vscode/src/test/windowTitle.test.ts` (new)
- `extensions/herdr-vscode/README.md` (Window title section, settings table)
- `extensions/herdr-vscode/CHANGELOG.md`
- `extensions/herdr-vscode/docs/how-it-works.md`
- `.plans/PLAN.md`
