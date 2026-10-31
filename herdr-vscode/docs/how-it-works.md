# How herdr-vscode works

herdr-vscode reaches herdr the way devc web does: `herdr remote-api-bridge` run in each
environment, one JSON request per connection, plus one long-lived `events.subscribe` connection
per running session. Nothing is installed in an environment; herdr ≥ 0.9.5 is all it needs.

## Environments

An environment is somewhere herdr sessions run, with a key and a way to run commands there
(`src/remoteShell.ts`, copied from devc-vscode):

| Environment | Key | Runs commands with |
| --- | --- | --- |
| This machine (not on Windows) | `host` | `child_process`, no shell (`LocalShell`); `HERDR_*` variables are removed so a VS Code started from a herdr pane does not steer herdr to that pane's session |
| SSH host, one per `herdr.sshHosts` entry | `ssh:<alias>` | `ssh -T -o BatchMode=yes` plus forwarding forced off, multiplexed through `/tmp/devc-<uid>` (`SshShell`); only aliases in `herdr.sshHosts` are ever spawned |
| Running dev container | `container:<first 12 chars of id>` | `docker exec -i [-u <remote user>]` (`DockerShell`); the remote user comes from the `devcontainer.metadata` label |

Discovery (`src/environments.ts`):

- Containers: `docker ps --filter label=devcontainer.local_folder --format '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.Names}}'`.
  Every running dev container is shown, named by the basename of its local folder. A
  `docker events --filter type=container --filter event=start --filter event=die --format '{{.ID}}'`
  process runs for the window's life; any line triggers rediscovery 500 ms later. If Docker is
  missing, there are no container environments and no error; the watcher retries every 30 s.
- SSH hosts: from settings, on every settings change and every 30 s. Unreachable hosts (ssh exit
  255, or ssh failing to start) are re-listed only on that 30 s pass.
- **Refresh** rediscovers both.

Every herdr command goes through one wrapper, so `~/.local/bin` is found without a login shell:

```
sh -c 'PATH="$HOME/.local/bin:$PATH"; exec herdr "$@"' herdr <args…>
```

## Sessions

`herdr session list --json` per environment (`src/sessions.ts`), every 10 s for reachable
environments and on **Refresh**:

- exit 0: `{"sessions":[{"name","default","running",…}]}`; malformed output counts as no sessions.
- exit 127 (the wrapper's `exec herdr` failed): *herdr not installed*.
- ssh exit 255: *unreachable*. Anything else: *error* (the first stderr line is in the tooltip
  and the `herdr` output channel).

A session's key is `<environment key>/<session name>`, e.g. `host/code-wksp`,
`ssh:buildbox/default`, `container:3f2a9c1b04de/devc`. Each running session gets a connection;
sessions that stop or whose environment goes away have theirs ended.

## Bridge protocol

`src/bridge.ts`. Every connection is `herdr --session <S> remote-api-bridge` spawned with stdin
piped and **never a pty** (a pty corrupts the JSON).

1. **Check:** `herdr --session <S> remote-api-bridge --check` must print exactly
   `herdr-api-bridge-v1` and exit 0. Otherwise the row says *needs herdr 0.9.5 or later* and
   there is no connection (until **Refresh**).
2. **Subscribe** before the first snapshot (herdr does not replay events):
   `{"id":"s","method":"events.subscribe","params":{"subscriptions":[…]}}`. The list is every
   global type (`workspace.*`, `tab.*`, `pane.created/closed/updated/focused/moved/exited`,
   `pane.agent_detected`, `layout.updated`) plus `{"type":"pane.agent_status_changed","pane_id":…}`
   for each pane: agent status changes are only reported through that per-pane type. The first
   reply is `{"id":"s","result":{"type":"subscription_started"}}`, then one
   `{"event":…,"data":…}` per line.
3. **Snapshot:** a one-shot `session.snapshot` (spawn, write one line, read the reply with the
   same id, end stdin). One request per connection: a second request on the same connection
   resets it.

Event names arrive spelled inconsistently (`pane_created`, but `pane.agent_status_changed`). A
name with no `.` has its first `_` turned into one. An error line with `code: "events_lost"`
means events were dropped; it is handled like any event.

## Refresh rules

- Any event re-takes `session.snapshot` 150 ms later (events arriving meanwhile share that
  snapshot; one snapshot runs at a time, and one more follows if events came during it).
- When a snapshot's pane set differs from the subscribed one, a new subscription with the new
  per-pane list is opened first, then the old one is closed (no gap; duplicate events are
  harmless).
- A subscription that ends on its own marks the session *disconnected*. It is retried after
  2 s, 5 s, 10 s, then every 30 s; each retry re-lists the environment first, so a session that
  stopped is dropped instead of retried.
- **Refresh**: rediscover environments, re-list every environment, re-snapshot every connected
  session and reconnect every disconnected or unsupported one.

## Shutdown

Ending a connection closes its stdin, then kills it if it has not exited 2 s later. Closing
stdin is what matters: `docker exec`'s process does not stop when the client is killed, but the
bridge inside the container exits when its stdin ends. Every connection is ended on deactivate,
when its session stops and when its environment goes away.

## Views

- **Sessions** groups rows under *This machine*, *SSH · &lt;alias&gt;* and *Dev containers*.
  An environment that has no session row to show (none running, herdr not installed,
  unreachable, error) gets one row with that status: labelled `this machine`, the ssh alias or
  the container's folder name.
- The selected session is stored in workspace state `herdr.selectedSession`. If it is not
  running, the view falls back to this machine's default session, else the first running
  session, without overwriting the stored choice, so it comes back when the session does.
- Status icons: blocked `circle-filled` orange, working blue, done green, idle and unknown
  `circle-outline`; panes without an agent `terminal`. Sessions and spaces show their worst
  status.
- **Agents** filter is stored in workspace state and in the context key `herdr.agentsFilter`.
