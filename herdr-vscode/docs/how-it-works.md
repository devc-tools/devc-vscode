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
- **Spaces** tab rows run `herdr.openTab`. Pane and agent rows run `herdr.focusPane` on click and
  have `herdr.openPaneTab` in their context menu. Session rows have no inline action.

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
- **Split Right** / **Split Down** call `pane.split` on the panel's focused tile, else herdr's
  focused pane if it is in this tab, with `focus:false` and the pane's `foreground_cwd ?? cwd`.
- The webview reports `focus` when an xterm gains focus; `src/focus.ts` keeps the window's last
  focused pane, fires `onDidChangeLastFocused`, and shows it in the status bar.
