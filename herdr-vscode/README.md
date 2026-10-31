# herdr-vscode

herdr sessions, spaces, agents and panes in VS Code, for people who already use
[herdr](https://herdr.dev). The **herdr** activity-bar container has four views:

- **Sessions**: every herdr session on this machine, on the SSH hosts in `herdr.sshHosts`, and
  in every running dev container. Each running session shows its agents' counts
  (`2 blocked · 1 working`) and an icon for its worst status. Click a running session to select
  it.
- **Spaces**: the selected session's spaces, tabs and panes. Space rows show their branch and git
  status (`⎇ v3_auth ● 4 ↑1`, `⎇ main · clean`), read every 10 s while Spaces is visible; tab rows sum up
  their panes (`claude, copilot`, `2 shells`). Click a tab to open it in the editor
  area (below); click a pane to put it in a Layout tab (below, or see `herdr.openPaneIn`).
- The status bar shows the selected session (`herdr: deephaven-mcp (devc)`; the herdr version is in its
  tooltip); click it to go to Sessions.

**Done and time in state.** herdr reports an agent that finished as `idle`. An agent that goes from
working to idle shows as **done** (green) until you look at it: click into its tile, click its row, or
move the herdr TUI's focus to it. Times count from when VS Code saw the state begin, and survive a window
reload; a state that began while VS Code was closed shows no time until it next changes.
- **Agents**: every agent pane across all connected sessions, blocked first, each with its state and
  how long it has been in it (`deephaven-mcp › v3_auth · blocked 2m`). Clicking one works as for a pane
  in Spaces. The title bar switches between **all sessions** and **this session** (the selected one, with
  `<space> › <tab>` rows), and **Filter Agents…** picks All, Blocked, Working or Done, with their counts;
  the view's description shows the counts (`all sessions · 2 blocked · 3 working`) or the filter
  (`blocked 2 of 7`). The number of blocked agents shows as a badge on the herdr icon and as a
  `<n> blocked` warning in the status bar; clicking the status bar item shows the blocked agents of
  all sessions.
- **Pane Context**: the repo, changes and files of the pane you are working with (below).

## herdr tabs in the editor area

Clicking a tab in **Spaces**, or **Open in herdr Tab** on a pane or agent row (the click itself when
`herdr.openPaneIn` is `herdr`), opens that herdr tab as an editor tab: its split layout, with every pane a live terminal tile. One editor tab is one
herdr tab, titled `<tab> · <space>`.

- Type in a tile as in the herdr TUI; the wheel scrolls herdr's own scrollback. Mouse clicks are
  not forwarded to the app yet: a drag selects text locally for copying (`Ctrl+Shift+C/V` off the
  Mac, `Cmd+C/V` on it). A multi-line paste goes as one bracketed paste.
- **New Space** (Spaces title bar), **New Tab** (a space's row), and **Split Right** / **Split Down** (a tab's or
  pane's row) create them in herdr and open the herdr tab they landed in.
- **Start Session** and **Stop Session** on Sessions rows run this machine's sessions. Stopping asks first,
  because every pane in the session closes. A started session has no spaces until you add one.
  **Start Session** also starts a dev container's herdr: on its `herdr not running` row it starts `devc`.
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
  Layout tab, else the most recently active one still open, else a new `Layout <n>`. It goes in as a
  tab in the stack of the focused tile, else the last one focused, else the first; drag its tab to split.
  A pane already there is just focused.
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

### Dragging panes in

- Drag a pane row from Spaces, Agents or Pane Context's **Other Panes in This Space** onto a Layout tab
  that is on screen and **let go, then click** where it should go: on a stack's tab strip to add it
  there as a tab, or near an edge of a tile (or of the whole tab) to split. The highlight while you move
  the pointer is Golden Layout's own, the same as when dragging a tile's tab. VS Code does not let a
  drag from a view drop into an editor's web page, so letting go only arms the Layout tab, which says
  *Place "…"* until the pointer comes over it; on some platforms letting go over it already places the pane.
- **Esc** (right after letting go: the keyboard is still in the view), **Cancel** on the tab's toolbar,
  or moving the pointer out of the tab cancels. After 15 s with the pointer never over a Layout tab,
  it cancels by itself.
- A pane is in a layout at most once: dragging in one it already has moves that tile there, or only
  focuses it when the spot is its own stack's tab strip.
- Each tile's tab has a grip (the dots before its status dot). Drag it into another Layout tab on screen,
  in another editor group (no Shift needed), to move the tile there; the first tab loses it. Dragging it
  within the same tab works too.
- Mirrored herdr tabs take no drops: their arrangement is herdr's.

## Pane Context

The **Pane Context** view shows the repo, changes and file tree of the pane you last clicked into, so
VS Code's editing is one click from any agent. Until you have clicked into a tile in this window it follows
herdr's own focus in the selected session; after that only tiles count. Clicking into a file editor or
another view changes nothing, and **Pin** stops it following. The header says which pane it is, and when
no tile in this window shows it, which **Show Pane** on the repo row fixes.

- **Repo row:** the repo (or directory, outside a repo), branch, changed count, ahead and behind.
  **Add to Workspace** adds it as a workspace folder; workspace folders never change any other way, and
  the action is there only for local paths. **Split Pane Here** makes a herdr pane below, in that folder.
- **Changes:** click to open; **Open Changes** shows a `HEAD ↔ working tree` diff.
- **Files:** the tree; click to open. **New File…**, **New Folder…**, **Rename…** and **Delete…** are on the
  rows. Delete is permanent.
- **Other Panes in This Space:** as in Spaces.
- **Paths printed in a tile are links.** `src/auth/middleware.ts:19`, `./x/y.md`, `~/n.txt` and `README.md`
  are underlined on hover, and resolved where the pane runs, against its directory. Clicking opens the file
  beside the tile at that line, reveals a directory in Files, and does nothing for a path that does not exist.

Everything it can reach is editable:

| Where the file is | How it opens | What you get |
| --- | --- | --- |
| This machine; a container path on a bind mount | a plain `file:` URI | everything: language servers, Source Control, search |
| A container path outside the mounts | `herdr-container://<id>/<path>` | edit and save, as the container's remote user, keeping owner and mode |
| An SSH host | `herdr-ssh://<alias>/<path>` | edit and save |

The last two have no language servers, Source Control or search, since those need local files. They need GNU
coreutils and findutils there (BusyBox, as on Alpine, is not supported). A save overwrites in place and is not atomic.
An open editor of such a file notices outside changes within about 5 s (`mtime`, at 1 s resolution, or size).

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
| `herdr.showStoppedSessions` | `false` | list stopped sessions on SSH hosts and in dev containers too; this machine's are always listed |
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
model, so it needs the build, and reaches no herdr. `src/test/paneContext.test.ts`, `git.test.ts` and
`remoteFs.test.ts` run real `git` and coreutils, only in temp directories. Opt-in suites run against a throwaway session:

- `HERDR_VSCODE_LIVE_SESSION=<name>`: connects to that running session on this machine (it
  needs one workspace), splits a pane and reports agent states in it.
- `HERDR_VSCODE_LIVE_HOME=<dir>`: points `HOME` at `<dir>` for the suites and runs full
  discovery there, so it must hold only a running throwaway session named `hv-test` (with one
  workspace, and `herdr` in `<dir>/.local/bin`). Add `HERDR_VSCODE_LIVE_STOP=1` to also stop that
  session and check it drops out. This also runs a real tiles webview: frames, keys, splits,
  takeover, restore, Layout tabs, dragging panes into them, Pane Context, and it stops and restarts that session's server. Keep `<dir>` short: herdr's socket path must fit in `sun_path` (about 100
  bytes).

Open `herdr-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to build
it and open an Extension Development Host with it loaded.
