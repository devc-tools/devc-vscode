# herdr-vscode: Layout tabs (panes as units)

Mockup board D (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): besides mirrored herdr tabs,
the user builds **Layout tabs**: named editor tabs holding any panes, from any space or session,
arranged freely with Golden Layout (stacks, drag, maximise). The layout belongs to VS Code;
herdr's own tabs and splits are never changed by it. The setting `herdr.openPaneIn` decides
whether clicking a pane puts it in a Layout tab (default) or opens its mirrored herdr tab.

Depends on [herdr-mirrored-tabs](herdr-mirrored-tabs.md) (webview bundle, streams, focus).
Paths are under `herdr-vscode/`.

## Checklist

- [x] 1. Layout store in workspace state; create, open, rename, delete
- [x] 2. Layout panels: same `herdr.tiles` view type and bundle, `kind: "layout"`, full Golden
      Layout interaction
- [x] 3. `herdr.addToLayout`: add or reveal a pane in the target Layout tab
- [x] 4. `herdr.openPaneIn` setting and click behavior of pane and agent rows
- [x] 5. **Copy as Layout** in the mirrored panel's toolbar
- [x] 6. Tile states for missing panes and disconnected sessions; pane-move follow-up
- [x] 7. Restore across reloads
- [x] 8. Tests (list under Validation)
- [x] 9. README, CHANGELOG, `docs/how-it-works.md`

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

- [x] `npm test` (in `herdr-vscode/`) passes, including unit tests for: target selection (active,
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
- [x] `pane.moved` data recorded in Implementation notes, and the moved-pane behavior matches
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

### Status (2026-10-30)

Implemented; the Manual items above were not run, because they need a person in VS Code, so they stay
unticked and the plan stays out of `implemented/`. Evidence for them, which does not replace them, is
below. No Docker and no SSH host here; only sessions on this machine were exercised live.

### Captured `pane.moved` (herdr 0.9.5)

Captured from `events.subscribe` on throwaway `hv-test`. Inside a workspace (`herdr pane move w1:p2 --new-tab`) the id stays:

```json
{"created_tab":{"tab_id":"w1:t2","label":"2","workspace_id":"w1",…},
 "pane":{"pane_id":"w1:p2","tab_id":"w1:t2","terminal_id":"term_65f1a89d2393a2","workspace_id":"w1",…},
 "previous_pane_id":"w1:p2","previous_tab_id":"w1:t1","previous_workspace_id":"w1","type":"pane_moved"}
```

To another workspace (`--new-workspace`) the id changes and the terminal does not:

```json
{"closed_tab_id":"w1:t2","created_tab":{"tab_id":"w2:t1",…},"created_workspace":{"workspace_id":"w2","label":"space2",…},
 "pane":{"pane_id":"w2:p1","tab_id":"w2:t1","terminal_id":"term_65f1a89d2393a2","workspace_id":"w2",…},
 "previous_pane_id":"w1:p2","previous_tab_id":"w1:t2","previous_workspace_id":"w1","type":"pane_moved"}
```

So it names both ids, and tiles are rewritten (`parsePaneMoved`, `rewritePane`), in every saved layout,
open or closed. A `terminal session control` attached by the old id during the move kept running
(it ended `detached` on our release). A move while the extension is not running is not seen: that tile
says "This pane is gone.".

Also measured: `herdr server stop` then a new server keeps workspaces and **pane ids**, with new
`terminal_id`s and new shells. A controller at shutdown gets `terminal.closed` `server is shutting down`.

### Verified

- `npm run build && npm run lint && xvfb-run -a npm test`: 102 passing, 29 pending (opt-in live suites).
  `npx vsce ls` lists `resources/layout.svg`, and no `node_modules`. `git diff --stat -- devc-vscode` is
  empty. The default run includes `src/test/layoutPanels.test.ts`: real webviews with Golden Layout and
  xterm running, over a made-up model, spawning nothing (the stream resolver finds no session).
- With `HERDR_VSCODE_LIVE_HOME` on throwaway `hv-test` in an isolated `HOME`: 127 passing, 4 pending
  (`live.test.ts`, which needs `HERDR_VSCODE_LIVE_SESSION`, and `HERDR_VSCODE_LIVE_STOP`). The new
  `src/test/liveLayouts.test.ts` covers, against real herdr: panes painted and typed into; stacked and
  dragged apart with `layout.export` unchanged; a pane in a mirror and a layout on one controller; Copy
  as Layout of a real mirror, rearranged with `layout.export` unchanged; tile closed with the pane still
  in the snapshot and its controller gone; a real cross-workspace `pane move`, with the tile on the new
  id showing the old screen, typing working, old controller gone and the new id saved; `pane.close` to
  *This pane is gone.* and Remove; `server stop` to *Waiting for …* with no controllers, a new server,
  the tile reconnecting and taking input; closing the tab with no controller left, and reopening it.
- Framebuffer screenshot of a Layout tab in the Extension Development Host: toolbar `"Layout 1" · layout`
  and Rename, tile headers with dot, label and faded `space · session`, a tab X, *Waiting for …* and *This
  pane is gone.* with Remove; the tab's 2×2 icon. Of a mirrored tab: Copy as Layout, Split Right, Split Down.

Not exercised at all, each one needing a person or a real window:

- The prompts of New, Open, Rename and Delete Layout (input box, quick pick, modal). `TilesPanels`' methods
  behind them are tested; the test host refuses modals. The toolbar's Rename and Copy as Layout buttons
  are wired, and their messages tested, but no real click on them was tried.
- A real tree click and context menu. Tree items' commands and `package.json` menus are tested as data,
  and the commands by direct calls.
- Real mouse dragging. The drag is synthetic pointer events through Golden Layout's own listener, to the
  right edge; other drop zones were not tried. Maximise was not tried.
- A real window reload (`deserializeWebviewPanel` was called directly) and `pagehide` saving.
- Two real sessions at once: sessions other than `hv-test` were only in the made-up model.
- A screenshot's dropdown of a crowded stack (the arrow showed; the list's styling was not seen open).

### Deviations and decisions

- **Mirror fix, in `layoutMapping.ts`.** `settings.reorderEnabled: false` did not stop a mirrored tile
  being dragged: `Tab` reads the component's `reorderEnabled` first, and a component without one resolves
  to `true`. Mirror components now carry `reorderEnabled: false`, and Copy as Layout has to turn it on per
  component as well as in the settings. Checked: without the line, the new test fails with the tile moved.
- `herdr.newLayout` "in the herdr view container title": VS Code has no menu for a view container, so it
  is on `view/title` of the first view, `herdr.sessions`.
- Target panel and add-or-reveal: the host picks the panel, and the **webview** decides reveal or add
  from its live layout (`addPlacement`), since the host's copy is up to 500 ms old.
- "else into the root as a new stack on the right" works on config: a root row gets a new column
  of `100/(n+1)`% with the others scaled, any other root is wrapped in a row at 50/50, then `loadLayout`.
  Golden Layout has no public call for wrapping the root.
- A saved layout that has never had a tile holds a short form with no `root` and no `resolved: true`, because
  the host cannot make a `ResolvedLayoutConfig` without loading Golden Layout. It is replaced on the first
  `stateChanged`.
- `stateChanged` does not fire when the only stack closes through its X, so the webview also listens to
  `itemDestroyed`.
- While a tile is dragged (`.lm_dragProxy` present), nothing saves, no terminal goes, and no size is sent,
  or the pane's pty would take the proxy's size.
- A tile behind another tab has no size, and announces itself only when it first comes to the front. So a
  restored stack opens streams for its front tiles only; once announced a tile keeps its stream behind others.
- A tile that follows a moved pane has a new `Terminal` on a new stream rather than being re-keyed: the first
  frame is full, so nothing is lost. For up to about 150 ms, until the next snapshot has the new id, it can
  say *This pane is gone.*.
- A `waiting` or `gone` tile has its xterm reset, since the overlay is 95% opaque.
- Tile close in a Layout panel is Golden Layout's own, with middle-click too; the stack's X closes the whole
  stack, as `showCloseIcon: true` gives. `paneKeyAt` now finds the tab's pane or the stack's visible tile.
- An empty layout shows a hint, by CSS, to click a pane. `resources/layout.svg` strokes `#808080`, since an
  icon rendered as an image gets no `currentColor`, and must show on light and dark themes.
- The status bar click reveals the tile in the panel that last had a tile focused (`lastFocus`), across both kinds.
- `src/layouts.ts` is imported by the webview bundle too, so it has no `vscode` or Node import.
- Packages: nothing installed. `node_modules/@esbuild/` still has both `darwin-x64` and `linux-x64`.

### For herdr-pane-context

- `TilesPanel` in `src/tilesPanel.ts` holds the shared plumbing; a new webview message for terminal links
  goes in its `onMessage`, and `createTile` in `src/webview/tiles.ts` is still where a link provider goes, for both kinds.
- `FocusTracker.onDidChangeLastFocused` fires for tiles in Layout panels as well, and panes there may be from
  any session. Reveal with `TilesPanels.revealPane(sessionKey, paneId)`, which covers both kinds.
- **A pane key is not stable.** A move to another workspace changes the `pane_id` (the terminal stays;
  `parsePaneMoved` in `src/layouts.ts` reads the event). If a followed or pinned pane should survive that, it
  must listen for `pane.moved` too: `lastFocused` moves to the new key only when the moved tile had the focus.
  `SnapshotPane` has no `terminal_id`; a server restart keeps pane ids and changes terminals.
- A connected session whose snapshot lacks the pane is a pane that is gone; no connected snapshot says nothing
  either way (`paneAvailability`).
