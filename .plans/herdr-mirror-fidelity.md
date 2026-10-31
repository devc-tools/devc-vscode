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

- [x] 1. Measure herdr 0.9.5 on throwaway `hv-test` (see Measurements) and record the results in
      this plan's Implementation notes before writing any other code
- [x] 2. `src/mirrorEdit.ts` (new, no `vscode`/Node/DOM imports): split paths, ratio diffing, drop
      zones, the request lists for a drop and for a zoom change
- [x] 3. `src/layoutMapping.ts`: split items carry `id` `split:<path>`; structure key without ratios;
      ratios by path; `layoutShape` replaced
- [x] 4. `src/tilesProtocol.ts`: new host and webview messages, new probe actions and probe fields
- [x] 5. Split ratios, VS Code → herdr: webview reports splitter drags; host sends
      `layout.set_split_ratio`
- [x] 6. Split ratios, herdr → VS Code: a re-export with the same structure but new ratios resizes the
      tiles in place (no `loadLayout`)
- [x] 7. Tile drag in mirrored panels: own drag-and-drop overlay, drop zones, `movePane` →
      `pane.swap` / `pane.move`
- [x] 8. Zoom: GL maximise ↔ herdr `pane.zoom` / export `zoomed`
- [x] 9. Copy as Layout drops the mirror-only parts (`split:` ids, `maximised`)
- [x] 10. Tests (list under Validation)
- [x] 11. README (mirrored tab bullets), CHANGELOG, `docs/how-it-works.md` (Layout mapping, new
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

- [x] Measurements M1–M5 (and M6 if needed) recorded in Implementation notes with the raw JSON, and
      `hv-test`'s home deleted afterwards
- [x] `npm run build && npm run lint && xvfb-run -a npm test` (in `herdr-vscode/`) passes, including
      unit tests (`src/test/mirrorEdit.test.ts`, `layoutMapping.test.ts`, `layouts.test.ts`) for:
  - [x] path key ↔ herdr path: `""` → `[]`, `"01"` → `[false,true]` (or the measured inverse)
  - [x] `mirrorConfig` ids: a right split holding a down split → row `split:`, column `split:1`;
        single pane → no id anywhere
  - [x] structure key equal for the same tree at ratios 0.5 and 0.6, different after a swap of two
        panes; ratios by path for a nested tree
  - [x] ratio diff: 0.6 vs `0.6000000238418579` → no change; 0.6 vs 0.62 → changed; in-flight path
        skipped
  - [x] clamping and rounding: 0.01 → 0.05, 0.99 → 0.95, 0.4567 → 0.457
  - [x] drop zone: header → `center`; body centre → `center`; 10% from the left → `left`; 10% from
        the bottom → `bottom`; a corner at (0.1, 0.1) → `left`
  - [x] drop requests (fallback, M2 refused and M6 not in place): `center` → one `pane.swap`
        `{"source_pane_id":S,"target_pane_id":T}`; `left` / `right` / `top` / `bottom` → no request
        (edge zones not offered; every zone in the webview is `center`). Was: `right` → one `pane.move`
        with `split:"right"`, `ratio:0.5`, `focus:false`; `left` → that move then a swap; `top` → down
        move then swap
  - [x] zoom requests: herdr zoomed on A, `setZoom` B → `off` A, `on` B; `setZoom` null → `off` A;
        herdr not zoomed, `setZoom` null → nothing
  - [x] `asLayoutConfig` removes `split:` ids and `maximised`
- [x] `src/test/mirrorPanels.test.ts` (new; real webview, fake model that records method **and
      params**, spawns nothing; same pattern as `layoutPanels.test.ts`):
  - [x] a re-export with the same tree and ratio 0.6 → 0.3: tile rectangles follow within 1 s, every
        tile's `serial` unchanged, no `layout` message sent (count posts)
  - [x] `dragSplitter` on `split:` to 0.25 → exactly one `layout.set_split_ratio` with
        `{"tab_id":…,"path":[],"ratio":0.25}` (±0.01); a following re-export at 0.25 posts nothing
        and the splitter does not move
  - [x] `set_split_ratio` answered with 0.3 for a request of 0.25 → the split shows 0.3
  - [x] (fallback) `dragTile` p1 → p2 `right` → `pane.swap` p1/p2, no `pane.move`; `center` →
        `pane.swap`; the tile layout is unchanged until the next export. Was: `right` → `pane.move`
        with the Contracts' params
  - [x] `dragTile` with a maximised stack, or onto itself → no request
  - [x] `clickMaximise` p2 → `pane.zoom {"pane_id":"…p2","mode":"on"}`; export `zoomed:true` with
        focus p3 → p3 maximised and no `pane.zoom` sent back; export `zoomed:false` → nothing maximised
- [x] `src/test/layoutPanels.test.ts` "mirrored panel: tiles do not drag…" still passes; it now also
      asserts the drag reached the host as `movePane` (fallback: a `pane.swap` request; was a
      `pane.move`), not a local GL move
- [x] Opt-in `src/test/liveMirrorEdit.test.ts` with `HERDR_VSCODE_LIVE_HOME` on throwaway `hv-test`
      (same setup and teardown as `liveTiles.test.ts`, its own tab `p1 | (p2 / p3)`):
  - [x] `dragSplitter` root to 0.3 → `layout.export` root ratio within 0.01 of 0.3 within 1 s
  - [x] `layout.set_split_ratio` from outside on `[true]` to 0.7 → the column's tiles resize within
        1 s, `serial`s unchanged
  - [x] (fallback) `dragTile` p3 → p1 `left` → export: p3 and p1 exchanged
        (`(right p3 (down p2 p1))`); terminals of p1, p2 and p3 kept (`serial`), p3's tile shows its old
        screen. Was: root's first is a split `right` with p3 `first` and p1 `second`
  - [x] `dragTile` p1 → p2 `center` → p1 and p2 exchanged in the export
  - [x] `clickMaximise` p2 → export `zoomed:true`, `focused_pane_id` p2; `pane.zoom` off from outside
        → nothing maximised within 1 s
  - [x] `ps` lists no `--session hv-test terminal session control` after teardown
- [ ] Manual: in `hv-test`, open a mirrored tab of `p1 | (p2 / p3)` beside the herdr TUI. Drag the
      vertical splitter: the TUI's split follows within 1 s. Resize in the TUI: the editor tab's
      splitter follows within 1 s, the tiles keep their content, the cursor stays in the tile you
      were typing in
- [ ] Manual (fallback): drag p3's tab onto p1's left edge: the indicator covers the whole of p1;
      after the drop both the TUI and the editor tab show p3 and p1 swapped. Drag p1 onto p2's
      centre: they swap. (Was: the indicator shows p1's left half, p3 ends left of p1)
- [ ] Manual: no drop indicator over the dragged tile itself or outside the tiles; Escape cancels
- [ ] Manual: maximise a tile: the TUI zooms that pane; unzoom in the TUI: the tile restores
- [ ] Manual: **Copy as Layout** of a maximised mirror opens unmaximised; dragging there does not
      change herdr (TUI unchanged)
- [x] `git diff --stat -- devc-vscode` is empty

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

### Measurements (step 1, herdr 0.9.5, 2026-10-31)

Throwaway `hv-test` in an isolated `HOME=/tmp/hvt` (herdr copied to `/tmp/hvt/.local/bin`, every
`HERDR_*` variable stripped), one workspace `w1`; requests through `bridgeRequest(new LocalShell(),
'hv-test', …)` from `out/bridge.js`, events from `events.subscribe` (`subscriptionList([])`). Tab
`w1:t4` set up as `p1 | (p2 / p3)` = `w1:p6 | (w1:p7 / w1:p8)` (`pane.split` takes `target_pane_id`,
not `pane_id`; with `pane_id` it splits the focused pane of the focused tab):

```json
{"type":"layout_export","layout":{"workspace_id":"w1","tab_id":"w1:t4","zoomed":false,"focused_pane_id":"w1:p6","root":{"type":"split","direction":"right","ratio":0.5,"first":{"type":"pane","pane_id":"w1:p6","cwd":"/tmp/hvt"},"second":{"type":"split","direction":"down","ratio":0.5,"first":{"type":"pane","pane_id":"w1:p7","cwd":"/tmp/hvt"},"second":{"type":"pane","pane_id":"w1:p8","cwd":"/tmp/hvt"}}}}}
```

**M1 `layout.set_split_ratio`: path as expected, herdr clamps to [0.1, 0.9].**

- `{"path":[],"ratio":0.3}` → `{"type":"layout_split_ratio_set","layout":{…"root":{"type":"split","direction":"right","ratio":0.3,…"second":{…"ratio":0.5…}}}}`: `[]` is the root.
- `{"path":[true],"ratio":0.7}` → root 0.3, `second` (the down split) 0.7: `true` = `second`. No conversion change.
- `{"path":[false]}` (a pane) → error `split_not_found` "split path not found".
- `ratio` `0` → stored 0.1; `1` → 0.9; `1.5` → 0.9; `0.01` → 0.1; `0.99` → 0.9. No error code for out-of-range ratios: herdr **clamps to [0.1, 0.9]** and answers success. So the plan's own clamp to [0.05, 0.95] stays (never send outside [0,1]); a ratio in [0.05, 0.1) or (0.9, 0.95] comes back clamped and the "herdr clamped it" path posts herdr's value back.
- Each success emits one `layout.updated`, whose `data.layout` is the *geometry* shape (`area`, `panes[].rect`, `splits[]` with ids like `"split_0_root"`, `"split_1_1"`, `"split_1_0"`: not path keys), not the export tree. A failure emits nothing. We re-export, as phase 15 does.

**M2 `pane.move` within the same tab: refused.**

```json
{"type":"pane_move","move_result":{"changed":false,"reason":"same_tab","previous_pane_id":"w1:p8","previous_workspace_id":"w1","previous_tab_id":"w1:t4","pane":{"pane_id":"w1:p8","terminal_id":"term_65f267f12a1df8",…},"source_layout":{…},"target_layout":{…},"focused_pane_id":"w1:p6"}}
```

Same for `"split":"down"` and for every target in the tab. (A move **into** the tab from another tab of
the same workspace does work, `changed:true`, pane id and terminal kept, the moved pane `second` at the
given ratio: seen by accident with a mis-split tab. Not used.)

**M3 `pane.swap`:** `{"source_pane_id":"w1:p6","target_pane_id":"w1:p8"}` →
`{"type":"pane_swap","swap":{"changed":true,"source_pane_id":"w1:p6","target_pane_id":"w1:p8","focused_pane_id":"w1:p6","layout":{…geometry…}}}`;
export after: `(right 0.5 p8 (down 0.7 p7 p6))`: the two ids exchanged, ratios kept. Events:
`workspace.focused`, `tab.focused`, `pane.focused`, `layout.updated`. **A swap focuses the source pane**
(seen with an unfocused source: `focused_pane_id` became the source). Swapping panes of different tabs:
`changed:false`, `reason:"cross_tab"`.

**M4 `pane.zoom`:**

- `on` p2 → `{"type":"pane_zoom","zoom":{"changed":true,"zoom_changed":true,"focus_changed":true,"pane_id":"w1:pE","focused_pane_id":"w1:pE","zoomed":true,"layout":{…}}}`; export `zoomed:true`, `focused_pane_id` p2. Events `workspace.focused`, `tab.focused`, `pane.focused`, `layout.updated`.
- `on` p3 while p2 is zoomed → `"changed":true,"zoom_changed":false,"focus_changed":true,"reason":"already_zoomed","zoomed":true,"focused_pane_id":p3`; export `zoomed:true`, focus p3. So herdr's zoom shows the **focused** pane: focusing another pane of a zoomed tab moves the zoom with it. The host still sends `off` first, as prescribed.
- `off` p3 → `"changed":true,"zoom_changed":true,"focus_changed":false,"zoomed":false`; one `layout.updated` only.
- `off` when not zoomed → `"changed":false,"reason":"already_unzoomed"` (it still focuses the named pane when it was not focused: `focus_changed:true`).
- `on` in a one-pane tab → `"changed":true,"zoom_changed":false,"reason":"single_pane","zoomed":false`.

**M5** `pane.move` while zoomed → `"changed":false,"reason":"zoomed_tab"` (checked before `same_tab`).
`pane.swap` while zoomed → `changed:true`, the tab stays zoomed and focus goes to the source, so the zoom
shows the source pane.

**M6 `layout.apply` (M2 was refused)** `{"tab_id":"w1:t4","root":<export tree with p3 left of p1, pane
nodes with their pane_id>,"focus":false}` → `{"type":"layout_apply","layout":{"tab_id":"w1:t5",…"root":{…"w1:p9"…"w1:pB"…"w1:pA"…}}}`:
it **replaced the tab**: events `tab.created`, `tab.closed`, three `pane.created`; a new tab id, three
new pane ids, new terminals; the old panes and their shells are gone (`pane.list` for `w1:t4` is empty,
a second apply to `w1:t4` answers `tab_not_found`). It does not rearrange in place.

**Decision (the plan's fallback):** M2 refused and M6 not in place, so **edge zones are not offered**:
a tile drag in a mirrored tab only swaps (centre). Any point over another tile is the centre zone and
the indicator covers the whole tile. `dropZone` (the full zone function) stays in `mirrorEdit.ts`, tested,
but the webview does not use edges; the host ignores a `movePane` with an edge zone. The Validation
items that described edge moves are rewritten below to the swap-only behaviour (marked "fallback").
Untried alternative for later: a same-tab move could be two cross-tab moves through a temporary tab
(cross-tab moves keep pane ids and terminals in a workspace).

### Status (2026-10-31)

Implemented with the M2/M6 fallback (swap only); the Manual items above were not run, because they
need a person in VS Code beside a herdr TUI, so they stay unticked and the plan stays out of
`implemented/`. The Validation items that described edge moves were rewritten to the fallback the plan
prescribes (each says "fallback" and keeps the original wording after "Was:").

### Verified

- `npm run build && npm run lint && xvfb-run -a npm test`: 306 passing, 59 pending (opt-in live
  suites), 0 failing. This phase adds 18 default tests and 6 opt-in live ones. `git diff --stat -- devc-vscode` is empty; no dependency changes.
- New default tests: `src/test/mirrorEdit.test.ts` (paths, diff, clamp, zones, requests, answers),
  `src/test/mirrorPanels.test.ts` (7 tests, real webview, fake herdr recording method and params; post
  count via a wrapped `webview.postMessage`), new cases in `layoutMapping.test.ts` and `layouts.test.ts`,
  and the mirror case of `layoutPanels.test.ts` now waits for the `pane.swap` and checks no Golden Layout
  drag is under way.
- Opt-in, against throwaway `hv-test` in an isolated `HOME=/tmp/hvt`: `src/test/liveMirrorEdit.test.ts`,
  6 passing. Timings from the run: splitter drag to herdr's root ratio 0.299 in 205–249 ms; an outside
  `set_split_ratio [true] 0.7` resized the column in place (serials kept) within 256 ms; a swap reached
  herdr and the tiles followed in 111–216 ms (tiles about 95 ms after herdr's export), every terminal kept
  and p3 showing its old screen (once its next frame arrived: the first run checked too early and failed,
  now it waits up to 3 s); unzoom from outside restored the tile in 144–181 ms; no controller after the
  panel closed. The whole live run (`HERDR_VSCODE_LIVE_HOME=/tmp/hvt`): 360 passing, 4 pending, 1 failing,
  the known `live model … lists only the isolated session` (the home lists `default` and `hv-ctl`).
  Afterwards `hv-ctl` and `hv-test` were deleted, the server stopped, `/tmp/hvt` removed; no `hv-test` /
  `hv-ctl` process left; the real `herdr session list` still shows `default`, `devc`,
  `devc-my-app-1a2b3c4d`.

Not exercised at all: a real pointer (every drag is synthetic pointer events dispatched by the webview),
the ghost and indicator's look (no screenshot), a real Escape during a drag, the herdr TUI following
visibly, a window reload while zoomed (the host replays `zoom` after `ready`, untested).

### Deviations and decisions

- **Edge drops not offered** (measurements above). `dropZone` is implemented and tested as specified,
  but `offeredZone` maps every zone to `center` while `EDGE_ZONES_OFFERED` is false, the indicator covers
  the whole tile, and `dropRequests` has no requests for edges (the host ignores such a `movePane`). The
  README says so.
- herdr clamps ratios to [0.1, 0.9] itself; the plan's own [0.05, 0.95] clamp stays. The host compares
  herdr's stored ratio with the ratio the **webview asked for** (not the clamped `r`), so a drag to 0.03
  (sent as 0.05, stored as 0.1) snaps the splitter to 0.1 too. Same outcome as the contract for every
  herdr clamp, plus our own.
- Zoom: Golden Layout emits a `stateChanged` with nothing maximised when the maximise moves from one
  stack to another, which posted `setZoom null` then `setZoom p3` (caught by the test). `applyZoom`
  minimises then maximises under a flag, and `stateChanged`s during it are ignored.
- While a `setZoom` is being carried out (`off` then `on` are two requests), re-exports leave the zoom
  alone and the answer decides; otherwise the `layout.updated` between them unmaximised the tile.
- The host keeps `view` (the config replayed after a webview reload) at herdr's latest ratios without
  posting it, and posts `zoom` after `ready`.
- Measured, and not in the plan: `pane.swap` focuses the source pane, so a drop moves herdr's focus to
  the dragged pane (the README says so beside zoom). `pane.split` takes `target_pane_id`; with
  `pane_id` it splits whatever is focused.
- The indicator and ghost are `position: fixed` (the plan says absolutely positioned): the webview does
  not scroll, so the client coordinates used for hit-testing are the same.
- The `dragTile` probe drops at 10% / 90% of the target's body for edges and its centre for `center`.
- Golden Layout internals used, all on items: `ContentItem.size` (writable, not in the `.d.ts`) and
  `RowOrColumn.updateSize(false)` (public), cast in `tiles.ts`; ids through the public `ContentItem.id`.

### For phase 23 (sidebar config) and later

- Nothing in the sidebar changed. `src/mirrorEdit.ts` and the new `layoutMapping` exports
  (`structureKey`, `ratiosByPath`, `splitId`, `SPLIT_ID_PREFIX`) have no `vscode` import.
- `layoutShape` is gone; anything comparing export trees should use `structureKey` (ratios excluded).
- A future herdr with same-tab `pane.move`: set `EDGE_ZONES_OFFERED` and fill in `dropRequests` from the
  Contracts table; the webview, protocol and host already carry the zone. Untried alternative today:
  two cross-tab moves through a temporary tab.

