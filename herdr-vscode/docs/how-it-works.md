# How herdr-vscode works

herdr-vscode reaches herdr the way devc web does: `herdr remote-api-bridge` run in each
environment, one JSON request per connection, plus one long-lived `events.subscribe` connection
per running session. Nothing is installed in an environment; herdr ≥ 0.9.5 is all it needs.

## Environments

An environment is somewhere herdr sessions run, with a key and a way to run commands there
(`src/remoteShell.ts`, copied from devc-vscode):

| Environment | Key | Runs commands with |
| --- | --- | --- |
| This machine (not on Windows) | `host` | `child_process`, no shell (`LocalShell`); `HERDR_*` variables are removed so a VS Code started from a herdr pane does not steer herdr to that pane's session |
| SSH host, one per `herdr.sshHosts` entry | `ssh:<alias>` | `ssh -T -o BatchMode=yes` plus forwarding forced off, multiplexed through `/tmp/devc-<uid>` (`SshShell`); only aliases in `herdr.sshHosts` are ever spawned |
| Running dev container | `container:<first 12 chars of id>` | `docker exec -i [-u <remote user>]` (`DockerShell`); the remote user comes from the `devcontainer.metadata` label |

Discovery (`src/environments.ts`):

- Containers: `docker ps --filter label=devcontainer.local_folder --format '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.Names}}'`.
  Every running dev container is shown, named by the basename of its local folder. A
  `docker events --filter type=container --filter event=start --filter event=die --format '{{.ID}}'`
  process runs for the window's life; any line triggers rediscovery 500 ms later. If Docker is
  missing, there are no container environments and no error; the watcher retries every 30 s.
- SSH hosts: from settings, on every settings change and every 30 s. Unreachable hosts (ssh exit
  255, or ssh failing to start) are re-listed only on that 30 s pass.
- **Refresh** rediscovers both.

Every herdr command goes through one wrapper, so `~/.local/bin` is found without a login shell:

```
sh -c 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"' herdr <args…>
```

## Sessions

`herdr session list --json` per environment (`src/sessions.ts`), every 10 s for reachable
environments and on **Refresh**:

- exit 0: `{"sessions":[{"name","default","running",…}]}`; malformed output counts as no sessions.
- exit 127 (the wrapper's `exec herdr` failed): *herdr not installed*.
- ssh exit 255: *unreachable*. Anything else: *error* (the first stderr line is in the tooltip
  and the `herdr` output channel).

A session's key is `<environment key>/<session name>`, e.g. `host/code-wksp`,
`ssh:buildbox/default`, `container:3f2a9c1b04de/devc`. Each running session gets a connection;
sessions that stop or whose environment goes away have theirs ended.

## Bridge protocol

`src/bridge.ts`. Every connection is `herdr --session <S> remote-api-bridge` spawned with stdin
piped and **never a pty** (a pty corrupts the JSON).

1. **Check:** `herdr --session <S> remote-api-bridge --check` must print exactly
   `herdr-api-bridge-v1` and exit 0. Otherwise the row says *needs herdr 0.9.5 or later* and
   there is no connection (until **Refresh**).
2. **Subscribe** before the first snapshot (herdr does not replay events):
   `{"id":"s","method":"events.subscribe","params":{"subscriptions":[…]}}`. The list is every
   global type (`workspace.*`, `tab.*`, `pane.created/closed/updated/focused/moved/exited`,
   `pane.agent_detected`, `layout.updated`) plus `{"type":"pane.agent_status_changed","pane_id":…}`
   for each pane: agent status changes are only reported through that per-pane type. The first
   reply is `{"id":"s","result":{"type":"subscription_started"}}`, then one
   `{"event":…,"data":…}` per line.
3. **Snapshot:** a one-shot `session.snapshot` (spawn, write one line, read the reply with the
   same id, end stdin). One request per connection: a second request on the same connection
   resets it.

Event names arrive spelled inconsistently (`pane_created`, but `pane.agent_status_changed`). A
name with no `.` has its first `_` turned into one. An error line with `code: "events_lost"`
means events were dropped; it is handled like any event.

## Refresh rules

- Any event re-takes `session.snapshot` 150 ms later (events arriving meanwhile share that
  snapshot; one snapshot runs at a time, and one more follows if events came during it).
- When a snapshot's pane set differs from the subscribed one, a new subscription with the new
  per-pane list is opened first, then the old one is closed (no gap; duplicate events are
  harmless).
- A subscription that ends on its own marks the session *disconnected*. It is retried after
  2 s, 5 s, 10 s, then every 30 s; each retry re-lists the environment first, so a session that
  stopped is dropped instead of retried.
- **Start Session** runs `herdr --session <S> server` detached in the home directory, so it outlives the
  window, then re-lists until it runs (20 tries, 500 ms apart). **Stop Session** runs `herdr session stop <S>`,
  on this machine only.
- **Start Session** in a dev container (a stopped session row, or the `herdr not running` row, which starts
  `devc`) runs, through `herdr.dockerPath` with a 15 s timeout, not through the container shell (whose `-i`
  does not combine with `-d`):

  ```
  docker exec -d [-u <remote user>] <container id> /bin/bash -lc 'cd; PATH="$HOME/.local/bin:$PATH"; export SHELL; exec "$0" "$@"' herdr --session <S> server
  ```

  `cd` starts the server in the user's home; `export SHELL` because bash sets `SHELL` without exporting it
  under `docker exec`, and herdr's panes start `$SHELL`. Then it re-lists as on this machine.
- **Refresh**: rediscover environments, re-list every environment, re-snapshot every connected
  session and reconnect every disconnected or unsupported one.

## Shutdown

Ending a connection closes its stdin, then kills it if it has not exited 2 s later. Closing
stdin is what matters: `docker exec`'s process does not stop when the client is killed, but the
bridge inside the container exits when its stdin ends. Every connection is ended on deactivate,
when its session stops and when its environment goes away.

## Views

- **Sessions** groups rows under *This machine*, *SSH · &lt;alias&gt;* and *Dev containers*.
  An environment that has no session row to show (none running, herdr not installed,
  unreachable, error) gets one row with that status: labelled `this machine`, the ssh alias or
  the container's folder name.
- The selected session is stored in workspace state `herdr.selectedSession`. If it is not
  running, the view falls back to this machine's default session, else the first running
  session, without overwriting the stored choice, so it comes back when the session does.
- Status icons: blocked `circle-filled` orange, working blue, done green, idle and unknown
  `circle-outline`; panes without an agent `terminal`. Sessions and spaces show their worst
  status.
- **Agents** filter (`all`, `blocked`, `working`, `done`) and scope (`all`, `session`: the selected
  session) are stored in workspace state and in the context keys `herdr.agentsFilter` and
  `herdr.agentsScope`. Counts in the view description and in **Filter Agents…** are over the agents in
  scope, before the filter; the badge counts blocked agents everywhere. Rows re-render every 30 s
  while the view is visible, for the elapsed times. The blocked status bar item sets scope `all` and
  filter `blocked`.
- **Sessions** row `contextValue`s get ` host` or ` container` appended (rows that cannot start stay
  `herdr.session.absent`); **Start Session** shows on `herdr.session.stopped (host|container)`, **Stop Session**
  on `herdr.session.running host` only.
- The **session status bar item** (`herdr.session`, left, priority 101) shows `herdr: <row label>`, with
  ` (<session>)` in a container and ` (<alias>)` on an SSH host, while a session is selected; its tooltip has
  the session key, the herdr version and the counts. Clicking it runs `herdr.sessions.focus`.

### Time in state and done

herdr 0.9.5 sends no timestamps and reports no `done` (`src/agentState.ts`). Each agent pane has a record,
keyed by pane key, updated whenever a snapshot is applied (`SessionModel`; `first` is the first snapshot
since the connection was (re)established), from the pane's raw `agent_status` and, from `agents[]` (not
`panes[]`), `state_change_seq` and `completion_seq`:

- **New record:** `since` now, `observed` unless `first`; an idle pane's `completion_seq` is a baseline,
  never shown as done.
- **Changed** (status, or `state_change_seq` when both known): `since` now, `observed` unless `first`.
  Turning idle, the completion token is `c:<completion_seq>`, else `l:<seq or now>` when it was working; a
  new token makes it unseen.
- **Unchanged** idle with a new `completion_seq`: a new token, unseen (herdr filled it in late).
- Records of panes gone from a connected session's snapshot are deleted; those of sessions with no
  connection are kept for 7 days.

The displayed status is `done` for an idle pane with an unseen token, else herdr's; it replaces
`agent_status` in the model's snapshots (herdr's is in `raw_status`), so every view, count, tile and
status bar item shows it. `state_since` is set only when `observed`: a state that began while the window
was closed or the session disconnected shows no time until its next change. A pane is seen when a tile of
it reports focus (every report, not only a change of the last focused tile), when herdr's
`focused_pane_id` moves to it (not on `first` snapshots), and when **Add to Layout**, **Open in herdr
Tab** or **Focus in herdr TUI** runs for it.

Records persist in workspace state `herdr.agentStates`
(`{"v":1,"panes":{"<pane key>":{"status","seq","since","observed","token","seen"}}}`), written at most
once a second after a change and on dispose, and read before the model starts. A malformed value or
another `v` is ignored.

### Spaces descriptions

- **Space rows:** `⎇ <branch or short SHA>` + ` ● <changes>` or ` · clean` + ` ↑<ahead>` + ` ↓<behind>`,
  from `git --no-optional-locks -C <dir> status --porcelain=v1 -z --branch` (`src/spaceGit.ts`) in the
  space's `worktree.checkout_path`, else its focused pane's `foreground_cwd ?? cwd`, else its first
  pane's. Until a result (or outside a repo) the repo name shows, as before. Git runs only for the
  selected session and only while Spaces is visible: every 10 s, and once (300 ms debounce) when it
  becomes visible, the session changes, or a space is added or changes directory; at most 4 at a time,
  skipping a space whose run is still going. A result taken in another directory is dropped. The
  tooltip has the label, repo name, directory and counts.
- **Tab rows:** the agent kinds in snapshot order (`claude ×2, codex`) and `+ <n> shell(s)`.
- **Spaces** tab rows run `herdr.openTab`. Pane and agent rows run `herdr.addToLayout` on click, or
  `herdr.openPaneTab` when `herdr.openPaneIn` is `herdr`; the command is chosen when the item is
  built, and the views refresh when the setting changes. Their context menu has **Add to Layout**,
  **Open in herdr Tab** and **Focus in herdr TUI** (`herdr.focusPane`). Session rows have no inline
  action.

## Mirrored tabs

One editor tab (`WebviewPanel`, view type `herdr.tiles`, `src/tilesPanel.ts`) mirrors one herdr tab.
The webview (`src/webview/tiles.ts`, bundled with its CSS into `dist/webview/`; Golden Layout and
xterm load from there, no CDN) gets its layout, frames and tile headers from the extension host and
sends back fits, input and actions; the messages are typed in `src/tilesProtocol.ts`.

### Layout mapping

`layout.export` with `{"tab_id":…}` answers `{"type":"layout_export","layout":{"tab_id",
"workspace_id","focused_pane_id","zoomed","root"}}`, where `root` is `{"type":"pane","pane_id",…}`
or `{"type":"split","direction":"right"|"down","ratio","first","second"}`. `src/layoutMapping.ts`
turns that into a Golden Layout config, 1:1: `right` → `row`, `down` → `column`, sizes
`<ratio>%` and `<1−ratio>%`, a pane → a stack of one `pane` component. Same-direction splits stay
nested.

A re-export follows, debounced 100 ms, when the session emits `layout.updated`, `pane.created`,
`pane.closed`, `pane.moved`, `pane.exited` or `tab.renamed` for this tab; an event names its tab
directly (`tab_id`, `layout.tab_id`, `pane.tab_id`) or only a pane (`pane_id`), looked up in the
latest snapshot. It also follows whenever a snapshot's panes for the tab differ from those on
screen, and after `events_lost`. `layout.updated` fires for focus changes too, so a re-export whose
split tree is unchanged is dropped, which keeps local splitter drags and maximise until the tree
really changes.

`loadLayout` destroys every component. Each panel holds one xterm `Terminal` per pane in a map, in
an element that is moved into the new component, and restores the keyboard focus afterwards. A
pane no longer in the layout has its terminal disposed and its stream closed.

A session that is not connected shows *Connecting to …*; after 10 s, or when the session has no
such tab (`tab.closed`, a snapshot without it, `layout_not_found`), the panel shows *This herdr tab
was closed.* with every terminal gone and its streams released. If the session or tab comes back,
so does the layout. This one path also serves restoring after a reload: the webview keeps
`{"kind":"mirror","sessionKey","tabId"}` with `setState`, and the serializer hands that to a new
panel.

### Pane streams

`src/streams.ts` keeps one controller per pane key (`<sessionKey>|<paneId>`) for the window, shared
by every tile showing the pane:

```
herdr --session <S> terminal session control <pane_id> --takeover --cols <C> --rows <R>
```

run with `RemoteShell.spawn` (never a pty) through the wrapper above. A tile announces itself
(`tileOpen`) once it has a real size, since the command needs one.

- Stdout: `terminal.frame` (`full`, `width`, `height`, base64 `bytes`) and `terminal.closed`
  (`reason`). The first frame and every frame after a `terminal.resize` is `full:true`, **even a
  resize to the same size**, which is how a second tile joining a running controller gets a
  complete screen without a new process.
- Stdin: `terminal.input`, `terminal.resize` (from the most recently focused tile showing the
  pane; 100 ms after its fit changes), `terminal.scroll`, and `terminal.release` when the last tile
  goes, with stdin ended 2 s later (the process normally exits by itself on release). On deactivate
  stdin ends straight after the release.
- `terminal attach taken over`: another controller took the pane (a second window). The tile says
  *Opened in another viewer.*, and **Reconnect** starts a new `--takeover` controller. Anything
  else (`terminal <id> exited` when the app exits, `terminal attach ended: terminal <id> not found`
  when the pane is closed, a process that just ended) shows *Disconnected: …*, also with
  **Reconnect**; a pane that exited also drops out at the next re-export.
- `terminal.resize` changes the pane's real pty size, and it persists after release.

Frames go to the webview as they came, with their size: a tile that does not own the pane's size
shows the size the pane really has. A `full` frame resets the terminal before it is written.

### Input

Frames are herdr's redraw, not the app's output, so xterm never learns the app's terminal modes
(application cursor keys, bracketed paste, mouse tracking) and `terminal.input` reaches the app
raw. Handling matches devc web's (`devc/web/static/renderer.js`, `tiles.js`):

- Keys: xterm's `onData`, as is. Arrow keys always go as `ESC[A` and the like, whatever the app
  asked for; vim, less, readline and the agent TUIs accept both forms.
- Paste: taken before xterm sees it. A paste with a newline has `\r\n` and `\n` normalized to
  `\r` and is wrapped in `ESC[200~`…`ESC[201~`, since the page cannot know whether the app enabled
  bracketed paste; a single line goes as is.
- Wheel: `terminal.scroll`, 3 lines per notch. Chromium reports notches and trackpad travel alike
  as pixels, so a notch is 3 cell heights of accumulated `deltaY`; the remainder carries until the
  direction reverses. xterm has no scrollback of its own (`scrollback: 0`): herdr owns it, and
  scrolling repaints through frames.
- Mouse clicks are not forwarded. A drag makes xterm's local selection.

VS Code specifics: xterm stops the propagation of every key it turns into input, so those never
reach VS Code's keybindings (`Ctrl+P` goes to the app, as in a terminal). Keys it does not handle,
such as `Cmd+P`, bubble up and work. On the Mac `Cmd+C/V` reach the workbench, which sends copy
and paste back into the webview. Elsewhere plain `Ctrl+C/V` belong to the app, so the webview takes
`Ctrl+Shift+C/V` itself and goes through `vscode.env.clipboard`.

### Tiles and toolbar

- A tile's header is the Golden Layout tab plus two elements of ours: the status dot (as in the
  status table; square for a shell) and the faded terminal title. They follow the session model
  with no re-layout.
- Golden Layout's close controls are intercepted in the capture phase: its own handlers would
  remove the tile before the user answers. The tile goes when herdr says the pane closed.
- **New Space** and **New Tab** call `workspace.create` and `tab.create` with `focus:false`, wait for the
  snapshot to hold the tab, and open it. A new tab starts in the space's focused pane's directory.
- **Split Right** / **Split Down** call `pane.split` on the panel's focused tile, else herdr's
  focused pane if it is in this tab, with `focus:false` and the pane's `foreground_cwd ?? cwd`.
- The webview reports `focus` when an xterm gains focus; `src/focus.ts` keeps the window's last
  focused pane, fires `onDidChangeLastFocused`, and shows it in the status bar.

## Layout tabs

A Layout panel is the same view type, bundle and stream manager as a mirrored tab
(`src/tilesPanel.ts`: `TilesPanel` is what they share, `MirrorPanel` and `LayoutPanel` what they
don't), with webview state `{"kind":"layout","layoutId"}`. `init` puts `kind-layout` or `kind-mirror`
on `<body>`, which picks the toolbar buttons and the tab close buttons. A Layout panel sends herdr no
request that changes anything: only `terminal session control`, per tile.

### Store

`src/layouts.ts`: workspace state `herdr.layouts`, an array of `{"id","name","config"}`. `config` is
`layout.saveLayout()`'s `ResolvedLayoutConfig`, sent by the webview 500 ms after Golden Layout's last
`stateChanged` (and on `pagehide`), or the short form of a layout that has never had a tile, with no
`root`. Golden Layout fires `stateChanged` on an animation frame, and not at all when the only stack
closes, so the webview also listens to `itemDestroyed`.

A tile being dragged is out of the tree, in Golden Layout's proxy. While `.lm_dragProxy` is in the
document nothing is saved, no terminal is disposed and no size is sent; the drop fires `stateChanged`
again. A terminal is disposed only when a settled layout no longer holds its pane, and that is also
all that closing a tile does (`tileClose`, then the last viewer releases the stream).

### Adding a pane

`herdr.addToLayout` picks the panel (`selectLayoutTarget`: active, else most recently active still
open, else a new `Layout <n>`, never a closed one) and posts `addTile`. The webview decides what that
means from its current layout (`addPlacement`), since the host's copy can be up to 500 ms old:

- pane present: focus its tile, bringing its tab to the front;
- a focused tile: `stack.addComponent` in its stack;
- neither: `saveLayout()` as a `LayoutConfig`, the pane added at the right of the root
  (`addPaneAtRoot`), `loadLayout`. As in a mirrored tab, terminals survive that in the tile map.

### Tile states

`LayoutPanel` runs a tile's stream only while `paneAvailability` says `live`, and follows the session
model:

| The session | The pane | The tile |
| --- | --- | --- |
| not connected, or no snapshot yet | | *Waiting for <row label>…*, stream closed; never "gone" before there is a snapshot to say so |
| connected | not in the snapshot | *This pane is gone.* with **Remove**, stream closed |
| connected | in the snapshot | live; a stream that ends shows *Disconnected: …* or *Opened in another viewer.*, as in a mirrored tab |

Going back to `live` opens a new stream with the tile's last size. herdr keeps pane ids across a
server restart (with new terminals), so tiles come back.

A tile behind another in its stack has no size. It announces itself (`tileOpen`) when it first comes to
the front, so a restored stack only opens streams for its front tiles; once announced it keeps its
stream while behind.

### Moved panes

`pane.moved` data, measured on herdr 0.9.5: `{"pane":{"pane_id",…,"terminal_id"},"previous_pane_id",
"previous_tab_id","previous_workspace_id","created_tab"?,"created_workspace"?,"closed_tab_id"?}`. A
move inside a workspace keeps the id; a move to another workspace gives a new one
(`previous_pane_id` is the old), on the same terminal. `TilesPanels` rewrites that pane in every saved
layout, open or not, and an open panel's webview rewrites its live layout: the tile gets a new
terminal and a new stream on the new id, and the full first frame repaints the same screen. A move
while the extension is not running is not seen, and the tile says *This pane is gone.*.

### Dragging panes in

Measured on 2026-10-31 with VS Code 1.144.0 under Xvfb and a real X pointer (XTest), with a tree view
whose controller has `dragMimeTypes: ["application/vnd.herdr.pane"]` and two webview panels side by side:

| Drag | Shift | Reached the target webview |
| --- | --- | --- |
| tree row → webview | no / held | no events at all |
| webview A (a `draggable` element) → webview B | no / held | yes: `dragenter`, `dragover`, `drop`, with A's data |
| webview A → over the side bar → webview B | no / held | yes |
| webview A → webview A | no / held | yes |

Webviews are out-of-process iframes, and Chromium does not drop a drag from one renderer process into a
frame of another. The workbench is one process; the webviews of one extension in one window share an
origin, hence a process. (VS Code also sets `pointer-events: none` on webview iframes during a workbench
drag, `auto` again while Shift is held; that does not help.) A tree drag's native `DataTransfer` holds
only `application/vnd.code.tree.<view>` and the controller's MIME types with the value `""`: what
`handleDrag` sets reaches other trees and text editors, never a webview. macOS was not measured.

So a tree drag only **arms** (`src/paneDrag.ts`). `PaneDragController` on `herdr.spaces`, `herdr.agents`
and `herdr.paneContext` takes a pane row's `handleDrag` (pane in a connected snapshot) to
`PanePlacement.arm`: `placePane` to every open Layout panel whose `WebviewPanel.visible` is true, context
key `herdr.placingPane`, a 15 s timer. Any other row's drag disarms. The panel the pointer reaches first
posts `placeHover`, takes the placement and the others get `placeEnd`. It ends on `placed`,
`placeCancel`, `herdr.cancelPlacement` (Escape while `herdr.placingPane`: after a tree drag the
keyboard is still in the tree), the timer, a new drag, or the panel closing.

The webview, armed, shows an overlay until the first `pointermove`/`pointerover`, then un-maximises,
highlights the zone under the pointer, and places on the first `pointerdown` or `pointerup` (whichever
comes; `pointerup` only if the platform delivers the tree drag's release), or on an HTML5 `drop` whose
data is not a tile. Placing listens in the capture phase on `window` and swallows the press, the release
and the next click: otherwise xterm would start a selection or take the focus, and Golden Layout a tab
or splitter drag.

Tile grips are real HTML5 drags (`application/vnd.herdr.pane` =
`{"sessionKey","paneId","title","layoutId"}`, `effectAllowed: "move"`); the grip's `pointerdown` stops
propagation so Golden Layout does not start its own tab drag. A drop from another layout posts
`tileMovedIn`; the host closes that pane's tile in the source panel (`removeTile`), whose layout then
saves as usual. A drop from another window's Layout tab (an unknown `layoutId`) only adds. Mirrored
panels ignore both: `dropEffect: "none"`, no grips, never armed.

Zones are Golden Layout 2.6.0's own drag-proxy logic, reached through `src/webview/glDrop.ts`, the one
place that touches its `@internal` members: `calculateItemAreas()`, `getArea(x, y)` (smallest area
wins), `contentItem.highlightDropZone(x, y, area)` (which also records the segment and tab index; it is
called again at the drop point right before `onDrop`), `ItemConfig.resolve`, `onDrop(item, area)`,
`dropTargetIndicator` and `tabDropPlaceholder` (removed after each drop or cancel). `golden-layout` is
pinned at 2.6.0, and the layout panel tests fail if these change.

| Pointer over | Result |
| --- | --- |
| a stack's header | a tab there, at the position under the pointer |
| a stack's body, left / right 25% | a split beside it (its size halved), or the stack wrapped in a new row at 50/50 |
| a stack's body, middle half, upper / lower half | a split above / below, in a column likewise |
| an empty stack's body; an empty layout | the only tile |
| a 50 px band along an edge of the tile area, when the root is a row or column | a new stack at that edge of the root |

A pane already in the layout, component `T` in stack `S`: on `S`'s header, or any zone of `S` while
`S` holds only `T`, nothing moves and `T` is focused. Otherwise `S.removeChild(T, true)`, then areas,
`getArea` and `highlightDropZone` again at the same point (the removal may have collapsed `S`'s row or
column) and `onDrop(T, area)`: the component, and its terminal, are kept. Removal and drop run in one
task: the webview's `itemDestroyed` and `stateChanged` handlers are deferred and must find `T` back in
the tree, or they would dispose its terminal.

### Copy as Layout

The mirrored panel's webview posts its `saveLayout()`; `asLayoutConfig` turns on reorder in the settings
**and on each component**. Golden Layout's tab takes a component's `reorderEnabled` before the
settings', and a component without one resolves to `true`, so a mirrored tab's components carry
`reorderEnabled: false` themselves.

## Pane Context

`src/paneContext.ts`. The followed pane is the pinned pane, else `FocusTracker.lastFocused`, else, while
no tile has been focused in this window, the selected session's `focused_pane_id`. The snapshot is what
carries that: `pane.focused` (`{"pane_id","workspace_id"}`) re-takes it like any event. `pane.moved` to another
workspace changes a pane's id, so the pin and `lastFocused` move to the new key. A followed pane that is gone,
or whose session is not connected, shows no rows; a pin stays until **Unpin**. Pin is not persisted.

### Refreshing

- A new followed pane or directory (`foreground_cwd ?? cwd`) reloads. So do **Refresh**, `pane.updated`, and
  for a `file:` root, a `FileSystemWatcher` on the root, debounced 500 ms.
- While the view is visible, every 5 s: `pane.get` for the pane's directory, and git status. **herdr 0.9.5 emits
  no event for a `cd`, nor `pane.updated` for a rename**, and the snapshot follows only events: when `pane.get`
  says something new, the session re-takes its snapshot. The tree refreshes only when the status changed.
- A hidden view does not load or poll, and catches up when it is shown. Other Panes refreshes alone when its rows change,
  since terminal titles change all the time and Files may be remote.

### Git

`src/git.ts`, run in the pane's environment:

```
git -C <dir> rev-parse --show-toplevel                                  # non-zero: not a repo
git --no-optional-locks -C <toplevel> status --porcelain=v1 -z --branch
git -C <toplevel> rev-parse --short HEAD                                # detached only
git -C <toplevel> show HEAD:<path>                                      # Open Changes; empty on failure
```

`--no-optional-locks`, because this runs every 5 s in a repo an agent is working in, and must not take
`index.lock` from under it. The first record is `## <branch>[...<upstream>][ [ahead N][, behind M]]`, `## HEAD (no
branch)` or `## No commits yet on <branch>`. A rename or copy, in **either** status column (` R` comes from
`git add -N`), has its original path as the next record, which is skipped. An untracked directory is one path ending
in `/`, with nothing to open. A deleted path opens as HEAD has it.

The left side of **Open Changes** is `herdr-git://<env key>/<toplevel>/<path>?<revision>#<length of toplevel>`:
the revision is `HEAD` (All Changes) or the baseline's tree SHA (Changed in This Pane); the provider runs
`git -C <toplevel> show <revision>:<path>`. The query reaches argv, so anything but `HEAD` or 40–64 hex digits gets an
empty document with nothing run, as does an unknown environment. The fragment says where the toplevel ends, and
survives a window reload.

### Baselines: changed in this pane

`src/baselines.ts`, `src/git.ts`. Git cannot say which process changed a file, so "changed in this pane" is every
change in the pane's worktree since a **baseline**: `{tree, head, at}`, the tree of the whole working state (tracked and
untracked, not ignored), HEAD's SHA (`""` before the first commit), and the time. It is taken when the view loads a
(pane, toplevel) it has none for, and by **Reset Baseline**. Not on agent status changes: that would snapshot every pane of
every session.

The snapshot is one round trip (`sh -c <script> sh <toplevel>`, the toplevel as `$1`):

```sh
set -e
top=$1
d=$(mktemp -d "${TMPDIR:-/tmp}/herdr-vscode.XXXXXX")
trap 'rm -rf "$d"' EXIT
gi=$(git -C "$top" rev-parse --git-path index)
case $gi in /*) ;; *) gi=$top/$gi ;; esac
if [ -f "$gi" ]; then cp "$gi" "$d/index"; touch -r "$gi" "$d/index"; fi
GIT_INDEX_FILE=$d/index git -C "$top" add -A
GIT_INDEX_FILE=$d/index git -C "$top" write-tree
git -C "$top" rev-parse -q --verify HEAD || true
```

- **A temporary index**, never the user's: their index, working tree, refs and stash are untouched. It writes blobs and
  trees into `.git/objects`, unreferenced, which `git gc` prunes after `gc.pruneExpire` (two weeks by default). Clean
  filters (Git LFS) run on changed files, as on any `git add`.
- **A copy of the real index**, so its stat cache is valid and `add -A` hashes only files that changed; an empty index
  would hash the whole repo every poll. A fresh `git init` has no index: `git` makes one. `--git-path index` is relative in
  a plain repo and absolute in a linked worktree.
- **`touch -r`** keeps the copy's mtime. Git judges a "racily clean" entry, a file written in the same second as the index
  (an agent's edit right after a commit), against the index file's mtime; with the copy's fresh mtime it would trust a stale
  stat and record the old content. Measured live: without it, a same-size edit made just after a commit was missing from the
  baseline and later showed as changed since.

What changed is `git diff-tree -r -z --no-renames --name-status <baseline tree> <current tree>` (`T` shown as `M`),
skipped when the tree is the baseline's or the last one diffed. Committed changes are in it, since the current tree is
the working state. When HEAD moved, `git rev-list --count <baseline head>..HEAD` (`HEAD` alone from no commits) gives
` · <n> commits`; a failure omits it. A `diff-tree` failure means `git gc` pruned the baseline tree: a new baseline is
taken and logged. Snapshots run one at a time, on load, on the 5 s poll after git status, and on the watcher's reload.

The store is `workspaceState` `herdr.paneContext.baselines`, `{"<pane key>\n<toplevel>": {tree, head, at}}`. On every model
change it drops entries older than 7 days and every entry of a pane whose session is connected and lacks it; a disconnected
session keeps its entries. `pane.moved` moves a pane's entries to its new key. herdr ids are not reused while a server runs,
but a restarted server numbers new workspaces from the highest restored one, so a closed workspace's pane ids come back:
dropping entries on absence is what keeps a reused id from inheriting an old baseline, as long as this window saw the pane go.

### Git markers

`src/decorations.ts`, a `FileDecorationProvider` for the followed repo only: each status path's URI
(`environmentUri(env, <toplevel>/<path>)`) gets its porcelain `XY` as a badge, first match: a conflict pair `!`, `??` `U`, a
`D` in either column `D`, `R` `R`, `A` or `C` `A`, else `M`, with the `gitDecoration.*` colour and `propagate: true` (folders get
the colour and a dot). An untracked directory (`dir/`) decorates itself and anything under it. Changed in This Pane rows'
URIs carry the fragment `herdr-since` and get the since-letter (`propagate: false`), so they show `A` where Files shows `U`.

Every change fires the explicit array of old ∪ new URIs, never `undefined`: VS Code asks only about URIs it has been told of,
and a collapsed folder's colour comes from its children's URIs having been fired. Plain `file:` URIs (no fragment) are left to
VS Code's Git when its API (`vscode.git`, `getAPI(1)`, used only if already active and enabled; never activated for this)
has a repository for them, re-fired on its `onDidOpenRepository`, `onDidCloseRepository` and `onDidChangeState`
(`getRepository` is `null` for everything before `initialized`). Container and SSH URIs are always ours.

### Repo-row actions

The Repo row's `contextValue` is `herdr.paneContext.root` plus ` addable`, ` showable`, ` scm` (a `file:` repo) and
` terminal` (this machine). **Open in Source Control** activates `vscode.git` if needed, then `getRepository(root) ??
openRepository(root)` and `workbench.view.scm`. Git keeps a repo outside the workspace only for this window session; a
bind-mounted repo of another uid trips `safe.directory` (Git says so; `openRepository` returns `null`). **Terminal Here** is
`createTerminal({name, cwd, location: Editor})`, on this machine only: a container or SSH root has **Split Pane Here**, a herdr
pane herdr can see.

### Other panes

For the followed pane's directory and each other pane's: `git -C <dir> rev-parse --show-toplevel --git-common-dir`, the
common dir resolved against `<dir>` (`../.git` from a subdirectory). Same toplevel: `same worktree`; same common dir:
`other worktree`; else nothing. Cached per environment and directory until the next load or **Refresh**, and run only when
the (collapsed) section is expanded.

### Paths

`src/paths.ts`. Host: `file://<path>`. SSH: `herdr-ssh://<alias><path>`. Container: the bind mounts from
`docker inspect --format '{{json .Mounts}}' <id>` (`"Type":"bind"`, with Docker Desktop's `/host_mnt` taken off the
`Source`); under a `Destination`, longest first, a path is `file://<Source><rest>`, otherwise
`herdr-container://<id12><path>?{"label":"<container folder name>"}`. The query is for `resourceLabelFormatters`
(`devc: ${query.label} › ${path}`; SSH: `ssh: ${authority} › ${path}`), which can substitute only the scheme, authority,
path and JSON query keys, and cannot be registered at run time; the providers ignore it. `Uri.joinPath` keeps it, and
two URIs differing only in query are two documents, so every container URI comes from `environmentUri`. Mounts are cached per container until a Docker `start` or `die` event for it, or
until its environment goes. `$HOME` (`printenv HOME`) is cached per environment.

### Read-write file systems

`src/remoteFs.ts`, ported from devc-vscode's `devcontainerFs.ts` and `sshFs.ts`: stat, find, cat, `sh -c 'cat > "$1"'`,
mkdir, rmdir, `rm -rf`, mv, over `DockerShell` as the remote user or `SshShell`. Any URI of these schemes reaches
the providers from anywhere, so the authority is checked before anything is spawned: a 12-char id of a
discovered dev container, or a host in `herdr.sshHosts` (ignoring case: `Uri.toString()` lower-cases authorities).
Otherwise `FileSystemError.Unavailable`. An editor restored by a reload asks before discovery is done, so the container
provider waits for the discovery pass under way before judging.

`watch` is a no-op. `ChangePoller` stats each open text document of these schemes every 5 s, and on open for
the baseline; a different `mtime` or `size` fires `Changed`, so a clean editor reloads and a dirty one prompts
on save. `stat -c %Y` has 1 s resolution: a same-size change within the second is missed. A document stops being
polled when it closes. Saving one fires `Changed` twice, harmlessly: once from the save, once from the poll.

### Terminal links

`src/webview/links.ts`, in an xterm link provider on every tile. The link text is posted as `openLink`; `TilesPanels`
raises `onDidRequestLink`, and the view resolves it in the pane's environment (absolute; `~/…` against `$HOME`; otherwise
against the pane's directory), checks `test -e`, then `test -d`. A file opens through `vscode.open` in `ViewColumn.Beside`
with the selection at `line:col`; a directory is revealed in Files when under the root.
Besides the regex itself, a match in a token with `://` is dropped, as is a number like `1.2.3`, and a trailing full stop
is not part of the path. Cell positions come from `getCell`, since a wide character is two cells and one string unit.

## Ask Agent

`src/agentReview.ts`, copied from devc-vscode's `agentReview.ts` and adapted. One comment controller,
`herdr.agentReview` (label `Agent (herdr)`).

### Path mapping

`environmentPathOf(uri, env, mounts)` in `src/paths.ts` gives a document's path in an environment, or nothing:

| `uri.scheme` | host | container | SSH |
| --- | --- | --- | --- |
| `file`, `git`, `review`, `pr` (`uri.path` is the host path) | `uri.path` | `containerPathOf(uri.path, mounts)` | — |
| `herdr-container` | — | `uri.path` when the authority is this container's 12-char id | — |
| `herdr-ssh` | — | — | `uri.path` when the authority is this alias (ignoring case) |
| `herdr-git` | `<toplevel>/<file>` when the authority is this environment's key (ignoring case) | same | same |

`containerPathOf` is `hostPathOf` backwards: the bind mount with the longest `Source` holding the path. A container URI's
`?{"label":…}` query plays no part. A **candidate** is an agent row (`agentRows` over every connected session) whose
session's environment maps the document. The commenting range is the whole document when there is a candidate, else none.
VS Code has no change event for commenting ranges: the controller re-assigns `commentingRangeProvider` (the same object)
when the set of environments with an agent changes, which also sets `herdr.hasAgents`, and on every Docker container
event (mounts may have changed).

### Choosing and sending

Each send (first, follow-up, Resend) chooses again: the thread's pane if it is still a candidate; Pane Context's followed
pane; the only candidate; the window's last pick; else a QuickPick in the Agents view's order. A `pane.moved` event moves
a thread's pane and the last pick to the new id.

The prompt goes through the session's bridge, as `agent.prompt` with `{"target":"<pane id>","text":"<prompt>"}` and no
`wait`, the operation behind `herdr agent prompt`. herdr types it into the pane line by line with a final Enter (measured
with a fake agent: no bracketed-paste markers when the program has not asked for them). The first line is a tag,
`[herdr-vscode review <thread id>#<n>]`. Before sending, `mkdir -p /tmp/herdr-vscode/review/<thread id>` runs in the
agent's environment. herdr's error codes: `agent_blocked` (the agent is at a prompt), `agent_not_found` (no agent in
that pane, including a pane that is gone or a plain shell); anything else is shown as herdr's message.

### Replies

One watcher per environment, started by a successful send and stopped when no thread waits on a reply there, when the
environment goes, or on deactivate; if it ends on its own while replies are awaited, it restarts after 5 s. It is a
`sh -c` script through the environment's shell (this machine's too): a background loop runs
`cksum /tmp/herdr-vscode/review/*/*.md | tr '\n' ';'` every second and prints the listing when it changes; closing its
stdin ends it (`docker exec` and `ssh` never signal the remote process). Each listing entry whose crc or size changed,
for a thread this window knows, is read with `cat` and replaces that question's placeholder or earlier reply. A change
made while no reply is awaited in that environment (the watcher stopped) is seen only after the next send there.

Claude Code in its default permission mode asks before writing outside the project, so the reply waits on that approval
in the pane; in auto mode it does not.

### Coexisting with devc-vscode

devc-vscode has the same feature for its dev container agents. Every id here is `herdr.*`, the label is `Agent (herdr)`
(devc's is `Agent (devc)`), the reply root `/tmp/herdr-vscode/review` (devc's `/tmp/devc-vscode/review`) and the tag
`[herdr-vscode review …]` (devc's `[devc review …]`), so each watcher ignores the other's files. Context values
(`failed`, `hasAgent`) are the same strings, but every menu is scoped by `commentController == herdr.agentReview`.
