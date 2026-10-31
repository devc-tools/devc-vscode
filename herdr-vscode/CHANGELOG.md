# Change Log

All notable changes to the "herdr-vscode" extension will be documented in this file.

## [Unreleased]

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
