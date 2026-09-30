# Plan Status

## Status

### Pending

- [SSH Environments](ssh-environments.md) — an SSH host (the devc-dev agent sandbox VM) as a third environment with dev container parity: Remote Files roots, ssh terminals and links, Agents view env with herdr and terminal agents, Add Agent; plain `ssh`, no remote VS Code server, no workspace folder.

- [SSH Workspace Sync](ssh-workspace-sync.md) — Send / Fetch a workspace folder's Git repo to an SSH host at the mirrored home-relative path (worktrees mirrored as worktrees), fetch opens a review diff and never merges, with sensitive paths flagged.

- [SSH Tree Sync Actions](ssh-tree-sync-actions.md) — inline Send / Fetch on SSH tree folders that are worktrees of a local repo (matched against the remote worktree listing at the mirrored path), plus fetch-only for worktrees that exist only on the host.

- [Optional Tool Detection](optional-tool-detection.md) — detect Docker, devc and host herdr; gate commands and pickers on what is present, keep SSH roots when Docker is missing, and fall back to a `docker exec` container terminal without devc.

### Completed

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
