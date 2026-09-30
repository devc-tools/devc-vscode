# Optional Tool Detection

The extension should work with any subset of its external tools. Each command and UI entry is
offered only when the tools it needs are present:

- **devc + Docker, no host herdr:** full dev container support, with no host agent features.
- **SSH only (no Docker, devc or host herdr):** full SSH host support.
- **Docker without devc:** container files, links and terminals, with a `docker exec` terminal in
  place of `devc herdr`.

Today, host herdr, container herdr and SSH herdr already degrade when missing. The gaps are:

- A missing Docker CLI empties the whole Sandboxes view, SSH roots included.
- Add Agent offers the host without herdr.
- Every devc-backed action is always offered.

## Tool matrix (reference)

| Feature | Needs |
| --- | --- |
| Container roots, files, links | Docker CLI |
| Container Attach Terminal, Open Folder in Container | `openFolderCommand` (default `devc herdr`); Attach Terminal falls back to `docker exec` |
| Container focus without a terminal, Add Agent in a container | `herdrAttachCommand` (default `devc herdr`), or the `docker exec` fallback on a running container; herdr in the container |
| Stop / Down Container | `stopCommand` / `downCommand` (default `devc stop` / `devc down`) |
| Host sessions, host terminal agents, Add Agent → host | host herdr |
| SSH roots, files, terminals, links | ssh |
| Send / Fetch | ssh, local git, remote git, a configured SSH host |
| SSH agents | ssh, herdr on the remote (already per host) |

## Contract

### Detection

A new module runs the checks below. It runs them on activation, on `devc-vscode.refresh`, when
any of these settings change, and when the window gains focus (at most once per 30 s):

- `devc-vscode.dockerPath`
- `devc-vscode.openFolderCommand`
- `devc-vscode.herdrAttachCommand`
- `devc-vscode.stopCommand`
- `devc-vscode.downCommand`
- `devc-vscode.sshHosts`

Each check has a 5000 ms timeout.

- **Docker:** `cp.execFile(<dockerPath>, ['--version'])`. Present only when it exits 0. A spawn
  error (`ENOENT`, `EACCES`), a timeout or a non-zero exit all count as absent. A stopped daemon
  still counts as present, because `--version` does not contact the daemon.
- **Host herdr:** false unless `hostHerdrSupported()`. Otherwise run
  `cp.execFile('herdr', ['--version'], { env: herdrEnv(undefined) })`. Present only when it exits 0.
- **devc found:** true when an executable file named `devc` exists in `~/.local/bin` or in any
  entry of `process.env.PATH`, checked in that order with `fs.promises.access(p, fs.constants.X_OK)`.
  On `win32`, look for `devc.exe` and `devc.cmd` instead of `devc`. Do not spawn a shell.
- **Command available:** worked out separately for each of the four command settings. A setting
  counts as user-set when `getConfiguration('devc-vscode').inspect(key)` has a `globalValue`,
  `workspaceValue` or `workspaceFolderValue` that is a string with non-empty trimmed text.
  - **Gotcha:** `get()` cannot tell a user-set value from the default. Use `inspect()`.
  - An empty string is not user-set. That matches the existing getters, which fall back to the
    default when the value is empty.
  - Available = user-set, or devc found.

### Context keys

Set with `vscode.commands.executeCommand('setContext', key, value)` after every detection run.

| Key | Value |
| --- | --- |
| `devc-vscode.hasDocker` | Docker present |
| `devc-vscode.hasHostHerdr` | host herdr present |
| `devc-vscode.hasSshHosts` | `getSshHosts().length > 0` |
| `devc-vscode.canOpenFolder` | `openFolderCommand` available |
| `devc-vscode.canStop` | `stopCommand` available |
| `devc-vscode.canDown` | `downCommand` available |

`devc-vscode.hasSshHosts` gets its own key because a `when` clause on `config.devc-vscode.sshHosts`
is true for an empty array.

`herdrAttachCommand` availability is used only in code, so it has no key.

### `package.json` menus

Add these clauses to the existing `when` expressions (`&&` onto what is there):

| Command | Menu | Add |
| --- | --- | --- |
| `devc-vscode.openFolderInContainer` | `explorer/context` | `devc-vscode.canOpenFolder` |
| `devc-vscode.openFolderInContainer` | `commandPalette` (new entry) | `devc-vscode.canOpenFolder` |
| `devc-vscode.sendToSshHost`, `devc-vscode.fetchFromSshHost` | `explorer/context` | `devc-vscode.hasSshHosts` |
| `devc-vscode.sendToSshHost`, `devc-vscode.fetchFromSshHost` | `commandPalette` (new entries) | `devc-vscode.hasSshHosts` |
| `devc-vscode.stopContainer` | `view/item/context` | `devc-vscode.canStop` |
| `devc-vscode.downContainer` | `view/item/context` | `devc-vscode.canDown` |

Container **Attach Terminal** stays visible, because it has a fallback.

### Docker missing no longer empties the Sandboxes view

`DockerContainerSource.listRunning` (`src/containerTree.ts`) resolves `[]` when `execDocker`
rejects. That covers spawn failure and timeout. SSH roots then still list, and
`AgentTreeDataProvider.sync` stops rejecting.

### Container terminal fallback (`docker exec`)

When the relevant command is not available, the extension opens a container terminal running this
command instead. It is built by a new export next to `sshTerminalCommand` in `src/remoteShell.ts`:

```
<docker> exec -it [-u <remoteUser>] [-w <mountDest>] <containerId> sh -c '<script>'
```

- `<docker>` is `getDockerCommand()`.
- `<remoteUser>` comes from `getRemoteUser(containerId, docker)`. Omit `-u` when it is undefined.
- `<mountDest>` is `findMatchingBindMount(containerId, hostFolder, docker)?.destPath`. Omit `-w`
  when it is undefined.
- Every word goes through `hostShellWord`: left bare when safe, otherwise `shQuote`d, the same as `sshTerminalCommand`.
- `<script>` is exactly:

  ```
  PATH="$HOME/.local/bin:$PATH"; if command -v herdr >/dev/null 2>&1; then exec herdr --session=devc; else s=$(getent passwd "$(id -u)" | cut -d: -f7); exec "${s:-sh}" -l; fi
  ```

  `devc` is `CONTAINER_SESSION`. `$SHELL` is usually unset under `docker exec`, which is why the
  login shell is read from passwd.

The terminal is opened by `openContainerTerminal`: name `devcontainer`, cwd set to the host
folder. Container lookup, terminal links and agent detection therefore work unchanged.

Where the fallback applies:

| Call site | Rule |
| --- | --- |
| `attachTerminal` (Sandboxes container root) | `openFolderCommand` available → send it, as today. Otherwise → fallback. |
| `attachAgentGroup` (container row) and `focusAgent` (container herdr agent, no terminal) | `herdrAttachCommand` available → send it, as today. Otherwise → fallback. |
| `launchInContainer` | `herdrAttachCommand` available → as today. Otherwise, if a running container serves the folder → fallback. Otherwise → return the error `devc not found — install devc or set devc-vscode.herdrAttachCommand` right away, without waiting out `CONTAINER_START_TIMEOUT_MS`. |
| `openFolderInContainer` | Unchanged. Its menu is hidden when not available. |

**Terminal restore gotcha:** `restoreTerminals` replays the saved `command`. A saved fallback
command names a container id that goes stale when the container is recreated. So save fallback
terminals with a marker instead of the command, and rebuild the command for the container
`findContainerForHostFolder` finds at restore time.

### Add Agent picker (`pickLaunchTarget`)

- **Host entry:** shown only when `workspaceSessionName() !== undefined` **and** host herdr is present.
- **Container folder entry:** shown only when Docker is present **and** either:
  - `herdrAttachCommand` is available, or
  - `agentTree.containerFor(folder)` is defined.
- **SSH entries:** unchanged.

When nothing is left, the existing "There is nowhere to start an agent." error is shown.

### Workspace row tooltip (Agents view)

The Workspace root always exists, so `viewsWelcome` would never show. Instead, the Workspace
row's tooltip adds one line for each missing tool, after `Agents in this VS Code window`, in this
order:

- When `hostHerdrSupported()` and host herdr is absent: `Install herdr to run agents on this machine.`
- When Docker is absent: `Install Docker, or set devc-vscode.dockerPath, to use dev containers.`

`AgentTreeDataProvider` gets a setter for the detection result and fires a change when it differs.

### Settings descriptions (`package.json`)

- `openFolderCommand`: append `Without devc on PATH and with this setting unset, Attach Terminal opens a docker exec shell instead, attached to the container's herdr when it has one.`
- `herdrAttachCommand`: append `Without devc on PATH and with this setting unset, a running container gets a docker exec shell attached to its herdr instead.`
- `stopCommand` / `downCommand`: append `The action shows when devc is on PATH or this setting is set.`

## Checklist

- [x] Detection module: Docker, host herdr, devc lookup, per-command availability, with the re-run triggers and 30 s focus throttle
- [x] Context keys set after every detection run
- [x] `package.json` `when` clauses and new `commandPalette` entries
- [x] `DockerContainerSource.listRunning` resolves `[]` when Docker cannot be run
- [x] `docker exec` fallback command builder in `src/remoteShell.ts`
- [x] Fallback wired into `attachTerminal`, `attachAgentGroup`, `focusAgent`, `launchInContainer`
- [x] Terminal restore rebuilds fallback commands for the current container
- [x] `pickLaunchTarget` host and container rules
- [x] Workspace row tooltip lines
- [x] Settings descriptions updated
- [x] README: Requirements section lists each tool and what it enables; Attach Terminal and Stop/Down text mention availability and the fallback
- [x] CHANGELOG `[Unreleased]` entries
- [x] Unit tests (see Validation)

## Validation

- [x] `npm run compile` and `npm run lint` pass
- [ ] `npm test` passes, including these new tests:
  - [x] `DockerContainerSource` with `dockerPath` `/nonexistent/docker` resolves `listRunning()` to `[]`
  - [x] `ContainerTreeDataProvider` built on that source still lists its SSH roots
  - [x] Fallback builder: with user `vscode` and dest `/workspaces/app`, the output equals `docker exec -it -u vscode -w /workspaces/app <id> sh -c '<script>'` with the script quoted exactly. With neither, the output has no `-u` and no `-w`.
  - [x] devc lookup: finds an executable `devc` in a temp dir on the PATH it is given; ignores a non-executable `devc`; checks `~/.local/bin` first
  - [x] Command availability: user-set non-empty → true without devc; user-set `""` → the same as unset; unset → matches devc found
- [ ] Manual, devc + Docker, `herdr` renamed off PATH: Add Agent lists no host entry; Stop/Down and Open Folder in Container show; the Workspace tooltip has the herdr line
- [ ] Manual, no Docker (`dockerPath` set to `/nonexistent/docker`), one SSH host configured: the Sandboxes view lists the SSH root and browses it; Send/Fetch show in the Explorer menu; the Workspace tooltip has the Docker line
- [ ] Manual, Docker without devc (`devc` renamed off PATH, command settings unset): Stop/Down and Open Folder in Container are hidden; container Attach Terminal opens a `docker exec` terminal in the mount dest, attached to herdr when the container has it, else a login shell; terminal links in it resolve; reloading the window restores it
- [ ] Manual, same as above but with `stopCommand` set to `docker stop <id>`: Stop Container shows and runs it
- [ ] Manual, no SSH hosts configured: Send/Fetch are absent from the Explorer menu and the command palette

## Relevant Files

- `src/tools.ts` (new): detection
- `src/test/tools.test.ts` (new)
- `src/extension.ts`: activation wiring, context keys, fallback call sites, `pickLaunchTarget`, `restoreTerminals`, saved terminal type
- `src/containerTree.ts`: `DockerContainerSource.listRunning`
- `src/hostHerdr.ts`: `hostHerdrInstalled` (the host herdr check, next to `runHerdr`)
- `src/remoteShell.ts`: fallback command builder
- `src/agentTree.ts`: Workspace row tooltip and detection setter
- `src/test/containerTree.test.ts`
- `src/test/remoteShell.test.ts`
- `package.json`: menus, command palette, settings descriptions
- `README.md`
- `CHANGELOG.md`
