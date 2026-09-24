# Plan Status

## Status

### Pending

- [Container File Tree as a Contributed Explorer View](explorer-tree-view.md) — replace workspace-folder grafting with a `TreeView` in the Explorer panel, backed by the existing filesystem provider.
- [Agents View: Host herdr Sessions](pending/agents-view-host-herdr.md) — rename the view to "Agents" and show agents from host herdr sessions this window owns.
- [Agents View: Plain Host Terminals](pending/agents-view-host-terminals.md) — detect agents in plain host VS Code terminals, classified by host herdr.

### Completed

_None yet._

## Development Phases

| Phase | Plan | Description | Status |
| --- | --- | --- | --- |
| 1 | [explorer-tree-view.md](explorer-tree-view.md) | Surface container files as a contributed Explorer tree view instead of workspace folders | in progress |
| 2 | [agents-view-host-herdr.md](pending/agents-view-host-herdr.md) | "Agents" view with host herdr sessions (session-aware; container herdr stays default-session) | ready |
| 3 | [agents-view-host-terminals.md](pending/agents-view-host-terminals.md) | Agents in plain host VS Code terminals (depends on phase 2) | ready |
