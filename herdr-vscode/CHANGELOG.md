# Change Log

All notable changes to the "herdr-vscode" extension will be documented in this file.

## [Unreleased]

- Sessions view: herdr sessions on this machine, on SSH hosts (`herdr.sshHosts`) and in running
  dev containers, with agent counts and status icons; the selected session is remembered per
  workspace; **Attach in Terminal**.
- Spaces view: the selected session's spaces, tabs and panes; clicking a pane focuses it in herdr.
- Agents view: every agent across all sessions, blocked first, with Show All / Blocked / Working
  filters and a blocked-count badge on the herdr icon.
- Status bar item for blocked agents.
- Settings: `herdr.sshHosts`, `herdr.sshPath`, `herdr.dockerPath`, `herdr.showStoppedSessions`.
- Scaffold: an empty herdr activity-bar container with a Sessions view.
