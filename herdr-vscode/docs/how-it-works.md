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
  window, then re-lists until it runs. **Stop Session** runs `herdr session stop <S>`. This machine only.
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
- **Agents** filter is stored in workspace state and in the context key `herdr.agentsFilter`.
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

The left side of **Open Changes** is `herdr-git://<env key>/<toplevel>/<path>?HEAD#<length of toplevel>`:
the fragment says where the toplevel ends, and survives a window reload. An unknown environment gets an empty document, with nothing run.

### Paths

`src/paths.ts`. Host: `file://<path>`. SSH: `herdr-ssh://<alias><path>`. Container: the bind mounts from
`docker inspect --format '{{json .Mounts}}' <id>` (`"Type":"bind"`, with Docker Desktop's `/host_mnt` taken off the
`Source`); under a `Destination`, longest first, a path is `file://<Source><rest>`, otherwise
`herdr-container://<id12><path>`. Mounts are cached per container until a Docker `start` or `die` event for it, or
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
