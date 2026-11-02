# herdr-vscode: session picker replaces the Sessions view; Active Pane "Changes" always shown

Decided by the user on 2026-11-02:

1. **The Sessions view is removed.** Everything it did moves into the **Switch Session** quick pick (phase 29),
   grouped by place as now: running sessions get **Stop** and **Delete** buttons, clicking a running session selects
   it, clicking a stopped one starts it and selects it. A **+** button in the picker's title bar creates a new
   session. Manage Sessions / Done (phase 29) go away.
2. With no session selected, Spaces (and Agents in session scope) show a **Select Session** button.
3. Active Pane's **Uncommitted** section is renamed **Changes** and is always shown in a repo.

Depends on phase 29. Paths are under `herdr-vscode/` unless they start with `.plans/`.

## Checklist

- [x] 1. Remove the `herdr.sessions` view and everything only it used (Contracts: Removed)
- [x] 2. The session list keeps selection and rows without a tree view (`SessionsView` → a plain class)
- [x] 3. Picker items: groups, running / stopped / unavailable rows, icons, active item (Contracts: Picker)
- [x] 4. Item buttons Stop and Delete; the picker stays open and refreshes (Contracts: Item buttons)
- [x] 5. Accepting a stopped session starts then selects it (Contracts: Accept)
- [x] 6. Title buttons **New Session…** (`+`) and **Refresh**; the New Session flow (Contracts: New Session)
- [x] 7. Spaces / Agents welcome text with **Select Session**
- [x] 8. Active Pane: **Changes** always shown (Contracts: Changes)
- [x] 9. Tests (Validation)
- [x] 10. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Removed

- `contributes.views.herdr` entry `herdr.sessions`; its `viewsWelcome` entry; activation event `onView:herdr.sessions`.
- Commands `herdr.sessions.manage`, `herdr.sessions.doneManaging`, `herdr.openSession`, `herdr.startSession`,
  `herdr.stopSession`, `herdr.deleteSession` as contributed commands: their `contributes.commands`,
  `commandPalette` and `view/item/context` / `view/title` entries. Their logic stays as functions the picker calls.
- Context keys `herdr.sessionsShown`, `herdr.sessionsManaging`; `sessionsShown`, `MANAGE_SESSIONS_LABEL`,
  manage mode.
- The `herdr.refresh` `view/title` entry on `herdr.sessions` (the command stays: the picker's Refresh runs it).
- `withProgress({ location: { viewId: 'herdr.sessions' } })`: use `ProgressLocation.Notification` with title
  `herdr: starting session "<name>"…` / `herdr: deleting session "<name>"…`.

The selection logic stays: `effectiveSelection`, the `herdr.selectedSession` workspaceState key, `select(key)`,
`selected`, `onDidChangeSelected`, `row(key)` (Spaces' description and the status bar use row labels). Keep
`sessionRows`, `groupOf`, `sessionRowLabel`, `firstSpaceId` if still used, else delete. The class no longer
implements `TreeDataProvider` or creates a tree view.

### Picker (`herdr.sessions.switch`)

Title `Switch herdr Session`; placeholder `Select a session` (or `No herdr sessions` when there are no items).
`ignoreFocusOut` stays false except while an action runs (below).

Items, in `model.states()` order, grouped by `groupOf(env)` (`This machine`, `SSH · <alias>`, `Dev containers`):
a `QuickPickItemKind.Separator` with the group label, then that group's rows from `sessionRows(...)` (so
`herdr.showStoppedSessions` applies exactly as it did to the view). Each item:

| row | `label` | `description` | `iconPath` | buttons |
| --- | --- | --- | --- | --- |
| running | row label | row description (`2 blocked · 1 working`, `connecting…`, …) | `statusIcon(sessionRowStatus(snapshot))` | Stop (host only), Delete (if `deletable`) |
| stopped | row label | `stopped` (container: `<name> · stopped`) | `statusIcon(undefined)` | Delete (if `deletable`) |
| absent (`herdr.session.absent`) | row label | row description (`unreachable`, `herdr not installed`, …) | `statusIcon(undefined)` | none |

The container "herdr not running" row (`herdr.session.stopped` with `session: 'devc'`, no `deletable`) is a
stopped row. The currently selected session's item is the active item (`activeItems`). While the picker is open,
`model.onDidChange` rebuilds the items, keeping the active item by session key.

### Item buttons

`onDidTriggerItemButton`:

- **Stop** — `iconPath: new ThemeIcon('debug-stop')`, `tooltip: 'Stop Session'`. On running rows with
  `envKey === HOST_KEY` only (container / SSH stop is not supported, unchanged). Same modal confirm, command
  (`sessionStopArgv`, 15 s timeout) and `m.relist(HOST_KEY)` as today's `herdr.stopSession`.
- **Delete** — `iconPath: new ThemeIcon('trash')`, `tooltip: 'Delete Session'`. On rows with `deletable`. Same modal
  confirm text (running: stop first) and commands as today's `herdr.deleteSession`, then `m.relist(env.key)`.

While a button's action runs (including its modal), set `qp.ignoreFocusOut = true` and `qp.busy = true`, then
restore both. Gotcha: a modal dialog takes focus; without `ignoreFocusOut` the picker hides and the rest of the
action still runs but the user loses the list. The picker stays open after the action; items refresh via the
model change. If the selected session was stopped / deleted, `effectiveSelection` already falls back.

### Accept

`onDidAccept` on:

- **running** row: `select(key)`, hide. (No space is opened; the old row click's `herdr.openSession` behaviour is
  dropped.)
- **stopped** row on `host` or `container`: hide, then start it as today's `herdr.startSession` did
  (`startHostSession` / `startContainerSession`, Notification progress), then `select(key)` on success; on failure
  today's warning (`session "<name>" did not start[ in <label>]. Its herdr-server.log says why.`).
- **stopped** row on SSH: hide, warning `herdr: starting sessions on SSH hosts is not supported yet.`
- **absent** row: nothing (picker stays open).

### Title buttons and New Session

`qp.buttons`:

1. **New Session…** — `iconPath: new ThemeIcon('add')`, `tooltip: 'New Session…'`.
2. **Refresh** — `iconPath: new ThemeIcon('refresh')`, `tooltip: 'Refresh'`; runs `m.refresh()` (the
   `herdr.refresh` command); the picker stays open.

New Session (picker hides first):

1. **Where** — `showQuickPick`, title `New herdr Session`, placeholder `Where should the session run?`. Items:
   `This machine` (always), then each `container` environment whose `EnvState.status` is `ok` (herdr installed and
   reachable), labelled with `env.label`, description `Dev container`. SSH hosts are not offered. Skip this step when
   `This machine` is the only choice.
2. **Name** — `showInputBox`, title `New herdr Session`, prompt `Session name`. `validateInput` returns:
   - `Enter a name.` for empty / whitespace-only
   - `Use letters, digits, ".", "_" or "-".` unless `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`
   - `A session named "<name>" already exists there.` if that env's `EnvState.sessions` has the name (running or not)
3. Start it like a stopped row (Accept), then `select(key)`. Escape at any step does nothing.

### Spaces and Agents welcome (`package.json` `viewsWelcome`)

- `herdr.spaces`, `when` `!herdr.sessionSelected`: `No session selected.\n[Select Session](command:herdr.sessions.switch)`
- `herdr.agents`, `when` `herdr.agentsScope == session && !herdr.sessionSelected`: the same text.

`herdr.sessions.switch` keeps its title `Switch Session`, `$(arrow-swap)` Spaces title action and the status bar
click (phase 29). It is in the command palette.

### Changes (`src/paneContext.ts`)

The `changes` group's label is `Changes` (was `Uncommitted`). It is shown whenever `loaded.toplevel && loaded.git`
(was: only with changes or in pane mode), expanded as before. Description: `String(changes.length)` (so `0` when
clean); pane mode keeps `<touched> of <total>` (`0 of 0`). Children when there is nothing to show:

- all mode, no changes: one plain note `No uncommitted changes`
- pane mode: unchanged (`NOTHING_RECORDED` / `NO_AGENT_NOTE` as today)

Context value stays `herdr.paneContext.changes`; the group id stays `<root>|changes`.

## Validation

Run from `herdr-vscode/` (bundle with a Linux esbuild if `node_modules` holds another platform's, via
`ESBUILD_BINARY_PATH`; tests under `xvfb-run -a` without a display).

- [x] `npm run compile` and `npm run lint` pass
- [x] `npm test` passes, including new / updated tests:
  - [x] `views.test.ts`: picker items for host running (Stop + Delete when deletable; Stop only for `default`),
        host stopped (Delete), container running (Delete only when deletable, no Stop), container "herdr not running"
        (no buttons), SSH unreachable (absent, no buttons); separators per group in `states()` order;
        `herdr.showStoppedSessions` hides stopped container / SSH rows but never host ones
  - [x] `views.test.ts`: accept routing — running → select, stopped host/container → start, stopped SSH → warning,
        absent → nothing (pure function returning the action)
  - [x] `views.test.ts`: new-session name validation for the four cases above; Where choices: host first, only `ok`
        containers, no SSH
  - [x] `views.test.ts`: contributions — no `herdr.sessions` view, none of the removed commands or context keys in
        `package.json`; Spaces / Agents welcome text and command link exact
  - [x] `extension.test.ts`: the herdr container's views are `herdr.spaces`, `herdr.agents`, `herdr.paneContext`
  - [x] `paneContext.test.ts`: a clean repo shows `Changes` with description `0` and the `No uncommitted changes`
        note; section order `root, Changes, Commits, Files`; pane mode `0 of 0`
- [x] `grep -rn "herdr\.sessions'\|viewId: 'herdr.sessions'\|sessionsShown\|sessionsManaging\|Manage Sessions\|herdr.openSession\|herdr.startSession\|herdr.stopSession\|herdr.deleteSession\|'Uncommitted'" src package.json` finds nothing
- [ ] Manual (Extension Development Host):
  - [ ] No Sessions view; with nothing selected Spaces shows **Select Session**
  - [ ] Picker: Stop / Delete buttons act and the list updates in place; a stopped host session starts on click
  - [ ] `+` creates and selects a new host session
  - [ ] Active Pane shows **Changes 0** in a clean repo

## Relevant Files

- `herdr-vscode/package.json` — view, commands, menus, welcome, activation events
- `herdr-vscode/src/views/sessionsView.ts` — tree view removed; picker item / accept / validation helpers
- `herdr-vscode/src/extension.ts` — picker UI, button actions, New Session flow, removed command registrations
- `herdr-vscode/src/sessionControl.ts` — start / stop / delete helpers reused (no contract change expected)
- `herdr-vscode/src/status.ts` — `statusIcon` reused; status bar click unchanged
- `herdr-vscode/src/views/spacesView.ts` — `row(key)` consumer (no change expected)
- `herdr-vscode/src/paneContext.ts` — Changes section
- `herdr-vscode/src/test/views.test.ts`
- `herdr-vscode/src/test/extension.test.ts`
- `herdr-vscode/src/test/paneContext.test.ts`
- `herdr-vscode/src/test/livePaneContext.test.ts` — if it names `Uncommitted`
- `herdr-vscode/src/test/liveSessionControl.test.ts`, `live.test.ts` — if they drive the removed commands or view
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md`
- `.plans/PLAN.md` — Pending entry and phase 30 row
