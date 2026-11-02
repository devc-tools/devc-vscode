# herdr-vscode: space tabs as the only tile view, with drag-built herdr layouts

Decided by the user on 2026-11-02, after using phases 15–25:

1. Shell panes have no status icon or dot (the dim square read as an empty checkbox).
2. Status dots follow mockup board A (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP,
   `Main.dc.html`): **filled gray = idle**, **empty outline = herdr not running / not connected**.
3. Clicking a pane or agent row opens (or reveals) its space's editor tab and focuses the pane
   there; it never opens a Layout tab.
4. The mirrored panel's toolbar buttons (Copy as Layout, Split Right, Split Down) go; tiles get a
   right-click context menu instead.
5. No breadcrumb; the tab strip starts at the left of the toolbar. Editor tab title is the space
   label for the `default` session, `<session> · <space>` otherwise.
6. **Layout tabs are removed.** herdr's split tree stays the only layout; Golden Layout dragging is
   the nicer way to edit it. Edge drops (split next to a tile), drops on strip entries (move to
   that herdr tab) and on the strip's **+** (move to a new herdr tab) are added. Stacks (several
   panes as GL tabs in one tile), cross-session tiles and sidebar-row drags are **not** offered.

Supersedes [herdr-layout-tabs](herdr-layout-tabs.md) and
[herdr-layout-drag-drop](herdr-layout-drag-drop.md) (add a superseded note to each). Depends on
phases 15, 22 and 25. Paths are under `herdr-vscode/` unless they start with `.plans/`.

## Checklist

- [x] 1. Measure the two-step same-tab move and strip-drop moves on throwaway `hv-test` (see
      Measurements); record results in Implementation notes before writing other code
- [x] 2. Status icons and dots (tree views, tile headers, tab strip) per Status display
- [x] 3. Pane / agent row click → `herdr.openPaneTab`; remove `herdr.openPaneIn`
- [x] 4. Remove Layout tabs: panels, store, commands, menus, placement / tree drag, restore of
      old Layout editors, Copy as Layout
- [x] 5. Toolbar: remove breadcrumb, Split Right, Split Down, Copy as Layout, Rename (layout);
      strip first, left aligned
- [x] 6. Editor tab title rule
- [x] 7. Tile context menu (`webview/context`): Split Right, Split Down, Zoom / Unzoom, Close Pane
- [x] 8. Edge drops within a tab (two-step move), if Measurements allow
- [x] 9. Tile drops onto strip entries and onto **+**
- [x] 10. Tests (list under Validation); delete Layout-only tests
- [x] 11. README, CHANGELOG, `docs/how-it-works.md`; superseded notes in the two Layout plans;
      `.plans/PLAN.md`

## Measurements (step 1)

Same isolated setup as [herdr-mirror-fidelity](herdr-mirror-fidelity.md) step 1 (short `HOME`
such as `/tmp/hvc`, `herdr` in `<home>/.local/bin`, every `HERDR_*` variable stripped,
`herdr --session hv-test server` detached). **Never** touch any session but `hv-test`. Requests via
`bridgeRequest(new LocalShell(), 'hv-test', method, params)` from `out/bridge.js`. Stop the server
and delete the home afterwards.

Setup: space `W`, tab `T` with `p1 | (p2 / p3)` (as in phase 22), plus a second tab `U` with one
pane `q1`.

| # | Request(s) | Record |
| --- | --- | --- |
| M7 | `pane.move` `{"pane_id":p3,"destination":{"type":"new_tab","workspace_id":W,"label":"moving"},"focus":false}` | Result shape (`move_result.changed`, new tab id). `p3`'s `pane_id` / `terminal_id` unchanged? Does `T` keep `p1 | p2`? Does `W`'s `active_tab_id` change? |
| M8 | then `pane.move` `{"pane_id":p3,"destination":{"type":"tab","tab_id":T,"split":"right","target_pane_id":p1,"ratio":0.5},"focus":false}` | `changed:true`? Resulting tree: is `p3` the `second` child of the new split around `p1`? Is `ratio` the `first` child's share? Is the temporary tab gone from the snapshot (auto-closed when empty), or still there? Repeat with `"split":"down"`. |
| M9 | `pane.move` `p2` → `{"type":"tab","tab_id":U,"split":"right"}` (no `target_pane_id`) | Accepted? Where does `p2` land (next to `U`'s focused pane / root)? `T`'s tree after. |
| M10 | `pane.move` `q1` (the only pane of `U`) → `{"type":"tab","tab_id":T,"split":"down","target_pane_id":p1}` | Is `U` closed? Any refusal (`last_pane`?) |
| M11 | `pane.move` `p1` → `{"type":"new_tab","workspace_id":W}` | A new tab holding `p1`; label when `label` omitted. |

Decisions:

- **M7 + M8 work** (pane and terminal ids kept, `changed:true` both times): edge zones are offered
  (`EDGE_ZONES_OFFERED = true`) with the Edge drops contract. If M8 puts the moved pane `first`,
  swap the mapping (right/down become move + swap, left/up a plain move). If the temporary tab is
  not auto-closed, the host closes it with `tab.close` after M8 succeeds.
- **M7 or M8 fails** (refused, or ids change): edge zones stay off (centre swap only, as today);
  write the result in the notes and README. Strip drops (step 9) are independent of this.
- **M9 refused without `target_pane_id`**: send the target tab's first pane in snapshot order as
  `target_pane_id`.
- **M10 refused**: dropping the last pane of a tab elsewhere is not offered (no drag starts from a
  one-pane tab's tile onto the strip). Within the tab there is nothing to drop on anyway.

## Contracts

### Status display

| Thing | State | Tree icon (codicon, color) | Webview dot (`.tile-dot-*`) |
| --- | --- | --- | --- |
| Agent pane | blocked | `circle-filled`, `charts.orange` | `blocked` (unchanged) |
| Agent pane | working | `circle-filled`, `charts.blue` | `working` (unchanged) |
| Agent pane | done | `circle-filled`, `charts.green` | `done` (unchanged) |
| Agent pane | idle, unknown | `circle-filled`, `disabledForeground` | `idle`: filled, `var(--vscode-disabledForeground)` |
| Shell pane (no agent) | — | **none** (`iconPath` undefined) | **no dot element** |
| Space row, session row (connected) | worst agent status | as the agent rows | — |
| Space row, session row (connected, no agents) | idle | `circle-filled`, `disabledForeground` | — |
| Session row (not running, disconnected, connecting, error) | off | `circle-outline` (no color) | — |
| Strip entry (herdr tab) | worst agent status of its panes | — | as the agent dot |
| Strip entry, tab with no agents | — | — | **no dot element** |
| Spaces **tab** rows | — | none (unchanged) | — |

- `statusIcon(undefined)` keeps meaning "off" (outline); connected rows with no agents pass
  `'idle'`. Rows configured without `state_icon` (sidebar config) still get no icon.
- The `.tile-dot-shell` rule is deleted. `TileMeta.status` / `StripTab.status` keep the `'shell'`
  value; the webview renders it as no dot (remove an existing dot element when the status becomes
  `shell`).
- The status bar's focused-pane item (`focus.ts`) is unchanged.

### Row clicks

- Spaces pane rows, Agents rows and Pane Context pane rows always run `herdr.openPaneTab`
  `[sessionKey, paneId]` (open or reveal the space's panel, `tab.focus` if needed, focus the tile).
  Ask Agent's "show agent" (`agentReview.ts`) does the same.
- Setting `herdr.openPaneIn` is removed from `package.json` and code; listeners on it go.
  `paneClickCommand` keeps no `target` parameter.

### Layout tabs removed

- Delete: `src/layouts.ts`, `src/paneDrag.ts`, `src/webview/glDrop.ts`, `LayoutPanel`, the
  placement plumbing in `tilesPanel.ts` / `tiles.ts` / `tilesProtocol.ts` (`placePane`,
  `placeHover`, `placed`, `placeCancel`, `tileMovedIn`, `addTile`, `layoutChanged`,
  `renameLayout`, `copyAsLayout`, the `layout` state kind), the `#place-*` and `.layout-only`
  markup and CSS, and the tests `layouts.test.ts`, `layoutPanels.test.ts`, `paneDrag.test.ts`,
  `liveLayouts.test.ts`, `liveDrag.test.ts`. Keep anything `layoutMapping.ts` needs for mirrors;
  drop its Layout-only exports.
- Commands removed from `package.json` (definitions, menus, `commandPalette` entries) and code:
  `herdr.addToLayout`, `herdr.newLayout`, `herdr.openLayout`, `herdr.renameLayout`,
  `herdr.deleteLayout`, `herdr.cancelPlacement`. Remove any `herdr.placing`-style context key
  they set. Trees no longer get a `dragAndDropController`.
- Restore: a webview restored with state `{"kind":"layout",…}` (saved by earlier builds) is
  disposed at once, no message. On activation, `context.workspaceState.update('herdr.layouts',
  undefined)` clears the old store.

### Toolbar

- Markup: `#toolbar` holds only `#strip` (with its **+**). Remove `#breadcrumb`, `#copy-layout`,
  `#split-right`, `#split-down`, `#rename-layout`. The `breadcrumb` field leaves the `meta`
  message.
- `#strip` is left aligned, takes the full toolbar width (`max-width` 100%), scrolls as today.

### Editor tab title

- Session name = the connection's herdr session name (`name` from the session list).
- `name === 'default'` → title `<space label>`. Otherwise → `<session name> · <space label>`.
- Updates on space rename, as today. Panels waiting for a connection keep their current
  "Connecting…" title behavior.

### Tile context menu

- Each tile's host element (the element containing the terminal, including its GL header tab)
  carries `data-vscode-context`
  `{"webviewSection":"tile","paneKey":"<sessionKey|paneId as today>","zoomed":<bool>,"preventDefaultContextMenuItems":true}`;
  `zoomed` is updated when zoom changes. Empty / message areas carry nothing (VS Code's default
  menu, i.e. none for a webview).
- Commands (category `herdr`, all hidden from the Command Palette with `"when": "false"`):

  | Command | Title | Menu `when` | Group | Action |
  | --- | --- | --- | --- | --- |
  | `herdr.tile.splitRight` | Split Right | `webviewId == 'herdr.tiles' && webviewSection == 'tile'` | `1_split@1` | `pane.split` `{"target_pane_id","direction":"right","cwd"?,"focus":false}` |
  | `herdr.tile.splitDown` | Split Down | same | `1_split@2` | same with `"down"` |
  | `herdr.tile.zoom` | Zoom | `… && !zoomed` | `2_view@1` | `pane.zoom` via `zoomRequests` (another pane's zoom off first) |
  | `herdr.tile.unzoom` | Unzoom | `… && zoomed` | `2_view@1` | `pane.zoom` `{"pane_id","mode":"off"}` |
  | `herdr.tile.close` | Close Pane | same as split | `3_close@1` | the existing modal confirm, then `pane.close` |

- The command argument is the context object (`{ webview, webviewSection, paneKey, zoomed }`).
  Route by `paneKey` to the `MirrorPanel` whose space shows that pane; with none, warn
  `herdr: that pane is not available.`. `cwd` for splits = the pane's `foreground_cwd ?? cwd`.
- **Gotcha:** right-click in xterm also selects a word on some platforms; leave that alone. The
  webview must not call `preventDefault` on `contextmenu` for tiles, or VS Code's menu never shows.
- GL header controls (maximise, close) stay.

### Tile drags (mirror panels)

All drops go through the existing `movePane` message path (`dropRequests` in `mirrorEdit.ts`
builds the request list); every refusal → warning `herdr: <reason>` and a re-export. Drags are
ignored while the shown tab is zoomed (as today). Only tiles of this panel are draggable.

**Edge drops** (only if M7 + M8 work): zone `left|right|top|bottom` on target tile `t`, dragged
pane `s` (≠ `t`), shown tab `T`, space `W`:

1. `pane.move` `{"pane_id":s,"destination":{"type":"new_tab","workspace_id":W,"label":"<s's pane label>"},"focus":false}`
2. `pane.move` `{"pane_id":s,"destination":{"type":"tab","tab_id":T,"split":<"right" for left/right, "down" for top/bottom>,"target_pane_id":t,"ratio":0.5},"focus":false}`
3. zone `left` or `top`: `pane.swap` `{"source_pane_id":s,"target_pane_id":t}`
4. temporary tab still in the snapshot (per M8): `tab.close` on it

If step 2 fails, do not retry: warning
`herdr: the pane could not be moved back; it is in tab "<label>".` and leave it there.
Exported tab changes during the sequence are applied normally; the shown tab must not switch to
the temporary tab (`focus:false`; if `active_tab_id` changed per M7, the pending-tab rule holds the
shown tab).

The drop indicator for edge zones: half of the target tile on that side, the same highlight style
the centre swap uses.

**Strip drops:** while a tile drag is in progress, strip entries and **+** are drop targets
(highlight with `--vscode-list-dropBackground`):

- Entry for another tab `X` → `pane.move` `{"pane_id":s,"destination":{"type":"tab","tab_id":X,"split":"right"(,"target_pane_id" per M9)},"focus":false}`.
  The panel keeps showing `T`.
- The shown tab's own entry → no-op.
- **+** → `pane.move` `{"pane_id":s,"destination":{"type":"new_tab","workspace_id":W},"focus":false}`.
- Dragging the only pane of `T` onto the strip: allowed only if M10 / M11 are accepted; then `T`
  closes and the panel follows `active_tab_id` as today.

## Validation

- [x] `npm run build && npm run lint` (in `herdr-vscode/`) pass
- [x] `xvfb-run -a npm test` (in `herdr-vscode/`) passes, including unit tests for:
      `statusIcon` / tree items (idle agent → `circle-filled` + `disabledForeground`; shell pane →
      no icon; connected session with no agents → gray filled; disconnected session → outline);
      pane, agent and Pane Context row commands are `herdr.openPaneTab`; `dropRequests` for each
      edge zone (the four-step list, or `[]` if edge zones are off) and for strip entry / **+**
      drops; title rule (`default` → space label; `work` → `work · <space>`); restored
      `{"kind":"layout"}` state → panel disposed; tile context commands route by `paneKey` and send
      `pane.split` / `pane.zoom` / `pane.close` with the params above (modal skipped by the
      test-only argument)
- [x] Webview probe (extend `spacePanels.test.ts`): toolbar has no `#breadcrumb`, `#copy-layout`,
      `#split-right`, `#split-down`; a shell tile and a no-agent strip entry have no
      `.tile-dot`; an idle agent tile has `.tile-dot-idle`; each tile host has a
      `data-vscode-context` with `webviewSection` `tile` and its `paneKey`
- [x] Opt-in live suite against `hv-test` (extend `liveMirrorEdit.test.ts`): edge drop right and
      top rearranges `T` with the same `pane_id`s and `terminal_id`s and leaves no extra tab (or,
      if edge zones are off, this item is replaced by "edge zones not offered" in the notes); drop
      on another strip entry moves the pane to that tab; drop on **+** creates a tab with the pane
- [x] `grep -rn --exclude-dir=test 'openPaneIn\|addToLayout\|newLayout\|cancelPlacement\|copy-layout\|id="breadcrumb"\|breadcrumbEl' herdr-vscode/src herdr-vscode/package.json` prints nothing
      (narrowed while implementing: "breadcrumb" also names the Agents rows' `space › tab` text, and the
      tests name the removed commands to check they are gone)
- [x] `grep -n '"herdr.tile.splitRight"' herdr-vscode/package.json` prints the command and its
      `webview/context` entry
- [ ] Manual: no square anywhere; idle agents and idle sessions show a filled gray dot; a stopped
      session shows an empty circle
- [ ] Manual: clicking an agent in Agents opens / reveals its space's editor tab, switches to the
      pane's herdr tab and focuses the tile; no other editor tab opens
- [ ] Manual: right-click a tile → Split Right / Split Down / Zoom / Close Pane each act in herdr
- [ ] Manual: toolbar shows only the tab strip at the left; editor tab titled `<space>` for the
      default session and `<session> · <space>` for a named one
- [ ] Manual: drag a tile to another tile's edge, onto another strip entry and onto **+**; the
      herdr TUI shows each change and the terminals keep running
- [ ] Manual: a Layout editor tab left open by the previous build disappears after reload

## Relevant Files

- `herdr-vscode/package.json` (remove Layout commands, menus, `herdr.openPaneIn`; add
  `herdr.tile.*` commands, `webview/context` menus, `commandPalette` hides)
- `herdr-vscode/src/status.ts` (idle color, off = outline)
- `herdr-vscode/src/views/spacesView.ts` (shell icon none, row commands, no `openPaneIn`, no drag
  controller)
- `herdr-vscode/src/views/agentsView.ts` (row commands, no `openPaneIn`, no drag controller)
- `herdr-vscode/src/views/sessionsView.ts` (connected / no agents → idle)
- `herdr-vscode/src/paneContext.ts` (row commands, no `openPaneIn`, no drag controller)
- `herdr-vscode/src/agentReview.ts` (show agent → `herdr.openPaneTab`)
- `herdr-vscode/src/extension.ts` (Layout commands and placement out; `herdr.tile.*` in; clear
  `herdr.layouts`; no `PaneDragController`)
- `herdr-vscode/src/tilesPanel.ts` (remove `LayoutPanel`, placement, Copy as Layout; title rule;
  context-menu routing; edge and strip drops; dispose restored layout panels)
- `herdr-vscode/src/tilesProtocol.ts` (remove Layout messages and state; `meta` without
  `breadcrumb`; strip-drop message fields)
- `herdr-vscode/src/mirrorEdit.ts` (`EDGE_ZONES_OFFERED` per M7/M8; `dropRequests` for edges and
  strip targets)
- `herdr-vscode/src/layoutMapping.ts` (drop Layout-only exports)
- `herdr-vscode/src/webview/tiles.ts`, `herdr-vscode/src/webview/tiles.css` (toolbar, dots,
  `data-vscode-context`, strip drop targets, edge indicator; Layout and placement code out)
- Delete: `herdr-vscode/src/layouts.ts`, `herdr-vscode/src/paneDrag.ts`,
  `herdr-vscode/src/webview/glDrop.ts`, `herdr-vscode/src/test/layouts.test.ts`,
  `herdr-vscode/src/test/layoutPanels.test.ts`, `herdr-vscode/src/test/paneDrag.test.ts`,
  `herdr-vscode/src/test/liveLayouts.test.ts`, `herdr-vscode/src/test/liveDrag.test.ts`
- Tests to update: `herdr-vscode/src/test/views.test.ts`, `extension.test.ts`,
  `mirrorPanels.test.ts`, `spacePanels.test.ts`, `mirrorEdit.test.ts`, `layoutMapping.test.ts`,
  `paneContext.test.ts`, `agentReview.test.ts`, `liveMirrorEdit.test.ts`, `liveSpaces.test.ts`,
  `liveTiles.test.ts`, `livePaneContext.test.ts`, `bridge.test.ts` (wherever they reference
  Layout, `openPaneIn`, the breadcrumb or the shell dot)
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md`
- `.plans/herdr-layout-tabs.md`, `.plans/herdr-layout-drag-drop.md` (superseded notes),
  `.plans/PLAN.md`

## Implementation notes

### Measurements (2026-11-02, herdr 0.9.5, throwaway `hv-test` in `HOME=/tmp/hvc`)

Tab `T` = `p6 | (p7 / p8)`, tab `U` = `p9`.

- **M7** `pane.move p8 → new_tab "moving"` → `{"type":"pane_move","move_result":{"changed":true,…,"pane":{"pane_id":"w1:p8","terminal_id":<same>,"tab_id":"w1:t6",…},"source_layout":{…}}}`.
  `T` became `p6 | p7`; the space's `active_tab_id` did **not** change.
- **M8** `pane.move p8 → {"type":"tab","tab_id":T,"split":"right","target_pane_id":p6,"ratio":0.3}` → `changed:true`,
  `T` = `((p6 right@0.3 p8) right@0.5 p7)`: the moved pane is the **`second`** child of a new split
  around the target, and `ratio` is the **first** child's share. The temporary tab was **auto-closed**
  (gone from the next snapshot). `split:"down"` the same with a down split. `pane_id` and
  `terminal_id` unchanged throughout.
- **M9** `pane.move p7 → {"type":"tab","tab_id":U,"split":"right"}` (no `target_pane_id`) → accepted,
  `U` = `(p9 right@0.5 p7)`.
- **M10** moving a pane into another tab and the last pane out of a tab: accepted; an emptied tab
  closes (as M8's temporary tab shows).
- **M11** `pane.move p6 → {"type":"new_tab","workspace_id":W}` without `label` → a new tab labelled
  with its number (`6`).

**Decisions:** edge zones offered (`EDGE_ZONES_OFFERED = true`); mapping as planned (right/down = a
move, left/up = move + swap); no `tab.close` needed after the move back; strip drops send no
`target_pane_id`; dragging a tab's only pane onto the strip is allowed (its tab closes).

### Status (2026-11-02)

Implemented; the Manual items above were not run, since they need a person in VS Code with a herdr TUI to
watch. The plan stays out of `archived/` until that pass.

### Verified

- `npm run build && npm run lint && xvfb-run -a npx vscode-test` (in `herdr-vscode/`): 289 passing, 57 pending
  (opt-in live suites), 0 failing. `npm ci` was needed first: the installed esbuild binary was for another platform.
- Live, throwaway `hv-test` in `HOME=/tmp/hvc` (one workspace; stopped and removed afterwards, real sessions
  untouched), three full runs: 340 / 337 / 339 passing. The new live tests passed every time: an edge drop
  left (`(right (right p3 p1) p2)`, shown ~400 ms after the drop, every `pane_id` and `terminal_id` kept, no extra
  tab left), top, centre, and **+** / strip-entry drops.
- Failures in those runs, none in code this plan touched:
  - `live model … lists only the isolated session`: always (the home also lists `default` and `hv-ctl`), as before.
  - `liveSpaces` setup "space in snapshot" (2 of 3 runs) and `liveTiles` "tile headers follow the model"
    (1 of 3): the snapshot flakes recorded in [herdr-space-tabs](herdr-space-tabs.md).
  - `livePaneContext` "a pinned pane follows a real move to another workspace" (2 of 4 runs including one
    run of that suite alone): `view.followed` did not reach the new key within 5 s. With a 1.5 s pause added
    it had moved (logged once). The pin moves only on the `pane.moved` event, so this looks like the same
    event/snapshot lag; not root-caused. Before this plan, the pane in that test was in a Layout tab; it is now
    in a space tab, which drops the pane when it leaves the space. That is not proven to be unrelated.
  - The Pane Context links tests failed once when that suite ran alone (`--grep`), and passed in all full runs.

### Deviations and decisions

- `parsePaneMoved` moved from the deleted `layouts.ts` to `src/sessions.ts`.
- A host-requested `focusTile` now reports the focus itself (Layout tabs did this; row clicks need it).
- `sessionRowStatus` exported from `sessionsView.ts` for testing the session icon.
- `resources/layout.svg` deleted; `keybindings` removed from `package.json` (its only entry was Cancel Placing).
- Probe additions: `toolbar`, per-tile `dot` and `context` (the `grip` field is gone); action `dragTileToStrip`.
- The edge drop indicator is the existing half-tile highlight; strip targets use `--vscode-list-dropBackground`.
