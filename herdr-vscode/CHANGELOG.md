# Change Log

All notable changes to the "herdr-vscode" extension will be documented in this file.

## [Unreleased]

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
