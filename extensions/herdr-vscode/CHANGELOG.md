# Change Log

All notable changes to the "herdr-vscode" extension will be documented in this file.

## [Unreleased]

- **Fewer row actions, and Close on every row**: a trash button on space, tab and pane rows in Spaces and on agent
  rows in Agents closes it in herdr, after asking. **New Tab** (space rows), **Split Right** / **Split Down** (tab and
  pane rows), **Split Pane Here** and **Pin** / **Unpin** (Active Pane) are gone; the space strip's **+** and the
  tile context menu still make tabs and splits.
- **New Space asks where the space starts**: pick one of the session's space folders, a workspace folder or home,
  type a path, or **Browse…**.
- **Open File** on an Active Pane change row opens the file even while its diff is the active editor (it only
  re-focused the diff).
- **Active Pane names its pane in the view header** (`ACTIVE PANE  Fixing the API · api › main`), with
  ` · not open in a tile` when it applies. The pane row is gone; the repo row is first, and
  **Show Pane** is in the title bar.
- **Clicking a space or tab in Spaces, or a tab in a space's strip, follows that tab's pane**: Active Pane and the
  status bar switch without another click into a tile.
- The Active Pane repo row shows git status in the Spaces format (`⎇ main · clean`, `⎇ main ● 3 ↑1`).
- **The Sessions view is gone; Switch Session does it all.** The picker (Spaces title bar, the session in the status
  bar, or **Select Session** in Spaces while none is selected) lists sessions by place: click a running one to select
  it, a stopped one to start and select it. **Stop** and **Delete** are buttons on the rows, and **New Session…**
  (`+`) starts a new named session on this machine or in a dev container.
- **Active Pane: Uncommitted is now Changes**, always shown in a repo (`0` and `No uncommitted changes` when clean).
- Shell panes have a terminal icon on Spaces and Active Pane rows, in tile headers and in the status bar (they had none).
- **Active Pane shows changes by commit.** **Changed in This Pane** and **Reset Baseline** are gone. **All Changes** is
  now **Uncommitted** (expanded), followed by **Commits** (collapsed): your branch's commits since the default branch
  (`vs origin/main`), or the 20 most recent on the default branch itself. Expand a commit for its files; click one for
  its diff in that commit, **Open File** for the file.
- **Show Only This Pane's Files** (title bar filter): Uncommitted and Commits narrow to the files the pane's agent
  changed while it was working, recorded by snapshotting the worktree when an agent starts and stops working, in every
  session. Nothing is written to the repo's `.git` (the old baselines wrote unreferenced objects there); the snapshots
  live in a temporary directory that is removed afterwards.
- **Panes are named by their task**: the terminal title (which Claude Code keeps set to the current task) comes
  before herdr's label, the folder and the agent kind, so three Claude panes no longer all read `claude`. Agent
  pane rows and tile headers show the folder after the name (was the terminal title); the Agents view no longer
  repeats the title when it is the name.
- **Agent marks**: Claude Code, GitHub Copilot, pi and OpenCode panes show their agent's mark (devc web's Lobe
  Icons), coloured by status, instead of the status dot on Spaces pane rows, Agents rows, Active Pane, tile
  headers and the focused-pane status bar item. Other agents keep the dot; tab strips and session, space and
  tab rows keep theirs.
- **Active Pane** starts with a row for the pane: its mark, name and `<space> › <tab>`, plus `· not open in a
  tile`. Clicking it opens the pane's tile; **Show Pane** moved there from the repo row. The header text is gone
  except when no pane is followed.
- **Pane Context is now Active Pane**, and its **Other Panes in This Space** section is gone.
- Clicking a file under **Changed in This Pane** or **All Changes** opens its diff; the row's **Open File** action
  opens the file itself (these were the other way round).
- Dropping a tile anywhere in the tab strip's blank area right of **+** moves its pane to a new tab, as on the +.
- Clicking a running session in Sessions opens its first space in an editor tab, or focuses that tab.
- **Delete Session** (trash icon) on Sessions rows, except herdr's default session: asks first, stops a running
  session, then runs `herdr session delete`.
- **Layout tabs are gone.** herdr's layout is the only one, and dragging tiles edits it: onto another tile's
  middle swaps the panes; near its edge splits that tile with the dragged pane on that side (through a passing
  tab, since herdr cannot move a pane within its tab; the terminal keeps running); onto another tab in the strip
  moves the pane there, and onto **+** to a new tab. Clicking a pane or agent row opens its space on the pane's
  tab and focuses its tile. **Add to Layout**, **New / Open / Rename / Delete Layout**, **Copy as Layout**,
  dragging rows into tiles and the `herdr.openPaneIn` setting are removed; Layout editor tabs left open close on
  reload.
- Right-click a tile for **Split Right**, **Split Down**, **Zoom** / **Unzoom** and **Close Pane**; the toolbar's
  Split Right, Split Down and Copy as Layout buttons and the breadcrumb are gone, and the tab strip starts at
  the left. Editor tabs are titled with the space, or `<session> · <space>` for a session other than `default`.
- Status dots: idle is a filled gray dot, and so is a connected session or space with no agents; the empty
  circle now only means herdr is not running or not connected. Shell panes have no icon or dot (was a terminal
  icon, and a square in tiles).

- An editor tab now mirrors a herdr **space** instead of one herdr tab. It shows the space's active tab,
  with a strip of the space's tabs in the toolbar that follows herdr's active tab both ways. **+** creates
  a tab, **×** closes one (after asking), and double-click renames one. Clicking a space row opens the space
  (**Open herdr Space**), and a tab row opens its space on that tab. **Open in herdr Tab** is now **Open in herdr
  Space**. Editor tabs saved by earlier builds come back as their tab's space.

- Spaces and Agents rows follow the `[ui.sidebar.spaces]` / `[ui.sidebar.agents]` rows (and `rows_by_agent`)
  in this machine's herdr `config.toml`: herdr's row tokens, `$name` tokens from `report-metadata`
  included, become the rows' labels, icons and descriptions. Without such rows nothing changes; a mistake in
  them falls back to the default rows and says why once in the **herdr** output channel. Saved changes apply
  within about 2 s. Setting `herdr.useHerdrSidebarConfig` (on by default).

- Mirrored tabs mirror both ways: dragging a splitter sets herdr's split ratio, and herdr's ratio
  changes move the splitters in place (no reload, terminals and focus kept); dragging a tile onto
  another swaps the two panes in herdr (herdr cannot move a pane within its tab, so there are no edge
  drops); maximising a tile zooms the pane in herdr and herdr's zoom maximises the tile. **Copy as
  Layout** opens unmaximised.

- **Ask Agent**: comment threads on editor lines (the gutter `+`, or **Ask herdr Agent About Selection**) that ask a
  herdr agent on this machine, in a dev container or on an SSH host about the code, with the file's path as that
  agent sees it; the agent's answer shows as a reply in the thread. **Show Agent**, **Delete Thread**, **Resend**.
  Ported from devc-vscode's agent review comments; both can be installed together.

- Pane Context: **Changed in This Pane · since 10:31**, every change in the pane's worktree since you first
  followed it there (kept across reloads; **Reset Baseline**; commits since counted), above the repo's whole
  status, now **All Changes** (collapsed). **Open Changes** on both.
- Git markers (`M`, `A`, `U`, `D`, …) in Git's colours on Pane Context's Files rows and on editors of the followed
  repo, for container and SSH files too; local repos VS Code's Git has open keep only Git's.
- Container and SSH editors are titled `devc: <container> › /path` and `ssh: <alias> › /path`.
- **Open in Source Control** and **Terminal Here** on Pane Context's repo row.
- Other Panes in This Space say `same worktree` / `other worktree`.

- Agents: a derived **done** state (an agent that went from working to idle, until you click into its
  tile, click its row, or herdr's focus moves to it), time in state on every row (`blocked 2m`), an
  **all sessions** / **this session** scope switch, and **Filter Agents…** (All, Blocked, Working, Done, with
  counts) in place of the filter buttons. The view's description shows the counts. **Show Done** in the
  command palette.
- Spaces: branch and git status on space rows (`⎇ v3_auth ● 4 ↑1`), and a summary on tab rows
  (`claude, copilot`, `2 shells`).
- **Start Session** on a dev container's `herdr not running` row (starts `devc`) and on its stopped sessions.
- Status bar item for the selected session, `herdr: <session>`, with the herdr version in its tooltip.

- Drag panes into Layout tabs: a pane row of Spaces, Agents or Pane Context's **Other Panes** dragged
  onto a Layout tab on screen, then a click on a tab strip (a new tab there) or near an edge (a split),
  with Golden Layout's own drop zones. **Esc** (**Cancel Placing Pane**), the toolbar's **Cancel**, or
  leaving the tab cancels. A pane the layout already has moves rather than doubling.
- A grip on each Layout tile's tab drags the tile to another Layout tab (or within its own).
- Every row of Spaces, Agents and Pane Context can now be dragged. Pane Context's Files and change
  rows can be dropped on an editor group, which opens the file.
- **New Space**, **New Tab**, **Split Right** and **Split Down** in Spaces.
- This machine's stopped sessions are always listed, with **Start Session** and **Stop Session**.
- Clicking a pane always adds it to a Layout tab as a tab. It used to become a split when no tile had
  focus, as after closing the focused tile or reloading.
- **Pane Context** view: the repo, branch, changes and file tree of the pane you last clicked into, or
  herdr's focused pane until you have. **Pin** / **Unpin**, **Add to Workspace**, **Split Pane Here**, **Show Pane**,
  **Open Changes**, and **New File…**, **New Folder…**, **Rename…**, **Delete…** on its Files rows.
- Paths printed in a tile are links: they open the file beside the tile at `:line[:col]`.
- `herdr-container:` and `herdr-ssh:` read-write file systems for files with no local path (container paths
  outside the bind mounts, SSH hosts), which notice outside changes to open files within about 5 s.
- Layout tabs: named editor tabs holding any panes from any session, arranged freely with stacks,
  drag and maximise, and saved per workspace. **New Layout**, **Open Layout…**, **Rename Layout…**,
  **Delete Layout…**, **Add to Layout**, and **Copy as Layout** on a mirrored tab's toolbar. They never
  change herdr's layout.
- `herdr.openPaneIn`: clicking a pane or agent row adds it to a Layout tab (default) or opens its
  mirrored herdr tab. It no longer focuses the pane in herdr: that moved to the context menu as
  **Focus in herdr TUI**.
- Fixed: a tile of a mirrored tab could be dragged, which rearranged it locally.
- herdr tabs in the editor area: **Open herdr Tab** (click a tab in Spaces) and **Open in herdr
  Tab** (context menu of pane and agent rows) show a herdr tab's split layout as live terminal
  tiles, kept in sync with herdr. Typing, wheel scrolling, Split Right / Split Down and closing a
  pane (with confirmation) go to herdr. Tabs come back after a window reload.
- Status bar item for the last focused tile's pane.
- Removed **Attach in Terminal**: herdr panes are shown in editor-area tiles, and the extension no
  longer opens the herdr TUI in an integrated terminal.
- Sessions view: herdr sessions on this machine, on SSH hosts (`herdr.sshHosts`) and in running
  dev containers, with agent counts and status icons; the selected session is remembered per
  workspace.
- Spaces view: the selected session's spaces, tabs and panes; clicking a pane focuses it in herdr.
- Agents view: every agent across all sessions, blocked first, with Show All / Blocked / Working
  filters and a blocked-count badge on the herdr icon.
- Status bar item for blocked agents.
- Settings: `herdr.sshHosts`, `herdr.sshPath`, `herdr.dockerPath`, `herdr.showStoppedSessions`.
- Scaffold: an empty herdr activity-bar container with a Sessions view.
