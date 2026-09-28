# SSH Environments

Make an SSH host (mainly the agent sandbox VM from `devc-dev`'s `agent-sandbox-vm` plan) a third
kind of environment next to the host and dev containers. It should behave almost exactly like a
dev container: a root in the file tree, terminals, terminal links, an Agents view environment
with herdr and terminal-detected agents, Add Agent, other windows seeing it, and terminals that
come back after a restart. The difference is transport: plain `ssh <host>` replaces
`docker exec <container>`, and ssh terminal commands replace `devc herdr` / `devc attach`.

There is **no VS Code server on the remote** and **no workspace folder** for it. The extension runs
only on the host and only ever spawns plain `ssh`.

**Depends on** [explorer-tree-view.md](implemented/explorer-tree-view.md) and
[agents-tree-redesign.md](implemented/agents-tree-redesign.md), both implemented.

## Why plain ssh

Measured in `devc-dev` (`docs/agent-sandbox-vm-findings.md`; T-2..T-7): VS Code **Remote-SSH**
installs a server on the remote. Its git askpass relay silently hands the host's GitHub session
to any process there, and remote Machine settings can turn that back on past any host-side
setting. Plain `ssh` with forwarding forced off carries none of that.

Keeping the remote out of the **workspace** matters too. VS Code applies a workspace folder's
`.vscode/settings.json`, `tasks.json` and `launch.json` on the host. Files opened by URI from a
tree view contribute no configuration, so config files an agent writes stay inert text.

## Parity map

| Dev container feature | SSH equivalent | Same code? |
| --- | --- | --- |
| `devc-vscode://<id>/<path>` FS provider (`docker exec` + coreutils) | `devc-ssh://<host>/<path>` provider (`ssh` + the same coreutils) | Shared coreutils logic behind a runner |
| File tree root per running container, based at the bind-mount path | File tree root per configured host, based at its `root` | Same view, same provider class, new root kind |
| New File / Folder / Rename / Delete / Copy Path / Refresh / drag and drop | Same commands on SSH nodes | Unchanged handlers |
| Attach Terminal (`devc herdr`) on a container root | Attach Terminal on an SSH root: an `ssh` terminal attached to herdr | New terminal command, same command id |
| Terminal links in `devcontainer` terminals | Terminal links in SSH terminals, resolved against the remote home, `root`, and the live cwd | Same link provider, generalised context |
| Container herdr watcher (`herdr --session=devc api snapshot` over `docker exec`) | The same `WATCH_SCRIPT` over `ssh`, for this window's session name | Shared script, runner-injected |
| Terminal agent detection (`PROBE_SCRIPT` / `EXPLAIN_SCRIPT` over `docker exec`) | Same scripts over `ssh` | Shared scripts, runner-injected |
| Focus / close agent, `startContainerAgent` | Same herdr calls over `ssh` | Runner-injected |
| Agents view container env (attach, stop, down, `+`) | SSH env (attach, stop session, delete session, `+`) | New node kind, actions differ |
| Add Agent picker: host, then "Dev Containers" | Adds an "SSH Hosts" group, plus "Add SSH Host…" from `~/.ssh/config` | Extended picker |
| `docker events` drive liveness | The watcher's ssh connection is the liveness signal, and it reconnects | New |
| Registry `container` groups | Registry `ssh` groups (`SNAPSHOT_VERSION` 5) | Extended |
| Terminal restore (`kind: 'container'`) | `kind: 'ssh'` | Extended |
| Open Folder in Container (Explorer context on host folders) | **None**: host folders don't map to SSH paths | — |
| Stop / Down container (`devc stop` / `devc down`) | **None**: the VM's lifecycle belongs to the user (`multipass`), outside this extension | — |

## Decisions

**One runner seam for "run a script in an environment".** Every place that builds
`docker exec [-i] [-u user] <id> sh -c <script> sh <args…>` goes through a runner interface
with two implementations: Docker, and SSH (`ssh … -- <host> <quoted sh -c script sh args…>`).
The runner supports stdin input, a timeout, and a long-lived spawn that keeps stdin open (for
the watcher). The FS provider, `herdr.ts` (watch, focus, close, start) and `terminalAgents.ts`
(probe, classify) take a runner instead of `(containerId, user, dockerCommand)`. **Docker
behaviour must stay byte-for-byte unchanged:** same argv, same `-u` user, same timeouts. Don't
copy-paste any of these functions into SSH variants.

**New scheme `devc-ssh`, URI `devc-ssh://<host>/<absolute path>`**, where `<host>` is an SSH
config alias (e.g. `agent-vm`). It is a separate scheme, so the two providers never share URI
parsing.

**Hosts come only from user settings.** `devc-vscode.sshHosts` and `devc-vscode.sshPath` are
`"scope": "application"`: user settings only, and a workspace can't override them. The provider
and every runner call **reject a host that isn't configured** (`FileSystemError.NoPermissions`)
*before* spawning anything. Any `devc-ssh://` URI from anywhere (a markdown link, a terminal
link, another extension) reaches the provider, and its authority becomes an `ssh` argument. An
unvalidated authority such as `-oProxyCommand=…` would be command execution on the host.

**`~/.ssh/config` feeds an "Add SSH Host…" flow, not the environment list.** Listing every
config alias as an environment would offer `github.com` and jump hosts as places to start
agents, and would make "whatever is in the file" the allowlist. Instead,
`devc-vscode.addSshHost` shows a QuickPick of the config's concrete aliases that aren't already
configured. It then asks for the remote root and appends the entry to the user-level
`sshHosts`. The picker and the file tree show only configured hosts.

**A configured host is pinned: every window sees it, and it is either up or not.** One VM runs
many projects, and its lifecycle belongs to the user, not this extension. Every window shows
every configured host in the file tree and the Add Agent picker. The **Agents view** SSH
environment shows in every window while the host is **reachable**, i.e. while that window's
watcher is connected, whether or not the window's session is running. An unreachable host has
no Agents view node, just as a stopped container has none. The extension attaches to and
manages agent sessions on the host; it never starts, stops or provisions it.

**The remote herdr session is this window's workspace session name.** That is the
`devc-vscode.herdrSession` setting when set, else `sessionNameForDir(workspaceDir())`, else
`devc`. It is computed even where `hostHerdrSupported()` is false, because that check is about
the host. This follows the host model rather than the container's fixed `devc`, because a VM
outlives and is shared across projects, unlike a per-folder container. Each window watches,
attaches to and launches into only its own session. Other sessions on the VM are visible only
through the windows that own them (Other Workspaces).

**One file tree view.** SSH roots join the existing `devc-vscode.containers` view, which keeps
its "Dev Containers" name and its command titles. Renaming the view (e.g. "Sandboxes") is out
of scope. Container roots come first, then SSH roots in settings order.

**System `ssh`, not an SSH library.** It honours the user's `~/.ssh/config` (keys, `HostName`,
`User`, known hosts). The extension forces the safety options on the command line, where they
override the config. Connections are multiplexed with `ControlMaster` so tree expansion doesn't
pay a handshake per `stat`.

**Terminals get the same forced forwarding options.** An SSH terminal must not forward the
host's agent even if the user's config says `ForwardAgent yes` for that host, because that is
the credential crossing this feature exists to avoid. Terminals don't get `BatchMode`, so
passphrase and host-key prompts still work there.

**Liveness is the watcher's connection.** There are no `docker events` for a VM. Each configured
host whose SSH environment could show runs a long-lived watcher over ssh. When it exits, it
reconnects with backoff, and the file tree root's error child reports why listing fails.

**No workspace folders, and a guard that removes them.** Nothing in the extension calls
`updateWorkspaceFolders` to add a `devc-ssh` folder. The guard (below) is cleanup for a user who
adds one by hand. It is **not** prevention: VS Code may read that folder's configuration before
the guard removes it.

**Error roots, not error dialogs.** An unreachable host still shows its file tree root; expanding
it shows one child explaining why.

## Contract

### Settings

```json
"devc-vscode.sshHosts": {
  "type": "array",
  "scope": "application",
  "default": [],
  "items": {
    "type": "object",
    "required": ["host"],
    "properties": {
      "host":  { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      "root":  { "type": "string", "pattern": "^/" },
      "label": { "type": "string" }
    }
  },
  "markdownDescription": "SSH hosts offered as environments: file tree roots, Add Agent targets and terminals. `host` is an alias from `~/.ssh/config`; `root` is the absolute remote directory files, terminals and agents start in (default: the remote home). User settings only — use **Add SSH Host…** to pick from `~/.ssh/config`."
},
"devc-vscode.sshPath": {
  "type": "string",
  "scope": "application",
  "default": "ssh",
  "description": "ssh client used for SSH environments (a name on PATH or an absolute path). User settings only."
}
```

- At read time, entries whose `host` fails the pattern or whose `root` isn't absolute are
  dropped. Each drop is reported once per session with
  `showWarningMessage('devc-vscode.sshHosts: ignoring invalid entry "<host>"')`. The JSON schema
  `pattern` only produces editor squiggles; the runtime check is the enforcement.
- If two entries have the same host, the later one is dropped with the same warning.
- Authority comparison is case-insensitive (lower-case both sides).
- With no `root`, the remote home is resolved once per host per session by running
  `printf %s "$HOME"` through the runner. That value is the effective root everywhere below.
- Changing `devc-vscode.sshHosts` refreshes the file tree and the Agents view, and starts or
  stops watchers.

### ssh invocation (exact argv, non-interactive)

```
<sshPath> -T
  -o BatchMode=yes
  -o ForwardAgent=no
  -o ForwardX11=no
  -o ClearAllForwardings=yes
  -o PermitLocalCommand=no
  -o ControlMaster=auto
  -o ControlPath=<controlDir>/%C
  -o ControlPersist=60
  -- <host> <remote command string>
```

- `<remote command string>` is the argv (`sh -c <script> sh <args…>`, or a coreutils argv) with
  **every element single-quoted** and joined by spaces. Quote as
  `'` + s.replaceAll(`'`, `'\''`) + `'`.
  **Gotcha:** ssh doesn't pass an argv. It joins its trailing arguments into one string that
  the remote login shell parses. Unquoted, a filename like `a b` splits and `$(…)` executes (on
  the remote). `docker exec` has no such step, which is why the Docker provider never needed
  quoting. The `find -printf '%f\\0%y\\0'` format keeps its literal backslash-zero through
  quoting.
- `<controlDir>` = `path.join(os.tmpdir(), 'dcs')`, created with mode `0700`. Before use,
  `fs.lstatSync` must show a directory owned by `process.getuid()` with mode `0700`. Otherwise,
  omit the three `Control*` options (no multiplexing) and log once to the `Devc` output channel.
  **Gotcha:** Unix socket paths are limited to 104 bytes on macOS. `%C` is a 40-char hash, and
  the short `dcs` directory under `os.tmpdir()` (≈49 chars on macOS) keeps it under the limit.
  Don't put the socket under `context.globalStorageUri`, which is far too long.
- The remote user is whatever `~/.ssh/config` says. There is no `-u` equivalent and no
  `getRemoteUser`.
- Timeout: 30 s per FS operation, and the same timeouts as the Docker path for herdr and probe
  calls. On timeout, kill the child and throw `FileSystemError.Unavailable` (FS) or treat it as
  a failed call (herdr/probe), as the Docker path does.
- **Exit code 255 is ssh's own failure** (connection, auth, host key), so map it to
  `FileSystemError.Unavailable` with the stderr text. If stderr contains
  `Host key verification failed`, the message is
  `<host>: unknown host key — run "ssh <host>" once in a terminal to accept it.`. Any other
  non-zero exit goes through the shared stderr mapping.
- The watcher spawn uses the same argv, with stdin kept open. Closing stdin makes the remote
  `WATCH_SCRIPT` exit, exactly as with `docker exec -i`.
- **Gotcha:** anything the remote shell's init prints to stdout corrupts `readFile`, `stat` and
  herdr JSON output. Ubuntu's `.bashrc` returns early for non-interactive shells, so the default
  is safe. The README tells users to keep output out of shell init on the remote.

### SSH terminals

Opened like container terminals: an editor-area terminal, `isTransient: true`,
`hideFromUser: true` then `show()`, into which the extension `sendText`s a command.
**Gotcha:** it must `sendText` into the host shell, not use `shellPath: ssh`. Terminal agent
detection reads the command's output through shell integration
(`onDidStartTerminalShellExecution`), which needs a host shell.

- `name`: `ssh <label ?? host>`. `iconPath`: `new vscode.ThemeIcon('remote')`.
  `env: { DEVC_SSH_HOST: <host> }` marks it. An SSH terminal is one whose
  `creationOptions.env.DEVC_SSH_HOST` names a configured host.
- Command sent (host-shell POSIX quoting as in `attachCommand`, `<root>` and `<session>` quoted):

  ```
  <sshPath> -t -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ControlMaster=auto -o ControlPath=<controlDir>/%C -o ControlPersist=60 -- <host> 'cd <root> && PATH="$HOME/.local/bin:$PATH" && if command -v herdr >/dev/null 2>&1; then exec herdr --session <session>; else exec "${SHELL:-sh}" -l; fi'
  ```

  Omit the `Control*` options when the control directory check fails. With no herdr on the
  remote, the user gets a login shell in `root`.
- **Gotcha: SSH terminals aren't host terminals.** Every place that treats
  `!isContainerTerminal(t)` as "a host terminal" (host foreground polling in the session
  source, `findHostClient`, `shutDownSession`, host terminal agent detection) must also exclude
  SSH terminals. Otherwise the local `ssh` client is read as the host foreground.

### File tree

- The view `devc-vscode.containers` keeps its name ("Dev Containers") and command titles.
- SSH roots: one per valid `sshHosts` entry, in settings order, after container roots.
  `contextValue` is `sshHost` (or `sshHost.attached` when an SSH terminal to it is open in this
  window, mirroring `container.attached`). Label is `label ?? host`, `description` is the
  effective root, `iconPath` is `new vscode.ThemeIcon('remote')`, and `id` is `sshHost:<host>`.
  Don't set `resourceUri` on roots, for the same reason as container roots.
- A root expands to `readDirectory(devc-ssh://<host><root>)`. Below that it's identical to the
  container tree: `contextValue` `directory` / `file`, directories first then
  case-insensitive, `id` = `uri.toString()`, `resourceUri` set, and files open with
  `vscode.open`.
- If listing a root fails, its only child is a non-collapsible item with `contextValue`
  `sshError`, label `Cannot reach <host>`, `tooltip` = the error message, and icon
  `ThemeIcon('error')`.
- `view/title` gains `devc-vscode.addSshHost` (icon `$(add)`).

### Commands and menus

Reuse the existing commands. Every `when` clause that names `container` in this view also
accepts `sshHost`:

| Command | Change |
| --- | --- |
| `devc-vscode.newFile`, `devc-vscode.newFolder` | `viewItem =~ /^(container\|sshHost)(\.attached)?$\|^directory$/` |
| `devc-vscode.rename`, `devc-vscode.delete`, `f2` / `delete` keybindings | unchanged (`directory` / `file`); handlers work on `devc-ssh` URIs |
| `devc-vscode.copyPath` | unchanged; copies `uri.path` |
| `devc-vscode.attachTerminal` | also inline on `sshHost(\.attached)?`: shows this window's oldest SSH terminal to that host, else opens one |

New command:

| Command id | Title | Category |
| --- | --- | --- |
| `devc-vscode.addSshHost` | `Add SSH Host…` | `Dev Container FS` |

It is **not** hidden from the command palette.

### Add SSH Host…

1. Parse `~/.ssh/config` (`os.homedir()`-relative):
   - Keywords are case-insensitive. Accept both `Host a b` and `Host=a b`, and strip one layer
     of double quotes from tokens.
   - Collect `Host` tokens that contain none of `*`, `?`, `!` and match the `host` pattern.
     Ignore `Match` blocks.
   - Follow `Include` lines, recursively and depth-limited to 8. Relative paths resolve against
     `~/.ssh/`, a leading `~/` against the home. Glob only a `*` in the **last** path segment,
     matched against `readdirSync` of the parent, sorted.
   - A missing or unreadable file contributes nothing and throws nothing.
2. Drop aliases already in `sshHosts` (case-insensitive). If none remain, show
   `showInformationMessage('No other hosts found in ~/.ssh/config.')` and return.
3. Show a QuickPick of the aliases (placeholder `SSH host to add`), then
   `showInputBox({ prompt: 'Remote directory to start in (blank for the remote home)', validateInput })`.
   The value must be blank or start with `/`.
4. Append `{ host, root? }` with
   `getConfiguration('devc-vscode').update('sshHosts', next, vscode.ConfigurationTarget.Global)`.
   Start from `inspect('sshHosts')?.globalValue ?? []`, **not** `get()`, which would fold in the
   default.

### Agents view

New environment node kind for SSH hosts, under **Workspace** after the containers, ordered by
label. Under **Other Workspaces**, ordered as today, with SSH after containers within a window.

| Node | Label | Icon | Description | Collapsible |
| --- | --- | --- | --- | --- |
| SSH env | `label ?? host` | `ThemeIcon('remote')` | `summarize(agents)` | Expanded when it has agents, else None |

- **Visibility (this window):** shown while the host is reachable: the watcher has received a
  snapshot since it last (re)connected, whether that snapshot is agents or an error response
  such as `server_not_running`. It is hidden from the moment the watcher exits until the next
  snapshot. Other windows' SSH envs are listed only when they have agents, as for other
  environments.
- **Agents:** herdr agents from the watched session, then agents detected in this window's SSH
  terminals to that host (same order as containers).
- **Tooltip:** host, session name, and the pane or terminal detail, as the container tooltip does.

| Node | contextValue |
| --- | --- |
| SSH env (this window) | `agentSsh`, plus `.running` when the session is running, plus `.attached` when an SSH terminal to it is open in this window, in that order |
| SSH env (other window) | `agentSshRemote` |

Menu additions (same inline order rules as today, `+` stays `inline@9`):

```jsonc
{ "command": "devc-vscode.attachAgentGroup", "when": "view == devc-vscode.agents && viewItem =~ /^agentSsh(\\..*)?$/", "group": "inline@1" },
{ "command": "devc-vscode.stopSession",      "when": "view == devc-vscode.agents && viewItem =~ /^agentSsh\\.running/",  "group": "inline@2" },
{ "command": "devc-vscode.deleteSession",    "when": "view == devc-vscode.agents && viewItem =~ /^agentSsh\\.running/",  "group": "inline@3" }
```

The existing `addAgent` clause regex becomes `/^agent(Workspace|Host|Container|Ssh)(\..*)?$/`.
**Gotcha:** `agentSshRemote` must not match it, and doesn't: `Remote` follows without a dot.

- `attachAgentGroup` on an SSH env shows this window's oldest SSH terminal to the host, else
  opens one.
- `stopSession` / `deleteSession` on an SSH env first close this window's SSH terminals to that
  host. They then run `herdr session stop <session>` (and `herdr session delete <session>`)
  through the runner, with the same modal wording as the host (`herdr session "<name>" on
  <label>`). `deleteSession` is refused by herdr for a default session; show its error.
- `focusAgent`, `closeAgent`: as for container agents, through the SSH runner. Focusing with no
  SSH terminal to the host opens one first, as the container path does.

### Add Agent

`pickLaunchTarget` adds, after the containers:

- a separator `SSH Hosts`, then `$(remote) <label ?? host>` per configured host (reachable or
  not);
- a final non-target item `$(add) Add SSH Host…`, shown only when the picker itself is shown.
  Choosing it runs `devc-vscode.addSshHost` and ends this Add Agent without starting anything.

Started from an SSH env node, the picker is skipped. Launch on SSH:

1. If this window's session on the host isn't running, open an SSH terminal (which starts
   `herdr --session <session>`). Wait until the watcher reports it running, with the progress
   notification and cancellation as for containers. Timeout 60 s, then fail with
   `herdr did not come up on <label>`.
2. `startAgent` through the SSH runner with `--cwd <root>`: the same herdr commands, spike
   findings and error handling as `startContainerAgent`.
3. Focus the new agent as the container path does.

### Watchers and liveness

- One watcher per configured host, started when the window activates and on `sshHosts`
  changes. It runs `WATCH_SCRIPT` with the session name from Decisions through the SSH runner.
- On exit: reconnect after 5 s, doubling to a 60 s cap, and reset to 5 s after a snapshot
  arrives. A removed host's watcher is disposed and not restarted.
- Every reconnect and every `sshHosts` change also refreshes that host's file tree root.

### Window registry

```ts
export type PublishedGroup =
  | { kind: 'host'; name: string; agents: PublishedAgent[] }
  | { kind: 'container'; container: ContainerInfo; agents: PublishedAgent[] }
  | { kind: 'ssh'; host: string; label: string; agents: PublishedAgent[] };
```

`SNAPSHOT_VERSION` becomes `5`, with no backward compatibility. Agent keys for SSH agents are
distinct from container keys, so `findLocal` resolves them.

### Terminal restore

`SavedTerminal` gains `{ kind: 'ssh'; host: string }`. On restore, an entry is reopened only if
the host is still configured **and** a runner call of `true` succeeds within 10 s. An existing SSH
terminal to that host (the extension host restarted, not the window) is adopted instead, as for
containers.

### Terminal links

The link provider also serves SSH terminals. Their context is: host, `home` = remote `$HOME`,
`cwd` = the live cwd from terminal agent detection when known, else the effective root.
Candidates are `stat`ed through the `devc-ssh` provider. Directories reveal in the file tree
(`nodeFor` works for SSH roots), and files open with `vscode.open`. The link tooltip is the
`devc-ssh://` URI plus the line suffix, as for containers.

### Activation

`activationEvents` adds `"onFileSystem:devc-ssh"`. Register the provider with
`{ isCaseSensitive: true }`.

### Workspace-folder guard

On activation and on every `workspace.onDidChangeWorkspaceFolders`:

- If any workspace folder has scheme `devc-ssh` and the window has more than one folder, remove
  each such folder with `updateWorkspaceFolders(index, 1)`, highest index first. Then
  `showWarningMessage('SSH folders cannot be workspace folders — use the Dev Containers view instead.')`.
- If the window's **only** folder is `devc-ssh` (opened with `--folder-uri`), removal isn't
  possible. Show
  `showErrorMessage('This window has an SSH folder as its workspace. Close it and browse the host from the Dev Containers view.', { modal: true })`
  and start no SSH watchers in that window.
- **Gotcha:** removing folder 0 restarts the extension host. The guard runs again on activation
  and finds nothing, so this terminates.

## Checklist

- [ ] Runner seam: Docker implementation; `devcontainerFs.ts`, `herdr.ts`, `terminalAgents.ts` moved onto it with Docker argv unchanged
- [ ] SSH runner: argv builder, quoting, host allowlist before spawn, control-directory check, timeouts, exit-255 mapping, long-lived stdin-held spawn
- [ ] `devc-ssh` provider over the shared coreutils logic
- [ ] `devc-vscode.sshHosts` / `devc-vscode.sshPath` settings with runtime validation and remote-home resolution
- [ ] `~/.ssh/config` alias parser and `devc-vscode.addSshHost`
- [ ] File tree: SSH roots, error child, config-change refresh
- [ ] Commands, menus and drag and drop accept SSH nodes
- [ ] SSH terminals: command, marker, Attach Terminal, excluded from host-terminal logic
- [ ] Terminal links in SSH terminals
- [ ] Terminal agent detection in SSH terminals
- [ ] SSH watchers with reconnect backoff
- [ ] Agents view: SSH env nodes, visibility rule, contextValues, menus, attach/stop/delete session, focus/close
- [ ] Add Agent: SSH Hosts group, Add SSH Host… item, SSH launch
- [ ] Window registry `ssh` groups, `SNAPSHOT_VERSION` 5
- [ ] Terminal restore for SSH terminals
- [ ] `onFileSystem:devc-ssh` activation
- [ ] Workspace-folder guard
- [ ] Tests (see Validation)
- [ ] README (SSH section, settings and commands tables); CHANGELOG entry

## Validation

### In a dev container (no Docker, no ssh host required)

- [ ] `npm run compile` and `npm run lint` exit 0
- [ ] `xvfb-run -a npm test` exits 0. The offline SSH tests are **passed, not skipped**, and the live SSH suite reports skipped. The existing suites pass with no Docker-path expectations changed.
- [ ] Offline tests cover:
  - [ ] quoting round-trip: each of `a b`, `it's`, `$(touch /tmp/x)`, `` `id` ``, `a\nb`, `back\\slash`, `-rf`, `%f\\0%y\\0`, quoted and passed to a local `sh -c 'printf %s …'`, prints the original exactly
  - [ ] allowlist: a configured host passes; an unconfigured host, an empty authority and `-oProxyCommand=x` all throw `NoPermissions` **without spawning** (inject the spawner and assert it was not called)
  - [ ] the exact non-interactive argv for a sample host, with and without a usable control directory
  - [ ] the exact SSH terminal command string, with a root and session needing quoting
  - [ ] the Docker runner builds the same argv as before the refactor, for watch, focus, close, start, probe and classify
  - [ ] exit 255 → `Unavailable`; host-key stderr → the exact message
  - [ ] settings parsing drops invalid and duplicate entries
  - [ ] ssh config parsing: `Host a b`, `Host=c`, quoted tokens, wildcard and negated tokens dropped, `Match` ignored, `Include` relative and `~/`, a `*` glob in the last segment, an include cycle stops at depth 8, a missing file yields nothing
  - [ ] Agents tree: an SSH env shows once its watcher has reported a snapshot, including a `server_not_running` one; it's absent before the first snapshot and after the watcher exits; it orders after containers; contextValues `agentSsh.running.attached` / `agentSshRemote`
  - [ ] registry: `snapshotGroups` emits `ssh` groups and `findLocal` resolves SSH agent keys
- [ ] `grep -n "updateWorkspaceFolders" src/*.ts` shows calls only inside the guard (removal), never an addition
- [ ] `node -e 'const p=require("./package.json").contributes.configuration.properties; for (const k of ["devc-vscode.sshHosts","devc-vscode.sshPath"]) if (p[k].scope!=="application") process.exit(1)'` exits 0

### Host only (needs the agent sandbox VM, `Host agent-vm` in `~/.ssh/config`, host key accepted, herdr installed on the VM)

- [ ] `DEVC_SSH_TEST_HOST=agent-vm DEVC_SSH_TEST_ROOT=/home/ubuntu/work npm test` exits 0 with the live SSH suite **running**. The suite runs `createDirectory`, `writeFile`, `readFile`, `stat`, `readDirectory`, `rename` and `delete` in a fresh `<root>/devc-ssh-test-<random>`, including a filename with a space and a single quote, and removes it at the end.
- [ ] `docker ps --filter label=devcontainer.config_file -q` prints an id, then `npm test` passes with the live Docker FS suite running (runner refactor regression)
- [ ] Manual, F5, with `"devc-vscode.sshHosts": [{ "host": "agent-vm", "root": "/home/ubuntu/work" }]` in user settings:
  - [ ] "Dev Containers" shows container roots then `agent-vm` (description `/home/ubuntu/work`). Expanding lists directories first. `vscode.workspace.workspaceFolders` is unchanged (Debug Console).
  - [ ] Open, edit, save a file; `ssh agent-vm cat <path>` shows the edit. New File / New Folder / F2 / Delete each show in `ssh agent-vm ls`. Dragging a host file from the native Explorer copies it to the VM.
  - [ ] Add SSH Host… lists the aliases in `~/.ssh/config` minus `agent-vm`; adding one writes it to user settings and its root appears
  - [ ] Attach Terminal on the root opens `ssh agent-vm` in herdr session `<workspace session>`; the Agents view shows the `agent-vm` env
  - [ ] Add Agent → `agent-vm` → `claude` starts an agent in `/home/ubuntu/work` that appears under the env; clicking it focuses its pane; its trash closes the pane
  - [ ] Running `claude` in a plain shell inside the SSH terminal (herdr absent or detached) shows it under the env via terminal detection
  - [ ] A path printed in the SSH terminal is a link: a file opens, a directory reveals in the tree
  - [ ] Stop herdr Session on the env closes the terminal and `ssh agent-vm herdr session list` shows it stopped; the env stays, empty, with no stop/delete actions
  - [ ] A second window with another folder shows its own `agent-vm` env under Workspace (empty until it starts an agent), and its Other Workspaces lists the first window's `agent-vm` env with its agents
  - [ ] Reload the window with an SSH terminal open: it comes back attached
  - [ ] **No VS Code server was installed:** `ssh agent-vm 'test ! -e ~/.vscode-server'` exits 0
  - [ ] **No agent forwarding:** with `ForwardAgent yes` for `agent-vm` in `~/.ssh/config`, `echo $SSH_AUTH_SOCK` in the SSH terminal prints nothing
  - [ ] **No credentials cross:** `ssh agent-vm '~/credtest.sh <private repo>'` still exits 0 after the above
  - [ ] Put the setting in **workspace** settings only (remove it from user settings): no SSH roots, envs or picker items
  - [ ] Stop the VM (`multipass stop agent`), refresh: the root shows `Cannot reach agent-vm` with the ssh error as tooltip, and the env disappears. Start it: within 60 s the watcher reconnects and files and agents return.
  - [ ] Debug Console: `vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('devc-ssh://-oProxyCommand=touch%20%2Ftmp%2Fdevc-ssh-pwned/x'))` fails with a permission error, and `ls /tmp/devc-ssh-pwned` on the host reports no such file
  - [ ] `vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: vscode.Uri.parse('devc-ssh://agent-vm/home/ubuntu/work') })`: the folder is removed and the warning shown
  - [ ] **Formatter probe:** on the VM, create `~/work/fmt-probe/` with `x.js` and a `prettier.config.js` whose body is `require('fs').writeFileSync('/tmp/devc-ssh-prettier-marker', 'ran'); module.exports = {};`. With the Prettier extension and `editor.formatOnSave: true`, open `x.js` from the tree, edit, save. `/tmp/devc-ssh-prettier-marker` must **not** exist on the host. If it does, record the extension and version in README § SSH as a known risk ("disable format-on-save for SSH files") and note it here.

## Relevant Files

| File | Change |
| --- | --- |
| `src/remoteShell.ts` | **New.** Runner interface; Docker and SSH runners (argv, quoting, allowlist, control dir, timeouts, exit-255 mapping, long-lived spawn) |
| `src/docker.ts` | `execDocker` stays; the Docker runner builds on it |
| `src/devcontainerFs.ts` | Coreutils logic runs on a runner; Docker provider behaviour unchanged |
| `src/sshFs.ts` | **New.** `devc-ssh` provider (allowlist + shared coreutils logic) |
| `src/sshConfig.ts` | **New.** `~/.ssh/config` alias parser |
| `src/herdr.ts` | watch / focus / close / start take a runner and a session name |
| `src/terminalAgents.ts` | probe / classify take a runner; tracker resolves SSH terminals to their host |
| `src/containerTree.ts` | SSH root kind, error child, `nodeFor` for SSH roots |
| `src/agentTree.ts` | SSH env node, visibility, ordering, contextValues, snapshot groups |
| `src/windowRegistry.ts` | `ssh` `PublishedGroup`, `SNAPSHOT_VERSION` 5 |
| `src/extension.ts` | Settings, provider, watchers, SSH terminals, host-terminal exclusions, attach/stop/delete/focus/close, Add Agent, Add SSH Host, terminal links, restore, workspace-folder guard |
| `src/test/sshFs.test.ts` | **New.** Quoting, allowlist, argv, terminal command, errors, settings; gated live suite |
| `src/test/sshConfig.test.ts` | **New.** Config parsing |
| `src/test/remoteShell.test.ts` | **New.** Docker runner argv matches the pre-refactor argv |
| `src/test/agents.test.ts` | SSH env cases |
| `src/test/windowRegistry.test.ts` | `ssh` groups |
| `src/test/terminalAgents.test.ts` | Call sites updated for the runner |
| `src/test/containerTree.test.ts` | SSH roots and error child against fakes |
| `package.json` | Settings, view name, command titles, `addSshHost`, menus, activation event |
| `README.md` | SSH section (purpose, settings, Add SSH Host, host key, shell-init caveat, GNU coreutils + procps on the remote, forced forwarding off, never a workspace folder); settings and commands tables |
| `CHANGELOG.md` | Entry |
| `.plans/PLAN.md` | Status entry and phase row |

## Not in this plan

- Starting, stopping, provisioning or deleting the VM itself (no `devc up` / `stop` / `down` equivalent).
- Renaming the "Dev Containers" view or rebranding environments (e.g. "Sandboxes").
- An "Open Folder in SSH Host" for host folders: host paths don't map to remote paths.
- A per-workspace root on a shared host (one `root` per host).
- Watching remote file changes (`watch()` stays a no-op; refresh is manual, as for containers).
- Password or keyboard-interactive auth for FS and herdr calls (`BatchMode=yes`; keys only). Terminals can prompt.
- Windows host support (`os.tmpdir()` control sockets and `process.getuid()` assume macOS/Linux).
