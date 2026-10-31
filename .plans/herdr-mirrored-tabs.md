# herdr-vscode: mirrored herdr tabs in the editor area

Mockup boards A and D (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): a herdr **tab** opens
as a VS Code editor tab whose content is that herdr tab's split layout, every pane a live
terminal tile. One VS Code editor tab = one herdr tab; the space and session are context only
(breadcrumb, title). Splits, closes and focus go to herdr; herdr's layout changes come back.

This plan also builds what [herdr-layout-tabs](herdr-layout-tabs.md) reuses: the webview bundle
(Golden Layout + xterm), the pane stream manager, and focus tracking.

Depends on [herdr-sidebar](implemented/herdr-sidebar.md). Paths are under `herdr-vscode/`.

Prior art in devc-tools (`/workspaces/tools/devc-tools`): `.plans/archived/devc-web.md`
(§ "Terminal streams" and § "Frames are Herdr's own redraw"), `.plans/archived/devc-web-golden-layout.md`,
`devc/web/controllers.ts` (one controller per pane), `devc/web/static/renderer.js`,
`devc/web/static/layout.js`, `devc/web/static/tiles.js`.

## Checklist

- [x] 1. Webview bundle: `src/webview/tiles.ts` + `src/webview/tiles.css` → `dist/webview/tiles.js`
      and `dist/webview/tiles.css` (second esbuild entry); dependencies pinned
- [x] 2. Pane stream manager in the extension host (`terminal session control`)
- [x] 3. Mirrored panel: open/reveal, `layout.export` → Golden Layout config, re-layout on events
- [x] 4. Tile rendering: xterm per pane, frames in, input/scroll/resize out, status dot in the
      tile header
- [x] 5. Panel toolbar: breadcrumb, Split Right, Split Down
- [x] 6. Close pane from a tile (with confirmation)
- [x] 7. Focus tracking (last focused pane) and the herdr status bar item
- [x] 8. Panel restore across reloads (`WebviewPanelSerializer`)
- [x] 9. Commands and menus: `herdr.openTab` (Spaces tab rows, click), `herdr.openPaneTab`
      (pane and agent rows, context menu)
- [x] 10. Tests (list under Validation)
- [x] 11. README (opening tabs; the pty-size caveat), CHANGELOG, `docs/how-it-works.md`
      (streams, layout mapping, input handling as built)
- [x] 12. Remove **Attach in Terminal** (see Terminals live in the editor area)

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

### Terminals live in the editor area

Decided by the user on 2026-10-30, after trying **Attach in Terminal** from herdr-sidebar: herdr
panes are shown in editor area tiles only. The extension does not open the herdr TUI in an
integrated terminal.

- Remove the `herdr.attachSession` command, its menu entries and its test, along with
  `attachCommand` in `src/extension.ts`, and its mentions in the README. Add a CHANGELOG entry.
- Remove `sshTerminalCommand` and `containerTerminalCommand` from `src/remoteShell.ts` if nothing
  else uses them.
- Session rows then have no inline action. A running row's click still selects it, and tabs open
  from Spaces. A stopped row has no action (starting a session is not in this plan).

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

- [x] `npm run build` (in `herdr-vscode/`) emits `dist/webview/tiles.js` and `dist/webview/tiles.css`;
      `npx vsce ls` (in the package) lists both and no `node_modules`
- [x] `npm test` (in `herdr-vscode/`) passes, including unit tests for: LayoutNode → GL config
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
- [x] `grep -rn attachSession herdr-vscode/src herdr-vscode/package.json` prints nothing; Session
      rows show no terminal icon

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

## Implementation notes

### Status (2026-10-30)

Implemented; the Manual items above were not run, because they need a person in VS Code. No Docker
and no reachable SSH host here, so the container and SSH item has no live evidence at all (the
argv goes through the same `RemoteShell.spawn` and `herdrArgv` as the bridge). The plan stays out
of `implemented/` until the manual pass.

### Verified

- `npm run build && npm run lint && xvfb-run -a npm test`: 67 passing, 21 pending (opt-in live
  suites). `npx vsce ls`: `dist/extension.js`, `dist/webview/tiles.{js,css}`, `resources/herdr.svg`,
  `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, and no `node_modules`, although the three
  packages are in `dependencies`. `git diff --stat -- devc-vscode` is empty.
- Opt-in, real extension host under xvfb with a **real webview**, against throwaway `hv-test` in an
  isolated `HOME` (`HERDR_VSCODE_LIVE_HOME`, `src/test/liveTiles.test.ts` + `liveModel.test.ts`: 17
  passing). What this covers, as evidence for the Manual items but not a replacement for them:
  - three-tile arrangement from a tab with split right then split down: rectangles right, title
    `mirror · space1`, painted in about 1 s, one controller per pane, and a framebuffer screenshot
    of the Extension Development Host looked right (toolbar, three then four tiles, status bar
    `hvh · shell`). The tab was opened with `panels.openTab`, not a Spaces click.
  - the pty took the tile's size (`stty size` printed the tile's rows and cols).
  - ArrowUp as a synthetic `keydown` on xterm's textarea reached `cat -v` as `^[[A`. **Real
    keyboards, vim and Claude Code prompts were not tried** (no `xdotool` here).
  - `split` message: fourth tile in 260–410 ms, beside the focused tile, existing terminals not
    re-created. `pane.close` from outside: tile gone in 220–305 ms, others keep their terminal.
  - Takeover by a second controller: *Opened in another viewer.*; the Reconnect message cleared it.
    Not a second VS Code window.
  - Golden Layout's close control: a real click reached `closePane` and the tile stayed. The test
    host refuses modals, so **the dialog and its Close Pane button were not exercised**; the
    `pane.close` params were, separately.
  - Restore: `deserializeWebviewPanel` with the saved state brought tiles back. Not a real window
    reload.
  - After `tab.close`: *This herdr tab was closed.*, no tiles, no controllers. Session never
    connecting: *Connecting to …*, then closed at 10 s.
  - Closing the panel: no `--session hv-test terminal session control` in `ps` after 30–105 ms.
  - xterm's own focus event was reported by `reveal(paneId)` on an existing and on a new panel.
- Never run at all: Ctrl+Shift+C/V and Cmd+C/V (nothing here sends real clipboard keys), the wheel
  in a webview, font and theme changes, maximise, the status bar click, the context menu.
- On this machine `ps` also lists `--session devc terminal session control …`: that is the user's
  own viewer of the live session, not the extension's. Do not count it in the `ps` check.

### Deviations and decisions

- **`layout.export` is wrapped:** the result is `{"type":"layout_export","layout":{…}}`, and pane
  nodes also carry `cwd`. The contract above shows it flat. `parseLayoutExport` takes the real shape.
- Unknown tab: `layout.export` errors with `layout_not_found`, treated as closed.
- A re-export whose split tree is unchanged is **dropped**, not reloaded: `layout.updated` also fires
  on focus changes, and reloading would reset splitter drags and maximise on every focus move. So
  a drag is reset by the next real change to the tree, not by every event.
- Besides the listed events, a re-export follows `events_lost` and any snapshot whose panes for the
  tab differ from those on screen.
- Frame messages also carry `cols`, `rows`: a tile that does not own the pane's size follows the
  frame's size, as devc web does.
- **A second tile joining a controller gets its repaint from a same-size `terminal.resize`**
  (measured: any `terminal.resize` gives a `full:true` frame), so one spawn is enough. devc web
  restarts the controller instead.
- `terminal.release` makes the process exit by itself; the stdin end 2 s later is the backstop. On
  deactivate stdin ends immediately after the release.
- Other `terminal.closed` reasons get *Disconnected: <reason>.* with **Reconnect**. Measured:
  `terminal <id> exited` when the app exits, `terminal attach ended: terminal <id> not found` when
  the pane is closed. Those overlays last until the re-export removes the tile (about 200 ms).
- A session that stops being connected tears the tiles down (*Connecting to …*) and rebuilds them
  on reconnect, one path with restore. No content is lost: xterm has `scrollback: 0`, herdr owns
  it. "Keep their scrollback" in the Validation list therefore means the tile keeps its terminal
  and screen; scrolling back asks herdr.
- Wheel: "3 lines per notch" with pixel deltas: one notch per 3 cell heights of accumulated `deltaY`,
  so a trackpad is proportional. One command may carry several notches, capped at 30 lines.
- Tile close: the tab's own X is hidden by CSS, since each stack has one tile and the stack's X
  already means that tile. Middle-click on a tile tab does nothing. Clicking a header focuses
  the tile.
- A shell pane's dot is a dim square; the status table has no shell entry for a CSS dot.
- Additions: Ctrl+Shift+C/V off the Mac via `vscode.env.clipboard` (plain Ctrl+C/V belong to the app,
  and VS Code stops the browser's own paste); `TileProbe`/`probe` messages used only by the live
  suite; `SessionModel.onDidEvent` for raw events; terminal colors from `--vscode-terminal-*`, following
  theme changes.
- Removed with Attach in Terminal: `attachCommand`, `sshTerminalCommand`,
  `containerTerminalCommand`, `hostShellWord`, and the `sshPath`, `dockerPath`, `sshControlDir` getters
  on `Environments`.
- `src/webview/` has its own `tsconfig.json` (DOM lib, bundler resolution); `npm run compile` runs
  both. The root config excludes only `tiles.ts`, so tests can import `webview/input.ts`.
- Packages: `npm install` pruned `@esbuild/darwin-x64` as warned; it was restored from `npm pack` at
  0.28.2 with no lockfile change. The lockfile still lists every esbuild platform.
- `sideEffects: false` in golden-layout's `package.json` did **not** make esbuild drop its CSS import;
  the base CSS is in `dist/webview/tiles.css`.

### For herdr-layout-tabs and herdr-pane-context

- `PaneViewer` in `src/streams.ts` is a panel, and it may hold **one tile per pane**: the webview's
  terminal map is keyed by paneKey. A Layout panel fits as is, so long as a pane appears once in it.
  The stream manager already shares a pane between panels of the window and handles the size owner.
- `MirrorPanel` mixes generic webview plumbing (messages, streams, focus, ready replay) with mirror
  logic (export, sync). Layout tabs will want the first half split into a base class. `TilesPanels`
  and `deserializeWebviewPanel` assume `kind: "mirror"`; extend the `init` state union.
- The webview applies whatever `layout` config it is sent, but `interceptClose` always posts
  `closePane`, and the `.lm_close_tab` CSS assumes one tile per stack. Layout panels need different
  close semantics, tab X's, and `reorderEnabled: true`; hang those on a class on `<body>`.
- `loadLayout` focus restoring, the terminal map, and `tileClose` for panes missing from the new
  config are in `applyLayout`; a Layout tab's `stateChanged` saving is not wired.
- `pane.moved`'s event data was not measured (no way to trigger it here was tried); it always
  re-exports. Layout tabs' "pane-move follow-up" should measure it.
- Pane Context: `FocusTracker.onDidChangeLastFocused` fires the paneKey, `lastFocused` reads it.
  `MirrorPanel.reveal(paneId)` / `TilesPanels.revealPane` reveal a tile. Terminal links need a link
  provider on the `Terminal` in `createTile` in `src/webview/tiles.ts`, plus a new message; CSP has
  no `connect-src`, so all file access goes through the host.
- Live testing: `probe` messages read a tile's buffer, rectangles and overlay, and can press a key or
  click close. With Xvfb's `-fbdir`, the framebuffer can be read as XWD for a screenshot.
- Inside a herdr pane, always strip `HERDR_*` and use an isolated `HOME` for test sessions. Live
  suites inherit the shell's `HERDR_SESSION`; `LocalShell` strips it, a bare `herdr` CLI does not.
