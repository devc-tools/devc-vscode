# herdr Sessions Tree

A **Sessions** view at the top of the herdr sidebar: every session in every environment, running ones under a
`Running` root and stopped / unavailable ones under a `Stopped` root. Running sessions expand to their spaces, tabs and
panes, the same rows Spaces shows. The Spaces view, Switch Session picker, Agents and Active Pane stay as they are.

Mockup (layout B was chosen): https://claude.ai/artifact/UigUDLiBoynFVN4eB5dSha, artboard "B · Flat, env in
description", with "this machine" dropped from descriptions.

Depends on phase 30 (herdr Session Picker): it reuses `SessionList`, `sessionRows` and the picker's start / stop /
delete / create actions.

## Contract

### View

- View id `herdr.sessions`, name `Sessions`, **first** in the `herdr` container (before Spaces, Agents, Active Pane).
- Created with `showCollapseAll: true`.
- Title bar (`view/title`, `navigation`): `herdr.sessions.new` (`$(add)`, "New Session…") at `@0`, `herdr.newSpace`
  at `@1` when `herdr.sessionSelected`, `herdr.refresh` (`$(refresh)`) at `@2`. Collapse All comes from
  `showCollapseAll`.
- `viewsWelcome` for `herdr.sessions` (shown when the tree has no roots): `No herdr sessions.\n[New Session](command:herdr.sessions.new)`.

### Tree shape

```
Running            3
  ● default            1 blocked · 1 working        ← selected session: expanded, label highlighted
    ● herdr-vscode     ⎇ main ● 3 ↑1                 ← Spaces' space / tab / pane rows, unchanged
      tab · main       claude + 1 shell
        ✳ Sessions panel mockup   herdr-vscode
        ▢ zsh
  ● api                ssh devbox · 1 done           ← collapsed
  ● deephaven-mcp      idle
Stopped            4
  ○ scratch
  ○ web-ui             herdr not running
  ○ nightly            ssh devbox · start not supported
  ⚠ buildbox           ssh · unreachable
```

- **Roots**: `Running` then `Stopped`. Label is the word; description is the number of rows under it (`3`). A root
  with no rows is omitted. Roots start `Expanded`. Root `contextValue`: `herdr.sessions.group`. No icon, no command.
- **Rows** come from `sessionRows(state, connection, showStopped)` per environment, in `SessionModel.states()` order
  (this machine, SSH hosts, dev containers), so `herdr.showStoppedSessions` filters exactly as in Switch Session.
  - Under `Running`: rows with `contextValue === 'herdr.session.running'`.
  - Under `Stopped`: every other row (`herdr.session.stopped` and `herdr.session.absent`, i.e. stopped sessions and
    environment-level rows such as `herdr not running`, `unreachable`, `herdr not installed`, `checking…`, `error`).
- **Session row label**: `SessionRowNode.label` (session name on this machine and SSH, folder name in a container,
  `env.label` for environment-level rows).
- **Session row description**: the parts below that are non-empty, joined with ` · `:
  1. environment: none for this machine; `ssh <alias>` on SSH session rows; `ssh` on an SSH environment-level row
     (its label is already the alias); none in a dev container (the icon says it);
  2. in a dev container, the session name when it is not `devc`;
  3. status: running and connected → `snapshotDescription(snapshot)` (`1 blocked · 1 working`, `idle` with no
     agents); running and not connected → `connecting…` / `disconnected` / `needs herdr 0.9.5 or later` as today;
     stopped on this machine or in a container → nothing (the Stopped root says it); stopped on SSH →
     `start not supported`; environment-level row → its text (`herdr not running`, `unreachable`, `herdr not installed`,
     `checking…`, `error`).

  Examples: `1 blocked · 1 working`, `ssh devbox · 1 done`, `idle`, `web · idle`,
  `herdr not running`, `ssh devbox · start not supported`, `ssh · unreachable`, `herdr not installed`.
  This description is computed for the tree only; Switch Session's descriptions do not change.
- **Session row icon**: the environment's codicon — `device-desktop` (this machine), `remote` (SSH), `package` (dev
  container; there is no container codicon). Running and connected: coloured by the worst agent status
  (`charts.orange` / `charts.blue` / `charts.green`), uncoloured when idle; running not connected, stopped, and
  `herdr not running` → `disabledForeground`. `unreachable`, `herdr not installed`, `error` →
  `new ThemeIcon('warning', new ThemeColor('list.warningForeground'))`; `checking…` → `ThemeIcon('loading~spin')`.
- **Session row tooltip**: `SessionRowNode.tooltip`, plus a last line `Selected session` on the selected row.
- **Session row id**: `session|<row.key>`. Space / tab / pane ids are `buildSpaces`' (`<sessionKey>|space|…`), already
  unique per session.
- **Session row `contextValue`**: `herdr.session.<state> <kind>[ deletable]`, state `running` | `stopped` | `absent`,
  kind `host` | `ssh` | `container`, ` deletable` when `row.deletable` and state is not `absent`. E.g.
  `herdr.session.running host deletable`, `herdr.session.stopped container`, `herdr.session.absent ssh`.
- **Children of a running, connected session**: `buildSpaces(snapshot, key, git, sidebarRows)` rendered with
  `spacesTreeItem` — identical rows, icons, commands and context values to Spaces. Running but not connected: no
  children (`TreeItemCollapsibleState.None`). Stopped / absent rows: no children.
- **Git text on space rows**: only the selected session's spaces get branch / git status (SpaceGit tracks one
  session); other sessions' space rows fall back to the repo name as `buildSpaces` does without a git lookup. SpaceGit
  polls while **Spaces or Sessions** is visible (today: Spaces only).

### Expansion and selection

- Initial state: the selected session's row `Expanded`; every other running, connected session `Collapsed`. Space and
  tab rows keep Spaces' rule (focused → `Expanded`, else `Collapsed`).
- When `SessionList.onDidChangeSelected` fires and the view is visible, `treeView.reveal(selectedRow, { expand: true,
  select: false, focus: false })`. Implement `getParent` (pane → tab → space → session row → `Running` root).
- Gotcha: VS Code remembers a user's expand / collapse per item `id` and ignores `collapsibleState` for ids it has
  seen, so the reveal is what expands a newly selected session; never change ids to force expansion. Gotcha: `reveal`
  on a hidden view opens the view, so skip it unless `treeView.visible`.
- The selected session's label is shown highlighted: `label: { label, highlights: [[0, label.length]] }` (a
  `TreeItemLabel`; tree item labels have no other way to look distinct and the tree's own selection moves on clicks).

### Clicks and row actions

- Clicking a running session row runs `herdr.sessions.select` with the row key: `SessionList.select(key)` (Spaces,
  Agents' this-session scope and the status bar follow, as with Switch Session). Clicking any other session row does
  nothing (no `command`). Space / tab / pane clicks are Spaces' (`herdr.openSpace`, `herdr.openTab`,
  `herdr.openPaneTab`).
- Inline buttons (`view/item/context`, `when` uses `view == herdr.sessions && viewItem =~ …`):

  | Command | Icon | Rows |
  |---|---|---|
  | `herdr.openHostTerminal` | `$(terminal)` | `^herdr\.session\.running container` — `inline@0` |
  | `herdr.newSpace` | `$(add)` | `^herdr\.session\.running ` — `inline@1` |
  | `herdr.sessions.stop` | `$(debug-stop)` | `^herdr\.session\.running host` — `inline@2` |
  | `herdr.sessions.start` | `$(play)` | `^herdr\.session\.stopped (host\|container)` — `inline@1` |
  | `herdr.sessions.delete` | `$(trash)` | `deletable` — `inline@3` |

- `herdr.sessions.start` / `stop` / `delete` take the tree's session row and call the existing Switch Session actions
  (`sessionActions.start` / `stop` / `remove`), including their confirmation modals. The `herdr not running` row in a
  container is `herdr.session.stopped container` (session `devc`), so Start starts devc's session as in the picker.
- `herdr.newSpace` given a session row creates the space in **that** session (today it always uses the selected one);
  with no argument it keeps using the selected session.
- `herdr.openHostTerminal` given a session row opens the terminal in that session's environment's project folder
  (`openHostTerminal(env)`, no space folder).
- `herdr.sessions.new` runs `sessionActions.create()` (New Session's place + name prompts).
- Space, tab and pane rows get the same inline and context menu items as in Spaces: widen each existing `when` from
  `view == herdr.spaces` to `view =~ /^herdr\.(spaces|sessions)$/` (and `herdr\.(spaces|agents)` →
  `herdr\.(spaces|sessions|agents)`, `herdr\.(spaces|agents|paneContext)` → `herdr\.(spaces|sessions|agents|paneContext)`).
  `herdr.openHostTerminal` on a container space row in Sessions uses the space's folder, as in Spaces.
- `commandPalette`: hide `herdr.sessions.select`, `herdr.sessions.start`, `herdr.sessions.stop`,
  `herdr.sessions.delete` (`"when": "false"`); `herdr.sessions.new` stays visible (title `New Session…`, category `herdr`).

### Refresh

The tree rebuilds on `SessionList.onDidChange` (which follows `SessionModel.onDidChange`), `SessionList.onDidChangeSelected`, the view's visibility, `SpaceGit.onDidChange` and the sidebar
config source's `onDidChange`, firing one full `onDidChangeTreeData`.

## Checklist

- [x] `package.json`: `herdr.sessions` view first in the container; `viewsWelcome`; commands `herdr.sessions.select`,
  `herdr.sessions.start`, `herdr.sessions.stop`, `herdr.sessions.delete`, `herdr.sessions.new` with titles / icons;
  title and inline menus; widened `when`s on space / tab / pane menu items; `commandPalette` hides.
- [x] Tree description builder (environment · container session · status) as an exported pure function, alongside the
  row → section split (Running / Stopped) and the `contextValue` builder.
- [x] `SessionsTreeView` (`TreeDataProvider` + `getParent`) in `src/views/sessionsTree.ts`: roots, session rows,
  space / tab / pane children through `buildSpaces` / `spacesTreeItem`, icons, tooltips, ids, highlighted selected label.
- [x] Expansion: selected session expanded initially; reveal-with-expand on selection change while visible.
- [x] SpaceGit polls while Spaces or Sessions is visible; git text for the selected session only.
- [x] Commands wired in `src/extension.ts`: select / start / stop / delete / new; `herdr.newSpace` and
  `herdr.openHostTerminal` accept a session row.
- [x] Unit tests in `src/test/views.test.ts` for the description builder, section split, contextValue builder and tree
  shape (roots omitted when empty, children only for connected running sessions, selected row expanded and highlighted).
- [x] SpaceGit visibility test in `src/test/spaceGit.test.ts` (polls with only Sessions visible).
- [x] `README.md`: four views; a **Sessions** bullet (Running / Stopped, descriptions, row buttons, selection by click).
- [x] `docs/how-it-works.md`: Sessions view section (row sources, description rule, contextValue format, expansion and
  reveal, git scope).
- [x] `CHANGELOG.md` `[Unreleased]`: a **Sessions view** entry.

## Validation

- [x] `cd extensions/herdr-vscode && npm test` passes (build, lint, unit tests). In this dev container: `ESBUILD_BINARY_PATH=<linux esbuild>` (node_modules has the macOS binary) and `xvfb-run -a`.
- [x] Description builder unit cases produce exactly: `1 blocked · 1 working` (host running), `idle` (host running, no
  agents), `ssh devbox · 1 done`, `idle` (container), `web · idle` (container session `web`),
  `herdr not running` (container), `ssh devbox · start not supported`, `ssh · unreachable`, `herdr not installed`
  (host), `` (empty, host stopped), `connecting…` (host running, not connected).
- [x] contextValue unit cases: `herdr.session.running host deletable`, `herdr.session.running container`,
  `herdr.session.stopped host deletable`, `herdr.session.absent ssh`.
- [x] Tree unit case: with no stopped rows the only root is `Running`; with nothing at all `getChildren()` is `[]`.
- [ ] Manual: the herdr sidebar shows Sessions first; `Running` lists running sessions with descriptions as above and
  `Stopped` lists stopped ones; no row mentions "this machine".
- [ ] Manual: the selected session is expanded with its label highlighted and its spaces show branch / git status;
  other running sessions are collapsed and expand to space / tab / pane rows that open and focus like Spaces'.
- [ ] Manual: clicking another running session selects it (status bar and Spaces follow) and it expands.
- [ ] Manual: Start on a stopped host session starts it and it moves to `Running`; Stop (host) and Delete ask first;
  `+` on a session row creates a space in that session; `$(terminal)` on a container session opens a host terminal.
- [ ] Manual: Switch Session, Spaces, Agents and Active Pane behave as before.

## Relevant Files

- `extensions/herdr-vscode/package.json`
- `extensions/herdr-vscode/src/extension.ts`
- `extensions/herdr-vscode/src/views/sessionsTree.ts` (new)
- `extensions/herdr-vscode/src/views/sessionsView.ts` (description / section / contextValue helpers next to `sessionRows`)
- `extensions/herdr-vscode/src/spaceGit.ts`
- `extensions/herdr-vscode/src/test/views.test.ts`
- `extensions/herdr-vscode/src/test/spaceGit.test.ts`
- `extensions/herdr-vscode/src/test/extension.test.ts` (view list, item menu list)
- `extensions/herdr-vscode/src/test/hostTerminal.test.ts` (Open Host Terminal menu entries)
- `extensions/herdr-vscode/README.md`
- `extensions/herdr-vscode/docs/how-it-works.md`
- `extensions/herdr-vscode/CHANGELOG.md`
- `.plans/PLAN.md`
