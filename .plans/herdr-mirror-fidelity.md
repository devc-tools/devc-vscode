# herdr-vscode: mirrored tabs mirror both ways (ratios, moves, zoom)

Mockup board D (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP), "Mirrored herdr tab … Always
mirrors herdr, both ways", and its table row "Drag a pane … within a mirrored tab = herdr pane
move". Phase 15 sends only split and close to herdr: splitter drags and maximise are local and are
reset by the next real change. This plan makes the rest of a mirrored tab's layout two-way:

1. A splitter drag sets herdr's split ratio; herdr's ratio changes resize the tiles in place.
2. Dragging a tile onto another tile of the same tab moves or swaps the pane in herdr.
3. Maximise ↔ herdr zoom.

Layout tabs ([herdr-layout-tabs](herdr-layout-tabs.md)) are not changed: they never touch herdr.

Depends on [herdr-mirrored-tabs](herdr-mirrored-tabs.md) (phase 15) and
[herdr-layout-tabs](herdr-layout-tabs.md) (phase 16). Paths are under `herdr-vscode/`. Read phase
15's and 16's Implementation notes first, especially "A re-export whose split tree is unchanged is
**dropped**" and "Mirror fix, in `layoutMapping.ts`" (`reorderEnabled: false` per component).

devc web (`/workspaces/tools/devc-tools/devc/web/`) does not sync ratios, moves or zoom, so there is
no prior art to reuse; the herdr semantics below come from herdr 0.9.5's bundled API schema
(`herdr api schema --json`) and must be confirmed by step 1.

## Checklist

- [ ] 1. Measure herdr 0.9.5 on throwaway `hv-test` (see Measurements) and record the results in
      this plan's Implementation notes before writing any other code
- [ ] 2. `src/mirrorEdit.ts` (new, no `vscode`/Node/DOM imports): split paths, ratio diffing, drop
      zones, the request lists for a drop and for a zoom change
- [ ] 3. `src/layoutMapping.ts`: split items carry `id` `split:<path>`; structure key without ratios;
      ratios by path; `layoutShape` replaced
- [ ] 4. `src/tilesProtocol.ts`: new host and webview messages, new probe actions and probe fields
- [ ] 5. Split ratios, VS Code → herdr: webview reports splitter drags; host sends
      `layout.set_split_ratio`
- [ ] 6. Split ratios, herdr → VS Code: a re-export with the same structure but new ratios resizes the
      tiles in place (no `loadLayout`)
- [ ] 7. Tile drag in mirrored panels: own drag-and-drop overlay, drop zones, `movePane` →
      `pane.swap` / `pane.move`
- [ ] 8. Zoom: GL maximise ↔ herdr `pane.zoom` / export `zoomed`
- [ ] 9. Copy as Layout drops the mirror-only parts (`split:` ids, `maximised`)
- [ ] 10. Tests (list under Validation)
- [ ] 11. README (mirrored tab bullets), CHANGELOG, `docs/how-it-works.md` (Layout mapping, new
      "Editing herdr's layout" section)

## Measurements (step 1)

Do **not** use any session but `hv-test`, and never run herdr against the default session. Use the
isolated-home setup the live suites use (README, "Opt-in suites"): a short `HOME` such as
`/tmp/hvh`, `herdr` in `<home>/.local/bin`, every `HERDR_*` variable stripped from the environment,
`herdr --session hv-test server` started detached, one workspace. Send requests through
`bridgeRequest(new LocalShell(), 'hv-test', method, params)` from `out/bridge.js` (as
`src/test/liveTiles.test.ts` does) and capture events from `events.subscribe` the way phase 16
captured `pane.moved`. Afterwards stop that server (`herdr --session hv-test server stop`) and delete
the home directory. If `node_modules/golden-layout` is missing, run `npm ci` first.

Set up a tab `T` with panes `p1 | (p2 / p3)`: `tab.create`, `pane.split p1 right` → p2,
`pane.split p2 down` → p3 (export: root split right, `second` a split down).

| # | Request | Record |
| --- | --- | --- |
| M1 | `layout.set_split_ratio` `{"tab_id":T,"path":[],"ratio":0.3}` then `{"tab_id":T,"path":[true],"ratio":0.7}` | The export after each: which split changed. Expected: `[]` is the root, `true` picks `second`. Also `ratio` `0`, `1`, `1.5`: error code (`invalid_ratio`?) or clamped value. Whether `layout.updated` is emitted, and its `data.layout.splits[].id` format. The result is `{"type":"layout_split_ratio_set","layout":{…export shape…}}`. |
| M2 | `pane.move` `{"pane_id":p3,"destination":{"type":"tab","tab_id":T,"split":"right","target_pane_id":p1,"ratio":0.5},"focus":false}` | Result `{"type":"pane_move","move_result":{changed,reason,…}}`: does a same-tab move work (`changed:true`) or is it refused (`reason:"same_tab"`)? Resulting tree: is the moved pane the `second` child of the new split, and is `ratio` the `first` child's share? `pane_id` and `terminal_id` unchanged? Repeat with `"split":"down"`. |
| M3 | `pane.swap` `{"source_pane_id":p1,"target_pane_id":p3}` | Result `{"type":"pane_swap","swap":{changed,reason,…}}`; tree after: the two pane ids exchanged, ratios kept? Focus moved? |
| M4 | `pane.zoom` `{"pane_id":p2,"mode":"on"}`, then `{"pane_id":p3,"mode":"on"}`, then `{"pane_id":p3,"mode":"off"}`; also `on` in a one-pane tab | Result `{"type":"pane_zoom","zoom":{changed,zoomed,pane_id,focused_pane_id,reason,…}}`. Export after each: `zoomed`, `focused_pane_id` (expected: zooming focuses the pane, and the zoomed pane is `focused_pane_id`). Which event fires (`layout.updated`? `pane.focused`?). Does `on` for p3 while p2 is zoomed move the zoom, or answer `already_zoomed`? One-pane tab: `reason:"single_pane"`. |
| M5 | M2 while the tab is zoomed | Expected refusal `reason:"zoomed_tab"`. |
| M6 | Only if M2 is refused: `layout.apply` `{"tab_id":T,"root":<export tree with p3 moved>,"focus":false}` | Does it rearrange the existing panes in place (same `pane_id`s and `terminal_id`s, no pane closed or created, same tab id)? |

Decisions that depend on the measurements (apply them, and write what was measured):

- M1 path meaning differs from "`[]` root, `true` = second": invert the conversion in `mirrorEdit.ts`
  and say so in the notes. Ratios out of `[0,1]` are never sent (see clamping below) whatever M1 shows.
- M2 places the moved pane `first`: swap the zone mapping below (right/down become move + swap,
  left/up a plain move).
- M2 refused (`same_tab`): if M6 rearranges in place, edge drops send one `layout.apply` with the
  rearranged tree (built from the last export; moved pane's split at ratio 0.5) instead of the
  `pane.move` (+ `pane.swap`) list. If M6 does not, edge zones are **not offered** (only the centre
  swap), and the README says so.
- M4 `on` for another pane answers `already_zoomed` without moving the zoom: the host sends `off` for
  the zoomed pane first (already prescribed below; keep it either way).

## Contracts

### Split paths and Golden Layout ids

- A split's **path** is the list of choices from the root of the export tree: each step is `first`
  or `second`. The root split's path is empty.
- **Path key** (messages, GL ids): one character per step, `0` = `first`, `1` = `second`; the root is
  `""`.
- herdr's `path` param: a JSON array of booleans, `true` = `second` (`"01"` → `[false,true]`; `""` →
  `[]`). M1 confirms this.
- `mirrorConfig` gives every `row` / `column` it makes `"id":"split:<path key>"` (root `"split:"`).
  Golden Layout keeps `id` on the item (`ContentItem.id`) and in `saveLayout()`. The webview finds a
  split by this id, never by walking the tree and assuming shape. Stacks and components get no id.

### Re-export handling (replaces "unchanged tree is dropped")

The host keeps, per mirror panel, from the last applied export: the **structure key** (the tree as
JSON with `ratio` removed from every split), the **ratios** by path key, and the **zoomed pane**
(`focused_pane_id` when `zoomed` is `true`, else none).

On every export (same triggers and 100 ms debounce as phase 15):

1. Structure key changed (panes added, removed, moved, swapped, direction changed) → post `layout`
   (full `mirrorConfig`, `loadLayout`), then `zoom`. Store everything.
2. Same structure → for each path whose herdr ratio differs from the stored one by more than
   **0.005** and which has no `set_split_ratio` in flight, post one
   `{"type":"ratios","ratios":{"<path key>":<ratio>,…}}` (only the changed paths; nothing when none).
   Store the new ratios.
3. Zoomed pane changed → post `zoom`. Store it.

herdr's ratios are `f32` in JSON (`0.6` may come back as `0.6000000238418579`); always compare with
the 0.005 tolerance, never `===`.

### Split ratios: VS Code → herdr

- Webview (mirror panels only): a pointerdown on a `.lm_splitter` arms a flag; the first
  `stateChanged` after the matching pointerup (Golden Layout applies the new sizes on drag stop,
  one animation frame later) reads every split item: `ratio = first.size / (first.size +
  second.size)`. Splits whose ratio differs by more than 0.005 from the webview's **applied** ratio
  (from the last `layout` config or `ratios` message, or the last one it reported) are posted 150 ms
  after that `stateChanged` as `{"type":"setRatios","ratios":{"<path key>":<ratio>,…}}`, and become
  the applied ratio. `stateChanged` without a splitter drag (window resize, focus, maximise, our own
  `ratios` message) posts nothing.
- Host: for each entry, in order, request `layout.set_split_ratio` with params
  `{"tab_id":"<tab>","path":[<booleans>],"ratio":<r>}` where `r` is the ratio clamped to
  `[0.05, 0.95]` and rounded to 3 decimals. The path is **in flight** until the answer.
  - Answer `{"type":"layout_split_ratio_set","layout":{…}}` (parse with `parseLayoutExport`, which
    reads `raw.layout`): store its ratio for that path; if it differs from `r` by more than 0.005
    (herdr clamped it), post `ratios` with herdr's value.
  - Error (`invalid_ratio`, `split_not_found`, …): log `<session>: layout.set_split_ratio <tab>
    <path key> failed: <message>`, post `ratios` with the stored herdr ratio for that path (the
    splitter snaps back), and schedule a re-export.

### Split ratios: herdr → VS Code

`ratios` message → for each path key, the split item with id `split:<key>`: set its two children's
`size` to `ratio×100` and `(1−ratio)×100` (`sizeUnit` stays `%`), then call that item's
`updateSize(false)`. Skip a path whose current ratio is within 0.005. No `loadLayout`, so terminals,
focus and scrollback are untouched. While a drag is running (`document.body` has `lm_dragging`, or
our own tile drag), keep the message and apply it on the next `pointerup`.

### Tile drag (mirror panels only)

Golden Layout's own drag stays off (components keep `reorderEnabled: false`): its drop always builds
GL stacks and rows that herdr cannot hold, and it cannot be told the drop zone. The webview runs its
own:

- **Start:** pointerdown (button 0) on a tile's `.lm_tab` (not on `.lm_close_tab` or
  `.lm_controls`), then a move of more than 10 px. Not started when the layout has one tile or a stack
  is maximised. The header click still focuses the tile as today; a press without the move is a click.
- **During:** `body.mirror-moving` (cursor `grabbing`, no text selection); a label ghost of the tile's
  title follows the pointer; the tile under the pointer (hit-tested against each `.lm_stack`'s
  `getBoundingClientRect()`) other than the dragged one shows a drop indicator (an absolutely
  positioned `div`, `pointer-events: none`, `--vscode-focusBorder` outline, translucent
  `--vscode-editor-selectionBackground` fill).
- **Zone** (a pure function in `mirrorEdit.ts`, given the stack's rect, the header height 26 and the
  point): in the header strip → `center`; otherwise with `rx`, `ry` the point's position in the body
  as 0..1 and `d = min(rx, 1−rx, ry, 1−ry)`: `d ≥ 0.25` → `center`, else the nearest edge
  `left` / `right` / `top` / `bottom` (ties: left, right, top, bottom in that order). Indicator: the
  whole tile for `center`, the matching half for an edge.
- **Not offered:** the dragged tile itself, anything outside the tile area, the whole-tab edges, and
  other panels. Escape or `pointercancel` cancels. Releasing there does nothing.
- **Drop** on a zone → `{"type":"movePane","paneKey":"<dragged>","targetPaneKey":"<target>","zone":"center"|"left"|"right"|"top"|"bottom"}`.
  The tiles do not move locally; the re-export moves them (expect 100–400 ms).

Host, on `movePane`: ignore it unless both panes are in this tab (the last export) and herdr's tab is
not zoomed. Send these requests in order (`S` dragged, `T` target, `TAB` this tab), stop at the first
error or `changed:false`, and on either show `herdr: <message or reason>` as a warning and schedule a
re-export:

| zone | requests |
| --- | --- |
| `center` | `pane.swap` `{"source_pane_id":S,"target_pane_id":T}` |
| `right` | `pane.move` `{"pane_id":S,"destination":{"type":"tab","tab_id":TAB,"split":"right","target_pane_id":T,"ratio":0.5},"focus":false}` |
| `bottom` | as `right` with `"split":"down"` |
| `left` | the `right` move, then `pane.swap` `{"source_pane_id":S,"target_pane_id":T}` |
| `top` | the `bottom` move, then the same swap |

(herdr splits only `right` / `down`, with the new pane `second`; left and top are that plus a swap.
Pane ids do not change within a workspace, phase 16's capture, so `S` stays valid for the swap. The
centre drop is a swap because a mirrored tab has no stacks: two panes cannot share a tile.)

`changed:false` reads `move_result.changed` / `swap.changed`; the reason is `move_result.reason` /
`swap.reason` (`same_tab`, `zoomed_tab`, `no_neighbor`, `same_pane`, `not_found`, `cross_tab`).

### Zoom

- herdr → VS Code: `{"type":"zoom","paneKey":"<key>"|null}` after every `layout` and whenever the
  zoomed pane changes. The webview maximises that pane's stack (`stack.maximise()`), or minimises the
  maximised stack for `null`, and records it as its applied zoom first, so the `stateChanged` this
  causes posts nothing.
- VS Code → herdr: on `stateChanged`, if `layout.maximisedStack`'s tile (or none) differs from the
  applied zoom, post `{"type":"setZoom","paneKey":"<key>"|null}` and record it. Covers the maximise
  button and any other way GL maximises.
- Host, on `setZoom`: `null` → `pane.zoom` `{"pane_id":<herdr's zoomed pane>,"mode":"off"}` (nothing
  if herdr is not zoomed). A pane `P` → if herdr is zoomed on another pane, first its `off`; then
  `pane.zoom` `{"pane_id":P,"mode":"on"}`. After the last answer (`{"type":"pane_zoom","zoom":{…}}`),
  reconcile: zoomed pane = `zoom.zoomed ? zoom.pane_id : null`; if that is not what the webview asked
  for (e.g. `reason:"single_pane"`), post `zoom` with herdr's state. Errors: warning `herdr: <message>`,
  then post `zoom` with the stored state.
- Zooming in VS Code zooms the herdr TUI too and makes that pane herdr's focused pane. This is the one
  exception to phase 15's "focusing a tile does not move herdr's focus"; the README says so.

### Copy as Layout

`asLayoutConfig` (in `src/layouts.ts`) also removes `id` values starting with `split:` and sets every
stack's `maximised` to `false`: a Layout tab never zooms herdr and opens unmaximised.

### Messages (`src/tilesProtocol.ts`)

Host → webview: `{"type":"ratios","ratios":Record<string,number>}`, `{"type":"zoom","paneKey":string|null}`.
Webview → host: `{"type":"setRatios","ratios":Record<string,number>}`, `{"type":"setZoom","paneKey":string|null}`,
`{"type":"movePane","paneKey","targetPaneKey","zone"}`. Layout panels never send these, and the host
ignores them from a Layout panel.

Probe additions (test support only): actions `{"kind":"dragSplitter","splitId":"split:<key>","fraction":<0..1>}`
(synthetic pointer events from the splitter to `fraction` of that split item's width or height, moving
more than 10 px first: GL's `DragListener` starts at 10 px), `{"kind":"dragTile","paneKey","targetPaneKey","zone"}`
(pointer events from the tab to a point inside the zone), `{"kind":"clickMaximise","paneKey"}`; result
fields `ratios: Record<string,number>` (from the live GL items) and `maximised: string|null`.

### Golden Layout 2.6 gotchas

- Sizes are numbers with a unit: a config's `"60%"` becomes `size: 60, sizeUnit: "%"` on the item and
  in `saveLayout()`. The two children may not sum to exactly 100; always use `a / (a + b)`.
- There is no splitter event. A splitter drag moves only the splitter element until drag stop, then
  sets the two sizes and calls `updateSize` on the next animation frame, which emits a bubbling
  `stateChanged`. `stateChanged` also fires for container resizes, maximise, focus, and our own
  `updateSize` calls: hence the splitter-pointer flag and the 0.005 diff.
- `document.body` and the dragged element get `lm_dragging` during any GL drag (splitter or tab).
- `stack.maximise()` / `minimise()` emit `stateChanged`; `layout.maximisedStack` is the maximised
  stack or `undefined`. Starting a GL tab drag minimises a maximised stack (not relevant while
  `reorderEnabled` is false, but our own drag must not start while maximised).
- `loadLayout` destroys every component (phase 15's gotcha): only a structure change may cause one.

## Validation

- [ ] Measurements M1–M5 (and M6 if needed) recorded in Implementation notes with the raw JSON, and
      `hv-test`'s home deleted afterwards
- [ ] `npm run build && npm run lint && xvfb-run -a npm test` (in `herdr-vscode/`) passes, including
      unit tests (`src/test/mirrorEdit.test.ts`, `layoutMapping.test.ts`, `layouts.test.ts`) for:
  - [ ] path key ↔ herdr path: `""` → `[]`, `"01"` → `[false,true]` (or the measured inverse)
  - [ ] `mirrorConfig` ids: a right split holding a down split → row `split:`, column `split:1`;
        single pane → no id anywhere
  - [ ] structure key equal for the same tree at ratios 0.5 and 0.6, different after a swap of two
        panes; ratios by path for a nested tree
  - [ ] ratio diff: 0.6 vs `0.6000000238418579` → no change; 0.6 vs 0.62 → changed; in-flight path
        skipped
  - [ ] clamping and rounding: 0.01 → 0.05, 0.99 → 0.95, 0.4567 → 0.457
  - [ ] drop zone: header → `center`; body centre → `center`; 10% from the left → `left`; 10% from
        the bottom → `bottom`; a corner at (0.1, 0.1) → `left`
  - [ ] drop requests: `center` → one `pane.swap`; `right` → one `pane.move` with `split:"right"`,
        `ratio:0.5`, `focus:false`; `left` → that move then a swap; `top` → down move then swap
        (exact params JSON as in Contracts)
  - [ ] zoom requests: herdr zoomed on A, `setZoom` B → `off` A, `on` B; `setZoom` null → `off` A;
        herdr not zoomed, `setZoom` null → nothing
  - [ ] `asLayoutConfig` removes `split:` ids and `maximised`
- [ ] `src/test/mirrorPanels.test.ts` (new; real webview, fake model that records method **and
      params**, spawns nothing; same pattern as `layoutPanels.test.ts`):
  - [ ] a re-export with the same tree and ratio 0.6 → 0.3: tile rectangles follow within 1 s, every
        tile's `serial` unchanged, no `layout` message sent (count posts)
  - [ ] `dragSplitter` on `split:` to 0.25 → exactly one `layout.set_split_ratio` with
        `{"tab_id":…,"path":[],"ratio":0.25}` (±0.01); a following re-export at 0.25 posts nothing
        and the splitter does not move
  - [ ] `set_split_ratio` answered with 0.3 for a request of 0.25 → the split shows 0.3
  - [ ] `dragTile` p1 → p2 `right` → `pane.move` with the Contracts' params; `center` → `pane.swap`;
        the tile layout is unchanged until the next export
  - [ ] `dragTile` with a maximised stack, or onto itself → no request
  - [ ] `clickMaximise` p2 → `pane.zoom {"pane_id":"…p2","mode":"on"}`; export `zoomed:true` with
        focus p3 → p3 maximised and no `pane.zoom` sent back; export `zoomed:false` → nothing maximised
- [ ] `src/test/layoutPanels.test.ts` "mirrored panel: tiles do not drag…" still passes; it now also
      asserts the drag reached the host as `movePane` (a `pane.move` request), not a local GL move
- [ ] Opt-in `src/test/liveMirrorEdit.test.ts` with `HERDR_VSCODE_LIVE_HOME` on throwaway `hv-test`
      (same setup and teardown as `liveTiles.test.ts`, its own tab `p1 | (p2 / p3)`):
  - [ ] `dragSplitter` root to 0.3 → `layout.export` root ratio within 0.01 of 0.3 within 1 s
  - [ ] `layout.set_split_ratio` from outside on `[true]` to 0.7 → the column's tiles resize within
        1 s, `serial`s unchanged
  - [ ] `dragTile` p3 → p1 `left` → export: root's first is a split `right` with p3 `first` and p1
        `second`; terminals of p1, p2 kept (`serial`), p3's tile shows its old screen
  - [ ] `dragTile` p1 → p2 `center` → p1 and p2 exchanged in the export
  - [ ] `clickMaximise` p2 → export `zoomed:true`, `focused_pane_id` p2; `pane.zoom` off from outside
        → nothing maximised within 1 s
  - [ ] `ps` lists no `--session hv-test terminal session control` after teardown
- [ ] Manual: in `hv-test`, open a mirrored tab of `p1 | (p2 / p3)` beside the herdr TUI. Drag the
      vertical splitter: the TUI's split follows within 1 s. Resize in the TUI: the editor tab's
      splitter follows within 1 s, the tiles keep their content, the cursor stays in the tile you
      were typing in
- [ ] Manual: drag p3's tab onto p1's left edge: the indicator shows p1's left half; after the drop
      both the TUI and the editor tab show p3 left of p1. Drag p1 onto p2's centre: they swap
- [ ] Manual: no drop indicator over the dragged tile itself or outside the tiles; Escape cancels
- [ ] Manual: maximise a tile: the TUI zooms that pane; unzoom in the TUI: the tile restores
- [ ] Manual: **Copy as Layout** of a maximised mirror opens unmaximised; dragging there does not
      change herdr (TUI unchanged)
- [ ] `git diff --stat -- devc-vscode` is empty

## Relevant Files

- `herdr-vscode/src/mirrorEdit.ts` (new: paths, ratio diff and clamping, drop zone, drop and zoom
  request lists)
- `herdr-vscode/src/layoutMapping.ts` (split ids, structure key, ratios by path; `layoutShape` goes)
- `herdr-vscode/src/layouts.ts` (`asLayoutConfig`)
- `herdr-vscode/src/tilesProtocol.ts` (messages, probe actions and fields)
- `herdr-vscode/src/tilesPanel.ts` (`MirrorPanel`: re-export handling, `setRatios`, `movePane`,
  `setZoom`)
- `herdr-vscode/src/webview/tiles.ts` (splitter flag, `ratios`, tile drag overlay, zoom, probes)
- `herdr-vscode/src/webview/tiles.css` (drop indicator, ghost, `mirror-moving`, `grab` cursor on
  mirror tabs)
- `herdr-vscode/src/test/mirrorEdit.test.ts` (new), `src/test/mirrorPanels.test.ts` (new),
  `src/test/liveMirrorEdit.test.ts` (new), `src/test/layoutMapping.test.ts`,
  `src/test/layouts.test.ts`, `src/test/layoutPanels.test.ts`
- `herdr-vscode/README.md` (mirrored tab bullets: replace "Dragging a splitter or maximising a tile is
  local to VS Code…" with ratios, drag-to-move/swap and zoom going to herdr; zoom moves herdr's focus;
  opt-in suite list mentions moves and ratios)
- `herdr-vscode/CHANGELOG.md`
- `herdr-vscode/docs/how-it-works.md` (§ Layout mapping: ids and the re-export rules replacing "a
  re-export whose split tree is unchanged is dropped"; new § "Editing herdr's layout": ratios, drag,
  zoom, the measured herdr semantics)
- `.plans/PLAN.md`

## Implementation notes
