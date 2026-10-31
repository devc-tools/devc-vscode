# herdr-vscode: drag panes into Layout tabs

Mockup board D, "Layout model" (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): "Drag a pane →
Into any Layout tab, onto an edge or a stack". Panes come from the Spaces and Agents views and Pane
Context's **Other Panes in This Space** rows, and land in a Layout tab on a stack (as a tab there) or
at an edge (a new split), with Golden Layout's own drop zones. A tile can also be dragged from one
open Layout tab to another. A pane is in a layout at most once: dropping a pane the layout already has
moves that tile (or only focuses it), never duplicates it. Layout tabs stay the default
(`herdr.openPaneIn` = `layout`), and clicking a row still adds the pane as before.

Mirrored herdr tabs are **not** drop targets here. Dragging inside a mirrored tab to move herdr panes
is phase 22.

Depends on [herdr-layout-tabs](herdr-layout-tabs.md) (Layout panels, `addTile`, the store) and
[herdr-pane-context](herdr-pane-context.md) (the Other Panes rows). Paths are under `herdr-vscode/`.
No new dependencies.

## Checklist

- [ ] 1. Drag sources: a `TreeDragAndDropController` on `herdr.spaces`, `herdr.agents` and
      `herdr.paneContext` that arms placement for a dragged pane row
- [ ] 2. Placement state in the extension host: arm and disarm, the `herdr.placingPane` context
      key, `herdr.cancelPlacement` on Escape, the 15 s timeout
- [ ] 3. Golden Layout drop shim in the webview (Golden Layout 2.6.0's own drop areas, indicator and
      `onDrop`), behind one typed module
- [ ] 4. Placing mode in Layout panels: overlay, toolbar hint, drop zones under the pointer, place on
      release or click, cancel
- [ ] 5. Tile grip in Layout panels: HTML5 drag of a tile into another (or the same) Layout tab; the
      source layout loses the tile
- [ ] 6. A pane already in the target layout: move or focus, by the rules below
- [ ] 7. Mirrored panels ignore placement and grip drops
- [ ] 8. Tests (list under Validation)
- [ ] 9. README, CHANGELOG, `docs/how-it-works.md`

## Measured: a tree drag cannot reach a webview

Measured on 2026-10-31 with the VS Code build the tests use (`.vscode-test/vscode-linux-arm64-1.144.0`)
under Xvfb, with a **real X pointer** (XTest), a scratch extension with a tree view (controller with
`dragMimeTypes: ['application/vnd.herdr.pane']`) and two webview panels side by side, logging every
drag event inside the webviews and in the workbench document (through `--remote-debugging-port`):

| Drag | Shift | Reached the target webview |
| --- | --- | --- |
| tree row → webview | no | no events at all |
| tree row → webview | held | no events at all |
| webview A (a `draggable` element) → webview B, adjacent | no / held | yes: `dragenter`, `dragover`, `drop`; `types` = `text/plain`, `application/vnd.herdr.pane`, `chromium/x-drag-id`; `getData` returns what A set |
| webview A → over the side bar → webview B | no / held | yes, the same; the workbench saw no drag events at all |
| webview A → webview A | no / held | yes |

What the code says, and the measurement confirms:

- On `dragstart` in the workbench, VS Code sets `pointer-events: none` on every webview iframe, and
  back to `auto` while Shift is held (`drag` / `dragover` with `shiftKey`). Measured: the iframes were
  `auto` during the Shift drag, and the drag still never entered them.
- Webviews are out-of-process iframes (`/json/list` lists them as type `iframe`). Chromium does not
  let a drag that started in one renderer process of a tab drop into a frame of another process. The
  workbench is one process; a webview is another. Webviews of **one extension in one window share an
  origin** (`vscode-webview://<same id>`), hence a process, so drags between them work.
- A tree drag's native `DataTransfer` holds only `application/vnd.code.tree.<view id lowercased>`
  (`{"id","itemHandles"}`) and each of the controller's `dragMimeTypes` with the value `""`. What
  `handleDrag` puts in its `DataTransfer` never reaches the native one; only other tree views and
  text editor drops see it.
- After a tree drag is released over a webview, the webview gets nothing until the pointer moves
  (then `pointerover`/`pointermove` with `buttons: 0`).

macOS was not measured. Nothing below depends on whether a tree drag reaches a webview there.

**Decision.** A drag from a tree **arms** placement instead of dropping: the extension host learns
of the drag from `handleDrag`, and every visible Layout panel shows where the pane would go under the
pointer once the pointer is over it; releasing there (if the platform delivers the release) or
clicking places it. Tile drags between Layout tabs are real HTML5 drag and drop, which works.
Rejected: a `text/uri-list` drop that opens an editor (it can only make editor groups, not Golden
Layout stacks), and rewriting the trees as webviews (out of scope).

## Contracts

### MIME type and data

- `application/vnd.herdr.pane` (lower case, as VS Code lower-cases MIME types).
- Tree drags: the controller's `dragMimeTypes` is `["application/vnd.herdr.pane"]`, `dropMimeTypes`
  `[]`. `handleDrag` sets that type to the JSON `[{"sessionKey":"<key>","paneId":"<id>"}]` (one entry)
  for a pane row, and sets nothing otherwise. The webview never reads this; it is there for anything
  else that reads tree drags.
- Tile grip drags (webview `dataTransfer.setData`): that type only (no `text/plain`, so dropping
  into another app does nothing), `effectAllowed = "move"`, value the JSON
  `{"sessionKey":"<key>","paneId":"<id>","title":"<tile title>","layoutId":"<uuid>"}`.
- Parse on drop: `JSON.parse`, then require an object whose `sessionKey`, `paneId`, `layoutId` are
  non-empty strings and `title` is a string; anything else (including `""`, which is what a tree drag
  carries if a platform does deliver one) is "not a tile". A parse that throws is "not a tile".

### Drag sources (trees)

- `herdr.spaces`, `herdr.agents`, `herdr.paneContext` are created with the controller. `canSelectMany`
  stays off: a drag carries one row.
- Pane rows: Spaces `pane` nodes, Agents rows, Pane Context `pane` nodes (Other Panes). Any other row
  (space, tab, Pane Context root/group/change/file/folder/note) arms nothing and **disarms** a
  placement in progress.
- Side effect, accepted: with a controller, every row of these trees becomes draggable, and Pane
  Context's Files rows (which have a `resourceUri`) can be dropped on an editor group, which opens the
  file. Note it in the CHANGELOG.
- `handleDrag` for a pane row: the pane must be in a **connected** session's snapshot; otherwise it
  arms nothing (no message). Title = `paneLabel(pane, snapshot)`.

### Placement (extension host)

- **Arm** (on `handleDrag` of an available pane row): disarm any previous placement; post
  `placePane` to every open Layout panel whose `WebviewPanel.visible` is true; set context key
  `herdr.placingPane` to `true`; start a 15 s timer. With no visible Layout panel, nothing is armed
  (no message, no key).
- `placeHover` from a panel (the pointer reached it): stop the timer, post `placeEnd` to every
  other armed panel. That panel now owns the placement until it places or cancels.
- **Disarm** on: `placed` or `placeCancel` from the owning panel; `herdr.cancelPlacement`; the timer
  (no `placeHover` within 15 s); a new `handleDrag`; the owning panel being disposed. Disarm posts
  `placeEnd` to every armed panel still open and sets `herdr.placingPane` to `false`.
- `placed {sessionKey, paneId}`: the panel's known panes gain it (as `LayoutPanel.addPane` does, so
  `showsPane`, Pane Context's **Show Pane** and the tile metas follow at once), then
  `panel.reveal(undefined, false)` so typing goes to the new tile.

### Commands, keybinding, context key

| Id | Title | Where | Does |
| --- | --- | --- | --- |
| `herdr.cancelPlacement` | Cancel Placing Pane | keybinding `escape` when `herdr.placingPane`; hidden from the command palette (`"when": "false"`) | disarm |

Context key `herdr.placingPane` (boolean), set with `setContext`. The keybinding matters because
after a tree drag the keyboard is still in the tree, not in the webview.

### Placing mode (Layout panel webview)

- `placePane {sessionKey, paneId, title}` arms the panel. Body class `placing`.
- Before the pointer reaches the panel: an overlay over the tile area (not over the toolbar),
  semi-transparent `--vscode-editor-background` with the border `--vscode-focusBorder`, centred text
  on two lines: `Place "<title>"` and
  `Let go over this tab, then click a tab strip to add it there or near an edge to split. Esc cancels.`
  The overlay has `pointer-events: none`.
- The first `pointermove` or `pointerover` in the panel (any `buttons`): hide the overlay, post
  `placeHover`, maximised stack (if any) un-maximised with `toggleMaximise()`, then
  `calculateItemAreas()`. Toolbar shows `#place-hint`: `Placing "<title>"` and a **Cancel** button.
- Every `pointermove`: the drop zone under the pointer is highlighted, exactly as Golden Layout does
  while dragging a tab (see Drop zones). No zone under the pointer: indicator hidden.
- **Place** on the first `pointerdown` (button 0) or `pointerup` in the panel, whichever comes first,
  at that point, if a zone is under it. A `pointerup` comes first only if the platform delivers the
  tree drag's release to the webview; then a drop feels like a drop. Afterwards: indicator hidden,
  placing ended, `placed` posted, the tile focused (`focusTile` and `setFocused`, as `addOrReveal`).
  A press with no zone under it places nothing and keeps placing.
- An HTML5 `drop` in the panel whose data is "not a tile" while armed also places at the drop point.
- **Cancel** (`placeCancel` posted, placing ended, overlay/indicator/placeholder removed) on: Escape
  `keydown` in the webview; the **Cancel** button; the pointer leaving the document after
  `placeHover` (`pointerleave` on `document.documentElement`). `placeEnd` from the host ends
  placing silently.
- **Gotcha: placing must swallow the click.** Listen in the capture phase on `window` and call
  `preventDefault()` and `stopPropagation()` on `pointerdown`, `pointerup`, and the next `click`
  while placing; otherwise xterm starts a selection or takes focus and Golden Layout starts a tab drag
  or splitter drag. `preventDefault()` on `pointerdown` also stops the compatibility `mousedown` /
  `mouseup` xterm listens to, but not `click`.
- A `layout` message while placing (a re-load) calls `calculateItemAreas()` again.

### Drop zones (Golden Layout 2.6.0 internals)

Use Golden Layout's own drop logic so zones, highlight and results match dragging a tab. The pieces
are `@internal` in 2.6.0 (present in the JS, absent from the `.d.ts`), so they go through **one**
module, `src/webview/glDrop.ts`, with a local interface and a single cast; `golden-layout` stays pinned
at exactly `2.6.0`, and the webview tests below fail if an upgrade changes them.

- `layout.calculateItemAreas()`: call before the first hit test and after any re-layout.
- `layout.getArea(x, y)` → area or `null` (`x`, `y` = `pageX`, `pageY`; the webview never scrolls,
  so they equal `clientX`, `clientY`). Smallest matching area wins.
- `area.contentItem.highlightDropZone(x, y, area)`: shows `.lm_dropTargetIndicator` (and the header
  tab placeholder) and **records the segment and tab index the drop will use**. Call it at the drop
  point immediately before `onDrop`, even if it was called on the last `pointermove`.
- New tile: `layout.createAndInitContentItem(ItemConfig.resolve({type:"component", componentType:"pane",
  componentState:{sessionKey,paneId}, title}, false), area.contentItem)` (`ItemConfig` is a public
  export; this is what `Stack.addItem` does), then `area.contentItem.onDrop(item, area)`, then
  `settleTile` on the new tile.
- After any drop or cancel: `layout.dropTargetIndicator?.hide()` and
  `layout.tabDropPlaceholder.remove()` (the header placeholder is otherwise left in the tab strip).

What the zones do (Golden Layout's, unchanged):

| Pointer over | Result |
| --- | --- |
| a stack's header | a tab in that stack at the position under the pointer |
| a stack's body, left 25% / right 25% | split: beside the stack in its row (the stack's size halved), or the stack wrapped in a new row at 50/50 |
| a stack's body, middle half, upper / lower half | split: above / below, in a column likewise |
| an empty stack's body; an empty layout | the only tile |
| a 50 px band along an edge of the whole tile area, when the root is a row or column | a new stack at that edge of the root |

A non-empty stack's body has **no** "add as tab" zone; that is Golden Layout's behaviour and is kept.
The header is where a pane joins a stack.

### A pane already in the layout

Applies to placing and to grip drops. Let `T` be the pane's existing component, `S` its stack, at
the drop point `p`:

1. Zone is `S`'s header, or any zone of `S` while `S` holds only `T` → no change; focus `T`
   (bring it to the front of `S`).
2. Otherwise → move: `S.removeChild(T, true)` (keep the component, as Golden Layout's drag proxy
   does), then `calculateItemAreas()`, `getArea(p)`, `highlightDropZone(p)` again (the removal may
   have deleted `S` and collapsed its row or column), then `onDrop(T, area)`; focus `T`. No area at
   `p` after the removal → put `T` back with `S.addChild(T)` if `S` survived, else
   `targetStack().addChild(T)`.

**Gotcha:** removal and `onDrop` must run in the same task. The webview's `itemDestroyed` handler
defers `onLayoutChanged` with `setTimeout`, and `stateChanged` waits for an animation frame; both
then see `T` back in the tree and keep its terminal. Never `await` between them.

### Tile grip (between Layout tabs)

- Layout panels only (`body.kind-layout`): each tile's tab gets a grip before the status dot,
  `draggable="true"`, about 6×12 px of dots drawn in CSS (no font glyph, no image),
  `cursor: grab`, `title="Drag to another Layout tab"`. Added in `tabCreated` with the dot and detail.
- **Gotcha:** Golden Layout starts its own tab drag on `pointerdown` on the tab. The grip's
  `pointerdown` listener calls `stopPropagation()` (not `preventDefault()`, which would stop the
  native drag), so the browser starts an HTML5 drag instead.
- `dragstart` on the grip: data per MIME type and data. `dragend`: nothing.
- In any Layout panel (including the source), `dragenter`/`dragover` whose `dataTransfer.types`
  includes `application/vnd.herdr.pane`: `preventDefault()`, `dropEffect = "move"`,
  `calculateItemAreas()` on the first `dragenter` of a drag, highlight the zone at the pointer.
  Track enter/leave with a counter on `document` (`dragenter` +1, `dragleave` −1, `drop` → 0); at 0
  hide the indicator and remove the placeholder. Capture-phase listeners on `window`.
- `drop` with a tile (data parses): `preventDefault()`, then place at the point as above (new tile,
  or the rules of "A pane already in the layout"). If `layoutId` is another layout, post
  `tileMovedIn {sessionKey, paneId, fromLayoutId}`. Same layout: it is a move within it, nothing
  posted.
- Host on `tileMovedIn`: the target panel gains the pane as for `placed` and is revealed; the panel
  of `fromLayoutId`, if open, gets `removeTile {paneKey}`, and its webview closes that component
  (`container.close()`), which saves its layout through the usual `stateChanged`. No `fromLayoutId`
  panel open (a drop from another window's Layout tab, whose layout ids this window does not know):
  the target keeps the pane and nothing is removed.
- The grip works without Shift (measured). Both Layout tabs must be on screen, in different editor
  groups.

### Mirrored panels

Never sent `placePane`. On `dragover` with the herdr type they set `dropEffect = "none"` and do not
`preventDefault()` beyond what VS Code's own webview script does; on `drop` they do nothing. Their
tabs get no grip.

### Messages (`src/tilesProtocol.ts`)

Host → webview:

| Message | Meaning |
| --- | --- |
| `{type:"placePane", sessionKey, paneId, title}` | arm placing mode |
| `{type:"placeEnd"}` | end placing mode silently |
| `{type:"removeTile", paneKey}` | the pane moved to another Layout tab; close its component |

Webview → host:

| Message | Meaning |
| --- | --- |
| `{type:"placeHover"}` | the pointer reached this armed panel |
| `{type:"placed", sessionKey, paneId}` | placing mode ended by placing this pane (new, moved, or only focused under rule 1) |
| `{type:"placeCancel"}` | placing cancelled here |
| `{type:"tileMovedIn", sessionKey, paneId, fromLayoutId}` | a grip drop from another Layout tab landed here |

Probe actions, for tests (the webview computes the point from the live layout and dispatches
synthetic events at it):

- `{kind:"placeAt", at: DropPoint}`: `pointermove` then `pointerdown` (`PointerEvent`, `button: 0`,
  `buttons: 1`) on the element at the point.
- `{kind:"dropTileAt", at: DropPoint, data: string}`: `dragenter`, `dragover`, `drop` (`DragEvent`
  with a `new DataTransfer()` holding `application/vnd.herdr.pane` = `data`).
- `DropPoint` = `{paneKey, segment: "header"|"left"|"right"|"top"|"bottom"}` (in the stack holding
  that pane: header = 5 px right of its last tab, vertically centred in the header; left/right = 10% /
  90% of the stack body's width at mid height; top/bottom = mid width at 20% / 80% height) or
  `{edge: "left"|"right"|"top"|"bottom"}` (20 px inside that edge of `#tiles`, centred along it) or
  `{center: true}` (the centre of `#tiles`, for an empty layout).

### Not in scope

- Dropping on anything that is not an open, visible Layout tab (an empty editor group, a text
  editor, a mirrored tab). With no Layout tab on screen, a drag does nothing; clicking a row still adds.
- Dragging a space or tab row to add all its panes; multi-select.
- Moving herdr panes by dragging inside a mirrored tab (phase 22).

## Validation

- [ ] `cd herdr-vscode && npm ci && npm run build && npm run lint && xvfb-run -a npm test` passes
      (this checkout's `node_modules` lacks `golden-layout` and `@xterm/*`, so `npm ci` first).
      `git diff --stat -- devc-vscode` is empty; `package.json` `dependencies` unchanged.
- [ ] Unit tests (no webview): `handleDrag` of a Spaces pane node, an Agents row and a Pane Context
      pane node sets `application/vnd.herdr.pane` to `[{"sessionKey","paneId"}]` and arms with the
      pane's label as title; of a space, tab or Files row sets nothing and disarms; of a pane whose
      session is not connected arms nothing. Grip data parsing: the valid JSON; `""`; `"x"`; missing
      `layoutId`; `paneId` not a string → only the first is a tile.
- [ ] Unit tests (placement state, fake panels): arm posts `placePane` only to visible Layout panels
      and sets `herdr.placingPane`; with none visible nothing is posted; `placeHover` sends
      `placeEnd` to the others; disarm on `placed`, `placeCancel`, `herdr.cancelPlacement`, a new
      drag, and after 15 s without `placeHover` (fake clock), each posting `placeEnd` and clearing
      the key; `placed` makes `showsPane` true at once.
- [ ] Webview tests in `src/test/layoutPanels.test.ts` (real webview, made-up model), as `shape()`
      of the saved config after the 500 ms save, starting from a Layout with one stack `[P1]`:
      1. `placePane` P2, `placeAt {paneKey:P1, segment:"right"}` → `{row:[[P1],[P2]]}`, P2 focused,
         `placed` received;
      2. P3 at `{paneKey:P2, segment:"header"}` → `{row:[[P1],[P2,P3]]}`;
      3. P4 at `{paneKey:P1, segment:"top"}` → `{row:[{column:[[P4],[P1]]},[P2,P3]]}`;
      4. P1 (already there) at `{paneKey:P3, segment:"bottom"}` →
         `{row:[[P4],{column:[[P2,P3],[P1]]}]}`, P1's terminal not re-created (`serial` unchanged);
      5. P3 at `{paneKey:P3, segment:"header"}` → unchanged, P3 in front of its stack;
      6. P5 at `{edge:"left"}` → P5's stack first in the root row;
      7. a new empty Layout, P1 at `{center:true}` → `[P1]`.
- [ ] Webview tests, cancel: after `placePane`, a probe `press` of `Escape` posts `placeCancel` and
      a following `placeAt` changes nothing; `placeEnd` likewise; while placing, `placeAt` does not
      focus xterm's textarea before the place, and does not start a Golden Layout drag (no
      `.lm_dragProxy`).
- [ ] Webview tests, grip: two Layout panels L1 `[P1,P2]` and L2 `[P3]`; `dropTileAt` on L2
      `{paneKey:P3, segment:"right"}` with `{"sessionKey",paneId:P1,"title","layoutId":L1}` → L2 saved
      as `{row:[[P3],[P1]]}`, L1 saved as `[P2]`, `showsPane` follows for both; the same drop again
      (P1 now in L2) from L1's id moves nothing duplicated (L2 has P1 once); data `""` with nothing
      armed does nothing; data with `layoutId` of L2 itself moves within L2 and posts no
      `tileMovedIn`; a tile tab in L1 has a `[draggable="true"]` grip, a mirrored panel's has none.
- [ ] Webview test, mirrors: a mirrored panel never receives `placePane` on arm, and `dropTileAt`
      on it leaves its layout unchanged.
- [ ] `package.json` test (extension.test.ts): `herdr.cancelPlacement` contributed, keybinding
      `escape` with `when` `herdr.placingPane`, hidden in `commandPalette`.
- [ ] Manual: drag an agent from Agents onto a Layout tab and let go. The overlay shows while
      dragging; moving the pointer shows Golden Layout's highlight; clicking near the right edge of a
      tile makes a side-by-side split with the agent live in it, and typing goes there. Record
      whether the release alone placed it (platform delivered `pointerup`) and on which OS.
- [ ] Manual: the same from a Spaces pane row onto a stack's tab strip adds it as a tab there; from
      a Pane Context **Other Panes** row works the same.
- [ ] Manual: dragging a pane the layout already shows onto another stack's edge moves that tile
      (no second tile); onto its own stack's tab strip only focuses it.
- [ ] Manual: Escape right after letting go cancels (the keyboard is still in the tree); moving the
      pointer out of the tab after hovering cancels; doing nothing for 15 s clears the overlay.
- [ ] Manual: two Layout tabs side by side; drag a tile by its grip from one to an edge of the other,
      without Shift. It moves; reload the window and both layouts keep the result.
- [ ] Manual: with only a mirrored tab on screen, dragging a pane row shows nothing and changes
      nothing; dragging a Files row of Pane Context onto an editor group opens the file.

## Relevant Files

- `herdr-vscode/package.json` (`herdr.cancelPlacement` command, `keybindings`, `commandPalette` entry)
- `herdr-vscode/src/paneDrag.ts` (new: the tree drag controller and the placement state)
- `herdr-vscode/src/views/spacesView.ts`, `herdr-vscode/src/views/agentsView.ts` (create their tree
  views with the controller)
- `herdr-vscode/src/paneContext.ts` (pane rows as drag sources; its `PaneRowNode` read by the controller)
- `herdr-vscode/src/extension.ts` (Pane Context's `createHost` gets the controller; wiring, command)
- `herdr-vscode/src/tilesPanel.ts` (`LayoutPanel` / `TilesPanels`: arm, `placed`, `tileMovedIn`,
  `removeTile`, visible Layout panels)
- `herdr-vscode/src/tilesProtocol.ts` (messages, probe actions, `DropPoint`)
- `herdr-vscode/src/layouts.ts` (grip data parsing, pure; no DOM)
- `herdr-vscode/src/webview/glDrop.ts` (new: Golden Layout internals shim)
- `herdr-vscode/src/webview/tiles.ts` (placing mode, grip, HTML5 drop, move rules, probes)
- `herdr-vscode/src/webview/tiles.css` (overlay, `#place-hint`, grip, placing cursor)
- `herdr-vscode/src/test/paneDrag.test.ts` (new), `herdr-vscode/src/test/layoutPanels.test.ts`,
  `herdr-vscode/src/test/layouts.test.ts`, `herdr-vscode/src/test/extension.test.ts`
- `herdr-vscode/README.md` (Layout tabs: dragging panes in, the grip, "let go then click", Escape)
- `herdr-vscode/CHANGELOG.md` (the feature; rows of the three views are draggable; Files rows can
  be dropped on an editor group)
- `herdr-vscode/docs/how-it-works.md` (Layout tabs: a new "Dragging panes in" section with the
  measured table and the reason a tree drag only arms, the zones, the move rules, the internals used)
- `.plans/PLAN.md`
