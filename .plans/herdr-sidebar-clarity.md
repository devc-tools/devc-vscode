# herdr-vscode: sidebar clarity (Active Pane header, tab focus, one git format, Sessions on demand)

Decided by the user on 2026-11-02, after "it's difficult to know what I'm looking at":

1. **Active Pane names its pane in the view header.** VS Code's `TreeView.description` is drawn dimmed after the
   view title, so the header reads `ACTIVE PANE  <pane name> · <space> › <tab>`. The pane row (phase 27) goes away:
   two identity rows (pane, then repo) were confusing. The repo row becomes the first row.
2. **Switching tabs from VS Code follows the new tab's pane.** Today the followed pane is the last clicked tile
   (`followedPaneKey`, `src/paneContext.ts`), and a tab switch (`tab.focus`) does not change it, so Active Pane and
   the status bar keep showing the previous tab's pane until a tile is clicked.
3. **One git summary format** for Spaces space rows and the Active Pane repo row: the Spaces one (`gitDescription`,
   `src/spaceGit.ts`). Today they differ (`⎇ main · clean` vs `⎇ main`, `⎇ main ● 3` vs `⎇ main · ● 3`).
4. **Sessions is shown only when needed.** Picking a session moves to a quick pick in the Spaces header and the
   session status bar item; the Sessions view shows only while managing sessions or while no session is selected.

Rejected for now: one combined tree (Spaces + Active Pane in a single view) and moving Active Pane to another view
container. Revisit only if cross-view expansion is still a problem after this phase.

Depends on phases 27 and 28. Paths are under `herdr-vscode/` unless they start with `.plans/`.

## Checklist

- [x] 1. Active Pane header: `TreeView.description` from the followed pane (Contracts); pane row removed; header
      message only for no-pane states
- [x] 2. Active Pane title actions: **Show Pane** always available while a pane is followed (moved from the pane row)
- [x] 3. Tab switches from VS Code set the followed pane (Contracts)
- [x] 4. One git format: the repo row's description uses `gitDescription`; `repoDescription` deleted
- [x] 5. Sessions view `when` clause and the `herdr.sessionsShown` context key
- [x] 6. **Switch Session** quick pick (`herdr.sessions.switch`) on the Spaces title bar and the session status bar item
- [x] 7. **Manage Sessions** / **Done** (`herdr.sessions.manage`, `herdr.sessions.doneManaging`)
- [x] 8. Tests (Validation)
- [x] 9. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Active Pane header (`src/paneContext.ts`)

The view's `TreeView.description` while a pane is followed and found in its session's snapshot:

```
[pinned · ]<pane name> · <space> › <tab>[ · not open in a tile]
```

- `<pane name>`: `paneLabel(pane, snapshot)` (unchanged rules, `src/sessions.ts`).
- `<space>` / `<tab>`: the workspace / tab label, the id when unlabelled (what `paneRowDescription` uses today).
- `pinned · ` prefix while pinned.
- ` · not open in a tile` when no tile in this window shows the pane (`panels.showsPane`).
- No pane followed, or the followed pane not found: `description` is `undefined` and `TreeView.message` is today's
  `paneContextMessage(pinned)` text (unchanged).

The view title stays `Active Pane` (do not set `TreeView.title`). The description is plain text: codicons
(`$(…)`) are not rendered there, so the agent mark is not shown in the header; the status bar item keeps it.

Update the description on the same triggers the pane row updates on today (snapshot change, focus change,
session selection, tiles change, pin / unpin). Set it only when the string changes: every snapshot event calls
`update()`.

Removed: the `pane` node type, `paneRow`, `updatePaneRow`, `paneRowDescription` (fold its text into the header
builder), the `herdr.paneContext.pane` / `herdr.paneContext.pane hidden` context values and their inline menu entry.
`getChildren(undefined)` returns `topLevel(loaded)` only (repo row first), or `[]` when nothing is loaded.

### Active Pane title actions (`package.json`)

`herdr.paneContext.showPane` moves to `view/title`, group `navigation@0`, icon `$(window)`, title `Show Pane`,
`when` `view == herdr.paneContext && herdr.paneContext.following`. New context key `herdr.paneContext.following`:
true while a pane is followed and found, set alongside the description. **Show Pane** opens or reveals the pane's
space tab and focuses its tile (what clicking the old pane row did, `paneClickCommand`).

Existing title actions (pin / unpin, pane-files filter, refresh) keep their groups `navigation@1`–`@3`.

### Tab switches set the followed pane (`src/tilesPanel.ts`, `src/focus.ts`)

When the user switches herdr tab **from VS Code**, the followed pane becomes that tab's herdr-focused pane:

- Triggers: a Spaces **tab** row click (`OPEN_TAB_COMMAND`), a Spaces **space** row click (`OPEN_SPACE_COMMAND`,
  which shows the space's active tab), and a tile-strip tab click (`focusTab` → `selectTab`).
- Which pane: once the session's snapshot shows that tab active, `snapshot.focusedPaneId` if it is in that tab;
  otherwise the first pane of that tab in snapshot order. Call `focus.set(sessionKey, paneId)`, the same call a
  tile click makes, so Active Pane, the status bar item and `lastFocused` all follow.
- Wait for the snapshot for at most 2 s after `tab.focus` resolves; if it does not show the tab active by then, do
  not change the followed pane. A `tab.focus` error does not change it either.
- A tab already active (no `tab.focus` sent) still sets the followed pane to its focused pane: clicking a tab row
  means "this tab".
- Not a trigger: tab switches made in herdr itself or by another client (`tab.focused` events not caused by this
  window). Those keep today's behaviour.
- A pinned Active Pane stays pinned: `focus.set` does not unpin (pinned wins in `followedPaneKey`, unchanged).

Gotcha: `selectTab` returns early for a tab already pending (`pendingTab`); the follow must still happen once for
that click, not twice.

### One git format (`src/paneContext.ts`, `src/spaceGit.ts`)

The Active Pane repo row's description is `gitDescription(loaded.git)` (`src/spaceGit.ts`):

| state | text |
| --- | --- |
| clean, in sync | `⎇ main · clean` |
| 3 changed | `⎇ main ● 3` |
| 3 changed, 1 ahead, 2 behind | `⎇ main ● 3 ↑1 ↓2` |
| clean, 2 behind | `⎇ main · clean ↓2` |

`repoDescription` and its tests are deleted. `gitDescription` and `splitGitDescription` are unchanged (the sidebar
config's `branch` / `git_status` tokens depend on `splitGitDescription`).

### Sessions on demand (`package.json`, `src/views/sessionsView.ts`, `src/extension.ts`)

**Visibility.** `herdr.sessions` in `contributes.views.herdr` gets `"when": "herdr.sessionsShown"`. The extension
sets context key `herdr.sessionsShown` to

```
manageMode || sessions.selected === undefined
```

re-evaluated on `sessions.onDidChangeSelected` and when manage mode changes. `manageMode` is in memory only
(false at activation; not persisted). Set the key at activation before the first discovery pass completes; it is
`true` then (nothing selected yet), so the view and its welcome text (`Looking for herdr sessions…`) show during
startup and hide once a session is selected.

Gotchas:

- A view hidden by `when` is gone, not collapsed: `herdr.sessions.focus` does nothing while it is hidden. Every
  caller of `herdr.sessions.focus` (the session status bar item) changes to `herdr.sessions.switch`.
- `onView:herdr.sessions` no longer reliably activates the extension; `onView:herdr.spaces` and
  `onStartupFinished` already do. Leave the activation events unchanged.
- `SessionsView.treeView` is still created at activation; selection via its rows works unchanged while shown.

**Switch Session** — command `herdr.sessions.switch`, title `Switch Session`, icon `$(arrow-swap)`,
category `herdr`:

- `view/title` on `herdr.spaces`, group `navigation@0`, `when` `view == herdr.spaces` (shown even with no selection).
- The session status bar item (`herdr.session`) runs it on click.
- `vscode.window.createQuickPick` (or `showQuickPick`) with items in the Sessions view's order: a
  `QuickPickItemKind.Separator` per group (`This machine`, `SSH · <alias>`, `Dev containers`), then one item per
  **running** session row (`contextValue === 'herdr.session.running'`, any suffix): `label` = the row label,
  `description` = the row description, `picked`/active on the currently selected session.
- Stopped / absent sessions are not listed. The last item, after a separator, is `$(gear) Manage Sessions…`, which
  runs `herdr.sessions.manage`.
- Choosing a session calls `sessions.select(key)` (same as a row click). Escape changes nothing.
- No running sessions: the quick pick shows only `Manage Sessions…`, with placeholder `No running herdr sessions`.

**Manage Sessions** — command `herdr.sessions.manage`, title `Manage Sessions`, icon `$(gear)`, category `herdr`:
sets `manageMode = true`, updates the context key, then runs `herdr.sessions.focus`. Also in `view/title` of
`herdr.spaces` (secondary group `9_manage`, i.e. the `…` menu) and the command palette.

**Done** — command `herdr.sessions.doneManaging`, title `Done`, icon `$(check)`: `view/title` on `herdr.sessions`,
group `navigation@0`, `when` `view == herdr.sessions && herdr.sessionsManaging`. Sets `manageMode = false`. Context
key `herdr.sessionsManaging` mirrors `manageMode`. Hidden from the command palette (`commandPalette` `when: false`).

The Sessions view's existing row actions (Start, Stop, Delete, attach) and `herdr.refresh` are unchanged.

## Validation

Run from `herdr-vscode/`.

- [x] `npm run compile` passes
- [x] `npm run lint` passes
- [x] `npm test` passes, including new / updated unit tests:
  - [x] `paneContext.test.ts`: header description for a followed agent pane (`<name> · <space> › <tab>`), pinned
        prefix, ` · not open in a tile`, unlabelled space / tab ids, `undefined` with the message when nothing is
        followed; root children start with the repo row (no `pane` row); the description is not re-set when unchanged
  - [x] `paneContext.test.ts`: repo row description equals `gitDescription` for the four table rows above
  - [x] `spacePanels.test.ts` (or `mirrorPanels.test.ts`, where `selectTab` is tested): selecting a tab sets
        `focus.lastFocused` to the snapshot's focused pane in that tab; first pane of the tab when the focused pane is
        elsewhere; unchanged on a `tab.focus` error; unchanged when the snapshot does not confirm within 2 s;
        an already-active tab still sets it; one `focus.set` per click
  - [x] `views.test.ts`: `herdr.sessionsShown` is true with no selection, false once a session is selected, true in
        manage mode, false after Done; Switch Session items: separators per group, running sessions only, the
        selected one active, `Manage Sessions…` last; empty case has only `Manage Sessions…`
- [x] `grep -rn "repoDescription\|paneRowDescription\|herdr.paneContext.pane" src package.json` finds nothing
- [x] `grep -rn "herdr.sessions.focus" src` finds only the `herdr.sessions.manage` implementation
- [ ] Manual (Extension Development Host, live herdr session):
  - [ ] Active Pane header shows `<pane name> · <space> › <tab>`; first row is the repo
  - [ ] Clicking another tab row in Spaces (no tile click) changes the Active Pane header and the status bar to that
        tab's pane; same for a tile-strip tab click
  - [ ] Spaces space row and Active Pane repo row show identical git text for the same repo
  - [ ] With a session selected, the Sessions view is not in the sidebar; Spaces' `$(arrow-swap)` switches session;
        `…` → Manage Sessions shows it; Done hides it; status bar click opens the quick pick

## Relevant Files

- `herdr-vscode/src/paneContext.ts` — header description, pane row removal, repo row git text, `following` context key
- `herdr-vscode/src/spaceGit.ts` — `gitDescription` reused (no change expected; listed for the import)
- `herdr-vscode/src/tilesPanel.ts` — `selectTab` / `openSpace` / `openTab` set the followed pane
- `herdr-vscode/src/focus.ts` — `set` reused; status bar item click command → `herdr.sessions.switch`
- `herdr-vscode/src/views/sessionsView.ts` — manage mode, `herdr.sessionsShown` / `herdr.sessionsManaging`, quick pick items
- `herdr-vscode/src/views/spacesView.ts` — none expected beyond the title action contribution; listed in case the
  tab/space click path lives here
- `herdr-vscode/src/extension.ts` — register `herdr.sessions.switch`, `herdr.sessions.manage`,
  `herdr.sessions.doneManaging`; `OPEN_TAB_COMMAND` / `OPEN_SPACE_COMMAND` wiring; status bar command
- `herdr-vscode/package.json` — Sessions `when`, new commands, `view/title` entries, pane-row menu entry removed,
  Show Pane moved to the title bar, `commandPalette` hiding for Done
- `herdr-vscode/src/test/paneContext.test.ts`
- `herdr-vscode/src/test/spacePanels.test.ts`
- `herdr-vscode/src/test/mirrorPanels.test.ts`
- `herdr-vscode/src/test/views.test.ts`
- `herdr-vscode/src/test/spaceGit.test.ts` — only if a `repoDescription` case lives here
- `herdr-vscode/README.md` — Sessions, Spaces, Active Pane, status bar sections
- `herdr-vscode/CHANGELOG.md` — `[Unreleased]` entries
- `herdr-vscode/docs/how-it-works.md` — Sessions view, session status bar item, Active Pane pane row / repo row, focus
- `.plans/PLAN.md` — Pending entry and phase 29 row
