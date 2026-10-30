# herdr-vscode: Layout tabs (panes as units)

Mockup board D (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): besides mirrored herdr tabs,
the user builds **Layout tabs**: named editor tabs holding any panes, from any space or session,
arranged freely with Golden Layout (stacks, drag, maximise). The layout belongs to VS Code;
herdr's own tabs and splits are never changed by it. The setting `herdr.openPaneIn` decides
whether clicking a pane puts it in a Layout tab (default) or opens its mirrored herdr tab.

Depends on [herdr-mirrored-tabs](herdr-mirrored-tabs.md) (webview bundle, streams, focus).
Paths are under `herdr-vscode/`.

## Checklist

- [ ] 1. Layout store in workspace state; create, open, rename, delete
- [ ] 2. Layout panels: same `herdr.tiles` view type and bundle, `kind: "layout"`, full Golden
      Layout interaction
- [ ] 3. `herdr.addToLayout`: add or reveal a pane in the target Layout tab
- [ ] 4. `herdr.openPaneIn` setting and click behavior of pane and agent rows
- [ ] 5. **Copy as Layout** in the mirrored panel's toolbar
- [ ] 6. Tile states for missing panes and disconnected sessions; pane-move follow-up
- [ ] 7. Restore across reloads
- [ ] 8. Tests (list under Validation)
- [ ] 9. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Settings

| Key | Type | Default | Scope |
| --- | --- | --- | --- |
| `herdr.openPaneIn` | `"layout"` \| `"herdr"` | `"layout"` | `window` |

### Click behavior (Spaces pane rows and Agents rows)

| `herdr.openPaneIn` | click runs |
| --- | --- |
| `layout` | `herdr.addToLayout` |
| `herdr` | `herdr.openPaneTab` |

Spaces **tab** rows always run `herdr.openTab`. Space rows only expand. `herdr.focusPane` moves
to the context menu as "Focus in herdr TUI". The tree items' `command` is chosen when the item is
built; the views refresh when the setting changes.

### Layout store

- Workspace state key `herdr.layouts`: JSON array of
  `{"id":"<uuid>","name":"<string>","config":<GoldenLayout ResolvedLayoutConfig>}`.
- Components in `config` are `componentType: "pane"`, `componentState`
  `{"sessionKey","paneId"}`. Saved on GL `stateChanged`, debounced 500 ms.
- Names are unique in the workspace; a new layout is named `Layout <n>` with the lowest free
  `n` unless the user types one.

### Commands

| Command | Title | Where | Does |
| --- | --- | --- | --- |
| `herdr.newLayout` | New Layout | herdr view container title `$(new-file)`; command palette | input box (default `Layout <n>`) → empty Layout tab |
| `herdr.openLayout` | Open Layout… | command palette | quick pick of saved layouts → open or reveal |
| `herdr.renameLayout` | Rename Layout… | command palette; Layout panel toolbar | rename; panel title follows |
| `herdr.deleteLayout` | Delete Layout… | command palette | quick pick → modal confirm → remove from the store, close its panel |
| `herdr.addToLayout` | Add to Layout | pane and agent row context menus; click when `openPaneIn` = `layout` | below |

Closing a Layout panel keeps the layout saved; `herdr.openLayout` brings it back.

### Adding a pane

- **Target**: the active Layout panel; else the most recently active Layout panel that is still
  open; else a saved layout is **not** reopened — a new layout `Layout <n>` is created.
- Pane already in the target → reveal the panel and focus that tile.
- Otherwise → `addComponent` into the stack holding the panel's focused tile (GL's focused
  stack), else into the root as a new stack on the right. Then focus the new tile.

### Layout panels

- Same `herdr.tiles` view type, bundle and stream manager as mirrored tabs. Webview state
  `{"kind":"layout","layoutId"}`. Title = the layout name. Icon `resources/layout.svg`, a monochrome 2×2 grid
  (`WebviewPanel.iconPath` takes a `Uri`, not a `ThemeIcon`).
- Golden Layout settings: `reorderEnabled: true`, `showMaximiseIcon: true`,
  `showCloseIcon: true`, `showPopoutIcon: false`, `popoutWholeStack: false`.
- Tile header: status dot, label, then the pane's space label faded (and `<session row label>`
  too when the layout holds panes from more than one session).
- **Closing a tile removes it from the layout only.** It never closes the herdr pane.
- Toolbar: left `"<name>" · layout`; right **Rename**.
- No herdr requests change layout from a Layout panel: no split, move or close in herdr.

### Copy as Layout

The mirrored panel's toolbar gains **Copy as Layout**: creates a layout named
`<tab label> (<space label>)` (suffixed ` 2`, ` 3`… when taken) from the mirrored panel's
current GL config, with reorder enabled, and opens it.

### Missing panes

- Session not connected → tile shows "Waiting for <session row label>…"; it reconnects when the
  session does.
- Session connected but the pane is not in its snapshot → "This pane is gone." with a
  **Remove** button.
- Moved panes: `pane.move` gives a pane a new id. Before implementing, capture a real
  `pane.moved` event (`herdr pane move <id> --new-tab` in a test session while subscribed) and
  record its `data` in this plan's Implementation notes. If it names both the old and new pane
  ids, rewrite matching tiles' `paneId` and save; otherwise moved panes become "This pane is gone.".

### Restore

On reload the serializer reopens each Layout panel from its `layoutId`; a layout deleted
meanwhile closes its panel.

## Validation

- [ ] `npm test` (in `herdr-vscode/`) passes, including unit tests for: target selection (active,
      most recent, none → new); default naming (`Layout 1`, then `Layout 2` when 1 exists);
      add-or-reveal (pane already present → no new component); store round-trip of a config;
      Copy as Layout naming (`agents (v3_auth)`, then `agents (v3_auth) 2`); click command per
      `openPaneIn`
- [ ] Manual: with `openPaneIn` default, clicking an agent in Agents opens `Layout 1` with that
      pane; clicking an agent from a different session adds it to the same layout as a tab in
      the focused stack; dragging it to the right edge makes a side-by-side split
- [ ] Manual: closing a tile in a Layout panel leaves the pane running in herdr (TUI still shows it)
- [ ] Manual: set `herdr.openPaneIn` to `herdr`; clicking a pane opens its mirrored herdr tab
      instead, with that tile focused
- [ ] Manual: **Copy as Layout** on a mirrored tab opens `<tab> (<space>)` with the same
      arrangement; rearranging it does not change herdr's layout (TUI unchanged)
- [ ] Manual: reload the window; open Layout panels come back with the same arrangement and
      reconnect; a closed one is listed by **Open Layout…**
- [ ] Manual: close a pane in herdr that a layout shows; its tile says "This pane is gone." and
      **Remove** removes it
- [ ] Manual: stop the session's herdr; tiles say "Waiting for …"; restart it; tiles of panes that
      still exist reconnect
- [ ] `pane.moved` data recorded in Implementation notes, and the moved-pane behavior matches
      what it allows

## Relevant Files

- `herdr-vscode/package.json` (setting, commands, menus)
- `herdr-vscode/resources/layout.svg` (new)
- `herdr-vscode/src/layouts.ts` (new: store, naming, target selection)
- `herdr-vscode/src/tilesPanel.ts` (layout kind, Copy as Layout, toolbar)
- `herdr-vscode/src/webview/tiles.ts`, `tiles.css` (layout mode, tile states)
- `herdr-vscode/src/views/spacesView.ts`, `agentsView.ts` (click per setting, context menus)
- `herdr-vscode/src/extension.ts`
- `herdr-vscode/src/test/*.test.ts`
- `herdr-vscode/README.md`, `CHANGELOG.md`, `docs/how-it-works.md`
- `.plans/PLAN.md`

## Implementation notes

(Record the captured `pane.moved` event here.)
