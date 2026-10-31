# herdr-vscode: mirrored herdr tabs in the editor area

Mockup boards A and D (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): a herdr **tab** opens
as a VS Code editor tab whose content is that herdr tab's split layout, every pane a live
terminal tile. One VS Code editor tab = one herdr tab; the space and session are context only
(breadcrumb, title). Splits, closes and focus go to herdr; herdr's layout changes come back.

This plan also builds what [herdr-layout-tabs](herdr-layout-tabs.md) reuses: the webview bundle
(Golden Layout + xterm), the pane stream manager, and focus tracking.

Depends on [herdr-sidebar](herdr-sidebar.md). Paths are under `herdr-vscode/`.

Prior art in devc-tools (`/workspaces/tools/devc-tools`): `.plans/archived/devc-web.md`
(§ "Terminal streams" and § "Frames are Herdr's own redraw"), `.plans/archived/devc-web-golden-layout.md`,
`devc/web/controllers.ts` (one controller per pane), `devc/web/static/renderer.js`,
`devc/web/static/layout.js`, `devc/web/static/tiles.js`.

## Checklist

- [ ] 1. Webview bundle: `src/webview/tiles.ts` + `src/webview/tiles.css` → `dist/webview/tiles.js`
      and `dist/webview/tiles.css` (second esbuild entry); dependencies pinned
- [ ] 2. Pane stream manager in the extension host (`terminal session control`)
- [ ] 3. Mirrored panel: open/reveal, `layout.export` → Golden Layout config, re-layout on events
- [ ] 4. Tile rendering: xterm per pane, frames in, input/scroll/resize out, status dot in the
      tile header
- [ ] 5. Panel toolbar: breadcrumb, Split Right, Split Down
- [ ] 6. Close pane from a tile (with confirmation)
- [ ] 7. Focus tracking (last focused pane) and the herdr status bar item
- [ ] 8. Panel restore across reloads (`WebviewPanelSerializer`)
- [ ] 9. Commands and menus: `herdr.openTab` (Spaces tab rows, click), `herdr.openPaneTab`
      (pane and agent rows, context menu)
- [ ] 10. Tests (list under Validation)
- [ ] 11. README (opening tabs; the pty-size caveat), CHANGELOG, `docs/how-it-works.md`
      (streams, layout mapping, input handling as built)

## Contracts

### Dependencies (exact versions, `herdr-vscode/package.json` `dependencies`)

`golden-layout` `2.6.0`, `@xterm/xterm` `6.0.0`, `@xterm/addon-fit` `0.11.0` — the versions devc
web vendors. All are bundled into `dist/webview/tiles.js`; nothing loads from a CDN.

### Webview bundle

- esbuild entry `src/webview/tiles.ts` → `dist/webview/tiles.js`, `platform: "browser"`,
  `format: "iife"`, `target: "es2022"`, `bundle: true`. It imports
  `golden-layout/dist/css/goldenlayout-base.css`, `@xterm/xterm/css/xterm.css` and
  `./tiles.css`; esbuild emits them as `dist/webview/tiles.css`.
- `tiles.css` themes Golden Layout with VS Code's variables only (`--vscode-editor-background`,
  `--vscode-editorGroupHeader-tabsBackground`, `--vscode-tab-activeForeground`,
  `--vscode-tab-inactiveForeground`, `--vscode-focusBorder`, `--vscode-panel-border`); no
  Golden Layout theme file, no images.
- Webview options: `enableScripts: true`, `retainContextWhenHidden: true`,
  `localResourceRoots: [dist/webview]`. CSP:
  `default-src 'none'; script-src <cspSource>; style-src <cspSource> 'unsafe-inline'; font-src <cspSource>`.
- Terminal font: `terminal.integrated.fontFamily` (fallback `editor.fontFamily`) and
  `terminal.integrated.fontSize` (fallback `editor.fontSize`), sent to the webview at load and on
  configuration change.

### Opening

- `herdr.openTab` (args `sessionKey`, `tabId`; title "Open herdr Tab"): click action of Spaces
  tab rows. Reveals the panel already showing that (session, tab), else creates one.
- `herdr.openPaneTab` (args `sessionKey`, `paneId`; title "Open in herdr Tab"): context menu of
  `herdr.pane.agent`, `herdr.pane.shell` rows and Agents rows. Opens the pane's tab as above,
  then focuses that pane's tile.
- Pane and agent row click stays `herdr.focusPane` in this plan.
- Panel `viewType` `herdr.tiles`; title `<tab label> · <space label>`; icon `resources/herdr.svg`;
  opened in the active editor column.

### Layout mapping

- Request `layout.export` with params `{"tab_id":"<id>"}` → `result` is
  `{"tab_id", "workspace_id", "focused_pane_id", "zoomed", "root": LayoutNode}` where LayoutNode is
  `{"type":"pane","pane_id":…}` or
  `{"type":"split","direction":"right"|"down","ratio":<0..1>,"first":LayoutNode,"second":LayoutNode}`.
- Mapping to a Golden Layout `LayoutConfig` root:
  - split `right` → `row`; split `down` → `column`; children `[first, second]` with `size`
    `"<ratio×100>%"` and `"<(1−ratio)×100>%"` (`ratio` is the first child's share).
  - pane → `stack` holding one `component` of `componentType: "pane"`, `componentState`
    `{"sessionKey","paneId"}`, `title` = the pane label rule from herdr-sidebar.
  - Nested same-direction splits stay nested; do not flatten (herdr's tree and the GL tree stay
    1:1).
- Mirror settings: `reorderEnabled: false`, `popoutWholeStack: false`, `showPopoutIcon: false`,
  `showMaximiseIcon: true` (local maximise only), `showCloseIcon: true`.
- Re-export when the session emits `layout.updated`, `pane.created`, `pane.closed`,
  `pane.moved`, `pane.exited` or `tab.renamed` for this tab (data `tab_id`, or a pane whose
  snapshot `tab_id` is this tab), debounced 100 ms, then `loadLayout`.
  **Gotcha:** `loadLayout` destroys every component. Keep one xterm `Terminal` per paneKey in a
  map and re-mount its element in the new component; never create a second `Terminal` for a
  pane in the same panel.
- Splitter drags are local and are reset by the next re-export. (Syncing ratios back through
  `layout.set_split_ratio` is out of scope.)
- `tab.closed` for this tab, or the tab missing from the snapshot: the panel shows
  "This herdr tab was closed." and releases its streams.

### Pane streams (extension host, one manager per window)

- **paneKey** = `<sessionKey>|<paneId>`.
- One controller per paneKey for the whole window, shared by every tile in every panel:
  `herdr --session <S> terminal session control <pane_id> --takeover --cols <C> --rows <R>`, run
  through the environment's `RemoteShell.spawn` and the herdr wrapper from herdr-sidebar. Stdout
  is one JSON record per line; stdin takes one JSON command per line.
- Output records:
  - `{"type":"terminal.frame","seq":n,"encoding":"ansi","full":bool,"width":c,"height":r,"bytes":"<base64>"}`.
    The first frame and every frame after a resize is `full:true`.
  - `{"type":"terminal.closed","reason":"<text>"}`: `detached` (we released), `terminal attach
    taken over` (another controller took it), anything else (error).
- Forwarded to the webview as `{"type":"frame","paneKey","full","bytes"}`; the webview calls
  `term.reset()` before writing a `full` frame, then `term.write(base64-decoded bytes)`.
- Commands written to stdin:
  - input: `{"type":"terminal.input","text":"<data>"}` for xterm `onData`
  - resize: `{"type":"terminal.resize","cols":c,"rows":r}` (both > 0), debounced 100 ms after the
    fit addon reports a change. The size comes from the most recently focused tile showing that
    pane.
  - wheel: `{"type":"terminal.scroll","direction":"up"|"down","lines":3}` per wheel notch
  - release: `{"type":"terminal.release"}` when no tile in the window shows the pane any more;
    end stdin 2 s later.
- Mouse clicks are not forwarded in this plan.
- `taken over` → the tile shows "Opened in another viewer." with a **Reconnect** button that
  restarts the controller with `--takeover`.
- **Gotcha:** frames are herdr's redraw, not the app's output: the webview never learns the
  app's terminal modes (application cursor keys, bracketed paste). `terminal.input` reaches the
  app raw. Match devc web's key handling in `devc/web/static/renderer.js` and record what was
  done in `docs/how-it-works.md`.
- **Gotcha:** `terminal.resize` changes the pane's real pty size, and it persists after release.
  A herdr TUI showing the same pane draws it at VS Code's size until the TUI resizes it back.
  The README says so.

### Tiles

- Tile header (the GL tab): status dot (herdr-sidebar's status table, as a CSS circle), label,
  then `terminal_title_stripped` faded when an agent is present. Updated from the session model
  without a re-layout.
- Tile body: the xterm. No pane IDs anywhere in the UI.

### Toolbar (HTML strip above the GL area)

- Left: breadcrumb `<session row label> › <space label> › <tab label>`.
- Right: **Split Right** and **Split Down** (buttons). They act on the panel's focused tile:
  request `pane.split` with params
  `{"target_pane_id":"<id>","direction":"right"|"down","cwd":"<pane foreground_cwd ?? cwd>","focus":false}`.
  The new pane arrives through the re-export.

### Closing a pane

GL close icon on a tile → modal `Close "<label>" in herdr? Its process ends.` with **Close Pane**
→ request `pane.close` with params `{"pane_id":"<id>"}`. Cancel keeps it.

### Focus tracking

- The webview posts `{"type":"focus","paneKey"}` when a tile's xterm gains focus. The extension
  keeps the window's **last focused pane** (paneKey) and fires an internal event for
  [herdr-pane-context](herdr-pane-context.md).
- Left status bar item, priority 100, shown while the last focused pane exists:
  `$(circle-filled) <label> · <agent_status or "shell">`, tooltip
  `<session row label> › <space label> › <tab label>`; click reveals its tile.
- Focusing a tile does **not** move herdr's own focus.

### Restore

`registerWebviewPanelSerializer('herdr.tiles')`; the webview stores
`{"kind":"mirror","sessionKey","tabId"}` with `vscode.setState`. On restore, the panel waits for
that session to connect (up to 10 s, showing "Connecting to <session>…") and then for the tab;
missing → "This herdr tab was closed.".

## Validation

- [ ] `npm run build` (in `herdr-vscode/`) emits `dist/webview/tiles.js` and `dist/webview/tiles.css`;
      `npx vsce ls` (in the package) lists both and no `node_modules`
- [ ] `npm test` (in `herdr-vscode/`) passes, including unit tests for: LayoutNode → GL config
      (single pane; right split with ratio 0.6 → sizes `60%`/`40%`; nested down-in-right;
      nested right-in-right stays nested); terminal record parsing (frame, closed with each
      reason, junk line ignored); controller sharing (two tiles, one spawn; last tile closed →
      release then stdin end); resize owner = last focused tile
- [ ] Manual: in herdr session `hv-test`, a tab with three panes (one split right, then the right
      one split down). Clicking that tab in Spaces opens an editor tab titled
      `<tab> · <space>` with the same three-tile arrangement and live output in each
- [ ] Manual: typing in a tile (including arrow keys in `vim` and in a Claude Code prompt)
      behaves as in the herdr TUI
- [ ] Manual: **Split Right** on the focused tile creates a pane in herdr (visible in the TUI) and
      a fourth tile appears in the same place within 1 s
- [ ] Manual: splitting or closing a pane in the herdr TUI updates the editor tab within 1 s,
      and existing tiles keep their scrollback (no re-created terminals)
- [ ] Manual: closing a tile asks for confirmation; **Close Pane** closes it in herdr
- [ ] Manual: the same herdr tab opened from a second VS Code window: the first window's tiles
      show "Opened in another viewer." and **Reconnect** takes them back
- [ ] Manual: reload the window; the editor tab comes back and reconnects
- [ ] Manual: after closing the editor tab, `ps -eo args | grep 'terminal session control'` in the
      environment prints nothing within 5 s
- [ ] Manual: the status bar shows the last focused tile's label and state; clicking it reveals
      the tile
- [ ] Manual, container and SSH: the above open-and-type check works for a container session and
      an SSH session

## Relevant Files

- `herdr-vscode/package.json` (dependencies, commands, menus, activation `onWebviewPanel:herdr.tiles`)
- `herdr-vscode/esbuild.mjs` (second entry)
- `herdr-vscode/.vscodeignore` (ship `dist/webview/**`; the scaffold whitelists only `!dist/**/*.js`, so add `!dist/**/*.css` for `tiles.css`)
- `herdr-vscode/src/extension.ts`
- `herdr-vscode/src/streams.ts` (new: pane stream manager)
- `herdr-vscode/src/tilesPanel.ts` (new: panel creation, messaging, serializer, toolbar actions)
- `herdr-vscode/src/layoutMapping.ts` (new: LayoutNode → GL config)
- `herdr-vscode/src/focus.ts` (new: last focused pane, status bar item)
- `herdr-vscode/src/views/spacesView.ts`, `agentsView.ts` (click and context menu commands)
- `herdr-vscode/src/webview/tiles.ts`, `tiles.css` (new)
- `herdr-vscode/src/test/*.test.ts`
- `herdr-vscode/README.md`, `CHANGELOG.md`, `docs/how-it-works.md`
- `.plans/PLAN.md`
