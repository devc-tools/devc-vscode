# Plan Status

## Status

### Pending

- [SSH Environments](ssh-environments.md) — an SSH host (the devc-dev agent sandbox VM) as a third environment with dev container parity: Remote Files roots, ssh terminals and links, Agents view env with herdr and terminal agents, Add Agent; plain `ssh`, no remote VS Code server, no workspace folder.

- [SSH Workspace Sync](ssh-workspace-sync.md) — Send / Fetch a workspace folder's Git repo to an SSH host at the mirrored home-relative path (worktrees mirrored as worktrees), fetch opens a review diff and never merges, with sensitive paths flagged.

- [SSH Tree Sync Actions](ssh-tree-sync-actions.md) — inline Send / Fetch on SSH tree folders that are worktrees of a local repo (matched against the remote worktree listing at the mirrored path), plus fetch-only for worktrees that exist only on the host.

- [Optional Tool Detection](optional-tool-detection.md) — detect Docker, devc and host herdr; gate commands and pickers on what is present, keep SSH roots when Docker is missing, and fall back to a `docker exec` container terminal without devc.

- [Agent Review Comments](agent-review-comments.md) — comment threads on host editors and GitHub PR review diffs that submit the question, with the container path and code, to a herdr agent in the dev container (`herdr agent prompt`); the agent's answer comes back as a thread reply through a watched reply file.

- [herdr Mirrored Tabs](herdr-mirrored-tabs.md) — a herdr tab opens as an editor tab of live pane tiles (Golden Layout + xterm over `terminal session control`), kept in sync with herdr's splits; split and close go to herdr.

- [herdr Layout Tabs](herdr-layout-tabs.md) — named Layout tabs holding any panes from any session, arranged freely and saved per workspace; `herdr.openPaneIn` picks Layout (default) or mirrored tab for pane clicks; Copy as Layout.

- [herdr Pane Context](herdr-pane-context.md) — a view of the followed pane's repo, changes and files (local and bind-mounted paths as plain files; other container and SSH paths through read-write providers ported from devc-vscode), with pin, Add to Workspace, Split Pane Here, and path links in tiles.

### Completed

- [herdr Sidebar](implemented/herdr-sidebar.md) — herdr-vscode's Sessions (host, SSH, dev containers), Spaces (selected session's spaces → tabs → panes) and Agents (all sessions, blocked first, badge) views over `herdr remote-api-bridge`. ✅ Done (SSH not tested live, deferred)
- [herdr-vscode Scaffold](implemented/herdr-vscode-scaffold.md) — devc-vscode moves into `devc-vscode/` and a self-contained `herdr-vscode/` extension folder (own package.json, lockfile, build, tests, `.vscode/`) sits beside it; no monorepo tooling. ✅ Done
- [Workspace Folders View](implemented/workspace-repos-view.md) — an Explorer view of pinned folders and Git repos with their worktrees, the window's first folder pinned automatically, each with a checkbox; Apply makes the ticked ones workspace folders and Source Control follows. ✅ Done (in-VS Code checks left to the user)
- [devc web Shared Server](implemented/devc-web-shared-server.md) — one `devc web` on `devc-vscode.devcWebPort` for every window, under a watchdog that stops it ~10 s after no window uses it; the token shared through SecretStorage. ✅ Done (in-VS Code checks left to the user)
- [devc web Panels](implemented/devc-web-panels.md) — the extension starts its own `devc web` (token kept in memory, as devc-desktop does), shows `/sidebar` in a **devc web** activity-bar view and opens `/main` in the integrated browser, paired by a per-window view id. ✅ Done (in-VS Code checks left to the user)
- [Container File Tree as a Contributed Explorer View](implemented/explorer-tree-view.md) — replace workspace-folder grafting with a `TreeView` in the Explorer panel, backed by the existing filesystem provider. ✅ Done (host-only validation not run)
- [Agents View: Host herdr Sessions](implemented/agents-view-host-herdr.md) — rename the view to "Agents" and show agents from host herdr sessions this window owns. ✅ Done
- [Agents View: Plain Host Terminals](implemented/agents-view-host-terminals.md) — detect agents in plain host VS Code terminals, classified by host herdr. ✅ Done
- [Agents View: Workspace Tree Redesign](implemented/agents-tree-redesign.md) — flatten the Agents view to Workspace / Other Workspaces roots with host and container environment nodes, and add a `+` flow that launches agents. ✅ Done

## Development Phases

| Phase | Plan | Description | Status |
| --- | --- | --- | --- |
| 1 | [explorer-tree-view.md](implemented/explorer-tree-view.md) | Surface container files as a contributed Explorer tree view instead of workspace folders | ✅ Done |
| 2 | [agents-view-host-herdr.md](implemented/agents-view-host-herdr.md) | "Agents" view with host herdr sessions (session-aware; container herdr stays default-session) | ✅ Done |
| 3 | [agents-view-host-terminals.md](implemented/agents-view-host-terminals.md) | Agents in plain host VS Code terminals (depends on phase 2) | ✅ Done |
| 4 | [agents-tree-redesign.md](implemented/agents-tree-redesign.md) | Workspace / Other Workspaces roots, environment nodes, Add Agent launch flow | ✅ Done |
| 5 | [ssh-environments.md](ssh-environments.md) | SSH hosts as environments over a shared docker/ssh runner seam; host allowlist in application-scoped settings, Add SSH Host from `~/.ssh/config` | in progress |
| 6 | [ssh-workspace-sync.md](ssh-workspace-sync.md) | Git-based Send / Fetch to SSH hosts at mirrored paths, review diff on fetch (depends on phase 5) | in progress |
| 7 | [ssh-tree-sync-actions.md](ssh-tree-sync-actions.md) | Send / Fetch actions on synced folders in the Sandboxes view's SSH tree (depends on phase 6) | in progress |
| 8 | [optional-tool-detection.md](optional-tool-detection.md) | Detect Docker / devc / host herdr, gate commands and UI, docker exec terminal fallback | in progress |
| 9 | [agent-review-comments.md](agent-review-comments.md) | Ask a container agent about code from comment threads, including PR review diffs; replies shown in the thread | in progress |
| 10 | [devc-web-panels.md](implemented/devc-web-panels.md) | devc web's sidebar in a VS Code view and its tiles in the integrated browser, on an extension-owned `devc web` (needs devc-tools' `devc-web-vscode-embedding`) | ✅ Done |
| 11 | [workspace-repos-view.md](implemented/workspace-repos-view.md) | Explorer view: pin repos, tick repos / worktrees as workspace folders, apply with Source Control following | ✅ Done |
| 12 | [devc-web-shared-server.md](implemented/devc-web-shared-server.md) | One shared devc web for every window on a fixed port, stopped when none uses it | ✅ Done |
| 13 | [herdr-vscode-scaffold.md](implemented/herdr-vscode-scaffold.md) | devc-vscode moved to `devc-vscode/`; empty herdr-vscode extension in `herdr-vscode/` | ✅ Done |
| 14 | [herdr-sidebar.md](implemented/herdr-sidebar.md) | herdr-vscode Sessions / Spaces / Agents views over remote-api-bridge (depends on phase 13) | ✅ Done (SSH not tested live, deferred) |
| 15 | [herdr-mirrored-tabs.md](herdr-mirrored-tabs.md) | herdr tab as an editor tab of live pane tiles, synced with herdr (depends on phase 14) | implemented, manual checks pending |
| 16 | [herdr-layout-tabs.md](herdr-layout-tabs.md) | User-built Layout tabs of any panes; `herdr.openPaneIn` (depends on phase 15) | |
| 17 | [herdr-pane-context.md](herdr-pane-context.md) | Pane Context view: repo, changes, files of the followed pane; terminal links (depends on phase 15) | |
