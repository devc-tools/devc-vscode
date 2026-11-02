# herdr-vscode: Active Pane changes by commit, with a this-pane filter

Decided by the user on 2026-11-02, after using phase 20's **Changed in This Pane**:

1. The baseline section goes. It listed more files than **All Changes** (committed work stayed in it,
   untracked folders were expanded), its start time was arbitrary, and its name promised per-pane
   attribution git cannot give.
2. Changes are shown **per commit**: an **Uncommitted** section, then **Commits**, each commit expandable
   to its files.
3. A view toggle switches every change section between **all files** and **files this pane touched**.

"Touched by this pane" is defined here as: files that changed in the pane's worktree while the pane's agent was
`working`. It is recorded by snapshotting the worktree when an agent starts and stops working. **Nothing is written
to the repo's `.git`** (user decision, 2026-11-02): snapshots go to a temporary object directory outside the repo
(see Span snapshots), unlike phase 20's, which wrote unreferenced objects into `.git/objects`. Two agents working in one worktree at the same time still see each other's
files; that limitation is documented, not solved. Phase 20 rejected snapshotting on status changes because it
"would snapshot every pane of every session"; that was for polling a moving baseline. Here it is two snapshots per
working span, each a stat-only `git add -A` into a copied index, which is cheap enough.

Depends on phases 20 and 27 ([herdr-pane-identity](herdr-pane-identity.md): the pane row sits above these sections).
Paths are under `herdr-vscode/` unless they start with `.plans/`.

## Checklist

- [ ] 1. Remove Changed in This Pane: the section, `src/baselines.ts`, **Reset Baseline**, the since-decorations,
      `countCommits`; clear the old `herdr.paneContext.baselines` workspaceState key on activation
- [ ] 2. Rename **All Changes** to **Uncommitted**, expanded by default
- [ ] 3. **Commits** section: base detection, `git log` parse, commit rows, lazily loaded file rows, diffs
- [ ] 4. Touched-files recorder over every agent pane of every connected session; `TouchedStore` (persisted,
      pruned, moved on `pane.moved`)
- [ ] 5. Title toggle **Show Only This Pane's Files** / **Show All Files** and its filtering of Uncommitted and Commits
- [ ] 6. Tests (Validation)
- [ ] 7. README, CHANGELOG, `docs/how-it-works.md` (replace "Baselines: changed in this pane")

## Contracts

### Top-level rows of Active Pane (a repo)

`pane` (phase 27), repo, **Uncommitted**, **Commits**, **Files**, in that order. Outside a repo: pane, directory
row, **Files**. Uncommitted is shown only when `git status` lists something (or, in pane mode, as below); Commits
only when HEAD exists.

### Uncommitted

Today's All Changes rows unchanged (`git status --porcelain=v1`, `xy` letters, untracked directories as one row), group
id suffix `changes`, label `Uncommitted`, **expanded** by default, description = row count (`3 of 12` in pane mode).
Click: `HEAD ↔ working tree` diff (`herdr.paneContext.openChanges`); inline **Open File** (unchanged from the
2026-11-02 fixes).

### Commits

**Base**, resolved once per load:

1. `git -C <top> rev-parse --abbrev-ref origin/HEAD` → e.g. `origin/main` (exit ≠ 0: none).
2. Else the first of `main`, `master` for which `git -C <top> rev-parse -q --verify refs/heads/<name>` succeeds.
3. `mb = git -C <top> merge-base HEAD <base>`.

**Range**: if a base exists and `mb` ≠ `git rev-parse HEAD`, the range is `<mb>..HEAD` and the group description is
`vs <base>` (e.g. `vs origin/main`). Otherwise the range is `HEAD` and the description is `recent`. Either way at
most **20** commits:

```
git -C <top> log -z -n 20 --format=%H%x1f%P%x1f%an%x1f%at%x1f%B <range>
```

Records are split on `\0`; fields on `\x1f` (`%B` last, may contain newlines). `%P` is space-separated parents
(empty for a root commit). `%at` is Unix seconds. A record with fewer than five fields or a non-40/64-hex `%H` is
skipped.

**Commit row**: collapsed; id `<root uri>|commit|<sha>`; label = first line of `%B` (trimmed; `(no message)` if
empty); description = `<sha first 7> · <time>`, time formatted like phase 20's `baselineTime` (`HH:MM` today, else
`Mon D HH:MM`; move that helper into `src/git.ts`); tooltip = `<full sha>\n<author> · <ISO 8601 local date>\n\n<%B
trimmed>`; icon `new ThemeIcon('git-commit')`; contextValue `herdr.paneContext.commit`.

**Commit files**, loaded on expand and cached by SHA for the view's lifetime:

- with parents: `git -C <top> diff-tree -r -z --no-renames --name-status <first parent> <sha>`
- root: `git -C <top> diff-tree -r -z --no-renames --name-status --root <sha>`

parsed with `parseDiffTree` (`T` shown as `M`). Rows: label basename, description `<dir> · <A|M|D>` (just the letter
at the top level), icon `ThemeIcon.File`, no `resourceUri` (the working tree's git decoration would mislead),
contextValue `herdr.paneContext.commitFile`.

- **Click** (`herdr.paneContext.openChanges`): `vscode.diff(left, right, "<name> (<sha7>)")` with
  `left = gitRevisionUri(env, top, path, <first parent>)` (the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`
  for a root commit; the provider returns `''` for a missing path) and `right = gitRevisionUri(env, top, path,
  <sha>)`. Status `D`: `vscode.open(left)`.
- **Open File** (inline, `herdr.paneContext.openFile`): the working tree file when `vscode.workspace.fs.stat`
  succeeds on it, else `gitRevisionUri(…, <sha>)` (`<first parent>` for `D`).

`gitRevisionUri`'s `REVISION` regex already accepts full SHAs; parents and the empty tree are full SHAs.

### Span snapshots (nothing in `.git`)

Each working span gets its own temporary directory in the pane's environment, created at span start with
`mktemp -d "${TMPDIR:-/tmp}/herdr-vscode-span.XXXXXX"` and removed (`rm -rf`) at span end, after the diff, whether it
succeeded or not. Every git command of a span runs with:

```
GIT_INDEX_FILE=<span dir>/index
GIT_OBJECT_DIRECTORY=<span dir>/objects
GIT_ALTERNATE_OBJECT_DIRECTORIES=<the repo's real objects dir>
git -c core.fsmonitor=false -C <toplevel> …
```

so new blobs and trees are written to the span directory and existing ones are read from the repo. The real objects
dir is `git -C <top> rev-parse --git-path objects` made absolute (relative in a plain repo, absolute in a linked
worktree). The snapshot script (replaces `SNAPSHOT_SCRIPT`; `sh -c <script> sh <toplevel> <span dir>`):

```sh
set -e
top=$1; d=$2
mkdir -p "$d/objects"
o=$(git -C "$top" rev-parse --git-path objects); case $o in /*) ;; *) o=$top/$o ;; esac
gi=$(git -C "$top" rev-parse --git-path index); case $gi in /*) ;; *) gi=$top/$gi ;; esac
if [ ! -f "$d/index" ] && [ -f "$gi" ]; then cp "$gi" "$d/index"; touch -r "$gi" "$d/index"; fi
export GIT_INDEX_FILE="$d/index" GIT_OBJECT_DIRECTORY="$d/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"
git -c core.fsmonitor=false -C "$top" add -A
git -c core.fsmonitor=false -C "$top" write-tree
```

It prints the tree SHA. The index is copied from the real one only at span start (the `[ ! -f ]` guard), with
`touch -r` for the racy-clean reason phase 20 documents; the end snapshot reuses the span's index. The diff runs with
the same three variables: `git -C <top> diff-tree -r -z --no-renames --name-status <start> <end>`.

Measured 2026-11-02 in a scratch repo: start snapshot, then modify / add / delete files, end snapshot → `M`, `A`, `D`
for exactly those files; a file already modified before the span was not reported; `.git/objects` file count unchanged.

Leftover span directories (window closed or reloaded mid-span): when the recorder first runs a command in an
environment it runs `find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'herdr-vscode-span.*' -mmin +1440 -exec rm -rf {} +`.

### This pane's files

**Toggle**: commands `herdr.paneContext.showPaneFiles` (title "Show Only This Pane's Files", icon `$(filter)`) and
`herdr.paneContext.showAllFiles` (title "Show All Files", icon `$(filter-filled)`), in `view/title` `navigation`
for `view == herdr.paneContext` with `!herdr.paneContext.paneFilesOnly` / `herdr.paneContext.paneFilesOnly`
respectively; both hidden from the command palette. The mode is stored in workspaceState key
`herdr.paneContext.paneFilesOnly` (boolean, default `false`) and mirrored to that context key. It applies to
whichever pane is followed.

**Recording** (new `src/touched.ts`, created in `extension.ts`, independent of whether Active Pane is visible):

- For every pane with `hasAgent` in every connected session, watch `raw_status` on each snapshot change.
- **Span start**: a pane seen `working` with no open span (a transition into `working`, or first sight while
  `working`, which includes after a reload). Resolve the pane's toplevel from `foreground_cwd ?? cwd` with
  `readToplevel` (cache per `<env key>\n<dir>`); not a repo: nothing. Create the span directory and take the start
  snapshot (Span snapshots); keep `{paneKey, envKey, toplevel, spanDir, tree}` in memory.
- **Span end**: the pane's `raw_status` is anything but `working`, or the pane left the snapshot. Take the end snapshot,
  diff it against the start (both in the span directory), add every path to the pane's touched set for that
  toplevel, remove the span directory. A failed snapshot or diff drops the span (log one line; the directory is
  still removed).
- At most one snapshot runs per `<env key>\n<toplevel>` at a time (a queue per toplevel); a span's end waits for its
  start.
- Spans are not persisted: a reload mid-span loses the files changed before the reload.

**`TouchedStore`**: workspaceState key `herdr.paneContext.touched`, value
`{ "<pane key>\n<toplevel>": { "paths": string[] (sorted, unique), "at": <ms of last update> } }`. Pruned on
activation and on session snapshot changes like phase 20's baselines: drop entries older than 7 days and every entry
of a pane that is closed (session connected and pane absent). On `pane.moved` the entries move to the new pane key.

**Filtering** in pane mode, for an agent pane with a touched set `T` for the loaded toplevel:

- Uncommitted: rows whose path is in `T`; an untracked-directory row (`dir/`) when any path in `T` starts with it.
  Description `<shown> of <all>`.
- Commits: each commit's file rows filtered to `T`; a commit with no file in `T` is hidden. Whether a commit has
  any is known only after its files load, so in pane mode the Commits group loads every listed commit's files
  (at most 20 `diff-tree` runs, in parallel up to 4) before returning its children. Description gets
  ` · this pane`.
- Nothing left in a section: one plain note row `Nothing recorded for this pane` (Uncommitted is then shown even
  when `T` is empty, so the note is visible).
- A shell pane (no agent): sections unfiltered, with a plain note row first in each: `No agent in this pane:
  showing all files`.

Files and its git markers are never filtered.

### Removed

`src/baselines.ts`; group `since`, `SinceNode`, `sinceRows`, `sinceDescription`; command `herdr.paneContext.resetBaseline`
(contribution, menus, registration); `SINCE_FRAGMENT`, `sinceLetter` and the `since` / `sinceTime` inputs of
`PaneDecorations`; `countCommits`; `takeSnapshot` and `SNAPSHOT_SCRIPT` (replaced by the span script). `parseDiffTree` stays;
`diffTrees` stays only if it gains the span environment, else it goes. After this phase nothing in herdr-vscode
writes to a repo's `.git`. On
activation, `context.workspaceState.update('herdr.paneContext.baselines', undefined)`.

## Validation

- [ ] `cd herdr-vscode && npm run compile && npm run lint` succeed
- [ ] Bundle with a Linux esbuild binary as in phase 27's Validation
- [ ] `xvfb-run -a npx vscode-test` passes, including new tests over a temp repo:
  - [ ] top-level labels `Uncommitted`, `Commits`, `Files` after the pane and repo rows; Uncommitted expanded;
        no `Changed in This Pane`; `herdr.paneContext.resetBaseline` is neither registered nor contributed
  - [ ] base detection: a clone with `origin/HEAD` → `vs origin/main` and only the branch's commits; no remote but a
        `main` → `vs main`; on `main` itself → `recent`, at most 20 commits
  - [ ] `git log` parse: multi-line `%B` keeps its body in the tooltip; a root commit has no parents; a malformed
        record is skipped
  - [ ] commit files: modify / add / delete / root commit letters; click on `M` opens a diff titled `<name> (<sha7>)`
        whose sides are `herdr-git` URIs at the parent and the commit; `D` opens the parent revision; Open File opens
        the working tree file, or the revision when it no longer exists
  - [ ] recorder with a fake model: idle → working → idle around a file write records that path for that
        (pane, toplevel); a write while idle is not recorded; first sight while working starts a span; a pane that
        disappears mid-span ends it; two panes on one toplevel never run two snapshots at once
  - [ ] span snapshots in a temp repo: `.git/objects` file count and `.git/index` mtime unchanged across a span;
        the span directory is gone after the span; modify / add / delete inside the span → `M` / `A` / `D`; a
        modification made before the span is not reported; a linked worktree (relative vs absolute objects path)
        works
  - [ ] `TouchedStore`: persisted through a memento round trip, pruned at 7 days and for closed panes, moved on
        `pane.moved`
  - [ ] pane mode: Uncommitted and Commits filtered to the touched set; untracked directory row kept when a touched
        path is under it; commits without touched files hidden; `Nothing recorded for this pane`; shell pane note and
        unfiltered rows; toggle commands flip the context key and the workspaceState value
  - [ ] the old `herdr.paneContext.baselines` key is cleared on activation
- [ ] Live (`HERDR_VSCODE_LIVE_SESSION`, throwaway session): an agent pane going working → idle while a file is
      written records it; record the snapshot timings under Implementation notes
- [ ] Manual (left to the user): on this repo, Commits shows recent commits, expanding one lists its files, clicking
      shows its diff; with the filter on, only files an agent touched remain

## Relevant Files

- `herdr-vscode/src/paneContext.ts` (sections, commit rows, filter, openChanges / openFile for commit files)
- `herdr-vscode/src/git.ts` (base detection, log parse, commit files, `baselineTime` moved here, `countCommits` removed)
- `herdr-vscode/src/touched.ts` (new: recorder and `TouchedStore`)
- `herdr-vscode/src/baselines.ts` (deleted)
- `herdr-vscode/src/decorations.ts` (since-letters removed)
- `herdr-vscode/src/extension.ts` (recorder, toggle commands, Reset Baseline removed, old key cleared)
- `herdr-vscode/package.json` (toggle commands and menus, Reset Baseline removed)
- `herdr-vscode/src/test/paneContext.test.ts`, `livePaneContext.test.ts`, `git.test.ts`, `decorations.test.ts`,
  `extension.test.ts`, `baselines.test.ts` (deleted), `touched.test.ts` (new)
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md`
- `.plans/herdr-pane-changes.md` (a superseded note on the baseline section)
- `.plans/PLAN.md`

## Implementation notes
