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

- [herdr Layout Drag and Drop](herdr-layout-drag-drop.md) — drag panes from Spaces, Agents and Pane Context into a Layout tab (a tree drag arms a placement the Layout panel completes, since VS Code can't drop a tree drag into a webview), onto Golden Layout's own drop zones; drag tiles between Layout tabs.

- [herdr Sidebar Triage](herdr-sidebar-triage.md) — Agents filter quick pick with counts, a derived Done state, time in state, this-session / all-sessions scope; branch and git status on space rows; tab summaries; Start for a dev container's herdr; a session status bar item.

- [herdr Pane Changes](herdr-pane-changes.md) — Pane Context's "Changed in This Pane" since a per-pane git baseline (full status kept as "All Changes"), git markers in Files, `devc:` / `ssh:` labels for remote files, Open in Source Control and Terminal Here on the repo row, same / other worktree on other panes.

- [herdr Ask Agent](herdr-ask-agent.md) — comment threads on editor lines that ask a herdr agent in any environment (`agent.prompt` over the bridge), the answer coming back as a thread reply; ported from devc-vscode's agent review comments.

- [herdr Mirror Fidelity](herdr-mirror-fidelity.md) — mirrored tabs mirror both ways: splitter drags set herdr's split ratios, tile drags swap or move panes in herdr, maximise ↔ herdr zoom.

- [herdr Sidebar Config](herdr-sidebar-config.md) — Spaces and Agents rows follow the `[ui.sidebar.*]` rows in this machine's herdr config.toml, mapping herdr's row tokens onto labels, icons and descriptions.

- [herdr SSH](herdr-ssh.md) — live checks and fixes for SSH hosts across every herdr-vscode feature, plus Start / Stop on SSH sessions. Blocked until a reachable SSH host with herdr is available.

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
| 16 | [herdr-layout-tabs.md](herdr-layout-tabs.md) | User-built Layout tabs of any panes; `herdr.openPaneIn` (depends on phase 15) | implemented, manual checks pending |
| 17 | [herdr-pane-context.md](herdr-pane-context.md) | Pane Context view: repo, changes, files of the followed pane; terminal links (depends on phase 15) | implemented, manual checks pending |
| 18 | [herdr-layout-drag-drop.md](herdr-layout-drag-drop.md) | Drag panes from the trees into Layout tabs; tiles between Layout tabs (depends on phase 16) | implemented, manual checks pending |
| 19 | [herdr-sidebar-triage.md](herdr-sidebar-triage.md) | Agents filters with counts, done, time in state, scope; space git, tab summaries, container Start, status bar (depends on phase 14) | implemented, manual checks pending |
| 20 | [herdr-pane-changes.md](herdr-pane-changes.md) | Pane Context: changes since a baseline, git markers, remote labels, repo actions (depends on phase 17) | implemented, manual checks pending |
| 21 | [herdr-ask-agent.md](herdr-ask-agent.md) | Ask a herdr agent from editor comment threads (depends on phases 17 and 20) | implemented, manual checks pending |
| 22 | [herdr-mirror-fidelity.md](herdr-mirror-fidelity.md) | Mirrored tabs: split ratios, pane moves and zoom both ways (depends on phase 15) | implemented, manual checks pending |
| 23 | [herdr-sidebar-config.md](herdr-sidebar-config.md) | Sidebar rows from herdr's `[ui.sidebar.*]` config (depends on phase 19) | |
| 24 | [herdr-ssh.md](herdr-ssh.md) | SSH hosts verified live and fixed; SSH session Start / Stop (blocked on a reachable host) | |
