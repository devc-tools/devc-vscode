# herdr-vscode: Pane Changes (changed since, git markers, remote labels, repo actions)

Mockup board C (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP), the parts the built Pane Context
view (phase 17) does not have yet:

- **Changed in This Pane · since 10:31**: what changed in the pane's worktree since a baseline taken when
  you first followed the pane, rather than the repo's whole `git status`, which moves to a collapsed
  **All Changes** section.
- **Git markers** (`M`, `A`, `U`, `D`, a dot on folders) on Files rows and on editors of the followed repo,
  for `herdr-container:` and `herdr-ssh:` files too.
- **Remote labels**: editor titles and hovers read `devc: deephaven-mcp › /workspaces/…` and
  `ssh: devbox › /home/…` instead of the raw URI.
- **Repo-row actions** **Open in Source Control** and **Terminal Here**, beside **Add to Workspace**.
- **Other Panes in This Space** says `same worktree` / `other worktree`.

The comment thread ("Ask agent") on board C is phase 21, not this plan.

Depends on [herdr-pane-context](herdr-pane-context.md) (phase 17: read its Contracts **and** its
"Deviations and decisions"; this plan changes only what it names). Paths are under `herdr-vscode/`.
`devc-vscode/` is never edited.

## Checklist

- [x] 1. Baseline snapshot in the environment (temporary index, never the user's), `since` diff, commit count
- [x] 2. Baseline store: recorded on first follow, persisted in `workspaceState`, pruned, moved on `pane.moved`;
      **Reset Baseline**
- [x] 3. Sections: **Changed in This Pane** (new, expanded) and **All Changes** (the old Changes, collapsed);
      `herdr-git` URIs take a tree revision; **Open Changes** on both
- [x] 4. `FileDecorationProvider` for the followed repo's status, yielding to VS Code's Git on repos it has open;
      since-letters on Changed in This Pane rows
- [x] 5. Container URIs carry `?{"label":…}`; `resourceLabelFormatters` for `herdr-container` and `herdr-ssh`
- [x] 6. Repo row: **Open in Source Control** (`file:` repos) and **Terminal Here** (this machine only)
- [x] 7. Other Panes rows: `same worktree` / `other worktree`
- [x] 8. Live measurement on throwaway `hv-test`: are pane ids reused (record under Implementation notes)
- [x] 9. Tests (list under Validation)
- [x] 10. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Baseline: what "changed in this pane" means

Git cannot say which process changed a file, so "changed in this pane" is **every change in the pane's
worktree since the pane's baseline, whoever made it**. Two agents in one worktree see each other's edits;
the README says so.

A baseline is `{ tree, head, at }`: the tree object of the whole working state (tracked and untracked,
not ignored), HEAD's full SHA (`""` in a repo with no commits) and the time (ms since epoch). It is keyed by
`<pane key>\n<toplevel>` (the pane key already holds the environment and session).

**When it is taken:** when the view loads a (pane, toplevel) that has no stored baseline: in practice the first
time you follow the pane in that repo, or after it `cd`s into another repo. Not on agent status changes: that would
mean snapshotting every pane of every session, followed or not. **Reset Baseline** takes a new one now.

**Snapshot** (one round trip, so one `ssh`/`docker exec` per poll). Run through the environment's
`RemoteShell.run` as argv `['sh', '-c', SNAPSHOT_SCRIPT, 'sh', <toplevel>]` (the toplevel travels as `$1`,
never inside the script), timeout 15 s, with exactly this script:

```sh
set -e
top=$1
d=$(mktemp -d "${TMPDIR:-/tmp}/herdr-vscode.XXXXXX")
trap 'rm -rf "$d"' EXIT
gi=$(git -C "$top" rev-parse --git-path index)
case $gi in /*) ;; *) gi=$top/$gi ;; esac
if [ -f "$gi" ]; then cp "$gi" "$d/index"; touch -r "$gi" "$d/index"; fi
GIT_INDEX_FILE=$d/index git -C "$top" add -A
GIT_INDEX_FILE=$d/index git -C "$top" write-tree
git -C "$top" rev-parse -q --verify HEAD || true
```

- stdout: line 1 the tree SHA (40 hex, or 64 in a SHA-256 repo), line 2 HEAD's SHA or empty. Parse with
  `/^([0-9a-f]{40,64})\n([0-9a-f]{40,64})?\n?$/`; anything else is a failure. Non-zero exit is a failure; its
  message is the first non-empty stderr line.
- `touch -r` was added during implementation (racily clean entries; see Implementation notes).
- Copying the real index first is what keeps it cheap: its stat cache is valid, so `add -A` hashes only files
  that changed. Starting from an empty index would hash the whole repo every poll.
- `rev-parse --git-path index` prints a path relative to `$top` in a plain repo (`.git/index`) and an
  absolute one in a linked worktree (`/repo/.git/worktrees/<name>/index`); the `case` handles both. A repo
  with no index yet (fresh `git init`) starts from none: `git` creates `$d/index`. Never pass `mktemp`'s own
  file as the index: an empty file is not a valid index ("index file smaller than expected").
- What this touches: blobs and trees written to `.git/objects` (unreferenced; `git gc` prunes them after
  `gc.pruneExpire`, two weeks by default) and a temp dir that the trap removes. The user's index, working tree,
  refs and stash are never touched. Clean filters (e.g. Git LFS) run on changed files, as on any `git add`.
- Verified on git 2.52 in a scratch repo: staged `M  a.txt` and untracked `u.txt` stayed exactly as they were in
  `git status` after a snapshot.

**Changed since** = `git -C <toplevel> diff-tree -r -z --no-renames --name-status <baseline tree> <current tree>`,
where the current tree comes from the same snapshot script. Output is NUL-separated pairs
`<status>\0<path>\0`; status `A`, `D`, `M`, or `T` (shown as `M`). Example, measured:
`M\0b.txt\0A\0new.txt\0D\0u.txt\0`. Committed changes are included automatically (the current tree is the
working state, which includes them). Skip the diff when the current tree equals the last one seen.

**Commits since** (display only): when the current HEAD differs from the baseline's,
`git -C <toplevel> rev-list --count <baseline head>..HEAD`, or `git -C <toplevel> rev-list --count HEAD` when the
baseline head is `""`. Non-zero exit (e.g. history rewritten and the old commit pruned) → omit the count.

**Lost baseline:** `diff-tree` exiting non-zero (the tree was pruned by `git gc`) → take a new baseline now,
log `pane context: baseline for <toplevel> was lost; recorded a new one`, and carry on.

**When it runs:** on every load and on the existing 5 s poll while the view is visible (after git status),
and on the existing debounced `FileSystemWatcher` reload for `file:` roots. One at a time, under the poll's
existing guard.

### Baseline store

- `context.workspaceState` key `herdr.paneContext.baselines`: an object
  `{ "<pane key>\n<toplevel>": { "tree": "<sha>", "head": "<sha or empty>", "at": <ms> } }`.
  Survives reloads.
- **Prune**, whenever the session model changes: drop entries older than 7 days; drop every entry of a pane
  whose session is **connected** and whose snapshot has no pane with that id (closed). Herdr pane ids look like
  `w2:p1` and are probably reused (Checklist 8 measures it): pruning on absence means a reused id starts fresh,
  as long as this window saw the pane go. A disconnected session prunes nothing.
- **`pane.moved`** (a cross-workspace move changes the pane id): move the pane's entries to the new key, as
  phase 17 moves the pin.
- **Reset Baseline**: `herdr.paneContext.resetBaseline`, title "Reset Baseline", icon `$(history)`, inline on
  the Changed in This Pane row; takes a new snapshot for the loaded (pane, toplevel), stores it, refreshes. Hidden
  from the Command Palette.

### Time label

`since HH:MM` (24-hour, local, zero-padded) when the baseline is from today (local date), else
`since <Mon> <D> HH:MM` with `Mon` from `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec` and `D` unpadded
(e.g. `since Oct 30 09:05`). No `Intl`/locale formatting: tests compare exact strings.

### Sections (changes to phase 17's view)

Top-level rows, in order: Repo row, **Changed in This Pane**, **All Changes**, **Files**,
**Other Panes in This Space**. Outside a repo: Repo row, Files, Other Panes, as now.

1. **Changed in This Pane** (group, `contextValue` `herdr.paneContext.since`, expanded; shown whenever the root
   is a repo). Description: the time label, then ` · <n> commit` / ` · <n> commits` when the count is > 0
   (e.g. `since 10:31 · 2 commits`). Rows, sorted by path:
   - label: file name; description: the directory relative to the toplevel (none at the top level);
     `resourceUri`: the file's URI **with fragment `herdr-since`** (see Decorations: this is what gives the row
     its since-letter instead of the git status badge); icon `ThemeIcon.File`;
     tooltip `<path in the environment> · <Added|Modified|Deleted> since HH:MM` (the time label without `since `).
   - click: opens the plain file URI (no fragment); a row deleted since the baseline opens the baseline's version
     (`herdr-git` URI with the baseline tree, below).
   - `contextValue` `herdr.paneContext.sinceChange`, inline **Open Changes**.
   - No changes: one row, label `No changes since HH:MM` (the time label's text), no icon, no command.
   - Snapshot failure: one warning row (phase 17's note row) `Could not record a baseline: <message>`.
2. **All Changes** (group, `contextValue` `herdr.paneContext.changes`, **collapsed**; omitted when nothing
   changed): phase 17's Changes section unchanged (rows, `<dir> · <XY>` descriptions, click, HEAD diff), renamed,
   with description `<n>` (the change count).

**Open Changes** (`herdr.paneContext.openChanges`) now also applies to `herdr.paneContext.sinceChange`: its
`when` becomes `view == herdr.paneContext && viewItem =~ /^herdr\.paneContext\.(change|sinceChange)$/`. On a
since row it opens `vscode.diff` of `herdr-git` at the baseline tree against the file, titled
`<file> (since HH:MM ↔ working tree)`; added since the baseline → empty left side (as for HEAD).

**`herdr-git` revisions:** the URI's query is now the revision: `HEAD` (as today) or a tree/commit SHA matching
`/^[0-9a-f]{40,64}$/`. The provider runs `git -C <toplevel> show <query>:<path>`; any other query returns `''`
without running anything (the query reaches argv, and any URI of this scheme reaches the provider). Fragment
unchanged (toplevel length).

### Git markers: `FileDecorationProvider`

One provider (`vscode.window.registerFileDecorationProvider`) for the **followed repo only**: the URIs of
phase 17's status changes (`environmentUri(env, <toplevel>/<path>, mounts)`) and the since rows' marked URIs.
Cleared when nothing is followed or the root is not a repo.

Status letter from porcelain `XY`, first rule that matches:

| `XY` | badge | tooltip | `color` (`ThemeColor`) |
| --- | --- | --- | --- |
| `DD` `AU` `UD` `UA` `DU` `AA` `UU` | `!` | Conflict | `gitDecoration.conflictingResourceForeground` |
| `??` | `U` | Untracked | `gitDecoration.untrackedResourceForeground` |
| either column `D` | `D` | Deleted | `gitDecoration.deletedResourceForeground` |
| either column `R` | `R` | Renamed | `gitDecoration.renamedResourceForeground` |
| either column `A` or `C` | `A` | Added | `gitDecoration.addedResourceForeground` |
| anything else (`M`, `T`) | `M` | Modified | `gitDecoration.modifiedResourceForeground` |

- Status decorations set `propagate: true`, so parent folders take the colour and VS Code's dot. Nothing
  decorates folders directly.
- An untracked directory record (`dir/`) decorates the directory URI, and any URI under it gets the same `U`
  decoration when asked.
- **Since rows** (fragment `herdr-since`): badge `A` / `M` / `D` with the added / modified / deleted colour,
  tooltip `Added since HH:MM` etc., `propagate: false`. Never yielded to Git (Git does not know the fragment).
- **Yield to VS Code's Git** for plain `file:` URIs (no fragment): no decoration when the built-in Git extension's
  API (`vscode.extensions.getExtension('vscode.git')`, `exports.getAPI(1)`) has a repository for the URI
  (`api.getRepository(uri) !== null`). Git decorates those itself, with the same letters and colours; ours would
  double them. Re-fire on `api.onDidOpenRepository`, `api.onDidCloseRepository` and `api.onDidChangeState`
  (before `state === 'initialized'`, `getRepository` returns `null` for everything). Git missing or disabled →
  decorate everything. Do not activate the Git extension for this; use it only if `isActive`, and re-check on
  `vscode.extensions.onDidChange`. Declare the API's few used members in a local interface; no new dependency.
- `herdr-container:` and `herdr-ssh:` URIs are always decorated.

**Gotchas:**

- **Fire `onDidChangeFileDecorations` with the explicit array of URIs** (old set ∪ new set) whenever the
  decorated set or a letter changes, never `undefined`. VS Code fetches a decoration only for URIs it has been
  asked about or told about; propagation to a **collapsed** folder needs the children's URIs to have been fired.
  `undefined` only refreshes what is already rendered, so collapsed folders would stay uncoloured.
- Decorations are by URI, globally: the same badge shows on an editor tab of that file and in any other view.
  Compare URIs by `toString()` (container URIs carry a JSON query, below).
- The `gitDecoration.*` colours are contributed by the built-in Git extension. With it disabled the badges still
  show but the colours resolve to the default foreground. Accepted.
- The Git extension matches `file:` URIs by exact `toString()`, so the `herdr-since` fragment keeps its badges
  off the since rows; that is intended (the row shows the since-letter, as on the mockup: `scopes.ts` is `A` in
  the section and `U` in Files).

### Remote labels: `resourceLabelFormatters`

Container URIs get the container's label in the query, since their authority is the 12-char id and a
formatter can only substitute `${scheme}`, `${authority}`, `${authoritySuffix}` (after a `+`), `${path}` and
`${query.<key>}` (the query parsed as JSON; checked in VS Code 1.144's `labelService`). Extensions cannot
register formatters at run time (`registerResourceLabelFormatter` is proposed API), so the label must be in the URI.

- `environmentUri` for an unmapped container path becomes
  `Uri.from({ scheme: 'herdr-container', authority: <id12>, path, query: JSON.stringify({ label: env.label }) })`
  (`env.label` is the container's folder name, `containerDisplayName`). Every producer already goes through
  `environmentUri` / `uriFor`, and `Uri.joinPath` keeps the query, so tree children, renames and link targets
  carry it too. The providers ignore the query; authority checks are unchanged. `herdr-ssh` URIs are unchanged.
- `package.json` `contributes.resourceLabelFormatters`, exactly:

```json
[
  { "scheme": "herdr-container", "formatting": { "label": "devc: ${query.label} › ${path}", "separator": "/" } },
  { "scheme": "herdr-ssh", "formatting": { "label": "ssh: ${authority} › ${path}", "separator": "/" } }
]
```

  Result: `devc: deephaven-mcp › /home/vscode/notes.md`, `ssh: devbox › /home/me/x.ts` in the window title,
  editor tab hover, tab description (for duplicate names), Open Editors and Quick Open.

**Gotchas:**

- **Breadcrumbs do not use formatters** for files outside a workspace folder: they show path segments
  (`home › vscode › notes.md`). The mockup's breadcrumb prefix is not reachable with public API; the title and
  hover carry it instead. The Manual check looks at the title and hover, not the breadcrumb.
- `separator` replaces **every** `/` in the formatted label, prefix included, so it stays `/`; the ` › ` is
  literal text in `label` and is not touched.
- A container editor restored from before this change has no query and reads `devc:  › /path`; reopening it from
  the view fixes it. Two URIs differing only in query are two documents, which is why every container URI must
  come from `environmentUri`.
- `Uri.toString()` lower-cases the authority, so an SSH editor restored from a string may read `ssh: devbox`
  for an alias `DevBox`. Accepted (phase 17 already looks hosts up ignoring case).
- `Uri.toString()` percent-encodes the JSON query (`%7B%22label%22…`); `uri.query` gives it back decoded.

### Repo-row actions

`rootContextValue` gains flags ` scm` (root is `file:` and a repo) and ` terminal` (the environment is this
machine, `env.kind === 'host'`). Inline order: Add to Workspace `@1`, Open in Source Control `@2`, Terminal Here
`@3`, Split Pane Here `@4`, Show Pane `@5`. Both new commands are hidden from the Command Palette.

- **Open in Source Control**: `herdr.paneContext.openSourceControl`, `$(source-control)`,
  `when: view == herdr.paneContext && viewItem =~ /^herdr\.paneContext\.root.* scm/`.
  1. Get `vscode.git`; activate it if needed (`await ext.activate()`); `getAPI(1)`. Missing, or
     `git.enabled` false → warning `herdr: VS Code's Git extension is not available.`
  2. `api.getRepository(root) ?? await api.openRepository(root)`. `null` → warning
     `herdr: VS Code's Git did not open <root path>. See Output › Git.`
  3. `vscode.commands.executeCommand('workbench.view.scm')`.

  Gotchas: Git opens a repo outside the workspace only for this window session (it is gone after a reload unless
  it is a workspace folder: that is what Add to Workspace is for). A bind-mounted repo owned by another uid trips
  Git's `safe.directory` check; Git shows its own notification and `openRepository` returns `null`. Git is off in an
  untrusted workspace. There is no public API to select one repo in the Source Control view; with several open,
  all are listed. Once open, VS Code's Git decorates its files and ours yields (above).
- **Terminal Here**: `herdr.paneContext.openTerminal`, title "Terminal Here", `$(terminal)`,
  `when: view == herdr.paneContext && viewItem =~ /^herdr\.paneContext\.root.* terminal/`.
  `vscode.window.createTerminal({ name: <root label>, cwd: <root path>, location: vscode.TerminalLocation.Editor })`
  and `show()`. **This machine only.** Decision: phase 15 removed Attach in Terminal because shells belong in the
  editor area as herdr panes; for a container or SSH root, **Split Pane Here** already gives a herdr pane in the
  root, in a tile, with agent detection and path links, so a second `docker exec`/`ssh` terminal would only be a
  shell herdr cannot see. On this machine VS Code's own terminal adds shell integration and `file:` links, and it
  opens in the editor area, matching that preference.

### Other Panes: same / other worktree

- For the followed pane's directory and each other pane's (`foreground_cwd ?? cwd`, same environment), run
  `git -C <dir> rev-parse --show-toplevel --git-common-dir`. Exit 0 → two lines: the toplevel (absolute), then
  the common dir, which may be relative to `<dir>` (`../.git` from a subdirectory, measured) → resolve with
  `path.posix.resolve(<dir>, line2)`. Non-zero → not comparable.
- Same toplevel → `same worktree`. Different toplevel, same common dir → `other worktree`. Otherwise (other repo,
  not a repo, either side failed) → no marker.
- Row description: `<marker> · <phase 17 description>`, or just the marker when that is empty; unchanged when there
  is no marker. Example: `same worktree · ✳ Refactoring auth`.
- Cached per `<env key>\n<dir>` until the next load or Refresh; computed when the section's children are asked
  for (it is collapsed by default), all panes in parallel, 15 s timeout each. Pane directories can be stale
  (herdr 0.9.5 sends no event for a `cd`); accepted.

## Validation

- [x] `cd herdr-vscode && npm run build && npm run lint && xvfb-run -a npm test` passes, with new or updated unit
      tests (real `git` in temp repos through `LocalShell`, as `git.test.ts` does) for:
  - [x] snapshot: parses tree and HEAD; the real index is untouched (`git ls-files -s --debug` output and
        `git status --porcelain=v1` identical before and after, with a staged change and an untracked file
        present); works in a linked worktree (absolute `--git-path`), in a repo with no commits (empty head) and
        in a fresh `git init` with no index; leaves no `herdr-vscode.*` dir in `$TMPDIR`; failure message is the
        first stderr line
  - [x] since: modify, add, delete an untracked-at-baseline file, and commit → exactly `M`, `A`, `D` rows
        sorted by path; `T` shows as `M`; commit count `1 commit` / `2 commits` / omitted; a pruned baseline
        (bogus tree SHA) records a new one
  - [x] time label: same day `since 09:05`; other day `since Oct 30 09:05` (fixed `now`)
  - [x] store (fake `Memento`): baseline taken once per (pane, toplevel) and reused after a new view is built on
        the same memento (reload); Reset Baseline replaces it; entries > 7 days dropped; a closed pane's entries
        dropped while its session is connected, kept while disconnected; `pane.moved` moves them
  - [x] sections: order and labels; Changed in This Pane description with and without commits; `No changes since …`
        row; warning row on snapshot failure; All Changes collapsed with description `<n>`; since-row
        `resourceUri` has fragment `herdr-since` and its command opens the plain URI
  - [x] `herdr-git`: `?<tree sha>` shows the baseline content; an invalid query (`--output=x`, `HEAD~1`) returns
        `''` without spawning
  - [x] decorations: the XY table, row by row; untracked dir and a child of it; since-row letters; a `file:` URI
        yields `undefined` when a fake Git API's `getRepository` returns a repo, and is decorated when it returns
        `null` or Git is absent; `herdr-container:` always decorated; a status change fires the explicit
        old ∪ new URI array (never `undefined`)
  - [x] container URIs: `environmentUri` gives `herdr-container://<id12><path>` with query `{"label":"<label>"}`;
        `Uri.joinPath` children keep it; providers still work with it (existing provider tests on a queried URI);
        `package.json` `resourceLabelFormatters` equals the JSON above
  - [x] repo row: `rootContextValue` flags (` scm` only for a `file:` repo, ` terminal` only on host); the `when`
        regexes match/not-match as data; **Terminal Here** creates a terminal whose `creationOptions` have the root
        `cwd` and name; **Open in Source Control** on a temp repo makes the built-in Git API's `getRepository` return
        it (the test host has `vscode.git`)
  - [x] other panes: same toplevel → `same worktree`; linked worktree → `other worktree`; other repo and non-repo →
        no marker; subdirectory relative common dir resolved; description format
- [x] With `HERDR_VSCODE_LIVE_HOME` on throwaway `hv-test` (as phase 17's `livePaneContext.test.ts`): following a
      pane in a temp repo records a baseline; a file written from the pane afterwards appears in Changed in This
      Pane within one poll; a file changed before following does not (it is in All Changes)
- [x] Checklist 8 result written under Implementation notes; `hv-test` stopped and deleted afterwards
- [x] `git diff --stat -- devc-vscode` is empty
- [ ] Manual: follow an agent pane, let it edit; **Changed in This Pane** lists only files changed since you
      first followed, heading `since HH:MM`; **Reset Baseline** empties it; reload the window and the time is kept
- [ ] Manual: Files shows `M` / `U` / `A` badges in Git colours on changed files of a container path outside the
      mounts (`herdr-container:`), and collapsed parent folders are coloured with a dot
- [ ] Manual: on a host repo that is a workspace folder, Files rows show one badge each (VS Code Git's), not two;
      on a host repo that is not, they show ours; after **Open in Source Control** they still show exactly one
- [ ] Manual: a `herdr-container:` editor's title bar and tab hover read `devc: <container> › /path`; a
      `herdr-ssh:` one `ssh: <alias> › /path`
- [ ] Manual: **Open in Source Control** on a host repo outside the workspace opens the Source Control view with
      it listed; **Terminal Here** opens a terminal editor tab in the repo root (host only; the action is absent
      for container and SSH roots)
- [ ] Manual: two panes in one worktree show `same worktree`; a pane in a linked worktree `other worktree`

## Relevant Files

- `herdr-vscode/package.json` (`resourceLabelFormatters`; commands `herdr.paneContext.resetBaseline`,
  `herdr.paneContext.openSourceControl`, `herdr.paneContext.openTerminal`; inline menus and reordered `@n`
  groups on the Repo row; Open Changes `when`; Command Palette hiding)
- `herdr-vscode/src/git.ts` (snapshot script, `diff-tree` / `rev-list` parsing, `rev-parse --show-toplevel
  --git-common-dir`, `herdr-git` revision query, XY → letter mapping)
- `herdr-vscode/src/baselines.ts` (new: the `workspaceState` store, pruning, moves, time label)
- `herdr-vscode/src/decorations.ts` (new: the `FileDecorationProvider` and the Git extension API interface)
- `herdr-vscode/src/paneContext.ts` (sections, rows, Reset Baseline, repo-row flags and actions, other-pane markers,
  feeding decorations)
- `herdr-vscode/src/paths.ts` (`environmentUri` container query)
- `herdr-vscode/src/remoteFs.ts` (only if a provider path assumes no query; comment on the URI shape)
- `herdr-vscode/src/extension.ts` (register the decoration provider, pass `workspaceState`, new commands)
- `herdr-vscode/src/test/git.test.ts`, `src/test/paneContext.test.ts`, `src/test/paths.test.ts`,
  `src/test/remoteFs.test.ts`, `src/test/livePaneContext.test.ts`, new `src/test/baselines.test.ts` and
  `src/test/decorations.test.ts`
- `herdr-vscode/README.md` (Pane Context section: the two change sections and what "in this pane" means, markers,
  labels, new actions, the files table's URI shape)
- `herdr-vscode/CHANGELOG.md`
- `herdr-vscode/docs/how-it-works.md` (Pane Context › Git: the snapshot script and why a temp index; baselines;
  decorations and yielding to Git; Paths: the container query)
- `.plans/PLAN.md`

## Implementation notes

### Status (2026-10-31)

Implemented. Everything but the six Manual items was run and passes; those need a person in a VS Code window (and a
dev container or SSH host for two of them), so they stay unticked and the plan stays out of `implemented/`. No Docker and
no SSH host here: container and SSH URIs, labels and markers have unit tests only.

### Measured (herdr 0.9.5, throwaway `hv-test` in an isolated `HOME` under `/tmp/hvt`)

- **Pane ids (Checklist 8).** While a server runs, ids are never reused: closing `w1:p2` then splitting gave `w1:p4`;
  closing the highest pane `w1:p4` then splitting gave `w1:p5`; closing workspace `w2` (the highest) then creating one gave
  `w3`. Across a **server restart** (workspaces restored from `session.json`), the per-workspace pane counter is kept
  (`w3` had `p1` left, the next split was `w3:p4`) but the **workspace counter restarts at the highest restored one + 1**:
  with `w4`, `w5` closed and only `w3` left, the next workspace after the restart was `w4` again, so `w4:p1` came back.
  Pruning on absence (a connected session whose snapshot lacks the pane) covers it when this window saw the pane go; a pane
  that closed while no window watched, followed by a restart and a new workspace, could inherit an old baseline (until
  7 days, or **Reset Baseline**). Accepted, as the plan expected.
- Live, from `src/test/livePaneContext.test.ts`: following a pane in a temp repo recorded a baseline (HEAD's SHA, `No changes
  since HH:MM`), with the change made before following only in All Changes; a file written from the pane by `printf` showed in
  Changed in This Pane (`A`) after 25–666 ms (the host root's `FileSystemWatcher` reload beats the 5 s poll).
- **Racily clean entries (deviation, found live).** One live run showed `middleware.ts`, edited *before* following, as changed
  since. The suite commits and then rewrites that file with content of the same size in the same second, so the real index
  entry is "racily clean"; git checks such an entry's content only when its mtime is not older than the **index file's**
  mtime, and `cp` gave the copy a fresh mtime, so `add -A` trusted the stale stat and the baseline recorded HEAD's content.
  Reproduced in a scratch repo (`core.trustctime=false`, mtimes set to one second): the plan's script records `aaaa`, the fixed
  one `bbbb`. Fix: `cp "$gi" "$d/index"; touch -r "$gi" "$d/index"` (POSIX, BusyBox has it), with a unit test for it.
  Every other line of the script is as written.

### Verified

- `npm run build && npm run lint && xvfb-run -a npm test`: 271 passing, 50 pending (opt-in live suites); before this phase
  238 / 48. No dependencies added. `git diff --stat -- devc-vscode` empty.
- New unit tests: `git.test.ts` (snapshot: index and status byte-identical before and after with a staged change and an
  untracked file, linked worktree, no commits, no index, no `herdr-vscode.*` left in a private `TMPDIR`, failure message, racy
  entry; since: `M`/`A`/`D` by path, `T`→`M`, commit counts, pruned tree; `herdr-git` at a tree and invalid queries spawning
  nothing; worktree ids and markers; the XY table), `baselines.test.ts` (time labels with a fixed `now`, store, prune, move),
  `decorations.test.ts` (table, untracked dir and children, since letters, yielding to a fake Git API and re-firing on its events,
  old ∪ new URI arrays), `paneContext.test.ts` (sections and labels, descriptions with commits, `No changes since`, warning row,
  All Changes collapsed, since-row URIs and commands, reload on the same memento, Reset Baseline, lost baseline logged, `pane.moved`
  and close pruning through the view, Open Changes title, Terminal Here's `creationOptions`, Open in Source Control making the
  **real** `vscode.git` API's `getRepository` return the temp repo, other-pane markers with a real linked worktree, the `when`
  regexes, inline order and Command Palette hiding), `paths.test.ts` (container query, `joinPath`, the formatters JSON) and
  `remoteFs.test.ts` (every provider test now on a URI with the label query).
- Live (`HERDR_VSCODE_LIVE_HOME=/tmp/hvt`), four full runs and three of the Pane Context suite alone: after the `touch -r` fix,
  two full runs 316 and 314 passing, 4 pending, and 16/16 three times alone. Every full run fails the pre-existing `live model … lists
  only the isolated session` (the home lists `default` and `hv-ctl`). Intermittent: `liveTiles` "tile headers follow the model"
  (known flaky) and, once, `livePaneContext` "a pinned pane follows a real move to another workspace" (timed out waiting for the
  new key; it passed in the other five runs that reached it, including all three alone, and the pin code path is unchanged apart
  from also moving baselines first). `hv-test` and `hv-ctl` were stopped and deleted and `/tmp/hvt` removed.
- Not run: anything in a real VS Code window (badges and colours as rendered, folder dots, one badge vs two on a workspace repo,
  editor titles and hovers with the labels, the inline icons, the Source Control view listing the repo, the terminal editor tab).

### Deviations and decisions

- `touch -r` in the snapshot script (above).
- Snapshots run through one queue per view (load, poll, Reset Baseline), so two loads of the same (pane, toplevel) never both take
  a first baseline. The plan's "under the poll's existing guard" alone would not cover loads.
- A failed snapshot shows the warning row even when a baseline exists (a poll that fails later), and Changed in This Pane then
  has no description; markers for since rows are dropped while it fails.
- The commit count is re-read only when HEAD changed since the last poll.
- `herdr-git` URIs keep `parseGitHeadUri` (now for any revision; the revision is `uri.query`); `gitRevisionUri` makes them,
  `gitHeadUri` is `gitRevisionUri(…, 'HEAD')`. The provider class keeps its name `GitHeadContentProvider`.
- `environmentUri` and `EnvironmentPaths.uriFor` now need the environment's `label` (type `UriEnvironment`).
- `rootContextValue` flags are in the order ` addable showable scm terminal`; the `when` regexes do not depend on the order.
- `PaneDecorations` is one provider for the window, fed by the view (`decorations.set`), cleared when nothing is followed, the root
  is not a repo, or the view is disposed. Since-row decorations carry the tooltip `Added since HH:MM`.
- **Open in Source Control** says `herdr: VS Code's Git did not open <fsPath>. See Output › Git.` with the host path (`rootUri.fsPath`).
- Other Panes' markers are computed in `getChildren` for the section (awaited, so the rows come with their markers), cached per
  `<env key>\n<dir>` and cleared on every load (which a host root's watcher triggers often) and on Refresh.
- Dragging a Changed in This Pane row onto an editor group (phase 18's tree drag) carries its `resourceUri`, which has the
  `#herdr-since` fragment; not checked in a window whether that opens a separate document from the plain file.

### For later phases

- Phase 21 (Ask Agent): the followed pane's repo is `loaded.toplevel` in `PaneContextView`; `herdr-git` URIs now take any
  `HEAD`/SHA revision through `gitRevisionUri`, and any query outside `/^(?:HEAD|[0-9a-f]{40,64})$/` gives `''` with nothing run.
  Container URIs from `environmentUri` carry `?{"label":…}`: compare URIs by `toString()` and build container URIs only through
  `environmentUri` / `EnvironmentPaths.uriFor`, or the same file opens as two documents. Comment threads on a since row's URI
  would have its `#herdr-since` fragment; use the plain URI (`SinceNode.fileUri`).
- Phases 22/23: nothing here touches tiles, mirroring or the Spaces/Agents rows. herdr workspace ids come back after a server restart
  (above), so anything keyed by pane id across restarts should prune on absence too.
