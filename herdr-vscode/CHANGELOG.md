# Change Log

All notable changes to the "herdr-vscode" extension will be documented in this file.

## [Unreleased]

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
