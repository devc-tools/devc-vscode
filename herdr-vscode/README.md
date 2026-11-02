# herdr-vscode

herdr sessions, spaces, agents and panes in VS Code, for people who already use
[herdr](https://herdr.dev). The **herdr** activity-bar container has four views:

- **Sessions**: every herdr session on this machine, on the SSH hosts in `herdr.sshHosts`, and
  in every running dev container. Each running session shows its agents' counts
  (`2 blocked · 1 working`) and an icon for its worst status. Click a running session to select
  it and open its first space in an editor tab (or focus that tab if it is already open).

  **Status dots:** orange is blocked, blue working, green done, and filled gray idle (also a session or
  space with no agents). An empty circle means herdr is not running there, or not connected. Plain shell
  panes have a terminal icon instead of a dot.

  **Pane names and agent marks.** A pane is named by what it is working on: its herdr agent name if it has
  one, else its terminal title (Claude Code keeps that set to the current task), else its herdr label, its
  folder, and only then its agent kind (`claude`). Where one pane is shown (pane rows in Spaces, Agents rows,
  Active Pane, tile headers and the focused-pane status bar item) Claude Code, GitHub Copilot, pi and
  OpenCode panes show their agent's mark, coloured like the status dot, instead of the dot; other agents
  keep the dot. Agent pane rows and tile headers show the pane's folder after the name.
- **Spaces**: the selected session's spaces, tabs and panes. Space rows show their branch and git
  status (`⎇ v3_auth ● 4 ↑1`, `⎇ main · clean`), read every 10 s while Spaces is visible; tab rows sum up
  their panes (`claude, copilot`, `2 shells`). Click a space to open it in the editor area (below), or
  a tab to open its space on that tab; click a pane to open its space on the pane's tab and focus its tile.
  Space rows expand with their arrow.
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
- **Active Pane**: the repo, changes and files of the pane you are working with (below).

## herdr spaces in the editor area

Clicking a space in **Spaces** opens it as an editor tab. One editor tab is one herdr space, titled with the
space's name, or `<session> · <space>` for a session other than `default`. It shows the space's active herdr
tab: its split layout, with every pane a live terminal tile. The strip across the top lists the space's tabs
in herdr's order, each with its worst agent status. herdr's layout is the only one: everything below edits it.

- The strip and herdr's active tab follow each other. Clicking a strip entry makes that tab herdr's active
  tab, and a tab switch in the herdr TUI switches the editor tab within a second. herdr's tab focus also
  moves the TUI to that space.
- **+** on the strip creates a tab in the space, in the focused tile's directory, and shows it. **×** on an
  entry closes that tab in herdr, after asking, because its processes end. Double-click an entry to rename it.
  Closing a space's last tab closes the space; the editor tab then says *This herdr space was closed.*
- Clicking a tab in **Spaces** opens its space on that tab. Clicking a pane or agent row (or **Open in herdr
  Space** in its context menu) does the same for the pane's tab and focuses its tile.

- Type in a tile as in the herdr TUI; the wheel scrolls herdr's own scrollback. Mouse clicks are
  not forwarded to the app yet: a drag selects text locally for copying (`Ctrl+Shift+C/V` off the
  Mac, `Cmd+C/V` on it). A multi-line paste goes as one bracketed paste.
- **New Space** (Spaces title bar), **New Tab** (a space's row), and **Split Right** / **Split Down** (a tab's or
  pane's row) create them in herdr and open their space on the tab they landed in.
- **Start Session** and **Stop Session** on Sessions rows run this machine's sessions. Stopping asks first,
  because every pane in the session closes. A started session has no spaces until you add one.
  **Start Session** also starts a dev container's herdr: on its `herdr not running` row it starts `devc`.
- **Delete Session** (trash icon) on every session row except herdr's default session runs
  `herdr session delete` in that session's environment, after asking. A running session is stopped first.
- Right-click a tile for **Split Right**, **Split Down** (a new shell in the tile's directory), **Zoom** /
  **Unzoom** and **Close Pane**. Closing, there or with the tile's close button, asks first, because the
  pane's process ends. Changes made in a herdr TUI come back within a second, and splitters move in place
  when herdr's split ratios change.
- Dragging a splitter sets herdr's split ratio (herdr keeps ratios between 0.1 and 0.9; the
  splitter snaps to what herdr has).
- Drag a tile by its tab:
  - onto the middle (or the header) of another tile: the two panes swap places in herdr;
  - near an edge of another tile: herdr splits that tile and puts the dragged pane on that side. herdr
    0.9.5 cannot move a pane within its tab, so the pane goes out to a passing tab (named after it) and
    straight back; its terminal keeps running. If herdr refuses the way back, the pane stays in that tab
    and a warning names it;
  - onto another tab in the strip: the pane moves to that herdr tab (split right); onto **+**: to a new tab.
    The editor tab keeps showing the tab you are on.

  Nothing moves until herdr's layout comes back, a few hundred milliseconds later. Escape cancels. A pane
  goes in one place at a time: there are no stacked tiles, and panes from other spaces or sessions do not
  mix in.
- Maximising a tile zooms that pane in herdr, and herdr's zoom maximises the tile. Zooming also
  makes that pane herdr's focused pane, and moves the herdr TUI's zoom with it. While herdr is
  zoomed, tiles cannot be dragged.
- A pane has one viewer at a time, per herdr: opening it in a second VS Code window shows
  *Opened in another viewer.* in the first, with **Reconnect** to take it back.
- The status bar shows the last focused tile's pane and state; click it to reveal the tile.
- Editor tabs come back after a window reload. Ones saved before editor tabs became spaces come back as
  the space of the tab they showed.

**Pane size:** a tile's size becomes the pane's real pty size, and it stays that way after the
tile closes. A herdr TUI showing the same pane draws it at VS Code's size until the TUI resizes it
back.

Other than maximising (zoom) and swapping (herdr focuses the dragged pane), focusing a tile does not
move herdr's own focus; **Focus in herdr TUI** on a pane row does.

## Active Pane

The **Active Pane** view shows the repo, changes and file tree of the pane you last clicked into, so
VS Code's editing is one click from any agent. Until you have clicked into a tile in this window it follows
herdr's own focus in the selected session; after that only tiles count. Clicking into a file editor or
another view changes nothing, and **Pin** stops it following.

- **Pane row:** the pane itself, first: its mark, name and `<space> › <tab>`, plus ` · not open in a tile` when
  no tile in this window shows it. Click it (or its **Show Pane** action, there while it is not open) to open its
  space on its tab and focus its tile.

- **Repo row:** the repo (or directory, outside a repo), branch, changed count, ahead and behind.
  **Add to Workspace** adds it as a workspace folder; workspace folders never change any other way, and
  the action is there only for local paths. **Open in Source Control** (local repos) has VS Code's Git open the
  repo and shows the Source Control view; outside the workspace Git keeps it only until the window reloads.
  **Terminal Here** (this machine only) opens VS Code's terminal in the repo, in the editor area; elsewhere,
  **Split Pane Here** makes a herdr pane below, in that folder.
- **Uncommitted:** the repo's whole `git status`. Click for a `HEAD ↔ working tree` diff;
  **Open File** opens the file as it is now.
- **Commits · vs origin/main:** the commits on your branch since it left the default branch (`origin/HEAD`, else
  `main` or `master`), or the 20 most recent (`recent`) on the default branch itself. Expand a commit for its files
  (`A`, `M`, `D` against its first parent); click one for its diff in that commit, and **Open File** for the file as
  it is now (or as the commit has it, when it is gone).
- **Show Only This Pane's Files** (the filter in the title bar; **Show All Files** turns it off) narrows Uncommitted
  and Commits to the files this pane's agent changed while it was **working**: herdr-vscode snapshots the worktree
  when an agent starts and stops working, in every connected session, whether or not this view is open. Git cannot
  say which process changed a file, so two agents working in one worktree at the same time see each other's files.
  A reload mid-span loses what changed before it. Kept per pane and repo until the pane closes or a week passes. A
  shell pane shows everything, with a note. The snapshots go to a temporary directory: **nothing is written to the
  repo's `.git`**.
- **Files:** the tree; click to open. Git markers (`M`, `A`, `U`, `D`, `R`, `!`) in Git's colours, and a dot on
  folders holding changes; the same badges show on editor tabs of those files. For a local repo that VS Code's own
  Git has open (a workspace folder, or after **Open in Source Control**), Git's badges are shown instead of a second
  set. **New File…**, **New Folder…**, **Rename…** and **Delete…** are on the rows. Delete is permanent.
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

- **Where:** files on this machine, VS Code Git and GitHub Pull Request diff sides, and Active Pane's container,
  SSH and `HEAD` documents, whenever an agent in a connected session can see the file: one on this machine, one in a
  dev container that bind-mounts it (or whose own file it is), or one on that SSH host. Other files get no `+`.
- **Which agent:** the thread's own while its pane is there; else the pane Active Pane follows, if it is an agent
  that can see the file; else the only one that can; else the one you picked last in this window; else a picker
  (**Which agent should answer?**).
- **What is sent:** the question goes straight into the agent's pane (herdr's `agent.prompt`), with the file's path
  **as the agent's environment sees it** (the container path for a container agent), the lines, which version of the
  file it is (working tree, index, a commit, a PR side), and the code (up to 200 lines). Nothing else reaches the agent:
  no selection tracking, no open files. The pane is not focused; **Show Agent** on the thread opens its space on
  its tab.
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

The agent marks are Lobe Icons' monochrome SVGs (MIT, see `resources/agent-icons/LICENSE` and `VERSIONS`),
vendored unmodified from devc web. `resources/agent-icons.woff` is built from them and committed;
`bash scripts/build-agent-icons.sh` rebuilds it (needs `pipx` and network: picosvg turns the marks' even-odd
holes into non-zero outlines, fantasticon builds the font at U+E001–U+E004, and a fontTools check fails the
script if a hole such as the Claude mark's eyes is filled). It is not part of `npm run build`.

`npm test` never discovers the machine's herdr sessions (`.vscode-test.mjs` sets
`HERDR_VSCODE_NO_DISCOVERY=1`). `src/test/spacePanels.test.ts` and `mirrorPanels.test.ts` open real webviews
over a made-up model, so they need the build, and reach no herdr. `src/test/paneContext.test.ts`, `git.test.ts` and
`remoteFs.test.ts` run real `git` and coreutils, only in temp directories. Opt-in suites run against a throwaway session:

- `HERDR_VSCODE_LIVE_SESSION=<name>`: connects to that running session on this machine (it
  needs one workspace), splits a pane and reports agent states in it.
- `HERDR_VSCODE_LIVE_HOME=<dir>`: points `HOME` at `<dir>` for the suites and runs full
  discovery there, so it must hold only a running throwaway session named `hv-test` (with one
  workspace, and `herdr` in `<dir>/.local/bin`). Add `HERDR_VSCODE_LIVE_STOP=1` to also stop that
  session and check it drops out. This also runs a real tiles webview: frames, keys, splits,
  takeover, restore, split ratios, swaps, edge and strip drops and zoom in space tabs, Active Pane,
  and it stops and restarts that session's server.
  Ask Agent runs a fake `claude` (a `sh` loop) in a pane of `hv-test` and prompts only that pane; its replies go to
  this machine's `/tmp/herdr-vscode/review`, and are removed afterwards. Keep `<dir>` short: herdr's socket path must fit in `sun_path` (about 100
  bytes).

Open `herdr-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to build
it and open an Extension Development Host with it loaded.
