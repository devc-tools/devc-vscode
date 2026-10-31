# herdr-vscode: Sessions, Spaces and Agents views

The herdr activity bar sidebar from mockup board A
(https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): every herdr session on this machine, on
configured SSH hosts and in running dev containers; the spaces → tabs → panes of the selected
session; and every agent across all sessions, blocked first. Read-only plus attach and focus: no
pane rendering yet (that is [herdr-mirrored-tabs](herdr-mirrored-tabs.md)).

Depends on [herdr-vscode-scaffold](herdr-vscode-scaffold.md). All code is in `herdr-vscode/` unless a
path says otherwise.

herdr is reached the way devc web reaches it: `herdr remote-api-bridge` (herdr ≥ 0.9.5) run in
the environment, one JSON request per connection, plus one long-lived `events.subscribe`
connection per session. The protocol was measured for devc web; read devc-tools'
`.plans/archived/devc-web.md` § Background (`/workspaces/tools/devc-tools`) and use
`devc/web/herdr_bridge.ts` there as prior art. The facts this plan relies on are restated under
Contracts.

## Checklist

- [ ] 1. Copy `devc-vscode/src/docker.ts` and `devc-vscode/src/remoteShell.ts` to `herdr-vscode/src/docker.ts`
      and `herdr-vscode/src/remoteShell.ts`, each starting with the comment
      `// Copied from devc-vscode/src/<file> at <short commit>; maintained separately.`; add
      `LocalShell implements RemoteShell` (runs argv on this machine with `child_process`, same
      semantics as `DockerShell`). devc-vscode's files are not changed.
- [ ] 2. `herdr-vscode/src/devcontainer.ts`: copies of `remoteUserFromMetadata` and `getRemoteUser`
      from `devc-vscode/src/herdr.ts` (same comment), plus `listDevcontainers()`
- [ ] 3. Environments: discover host, SSH and container environments; rediscover on Docker
      events, on a 30 s timer for SSH, and on **Refresh**
- [ ] 4. Sessions per environment from `herdr session list --json`
- [ ] 5. Bridge client: `--check`, one-shot requests, `events.subscribe` with event-name
      normalization, `events_lost` handling, clean shutdown
- [ ] 6. Session model: snapshot per running session, re-taken on events (debounced), with
      per-pane `pane.agent_status_changed` subscriptions kept in step with the pane set
- [ ] 7. **Sessions** view (`herdr.sessions`) with selection persisted in workspace state
- [ ] 8. **Spaces** view (`herdr.spaces`) for the selected session
- [ ] 9. **Agents** view (`herdr.agents`) with filter commands and the blocked-count badge
- [ ] 10. Commands: refresh, attach session, focus pane, filters (contributed in `package.json`)
- [ ] 11. Status bar item for blocked agents
- [ ] 12. Settings in `package.json`
- [ ] 13. Unit tests (list under Validation)
- [ ] 14. `herdr-vscode/README.md` (what it shows, requirements, settings),
      `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md` (new:
      discovery, bridge protocol, refresh rules)

## Contracts

### Settings (`contributes.configuration`, title "herdr")

| Key | Type | Default | Scope | Meaning |
| --- | --- | --- | --- | --- |
| `herdr.sshHosts` | `string[]`, items matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` | `[]` | `application` | ssh aliases from `~/.ssh/config` whose herdr sessions are shown |
| `herdr.sshPath` | string | `"ssh"` | `application` | ssh client |
| `herdr.dockerPath` | string | `"docker"` | `application` | Docker CLI |
| `herdr.showStoppedSessions` | boolean | `false` | `window` | list stopped sessions too |

### Environments

Each environment has a **key** and a `RemoteShell`:

- **This machine** — key `host`; `LocalShell`. Not on Windows (`process.platform === 'win32'`).
- **SSH host** — key `ssh:<alias>` for each `herdr.sshHosts` entry; `SshShell` (the
  copy in `src/remoteShell.ts`) with `allowed` = membership in `herdr.sshHosts`, `controlDir` from
  `ensureControlDir()`, `sshPath` from settings. Every ssh carries `SSH_SAFETY_OPTIONS`.
- **Dev container** — key `container:<first 12 chars of the container id>`; `DockerShell` as the
  container's remote user (`getRemoteUser`). Listed with
  `docker ps --filter label=devcontainer.local_folder --format '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.Names}}'`;
  every running dev container is shown, not only the workspace's. Display name: the basename of
  `devcontainer.local_folder`.
- Docker is watched with
  `docker events --filter type=container --filter event=start --filter event=die --format '{{.ID}}'`;
  any line triggers container rediscovery (debounced 500 ms). No Docker (spawn fails) means no
  container environments and no error shown.

Every herdr command in an environment runs through this wrapper, so `~/.local/bin` is found
without a login shell:

```
sh -c 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"' herdr <args…>
```

### Sessions

- `herdr session list --json` → `{"sessions":[{"name":string,"default":bool,"running":bool,"session_dir":string,"socket_path":string}]}`.
  A non-zero exit whose stderr says herdr is not found (`exit 127`) marks the environment
  *herdr not installed*.
- Session **key**: `<environment key>/<session name>`, e.g. `host/code-wksp`,
  `ssh:buildbox/default`, `container:3f2a9c1b04de/devc`.
- Running sessions get a bridge (below). Stopped sessions are listed only when
  `herdr.showStoppedSessions` is true. Re-list every 10 s per reachable environment and on
  **Refresh**.
- A dev container with no running session shows one row, *herdr not running* (no Start action in
  this plan).

### Bridge protocol

- Check: `herdr --session <S> remote-api-bridge --check` must print exactly
  `herdr-api-bridge-v1` and exit 0; otherwise the session row says *needs herdr 0.9.5 or later*
  and gets no bridge.
- Connection: spawn `herdr --session <S> remote-api-bridge` with `RemoteShell.spawn` (stdin
  piped, **never a pty** — a pty corrupts the JSON). Write one line
  `{"id":"<string>","method":"<method>","params":{…}}\n`; read lines from stdout.
- **One request per connection.** A second request on the same connection resets it. A one-shot
  call = spawn, write one line, read one line, end stdin.
- Success `{"id":…,"result":{…}}`; error `{"id":…,"error":{"code":string,"message":string}}`.
- `session.snapshot` (params `{}`) → `result.snapshot`:
  - `workspaces[]`: `workspace_id`, `label`, `number`, `focused`, `active_tab_id`, `tab_count`,
    `pane_count`, `agent_status`, `worktree` (`null` or `{repo_name, repo_root, checkout_path, is_linked_worktree, repo_key}`)
  - `tabs[]`: `tab_id`, `workspace_id`, `label`, `number`, `focused`, `pane_count`, `agent_status`
  - `panes[]`: `pane_id`, `tab_id`, `workspace_id`, `terminal_id`, `label`, `agent`,
    `display_agent`, `agent_status`, `cwd`, `foreground_cwd`, `terminal_title_stripped`,
    `focused`, `revision`
  - `agents[]`: `pane_id`, `name` (unique live agent name or `null`), `agent`, `agent_status`, …
  - `focused_workspace_id`, `focused_tab_id`, `focused_pane_id`, `version`, `protocol`
  - `agent_status` is one of `idle`, `working`, `blocked`, `done`, `unknown`.
- `events.subscribe` connection, opened **before** the first snapshot (no replay):
  `{"id":"s","method":"events.subscribe","params":{"subscriptions":[…]}}`. First reply line
  `{"id":"s","result":{"type":"subscription_started"}}`, then `{"event":"<name>","data":{…}}` per
  line.
  - Global types: `workspace.created`, `workspace.updated`, `workspace.metadata_updated`,
    `workspace.renamed`, `workspace.moved`, `workspace.reordered`, `workspace.closed`,
    `workspace.focused`, `tab.created`, `tab.closed`, `tab.focused`, `tab.renamed`, `tab.moved`,
    `pane.created`, `pane.closed`, `pane.updated`, `pane.focused`, `pane.moved`, `pane.exited`,
    `pane.agent_detected`, `layout.updated`.
  - Plus `{"type":"pane.agent_status_changed","pane_id":"<id>"}` once per pane (required field;
    agent status changes emit nothing else).
  - **Gotcha — event names are spelled inconsistently.** Normalize: if the name has no `.`,
    replace its first `_` with `.` (`pane_created` → `pane.created`,
    `workspace_metadata_updated` → `workspace.metadata_updated`).
  - An error line with `code: "events_lost"` means take a fresh snapshot.
- Model refresh: any event → re-take `session.snapshot` (debounced 150 ms). When the snapshot's
  pane-id set differs from the subscribed set, open a new subscribe connection with the new
  per-pane list, then close the old one.
- A subscribe connection that ends on its own: mark the session *disconnected*, retry after 2 s,
  5 s, 10 s, then every 30 s; re-list sessions first (it may have stopped).
- Shutdown (deactivate, environment gone, session gone): end every connection's stdin.
  **Gotcha:** `docker exec`'s process does not stop when the client is killed; ending stdin is
  what stops the bridge inside the container.

### Status presentation (all three views)

| agent_status | icon (codicon, ThemeColor) | sort rank |
| --- | --- | --- |
| `blocked` | `circle-filled`, `charts.orange` | 0 |
| `working` | `circle-filled`, `charts.blue` | 1 |
| `done` | `circle-filled`, `charts.green` | 2 |
| `idle` | `circle-outline` | 3 |
| `unknown` | `circle-outline` | 4 |

A pane with no agent uses `terminal` (no color). A session's or space's icon is its worst
status (lowest rank) over its agents; with no agents, `circle-outline`.

Counts description: `"<n> blocked · <n> working · <n> done"`, omitting zero parts, in that
order; `"idle"` when all are zero.

### View container and views

`contributes.viewsContainers.activitybar`: `{"id":"herdr","title":"herdr","icon":"resources/herdr.svg"}`
(from the scaffold). `views.herdr`, in order: `herdr.sessions` "Sessions", `herdr.spaces`
"Spaces", `herdr.agents` "Agents". Activation: `onView:herdr.sessions`, `onView:herdr.spaces`,
`onView:herdr.agents`, `onStartupFinished` (so the badge and status bar work before the
container is opened).

**Sessions** (`herdr.sessions`)

- Roots, in order: `This machine` (always, unless Windows), one `SSH · <alias>` per configured
  host, `Dev containers` (only when at least one container exists). Roots are collapsible,
  expanded by default, `contextValue` `herdr.group`.
- Children: one row per session. Label: the session name (host, SSH) or the container's
  display name (containers; the session name goes first in the description when it is not
  `devc`). Description: the counts description; `stopped`; `herdr not running`;
  `herdr not installed`; `needs herdr 0.9.5 or later`; `disconnected`; or `unreachable` (ssh exit 255).
- `contextValue`: `herdr.session.running`, `herdr.session.stopped`, `herdr.session.absent`.
- Selecting a running session makes it the **selected session**: stored in workspace state key
  `herdr.selectedSession` as the session key, restored on activation (falls back to the host's
  default session if gone, else the first running session).
- Tooltip: `<session key>` and herdr `version`.

**Spaces** (`herdr.spaces`)

- `TreeView.description` = the selected session's row label. With none: welcome text
  "Select a running session in Sessions.".
- Workspace rows (snapshot order by `number`): label `label`; description `worktree.repo_name`
  when present and different from the label; status icon; collapsed unless `focused`;
  `contextValue` `herdr.space`.
- Tab rows under each: label `tab · <label>`; collapsed unless `focused`; `contextValue`
  `herdr.tab`.
- Pane rows under each tab: label = `name` from `agents[]` for that pane, else `display_agent`,
  else `agent`, else `label`, else the basename of `foreground_cwd ?? cwd`, else `shell`.
  Description: `terminal_title_stripped` when an agent is present, else
  `foreground_cwd ?? cwd`. `contextValue` `herdr.pane.agent` or `herdr.pane.shell`. Click runs
  `herdr.focusPane`.

**Agents** (`herdr.agents`)

- Flat list of every pane with an agent across every connected session, sorted by status rank,
  then session row label, then workspace number.
- Label as for pane rows. Description `<session row label> › <workspace label>`, plus
  ` · <terminal_title_stripped>` when present. Click runs `herdr.focusPane`.
- Filter (context key `herdr.agentsFilter`, workspace state `herdr.agentsFilter`, default
  `all`): `all` | `blocked` | `working`. Title-bar actions: `herdr.agents.showAll`
  (`$(list-flat)`, shown when filter ≠ all), `herdr.agents.showBlocked` (`$(warning)`),
  `herdr.agents.showWorking` (`$(sync)`).
- `TreeView.badge` = number of blocked agents (all sessions, regardless of filter), tooltip
  `"<n> agents blocked"`; `undefined` at 0. This badge shows on the herdr activity bar icon.

### Commands

| Command | Title | Where | Does |
| --- | --- | --- | --- |
| `herdr.refresh` | Refresh | Sessions title `$(refresh)` | rediscover environments, re-list sessions, re-snapshot |
| `herdr.attachSession` | Attach in Terminal | Sessions row `herdr.session.running` / `herdr.session.stopped`, inline `$(terminal)` | integrated terminal named `herdr: <row label>` running: host `herdr --session <S>`; container `containerTerminalCommand(docker, id, user, undefined, S)`; SSH `sshTerminalCommand(ssh, alias, undefined, S, controlDir)` |
| `herdr.focusPane` | Focus Pane in herdr | pane and agent rows (click) | bridge request `pane.focus` with params `{"pane_id":"<id>"}` |
| `herdr.agents.showAll` / `.showBlocked` / `.showWorking` | Show All / Blocked / Working | Agents title | set the filter |

`herdr.focusPane` errors show `herdr: <error.message>` as a warning notification.

### Status bar

Right-aligned item, priority 100: `$(warning) <n> blocked` while n > 0, hidden at 0;
background `statusBarItem.warningBackground`; click runs `herdr.agents.showBlocked` then
`workbench.view.extension.herdr`.

## Validation

- [ ] `cd herdr-vscode && npm run build && npm test` passes, including new unit tests for:
      session-list parsing (running, stopped, malformed JSON → no sessions, environment error);
      event-name normalization (`pane_created`, `workspace_metadata_updated`,
      `pane.agent_status_changed` unchanged); snapshot → Spaces items (labels, descriptions,
      contextValues, ordering, focused expansion); pane label fallback order; counts description
      (`2 blocked · 1 working`, `idle`); Agents sort and each filter; worst-status rollup;
      session key format; the herdr wrapper argv for each environment kind
- [ ] `git diff --stat -- devc-vscode` is empty (devc-vscode untouched)
- [ ] Manual, host: `herdr --session hv-test` in a terminal, split a pane, start `claude` in one.
      In an Extension Development Host: Sessions → This machine shows `hv-test` with
      `1 working` (or `idle`) and the right icon; selecting it fills Spaces with its workspace,
      tab and both panes; clicking the shell pane moves herdr's focus to it (visible in the TUI)
- [ ] Manual, agent states: make the agent ask for a permission. Within 2 s the Agents view lists
      it first with the orange icon, the herdr activity bar icon shows badge `1`, and the status
      bar shows `1 blocked`; approving it in the TUI clears all three within 2 s
- [ ] Manual, filters: Show Blocked hides non-blocked agents; Show All restores them; the choice
      survives a window reload
- [ ] Manual, container: with a running devc container whose herdr session `devc` has an agent,
      Dev containers lists it by folder name; selecting it fills Spaces; stopping the container
      removes the row within 5 s; starting it adds it back
- [ ] Manual, SSH: add a reachable alias to `herdr.sshHosts`; `SSH · <alias>` lists its running
      sessions; an unreachable alias shows `unreachable` and no error notification
- [ ] Manual, attach: **Attach in Terminal** on each kind opens a terminal attached to that herdr
      session
- [ ] Manual, cleanup: after closing the window, `ps -eo args | grep remote-api-bridge` on the
      host and `docker exec <id> ps -eo args | grep remote-api-bridge` in the container print
      nothing within 5 s
- [ ] Manual, old herdr: with a session whose herdr lacks `remote-api-bridge`, the row says
      `needs herdr 0.9.5 or later`
- [ ] Selection persistence: reload the window; the same session is selected and Spaces shows it

## Relevant Files

- `herdr-vscode/src/docker.ts`, `herdr-vscode/src/remoteShell.ts` (new: copies, plus `LocalShell`)
- `herdr-vscode/src/devcontainer.ts` (new: copied `remoteUserFromMetadata`, `getRemoteUser`; `listDevcontainers`)
- `herdr-vscode/package.json` (views, commands, menus, settings, activation events)
- `herdr-vscode/src/extension.ts`
- `herdr-vscode/src/environments.ts` (new)
- `herdr-vscode/src/bridge.ts` (new)
- `herdr-vscode/src/sessions.ts` (new: session model, snapshots, subscriptions)
- `herdr-vscode/src/views/sessionsView.ts`, `spacesView.ts`, `agentsView.ts` (new)
- `herdr-vscode/src/status.ts` (new: icons, ranks, counts, status bar)
- `herdr-vscode/src/test/*.test.ts` (new unit tests)
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`,
  `herdr-vscode/docs/how-it-works.md` (new)
- `.plans/PLAN.md`
