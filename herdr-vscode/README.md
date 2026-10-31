# herdr-vscode

herdr sessions, spaces, agents and panes in VS Code, for people who already use
[herdr](https://herdr.dev). The **herdr** activity-bar container has three views:

- **Sessions**: every herdr session on this machine, on the SSH hosts in `herdr.sshHosts`, and
  in every running dev container. Each running session shows its agents' counts
  (`2 blocked · 1 working`) and an icon for its worst status. Click a running session to select
  it.
- **Spaces**: the selected session's spaces, tabs and panes. Click a tab to open it in the editor
  area (below); click a pane to put it in a Layout tab (below, or see `herdr.openPaneIn`).
- **Agents**: every agent pane across all connected sessions, blocked first. Clicking one works as
  for a pane in Spaces. The title bar filters to blocked or working agents. The number of blocked agents shows as a badge on the
  herdr icon and as a `<n> blocked` warning in the status bar; clicking the status bar item
  shows the blocked agents.

## herdr tabs in the editor area

Clicking a tab in **Spaces**, or **Open in herdr Tab** on a pane or agent row (the click itself when
`herdr.openPaneIn` is `herdr`), opens that herdr tab as an editor tab: its split layout, with every pane a live terminal tile. One editor tab is one
herdr tab, titled `<tab> · <space>`.

- Type in a tile as in the herdr TUI; the wheel scrolls herdr's own scrollback. Mouse clicks are
  not forwarded to the app yet: a drag selects text locally for copying (`Ctrl+Shift+C/V` off the
  Mac, `Cmd+C/V` on it). A multi-line paste goes as one bracketed paste.
- **Split Right** and **Split Down** in the toolbar split the focused tile in herdr; the tile's
  close button closes the pane in herdr, after asking, because its process ends. Changes made in a
  herdr TUI come back within a second. Dragging a splitter or maximising a tile is local to VS
  Code, and the next layout change in herdr resets it.
- A pane has one viewer at a time, per herdr: opening it in a second VS Code window shows
  *Opened in another viewer.* in the first, with **Reconnect** to take it back.
- The status bar shows the last focused tile's pane and state; click it to reveal the tile.
- Editor tabs come back after a window reload.

**Pane size:** a tile's size becomes the pane's real pty size, and it stays that way after the
tile closes. A herdr TUI showing the same pane draws it at VS Code's size until the TUI resizes it
back.

Other than that, focusing a tile does not move herdr's own focus; **Focus in herdr TUI** on a pane
row does.

## Layout tabs

A Layout tab is a named editor tab holding any panes you like, from any space or session, arranged
freely: drag a tile's tab to stack it with others or to an edge to split, and maximise a stack. The
arrangement belongs to VS Code: it never changes herdr's tabs or splits.

- Clicking a pane or agent row, or **Add to Layout** in its context menu, adds the pane to the active
  Layout tab, else the most recently active one still open, else a new `Layout <n>`. It goes in the
  stack of the focused tile, else in a new stack on the right. A pane already there is just focused.
- **New Layout** (the new-file icon on the Sessions view's title bar, or the command palette), **Open Layout…**,
  **Rename Layout…** (also on the tab's toolbar) and **Delete Layout…** manage them. Layouts are
  saved per workspace, and come back after a window reload.
- Closing a tile takes it out of the layout. The pane keeps running in herdr. Closing the editor tab
  keeps the layout saved; **Open Layout…** brings it back.
- **Copy as Layout** on a mirrored tab's toolbar makes a Layout from its current arrangement, named
  `<tab> (<space>)`, to rearrange without touching herdr.
- A tile whose session is not connected says *Waiting for …* and reconnects when the session does.
  A pane that no longer exists says *This pane is gone.*, with **Remove**. A pane moved to another
  space in herdr stays in the tile, while VS Code is running to see the move.

## Requirements

- herdr **0.9.5 or later** in each environment, on `PATH` or in `~/.local/bin`. Older herdr
  lacks `remote-api-bridge`; its sessions are listed as `needs herdr 0.9.5 or later`.
- Dev containers: the Docker CLI (`herdr.dockerPath`). Without Docker there are simply no
  container rows. herdr runs in the container as its dev container remote user.
- SSH hosts: an alias in `~/.ssh/config` that connects without a prompt (keys or an agent;
  `ssh` runs with `BatchMode=yes`). Hosts that cannot be reached show `unreachable`.
- This machine is not shown on Windows.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `herdr.sshHosts` | `[]` | ssh aliases from `~/.ssh/config` whose herdr sessions are shown (application scope) |
| `herdr.sshPath` | `"ssh"` | ssh client (application scope) |
| `herdr.dockerPath` | `"docker"` | Docker CLI (application scope) |
| `herdr.showStoppedSessions` | `false` | list stopped sessions too |
| `herdr.openPaneIn` | `"layout"` | what clicking a pane or agent row does: `layout` adds it to a Layout tab, `herdr` opens its mirrored herdr tab |

How discovery, the bridge protocol and refreshing work: [docs/how-it-works.md](docs/how-it-works.md).

herdr-vscode lives in the devc-vscode repo, in its own folder beside `devc-vscode/`, and is a
self-contained extension: its own `package.json`, lockfile, `node_modules`, build and tests.
Nothing is shared with devc-vscode at build time (a few helpers are copied, see
`src/remoteShell.ts`), and both extensions can be installed side by side.

## Development

```sh
cd herdr-vscode
npm ci
npm run build      # tsc type-check (out/) + esbuild bundles (dist/extension.js, dist/webview/tiles.{js,css})
npm run lint
npm test           # .npmrc sets ignore-scripts, so pretest does not run: build first
npm run package:dev   # build a .vsix and install it into `code`
```

`npm test` never discovers the machine's herdr sessions (`.vscode-test.mjs` sets
`HERDR_VSCODE_NO_DISCOVERY=1`). `src/test/layoutPanels.test.ts` opens real webviews over a made-up
model, so it needs the build, and reaches no herdr. Opt-in suites run against a throwaway session:

- `HERDR_VSCODE_LIVE_SESSION=<name>`: connects to that running session on this machine (it
  needs one workspace), splits a pane and reports agent states in it.
- `HERDR_VSCODE_LIVE_HOME=<dir>`: points `HOME` at `<dir>` for the suites and runs full
  discovery there, so it must hold only a running throwaway session named `hv-test` (with one
  workspace, and `herdr` in `<dir>/.local/bin`). Add `HERDR_VSCODE_LIVE_STOP=1` to also stop that
  session and check it drops out. This also runs a real tiles webview: frames, keys, splits,
  takeover, restore, Layout tabs, and it stops and restarts that session's server. Keep `<dir>` short: herdr's socket path must fit in `sun_path` (about 100
  bytes).

Open `herdr-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to build
it and open an Extension Development Host with it loaded.
