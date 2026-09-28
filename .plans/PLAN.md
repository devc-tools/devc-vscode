# Plan Status

## Status

### Pending

- [SSH File Tree](ssh-file-tree.md) — browse and edit an SSH host's files (the devc-dev agent sandbox VM) from a contributed Explorer view over plain `ssh`, with no remote VS Code server and no workspace folder.

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
| 5 | [ssh-file-tree.md](ssh-file-tree.md) | `devc-ssh` FileSystemProvider over plain `ssh` + "SSH Files" Explorer view; host allowlist in application-scoped settings (depends on phase 1) | |
