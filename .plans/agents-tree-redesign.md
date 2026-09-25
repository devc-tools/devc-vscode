# Agents View: Workspace Tree Redesign

Flatten the Agents view to two root nodes, **Workspace** and **Other Workspaces**,
each holding environment nodes (one host, one per dev container) with agents directly
under them. Add a `+` flow that launches a new agent in a chosen environment.

Source design: [tree-design.md](tree-design.md). This plan records that design plus the
decisions made reviewing it.

## Checklist

- [x] Spike: confirm `herdr tab create` output shape and `herdr agent start` in host and container herdr (see Launching)
- [ ] Manual check in a live window (see Validation)
- [x] Tree: two root nodes, environment nodes, flat agent rows (see Tree shape)
- [x] Tree: environment visibility rules (running only)
- [x] Registry: environment-shaped published groups, `SNAPSHOT_VERSION` bump
- [x] Menus: `+` on the Workspace root and this workspace's environment nodes; existing lifecycle actions re-pointed to environment nodes
- [x] Launch flow: agent picker → environment picker (skipped when only one) → start agent
- [x] Setting: `devc-vscode.agentKinds`
- [x] Remove the old node kinds, placeholders and the view's welcome text
- [x] Tests (see Validation)

## Decisions

- **Two roots, one view.** `Workspace` (always expanded) and `Other Workspaces` (collapsed
  by default). Both always show, even when empty. No separate panel for now.
- **One host environment per workspace.** Its agents are everything on the host this
  window owns today: the workspace's herdr session, any other host herdr session attached
  in this window's terminals, and plain host terminals. They merge into one list. The
  extension only *launches* into the workspace's own session; the other sessions are
  shown, not targeted.
- **One container environment per dev container** of the workspace.
- **Herdr vs terminal is not shown in the tree.** There is no grouping and no description
  tag for it. The tooltip keeps the detail.
- **An environment shows while it is running.** A container shows while it runs. The host
  shows while the workspace session runs or any host agent exists. Stopped and
  not-yet-created containers, and a workspace session that isn't running, get no node.
  To start one, use `+`.
- **Agent row:** label = task, description = agent kind, icon = status.
- **Buttons:** environment nodes keep today's inline actions (attach, stop, trash) and add
  `+`. Agents keep inline trash. Whether to move destructive actions to the context menu
  is deferred until the new tree is in use.
- **Launch order:** agent first, then environment. If there's only one possible
  environment, skip the environment picker.
- **Other Workspaces is read-only.** It has no `+` and no lifecycle actions. Clicking an
  agent switches windows, as today.

## Tree shape

```
Workspace                          [+]
  <H> devc-vscode                  [+] [attach] [stop] [trash]
    ⟳ Refactor agent tree          claude
    ✓ Update README                claude
  <C> devc-vscode                  [+] [attach] [stop] [trash]
    🔔 Fix watcher race            claude
    ⟳ Add herdr tests              codex
Other Workspaces
  <H> blog
    ○ blog                         claude
  <C> blog
    ⟳ Draft post on herdr          claude
```

| Node | Label | Icon | Description | Collapsible |
| --- | --- | --- | --- | --- |
| Workspace root | `Workspace` | none | `summarize(agents)` | Expanded, always |
| Other Workspaces root | `Other Workspaces` | none | `summarize(agents)` | Collapsed by default |
| Host env | basename of `workspaceDir()` (other windows: the name they publish) | `HOST_ICON` = `ThemeIcon('vm-outline')` | `summarize(agents)` | Expanded when it has agents, else None |
| Container env | `container.name` | `CONTAINER_ICON` (`vm`, unchanged) | `summarize(agents)` | Expanded when it has agents, else None |
| Agent | task (below) | `STATUS_ICONS[status]` (unchanged) | `agent.agent` | None |

- **Task label:** `agent.title` if it's non-empty. Otherwise the basename of `agent.cwd`.
  Otherwise `agent.agent`.
- **Host icon:** `vm-outline` is a suggestion. Any codicon works as long as it's clearly
  different from `vm` and not `terminal-tmux` (that's still `SESSION_ICON` on host herdr
  terminal tabs). Export it next to `CONTAINER_ICON` so terminals the extension opens
  for the host can use it too.
- **Order under Workspace:** host first, then containers by label.
- **Order under Other Workspaces:** by window name, then host before containers.
- **Other windows' environment labels:** folder or workspace name only; the window name
  goes in the tooltip. Only environments with agents are listed.
- **Container agents:** herdr agents and terminal-detected agents in one list. Order:
  herdr first, then terminals (as today, minus the sub-node).
- **Host agents:** the workspace session's agents, then other attached sessions' agents,
  then plain host terminals.
- **Tooltips:** keep today's content (herdr session / container name, pane or terminal
  detail, cwd, and the other window's switch hint).
- **Badge:** `attentionCount()` is unchanged.
- **Expand/Collapse All** title actions stay and apply to both roots.

### contextValues

| Node | contextValue |
| --- | --- |
| Workspace root | `agentWorkspace` |
| Other Workspaces root | `agentOtherWorkspaces` |
| Host env (this window) | `agentHost`, plus `.attached` when a client of the workspace session is open in this window |
| Container env (this window) | `agentContainer`, plus `.attached` (as today) |
| Host / container env (other window) | `agentHostRemote` / `agentContainerRemote` |
| Agent | `agent` / `agentRemote` (unchanged) |

## Menus and commands

New command:

```jsonc
{ "command": "devc-vscode.addAgent", "title": "Add Agent", "category": "Dev Container FS", "icon": "$(add)" }
```

- `addAgent` is inline on `agentWorkspace`, `agentHost*` and `agentContainer*` (not the
  `*Remote` ones). Hide it from the command palette, like the other tree commands.
- Handler: `addAgent(node?: AgentNode)`. On the Workspace root it runs the full flow. On
  an environment node it skips the environment picker.
- **Host env inline actions:**
  - `attachAgentGroup`: attach to the workspace session, or start it.
  - `stopSession`
  - `deleteSession`: omitted when the workspace session is herdr's default, as today.
  - These all act on the **workspace session** only.
- **Container env inline actions:** `attachAgentGroup`, `stopContainer`, `downContainer`,
  as today.
- `closeAgent`, `focusAgent`: unchanged in behaviour. They take the new agent node shape.
- The `when` clauses in `package.json` are rewritten for the contextValues above. Order: attach,
  stop, trash, then `+` last (`inline@9`), so it is always rightmost.

## Launching

The flow in `addAgent`:

1. **Agent picker:** a `QuickPick` of `devc-vscode.agentKinds`. Items are labelled by
   kind.
2. **Environment picker** (skipped when started from an environment node, or when only
   one environment is possible). Items:
   - `$(vm-outline) <workspaceDir basename>` with description `host`. Only present when
     `hostHerdrSupported()`.
   - `$(vm) <folder basename>` with description `container`, one per workspace folder
     (`getHostFolders()`), whether or not its container is running.
3. **Start:**
   - **Host:**
     1. Make sure the workspace session is running and attached. Reuse
        `attachAgentGroup`'s path: find a client with `findHostClient`, or open one with
        `openHostHerdrTerminal`, and wait with `waitForHostClient`.
     2. Run `herdr tab create --cwd <workspaceDir()> --focus` against the session's
        socket.
     3. Run `herdr agent start <name> --kind <kind> --pane <paneId>`.
   - **Container:**
     1. If no container is running for the folder, open a container terminal with
        `getHerdrAttachCommand()` (as `attachAgentGroup` does). Show progress with
        `window.withProgress` (notification) until the container's herdr watcher reports
        running.
     2. Run the same two herdr commands through `docker exec`, following the pattern of
        `closeHerdrPane` (`PATH="$HOME/.local/bin:$PATH"`, user from `getRemoteUser`).
        `--cwd` is the container workspace folder.
   - `<name>` is the kind (e.g. `claude`). herdr's agent name is not shown in the tree.
4. On success, bring the terminal attached to that environment to the front. The new
   agent shows up through the existing watchers; there's no optimistic insert.
5. On failure (herdr error, timeout, container never came up), call
   `showErrorMessage` with herdr's message (`errorMessage()` in `hostHerdr.ts`).

New helpers:

```ts
// src/hostHerdr.ts
export async function startHostAgent(session: HostSession, cwd: string, kind: string): Promise<string | undefined>; // error message, undefined on success
// src/herdr.ts
export async function startContainerAgent(containerId: string, user: string | undefined, cwd: string, kind: string, dockerCommand: string): Promise<string | undefined>;
```

**Spike findings** (host herdr 0.8.2, container herdr 0.9.1, both have `agent start`):
- `tab create` and `workspace create` both answer
  `{"result":{"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2",…}}}`.
- A session with no herdr workspace yet fails `tab create` with
  `workspace_not_found`. Fall back to `workspace create`.
- `agent start` answers `agent_not_ready` when the agent is blocked on a startup
  prompt, and `timeout` when it's slow. Either way it has launched. `agent_pane_busy`
  and an unsupported kind are real failures. Names needn't be unique.

**Spike first (done):**
- Check what `herdr tab create` prints and where the new pane id is. It likely prints
  JSON, but that's unconfirmed. Parse it strictly.
- `herdr agent start` requires "an existing pane at an interactive shell prompt", and
  waits up to `--timeout` (default 30s). Keep the default.
- Confirm that the container's herdr has `agent start`. If it doesn't, fall back to
  `herdr pane run <paneId> <kind>`. Worst case, `pane send-text` the kind plus a
  newline.

### Setting

```jsonc
"devc-vscode.agentKinds": {
  "type": "array",
  "items": { "type": "string" },
  "default": ["claude", "copilot", "pi"],
  "markdownDescription": "Agents offered by the Agents view's Add Agent action, as herdr `--kind` values (see `herdr agent start --help`)."
}
```

## Window registry

Replace `PublishedGroup` with environment-shaped groups and bump `SNAPSHOT_VERSION`
to `4` (no backward compatibility needed):

```ts
export type PublishedGroup =
  | { kind: 'host'; name: string; agents: PublishedAgent[] }
  | { kind: 'container'; container: ContainerInfo; agents: PublishedAgent[] };
```

- `name` is the basename of `workspaceDir()`.
- Agent keys (`keyOf`) are unchanged: `host-herdr:…`, `local-terminal:…`, `herdr:…`,
  `terminal:…`. So `findLocal` and focus requests keep working. `PublishedAgent.herdr`
  stays, because focus still needs it.

## Existing touchpoints

- `src/agentTree.ts`:
  - `AgentNode` union: remove `thisWindow`, `otherWindows`, `window`, `containerHerdr`,
    `local`, and the `session` group kind. Add `workspace`, `otherWorkspaces`, and
    `host` (carrying `remote?: WindowSnapshot`). Drop the `state` field on `container`.
    `session` stays as a field on host agent nodes, because `closeAgent`/`focusAgent`
    need it.
  - Rework: `localGroups()`, `getChildren`, `buildTreeItem`, `snapshotGroups`.
  - Remove: `sessionLabel`, `groupDescription`, `CONTAINER_ICON_IDLE`,
    `SESSION_ICON_IDLE`, the placeholder logic, and `stopped` container tracking. If
    `stopped` is only used for this view, remove the provider's setter and its caller
    too.
- `src/extension.ts`: register `addAgent`. Adapt `attachAgentGroup`, `shutDownSession`
  and `closeAgent` to the new node kinds (a host env node means the workspace session).
  Add the environment picker and launch flow.
- `src/herdr.ts`, `src/hostHerdr.ts`: the start helpers above.
- `src/windowRegistry.ts`: `PublishedGroup`, `SNAPSHOT_VERSION`.
- `package.json`: the `addAgent` command, the `agentKinds` setting, rewritten
  `view/item/context` `when` clauses, and the `commandPalette` hide. Remove the
  `viewsWelcome` entry for `devc-vscode.agents`, since the roots always show.

## Concept boundaries

- **"Workspace" (tree root) vs herdr's workspace:** `AgentInfo.workspace` is a herdr
  workspace label inside one herdr server. It's unrelated to the VS Code workspace the
  root names. Don't reuse `workspace` as a node field name for either without
  qualifying it.
- **Host env vs herdr session:** a host env can hold agents from several herdr
  sessions and from plain terminals. `session` on an agent node is the herdr session;
  the env node has no single session except for actions, which always mean the
  workspace session (`workspaceSession`).
- **`attachTerminal` vs `attachAgentGroup`:** the first belongs to the Dev Containers
  view and is unchanged. The second is the Agents view's attach.
- **`HOST_ICON` vs `SESSION_ICON`:** the environment node uses `HOST_ICON`. Host herdr
  terminal tabs keep `SESSION_ICON` unless you decide to switch them too. Keep that
  choice consistent between the tab and the tree.
- **"Environment"** is a new term, used in this plan and the picker only. The code can
  call these nodes `host`/`container`.

## Validation

- `npm test` passes. Update `agents.test.ts`, `hostHerdr.test.ts`,
  `hostTerminals.test.ts` and `windowRegistry.test.ts` for the new shapes. At minimum:
  - Roots always present. Workspace holds host first, then containers.
  - A stopped container, and a workspace session that isn't running (with no host
    agents), produce no environment node.
  - Host env merges the workspace session's agents, other attached sessions' agents,
    and plain terminal agents.
  - Container env lists herdr and terminal agents flat.
  - Agent label falls back title → cwd basename → kind. The description is the kind.
  - Other windows' groups map to env nodes under Other Workspaces, with the
    `*Remote` contextValues.
  - `snapshotGroups` emits `host`/`container` groups, and `findLocal` still resolves
    keys.
- **Manual:**
  - `+` on the root with one folder and no host herdr skips the environment picker.
  - `+` on a container env starts an agent that appears under it.
  - `+` → host starts the workspace session if needed.
  - Other Workspaces has no `+`.

## .gitignore

Nothing new.
