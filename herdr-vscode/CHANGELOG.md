# Change Log

All notable changes to the "herdr-vscode" extension will be documented in this file.

## [Unreleased]

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
