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
  herdr TUI come back within a second, and splitters move in place when herdr's split ratios change.
- Dragging a splitter sets herdr's split ratio (herdr keeps ratios between 0.1 and 0.9; the
  splitter snaps to what herdr has).
- Dragging a tile's tab onto another tile swaps the two panes in herdr. herdr 0.9.5 cannot move a
  pane within its tab (`same_tab`), so there are no edge drops in a mirrored tab: anywhere on another
  tile swaps. Nothing moves until herdr's layout comes back, a few hundred milliseconds later. Escape
  cancels. To arrange panes freely, use **Copy as Layout**.
- Maximising a tile zooms that pane in herdr, and herdr's zoom maximises the tile. Zooming also
  makes that pane herdr's focused pane, and moves the herdr TUI's zoom with it. While herdr is
  zoomed, tiles cannot be dragged.
- A pane has one viewer at a time, per herdr: opening it in a second VS Code window shows
  *Opened in another viewer.* in the first, with **Reconnect** to take it back.
- The status bar shows the last focused tile's pane and state; click it to reveal the tile.
- Editor tabs come back after a window reload.

**Pane size:** a tile's size becomes the pane's real pty size, and it stays that way after the
tile closes. A herdr TUI showing the same pane draws it at VS Code's size until the TUI resizes it
back.

Other than maximising (zoom) and swapping (herdr focuses the dragged pane), focusing a tile does not
move herdr's own focus; **Focus in herdr TUI** on a pane row does.

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
  the action is there only for local paths. **Open in Source Control** (local repos) has VS Code's Git open the
  repo and shows the Source Control view; outside the workspace Git keeps it only until the window reloads.
  **Terminal Here** (this machine only) opens VS Code's terminal in the repo, in the editor area; elsewhere,
  **Split Pane Here** makes a herdr pane below, in that folder.
- **Changed in This Pane · since 10:31:** every file that changed in the pane's worktree since you first
  followed the pane there, with `A`, `M` or `D` and ` · 2 commits` when HEAD moved on. Git cannot say which
  process changed a file, so this is everything changed in that worktree since then, **whoever changed it**: two
  agents in one worktree see each other's edits. The time is kept across reloads, per pane and repo, until the pane
  closes or a week passes. **Reset Baseline** starts it again from now. Click to open; **Open Changes** shows a
  `since 10:31 ↔ working tree` diff. Taking the baseline writes git objects into the repo (unreferenced, so `git gc`
  prunes them) and never touches its index, working tree or refs.
- **All Changes** (collapsed): the repo's whole `git status`. Click to open; **Open Changes** shows a
  `HEAD ↔ working tree` diff.
- **Files:** the tree; click to open. Git markers (`M`, `A`, `U`, `D`, `R`, `!`) in Git's colours, and a dot on
  folders holding changes; the same badges show on editor tabs of those files. For a local repo that VS Code's own
  Git has open (a workspace folder, or after **Open in Source Control**), Git's badges are shown instead of a second
  set. **New File…**, **New Folder…**, **Rename…** and **Delete…** are on the rows. Delete is permanent.
- **Other Panes in This Space:** as in Spaces, with `same worktree` or `other worktree` (another worktree of
  the same repo) before the description.
- **Paths printed in a tile are links.** `src/auth/middleware.ts:19`, `./x/y.md`, `~/n.txt` and `README.md`
  are underlined on hover, and resolved where the pane runs, against its directory. Clicking opens the file
  beside the tile at that line, reveals a directory in Files, and does nothing for a path that does not exist.

Everything it can reach is editable:

| Where the file is | How it opens | What you get |
| --- | --- | --- |
| This machine; a container path on a bind mount | a plain `file:` URI | everything: language servers, Source Control, search |
| A container path outside the mounts | `herdr-container://<id>/<path>?{"label":"<container>"}` | edit and save, as the container's remote user, keeping owner and mode |
| An SSH host | `herdr-ssh://<alias>/<path>` | edit and save |

Their editors' titles and tab hovers read `devc: <container> › /path` and `ssh: <alias> › /path`. Breadcrumbs
show only the path segments (VS Code does not label those). A container editor restored from before this
version reads `devc:  › /path` until opened again from the view.

The last two have no language servers, Source Control or search, since those need local files. They need GNU
coreutils and findutils there (BusyBox, as on Alpine, is not supported). A save overwrites in place and is not atomic.
An open editor of such a file notices outside changes within about 5 s (`mtime`, at 1 s resolution, or size).

## Ask an agent about code

Ask a herdr agent about lines of code from the editor, in a comment thread. Click the `+` in the gutter (or
select lines and run **Ask herdr Agent About Selection** from the editor's context menu, which skips VS Code's
provider picker), write the question and **Ask Agent**. The thread is titled
`Ask agent · claude (v3_auth) · lines 19–21`: the question shows as yours, then `claude` · *Waiting for reply…*,
which the agent's answer replaces. Follow-ups in the thread go to the same agent.

- **Where:** files on this machine, VS Code Git and GitHub Pull Request diff sides, and Pane Context's container,
  SSH and `HEAD` documents, whenever an agent in a connected session can see the file: one on this machine, one in a
  dev container that bind-mounts it (or whose own file it is), or one on that SSH host. Other files get no `+`.
- **Which agent:** the thread's own while its pane is there; else the pane Pane Context follows, if it is an agent
  that can see the file; else the only one that can; else the one you picked last in this window; else a picker
  (**Which agent should answer?**).
- **What is sent:** the question goes straight into the agent's pane (herdr's `agent.prompt`), with the file's path
  **as the agent's environment sees it** (the container path for a container agent), the lines, which version of the
  file it is (working tree, index, a commit, a PR side), and the code (up to 200 lines). Nothing else reaches the agent:
  no selection tracking, no open files. The pane is not focused; **Show Agent** on the thread opens it (per
  `herdr.openPaneIn`).
- **The answer** is a Markdown file the agent writes to `/tmp/herdr-vscode/review/<thread>/<n>.md` in its
  environment; it shows in the thread within about a second, and again if the agent rewrites it. **Delete Thread**
  removes the thread and its files. Threads are kept in this window only, never posted to GitHub, and are gone on reload.
- **Not sent:** when the agent is waiting on a prompt in its pane (`claude is waiting on a prompt in its pane. Answer
  it, then Resend.`), when its pane is gone, or when herdr fails, the question is marked `Not sent`; **Resend** on it
  tries again.

Claude Code in its default permission mode asks before writing outside the project, so the answer waits until you
approve the write to `/tmp/herdr-vscode/review/…` in the agent's pane. In auto mode it does not wait.

With devc-vscode also installed, a container-mounted file's `+` offers both **Agent (devc)** and **Agent (herdr)**;
each answers in its own threads.

## Rows from herdr's config

If you lay out herdr's own sidebar with `[ui.sidebar.spaces]` and `[ui.sidebar.agents]` rows in herdr's
`config.toml`, Spaces' space rows and Agents' rows follow the same rows, so both sidebars show the same
things. Without them (or with `herdr.useHerdrSidebarConfig` off), the rows stay as described above.

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace", "$jj_status"], ["branch", "git_status"]]

[ui.sidebar.agents]
rows = [["state_icon", "machine", "workspace", "tab"], ["agent"], ["$ticket"]]

[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"], ["agent"]]
```

A tree row has one line, so the rows are read in order as one: `workspace` (space rows) or `agent`
(agent rows) is the label, `state_icon` the icon (no `state_icon`, no icon), and every other token a part
of the description, joined with ` · ` (` › ` between `workspace`, `tab` and `pane`):

| Token | Space row | Agent row |
| --- | --- | --- |
| `state_icon` | icon of the worst agent status | icon of the agent's status |
| `workspace` | label | the space's name |
| `agent` | | label |
| `state_text` | the worst status (`blocked`, `working`, `done`, `idle`) | herdr's label for the status, else the status |
| `branch`, `git_status` | `⎇ v3_auth`, `● 4 ↑1` (together: `⎇ v3_auth ● 4 ↑1`) | |
| `machine` | | the SSH host or dev container; nothing on this machine |
| `tab`, `pane` | | the tab's and pane's names |
| `terminal_title`, `terminal_title_stripped` | | the terminal title |
| `$name` | a token from `herdr workspace report-metadata <id> --token name=value` | a token from `herdr pane report-metadata <id> --token name=value` |

Each token shows once; empty ones are skipped. Agent rows keep their time in state (`2m`) last. Colours,
`bold`, `dim` and `row_gap` are accepted and ignored. `rows_by_agent` rows apply to agents of exactly that
id; an agents section with only `rows_by_agent` leaves other agents' rows as they are.

- Only **this machine's** `config.toml` is read, for every session, dev container and SSH host alike:
  `$HERDR_CONFIG_PATH`, else `$XDG_CONFIG_HOME/herdr/config.toml`, else `~/.config/herdr/config.toml`
  (VS Code started from a desktop launcher may not have the variables your shell sets). A container's
  or SSH host's own config is not read.
- Saving the file applies it within about 2 s.
- A mistake in the sidebar rows (`"bogus"`, `fg = "blue"`, …) puts both views back on the default rows
  and logs `sidebar config: <path>: <reason>; using default rows` once in the **herdr** output channel.
  herdr itself ignores its whole config when anything in it is wrong, outside the sidebar rows too, so
  if herdr's sidebar shows its defaults while VS Code follows your rows, run `herdr config check`.

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
| `herdr.useHerdrSidebarConfig` | `true` | lay out Spaces and Agents rows from `[ui.sidebar.*]` in this machine's herdr `config.toml` (see [Rows from herdr's config](#rows-from-herdrs-config)); off: the built-in rows |

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
  takeover, restore, Layout tabs, dragging panes into them, split ratios, swaps and zoom in mirrored tabs, Pane Context,
  and it stops and restarts that session's server.
  Ask Agent runs a fake `claude` (a `sh` loop) in a pane of `hv-test` and prompts only that pane; its replies go to
  this machine's `/tmp/herdr-vscode/review`, and are removed afterwards. Keep `<dir>` short: herdr's socket path must fit in `sun_path` (about 100
  bytes).

Open `herdr-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to build
it and open an Extension Development Host with it loaded.
