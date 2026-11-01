# herdr-vscode: one editor tab per herdr space

Changes the scope set by [herdr-mirrored-tabs](herdr-mirrored-tabs.md) ("One VS Code editor tab =
one herdr tab"). Decided by the user on 2026-11-01: **a VS Code editor tab mirrors a herdr space.**
The panel shows the space's **active** herdr tab as tiles (exactly as a mirrored tab does today,
including [herdr-mirror-fidelity](herdr-mirror-fidelity.md)'s ratios, moves and zoom), with a **tab
strip** of the space's herdr tabs in its toolbar. The strip and herdr's active tab are synced
both ways, and the strip can create, close and rename herdr tabs.

Layout tabs ([herdr-layout-tabs](herdr-layout-tabs.md)) are unchanged.

Depends on phases 15 and 22. Paths are under `herdr-vscode/` unless they start with `.plans/`.

## Checklist

- [x] 1. Snapshot: parse `active_tab_id` on workspaces; keep the tabs' snapshot order
- [x] 2. Panel identity: the mirror panel is keyed by (session, space), not (session, tab); title,
      breadcrumb, `herdr.openSpace`, and `openTab` / `openPaneTab` / `revealPane` re-pointed
- [x] 3. Shown tab follows the space's `active_tab_id`; switching tabs swaps tiles and streams
- [x] 4. Tab strip in the toolbar (render, status dot, active entry, overflow)
- [x] 5. Strip click → `tab.focus`
- [x] 6. Strip **+** → `tab.create` in this space
- [x] 7. Strip **×** → confirm → `tab.close`
- [x] 8. Strip double-click → input box → `tab.rename`
- [x] 9. Space closed / missing → "This herdr space was closed."
- [x] 10. Restore: new `space` state, and the old `mirror` state migrated
- [x] 11. Spaces view: space row click opens the space; command titles and `herdr.openPaneIn` text
- [x] 12. Tests (list under Validation)
- [x] 13. README, CHANGELOG, `docs/how-it-works.md`; superseded note in
      `.plans/herdr-mirrored-tabs.md`

## Contracts

### Terms

- **space** = herdr workspace (`workspace_id`). **spaceKey** = `<sessionKey>|<workspaceId>`.
- **shown tab** = the herdr tab whose tiles the panel displays. It is always the space's
  `active_tab_id` from the latest snapshot, except for the optimistic switch below.

### Snapshot

- Each snapshot workspace has `active_tab_id` (string; measured on herdr protocol 22:
  `{"workspace_id":"w1","active_tab_id":"w1:t1P",…}`). Parse it into the workspace model as
  optional. A missing or unknown `active_tab_id` → the space's first tab in snapshot order.
- The snapshot's `tabs` array order is herdr's tab order (it follows `tab.move`). The strip uses
  that order filtered by `workspace_id`; do not sort by `number`.
- Re-read the snapshot (the model's existing refresh) on `tab.focused`, `tab.created`,
  `tab.closed`, `tab.renamed`, `tab.moved`, `workspace.renamed` and `workspace.closed` for the
  session if the model does not already. The `tab.focused` event's data shape was not measured;
  do not depend on it — the snapshot's `active_tab_id` is the source of truth.

### Opening

- Panel `viewType` stays `herdr.tiles`. One mirror panel per spaceKey per window.
- **`herdr.openSpace`** (new; args `sessionKey`, `workspaceId`; title "Open herdr Space"): reveals
  the panel for that spaceKey, else creates one in the active editor column. Does not call
  `tab.focus`.
- **`herdr.openTab`** (args `sessionKey`, `tabId`; title "Open herdr Tab"; Spaces tab row click):
  opens the tab's space as above, then, if the tab is not the space's active tab, requests
  `tab.focus` with params `{"tab_id":"<id>"}`.
- **`herdr.openPaneTab`** (args unchanged; title becomes "Open in herdr Space"): opens the pane's
  tab as `herdr.openTab` does, then focuses the pane's tile once it is shown.
- `revealPane` (status bar click, Pane Context, `herdr.openPaneIn` = `herdr`): a mirror panel
  "shows" a pane only when the pane is in its **shown tab**. With none, `openPaneTab`.
- Everything that called `openTab` after creating or splitting (New Tab and Split Right / Down
  on Spaces rows) keeps calling it, and so now also focuses that tab in herdr.
- Title: `<space label>`. Breadcrumb: `<session row label> › <space label>`. Both update on
  rename.

### Shown tab

- On every snapshot change, if the space's `active_tab_id` differs from the shown tab, switch to
  it: export its layout (`layout.export` `{"tab_id"}`) and apply it as today. Panes of the old tab
  leave the panel through the existing tile-removal path, so their streams are released by the
  stream manager's existing rules; panes of the new tab get controllers.
- The panel's split-ratio, zoom, in-flight and focused-pane state is per shown tab: reset it on a
  switch.
- **Gotcha:** an export in flight for the old tab can answer after the switch. Drop any export
  answer (and any `set_split_ratio` / `pane.zoom` answer) whose `tab_id` is not the shown tab.
- **Gotcha:** the existing "re-export unchanged split tree is dropped" rule compares structures;
  a switch between two tabs with the same structure (e.g. two single-pane tabs) must still load,
  because the pane IDs differ. Compare tab ID and pane IDs, not only shape.
- Switch latency target: tiles of the new tab within 1 s of the switch in herdr.

### Tab strip (toolbar)

- Toolbar layout, left to right: breadcrumb, tab strip, then the existing buttons (Split Right,
  Split Down, Copy as Layout). The breadcrumb shrinks with ellipsis first; the strip scrolls
  horizontally (no wrap, no visible scrollbar), and the active entry is scrolled into view.
- Entry: status dot (the same status the Spaces tab row shows for that tab, as the CSS circle tiles
  use; a tab without agents gets the dim square shell tiles use), then the tab label. The active
  entry uses `--vscode-tab-activeForeground` and a bottom border in `--vscode-focusBorder`; others
  `--vscode-tab-inactiveForeground`. Entry tooltip: the label.
- Each entry has an **×** shown on hover and on the active entry. A **+** button ends the strip
  (tooltip "New Tab").
- No pane or tab IDs anywhere in the UI.

### Strip actions (webview → extension messages; requests go to the panel's session)

- **Click** an entry that is not the shown tab: the panel switches to it at once (optimistic),
  then requests `tab.focus` `{"tab_id":"<id>"}`. On error: warning `herdr: <message>` and switch
  back to the snapshot's `active_tab_id`.
- **+**: request `tab.create` with params
  `{"workspace_id":"<space id>","cwd":"<cwd>","focus":true}`, where `<cwd>` is the panel's focused
  tile pane's `foreground_cwd ?? cwd`, else the shown tab's first pane's, else omit `cwd`. The new
  tab becomes active in herdr and the panel follows through the snapshot.
- **×**: modal warning `Close tab "<label>" in herdr? Its processes end.` with button
  **Close Tab** → request `tab.close` `{"tab_id":"<id>"}`. Cancel does nothing.
- **Double-click** an entry: `vscode.window.showInputBox` with `prompt` "Rename herdr tab",
  `value` the current label, validation "Enter a name." on empty/whitespace → request
  `tab.rename` `{"tab_id":"<id>","label":"<trimmed>"}`. Escape does nothing. Double-click must not
  also fire the click's `tab.focus` twice: the first click focuses, the second is ignored.
- **Gotcha:** `tab.focus` may also move herdr's focused workspace (the TUI jumps to this space).
  Measure it on a live session and record the result in Implementation notes and the README; it
  is accepted either way (two-way sync was the user's choice).
- **Gotcha:** closing a space's last tab may close the space in herdr. Measure; if so, the panel
  follows the space-closed rule below.

### Space closed

`workspace.closed` for this space, or the space missing from a connected snapshot: the panel shows
"This herdr space was closed." and releases its streams (the same path as today's "This herdr tab
was closed."). The tab-closed message is no longer used by mirror panels; a closed shown tab is
simply replaced by the new `active_tab_id`.

### Restore

- The webview stores `{"kind":"space","sessionKey","workspaceId"}`.
- The old state `{"kind":"mirror","sessionKey","tabId"}` (saved by earlier builds) is still
  accepted: after the session connects (same 10 s wait, "Connecting to <session>…"), look the tab
  up in the snapshot and restore as that tab's space, without `tab.focus`. Tab not found → "This
  herdr space was closed.". The next `setState` writes the new shape.
- A restored panel whose spaceKey already has a panel in this window is disposed (the first one
  wins).

### Spaces view and settings

- Space rows (`herdr.space`) get `command` `herdr.openSpace` with
  `[sessionKey, workspaceId]`. Expanding stays on the twistie.
- Tab row click stays `herdr.openTab`. Context-menu title of `herdr.openPaneTab` on pane and
  Agents rows becomes "Open in herdr Space"; so does the click title from `paneClickCommand`.
- `herdr.openPaneIn` keeps its values `layout` and `herdr`; the `herdr` enumDescription becomes
  "Open the pane's herdr space, showing its tab."

## Validation

- [x] `npm run build && npm run lint` (in `herdr-vscode/`) pass
- [x] `xvfb-run -a npm test` (in `herdr-vscode/`) passes, including unit tests for:
      `active_tab_id` parsing (present, missing → first tab, unknown → first tab); strip model
      from a snapshot (order follows the `tabs` array, not `number`; only this space's tabs; the
      active flag); one panel per spaceKey (`openTab` on two tabs of one space → one panel;
      tabs of two spaces → two panels); `showsPane` true only for panes of the shown tab;
      restore of `{"kind":"mirror",…}` → space panel for the tab's workspace, and unknown tab →
      closed text; a stale export answer for another tab is dropped; two single-pane tabs
      switch (tile set changes although the structure is equal); `tab.create` params use the
      focused tile's `foreground_cwd`, falling back to `cwd`
- [x] Opt-in live suite against throwaway `hv-test` in an isolated `HOME` (extend
      `src/test/liveTiles.test.ts`): a space with two tabs opens as one panel titled with the
      space label and a two-entry strip; `herdr tab focus <other>` from the CLI switches the
      tiles within 1 s; a strip click message makes the snapshot's `active_tab_id` change; **+**
      creates a third tab that becomes shown; the `tab.close` and `tab.rename` request paths run
      (modal and input box are refused by the test host); after a switch no
      `--session hv-test terminal session control` remains for the old tab's panes within 5 s;
      `workspace close` → "This herdr space was closed."
- [x] `grep -n '"herdr.openSpace"' herdr-vscode/package.json` prints the command entry
- [ ] Manual: clicking a space row in Spaces opens one editor tab titled with the space label,
      showing herdr's active tab; clicking a tab row of the same space reuses that editor tab
      and the herdr TUI switches to that tab
- [ ] Manual: switching tabs in the herdr TUI switches the editor tab's tiles within 1 s
- [ ] Manual: strip click, **+**, **×** (with its confirmation) and double-click rename each show
      up in the herdr TUI
- [ ] Manual: mirror-fidelity still works on the shown tab after a switch (splitter drag sets the
      ratio in herdr, tile drop swaps, maximise is zoom)
- [ ] Manual: an editor tab saved by the previous build (one herdr tab) comes back after reload as
      its space
- [ ] Manual: status bar click and Pane Context's Show Pane reveal a pane in another tab of an open
      space by switching that space's tab

## Relevant Files

- `herdr-vscode/package.json` (`herdr.openSpace` command, `herdr.openPaneTab` title,
  `herdr.openPaneIn` enumDescription)
- `herdr-vscode/src/sessions.ts` (`active_tab_id`; refresh on tab and workspace events if needed)
- `herdr-vscode/src/tilesPanel.ts` (space-keyed mirror panel, shown-tab switching, strip actions,
  restore, `TilesPanels.openSpace` / `openTab` / `openPaneTab` / `revealPane`)
- `herdr-vscode/src/tilesProtocol.ts` (`space` state kind, strip view model, strip messages)
- `herdr-vscode/src/webview/tiles.ts`, `herdr-vscode/src/webview/tiles.css` (tab strip)
- `herdr-vscode/src/extension.ts` (`herdr.openSpace`, `herdr.openTab` with `tab.focus`)
- `herdr-vscode/src/views/spacesView.ts` (space row command, `paneClickCommand` title)
- `herdr-vscode/src/test/sessions.test.ts`, `mirrorPanels.test.ts`, `views.test.ts`,
  `extension.test.ts`, `liveTiles.test.ts`, `liveMirrorEdit.test.ts`, `layoutPanels.test.ts`,
  `liveLayouts.test.ts` (fixtures and expectations that assume one panel per tab)
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md`
- `.plans/herdr-mirrored-tabs.md` (superseded note), `.plans/PLAN.md`

## Implementation notes

### Status (2026-11-01)

Implemented; the Manual items above were not run, because they need a person in VS Code and a herdr
TUI to watch. The plan stays out of `implemented/` until that pass.

### Verified

- `npm run build && npm run lint && xvfb-run -a npm test` (in `herdr-vscode/`): 334 passing, 60 pending
  (opt-in live suites). New `src/test/spacePanels.test.ts` (10 tests, real webview over a made-up model)
  covers every unit item in Validation; `views.test.ts` has `activeTabOf` / `stripTabs` and the row commands.
- Live, throwaway `hv-test` in an isolated `HOME=/tmp/hvs` (removed afterwards; the real sessions were not
  touched): new `src/test/liveSpaces.test.ts` (6) and the updated `liveTiles.test.ts` (14) pass. Two full live
  runs in a row: 395 passing, 4 pending, 1 failing, the known `live model … lists only the isolated session`
  (the home also lists `default` and `hv-ctl`).
- Measured on herdr 0.9.5:
  - `tab.focus` also makes the tab's space herdr's focused workspace (`focused_workspace_id` `w1` → the
    space). Accepted, and stated in the README.
  - Closing a space's last tab: `tab.close` answers `{"type":"ok"}`, and the space is gone from the next
    snapshot. The panel shows *This herdr space was closed.*
  - A strip click → snapshot `active_tab_id` agrees after 207–406 ms; `tab.focus` from outside → tiles of the
    other tab after 379–488 ms; the old tab's controller gone about 21 ms later.
  - `workspace.create` answers `{"type":"workspace_created","workspace":{"workspace_id",…,"active_tab_id"},
    "tab":{…},"root_pane":{…}}`.
- A framebuffer screenshot of the test host showed the editor tab titled with the space, breadcrumb
  `hv-row › spaces`, and the strip: `agents` (shell square), the active `two` (blue working dot, ×), **+**, then
  Copy as Layout, Split Right, Split Down.

### Flaky, not explained

In 2 of 9 live runs that included `liveTiles` or `liveSpaces`, the session model's snapshot did not
pick up a herdr change in time. `liveTiles`' *tile headers follow the model* waited 3 s for the
`report_agent` label (once in a combined run, once in a full run). `liveSpaces`' setup waited 5 s for
a new workspace: the connection was `connected` and its snapshot still listed only `w1`. Neither has
been reproduced since: the suites alone passed 3/3 and 4/4, and two full runs were clean. The
original code's `liveTiles` passed 2/2, which is too few runs to rule out a regression. These
features did not change the model's snapshot or subscribe path (`src/sessions.ts` only parses
`active_tab_id`). A suspect for later is the resubscribe in `SessionConnection.takeSnapshot`: it
closes the old subscription once the new one is attached, and could drop events the old one had not
delivered yet. Both waits now log the model's state on timeout. Separately, one full run failed
`livePaneContext`'s *a directory is revealed in Files* (8 s). That suite opens no mirror panels, and
it passed in the next two full runs.

### Deviations and decisions

- The strip entry's dot is the worst agent status of the tab's panes (`worstStatus`). Spaces tab rows
  have no status icon (only the summary text), so there was nothing to copy.
- `MirrorPanel` keeps its name and is now keyed by space; `tabId` is the shown tab. `TilesPanels.openTab`
  returns `undefined` (with a warning) for a tab not in the snapshot, where it used to open a panel that
  waited. `openSpace` covers the waiting case (the stranded-session live test uses it).
- A strip click's tab stays shown up to 2 s while the snapshot catches up (`PENDING_TAB_MS`), so the
  tiles do not flick back to the old tab between `tab.focus`'s answer and the snapshot.
- Panels restored from the old state are tracked as *unresolved* until the session connects, so
  `dispose` and font changes reach them; resolving re-sends `init` so the webview stores the new state.
- `closeTab(tabId, confirm)` and `renameTab(tabId, name)` take test-only arguments that skip the
  modal and the input box (the test host refuses both).
- Probe additions: `strip` in `probeResult`; `clickStrip` / `clickNewTab` actions.
- The webview treats `space` and `mirror` init states alike (`kind-mirror`), so every existing
  mirror-only control and handler applies unchanged.

