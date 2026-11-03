# Remote Files: a new extension for browsing dev container and SSH files

Requested by the user on 2026-11-03. A new, self-contained extension at
`extensions/remote-files-vscode/` with one Explorer tree whose roots are running dev containers
and configured SSH hosts. You can browse, open, create, rename, delete, drag-and-drop files and
open a terminal at any folder. This is one step in splitting devc-vscode into smaller extensions.

Decided with the user:

- **In scope:** browsing, file operations (new file / folder, rename, delete, copy path,
  drag-and-drop), **Add SSH Host…**, **Terminal Here**.
- **Out of scope:** Send / Fetch workspace sync, agents, herdr, devc web, Copy Host Container
  Path, Open Folder in Container.
- **devc-vscode stays as it is.** Its Sandboxes tree and `devc-vscode` / `devc-ssh` providers are
  not touched. Removing them is a later plan.
- **herdr-vscode stays as it is.** It keeps its own `herdr-container` / `herdr-ssh` providers.
- **SSH hosts come from the extension's own setting**, `remoteFiles.sshHosts`.

Like the other extensions (see the root `README.md`), this one shares nothing at build time. Code
is **copied** in, with a header comment naming where it came from:

```ts
// Ported from <extension>/src/<file>.ts at <short sha of HEAD when ported>; maintained separately.
```

Sources:

| New file | Ported from | Notes |
| --- | --- | --- |
| `src/remoteFs.ts` | `herdr-vscode/src/remoteFs.ts` | `CoreutilsFileSystemProvider`, the container and SSH providers, `ChangePoller`. The herdr copy is the newest (authority checks, `whenKnown`, polling); start from it. |
| `src/remoteShell.ts` | `herdr-vscode/src/remoteShell.ts` | `RemoteShell`, `DockerShell`, `SshShell`, `sshFailure`, `SSH_SAFETY_OPTIONS`, `controlOptions`, `ensureControlDir`, `shQuote`. Drop `LocalShell` and anything else nothing here uses. |
| `src/docker.ts` | `devc-vscode/src/docker.ts` | `execDocker`. |
| `src/sshHosts.ts` | `devc-vscode/src/sshFs.ts` | `SshHostInfo`, `HOST_PATTERN`, `parseSshHosts` only. No `vscode` import. |
| `src/sshConfig.ts` | `devc-vscode/src/sshConfig.ts` | `sshConfigAliases`; import `HOST_PATTERN` from `./sshHosts`. |
| `src/tree.ts` | `devc-vscode/src/containerTree.ts` | The tree and drag-and-drop, minus everything sync-related (`SyncTargetSource`, `sync` on nodes, `directory.sync` / `directory.fetch`) and minus the attached-terminal state. |
| `src/containers.ts` | `devc-vscode/src/containerTree.ts` + `herdr.ts` | Container discovery (`listLabelledDevContainers`, `rootLabel`, `DockerContainerSource`) and the remote user (`getRemoteUser`, `remoteUserFromMetadata`). |
| `src/terminals.ts` | new | Terminal Here argv builders (no `vscode` import). |
| `src/extension.ts` | new, logic from `devc-vscode/src/extension.ts` | Activation, commands, settings, docker events, workspace-folder guard. |

## Checklist

- [ ] 1. Scaffold `extensions/remote-files-vscode/` from `workspace-folders-vscode` (tsc build, not esbuild): `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `.vscode-test.mjs`, `.vscode/`, `.vscodeignore`, `.npmrc`, `.nvmrc`, `LICENSE`, `README.md`, `CHANGELOG.md`
- [ ] 2. Port `remoteShell.ts`, `docker.ts`, `sshHosts.ts`, `sshConfig.ts` with their tests
- [ ] 3. Port `remoteFs.ts` (providers + `ChangePoller`) with the new schemes and messages; port its tests
- [ ] 4. `containers.ts`: discovery with the `remoteFiles.containers` scope, remote user lookup
- [ ] 5. `tree.ts`: roots, children, Show All Files, `getParent`, drag-and-drop; port the tree tests
- [ ] 6. Commands: Refresh, Show All Files / Show Only /workspaces, New File, New Folder, Rename, Delete, Copy Path, Add SSH Host…, Terminal Here; menus and keybindings
- [ ] 7. `terminals.ts` + Terminal Here, with tests for the argv builders
- [ ] 8. Live refresh: docker events, workspace folder changes, settings changes
- [ ] 9. Workspace-folder guard for both schemes
- [ ] 10. Docs: extension `README.md`, `CHANGELOG.md`, root `README.md` bullet
- [ ] 11. Validation (below)

## Contracts

### Manifest

- `name`: `remote-files-vscode`; `displayName`: `Remote Files`; `publisher`: `devc-tools`;
  `version`: `0.0.1`; `engines.vscode`: `^1.138.0`; `repository` as in the other extensions.
- `description`: `Browse and edit files in running dev containers and on SSH hosts from an Explorer view.`
- `activationEvents`: `["onFileSystem:remotefs-container", "onFileSystem:remotefs-ssh"]`. The view
  and commands activate the extension implicitly.
- Command category for every command: `Remote Files`.

### URI schemes

| Scheme | Authority | Path | Query |
| --- | --- | --- | --- |
| `remotefs-container` | first 12 chars of the container id | absolute path in the container | `{"label":"<root label>"}` (JSON), for the label formatter only; providers ignore it |
| `remotefs-ssh` | the `~/.ssh/config` alias as configured | absolute remote path | none |

Both are registered with `{ isCaseSensitive: true }`.

**Gotcha:** `Uri.toString()` lower-cases the authority. SSH host lookups compare
case-insensitively, as `herdr-vscode`'s do. Container ids are already lower-case hex.

`contributes.resourceLabelFormatters`:

```json
[
  { "scheme": "remotefs-container", "formatting": { "label": "container: ${query.label} › ${path}", "separator": "/" } },
  { "scheme": "remotefs-ssh", "formatting": { "label": "ssh: ${authority} › ${path}", "separator": "/" } }
]
```

Provider behaviour is the herdr port, with these messages:

- **Container provider:** the authority must be a container the discovery in
  [Containers](#containers) currently lists. Any other authority throws
  `FileSystemError.Unavailable('Not a running dev container')` before anything is spawned.
  `whenKnown` waits for the first discovery to settle. The shell is a `DockerShell` as the
  container's remote user (from the `devcontainer.metadata` label, else Docker's default user).
  Cache the user per container id until that container's next `stop` / `die` / `destroy` event.
- **SSH provider:** the authority must be a host in `remoteFiles.sshHosts`, compared
  case-insensitively. Any other authority throws
  `FileSystemError.Unavailable('SSH host is not in remoteFiles.sshHosts')` before anything is
  spawned. ssh's own failures (exit 255) map through `sshFailure` to `Unavailable`.
- **`ChangePoller`:** polls both schemes every 5 s, as in herdr-vscode.

### Settings

All `"scope": "application"`, so a workspace folder can't redirect them.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `remoteFiles.sshHosts` | array of `{ host, root?, label? }` | `[]` | Same JSON schema as `devc-vscode.sshHosts` (`host` pattern `^[A-Za-z0-9][A-Za-z0-9._-]*$`, `root` pattern `^/`). Description: `SSH hosts shown in Remote Files. \`host\` is an alias from \`~/.ssh/config\`; \`root\` is the absolute remote directory the tree starts at (default: the remote home); \`label\` is shown instead of the host. Use **Add SSH Host…** to pick from \`~/.ssh/config\`.` (as `markdownDescription`). |
| `remoteFiles.sshPath` | string | `"ssh"` | ssh client: a name on PATH or an absolute path. Blank means `ssh`. |
| `remoteFiles.dockerPath` | string | `"docker"` | Docker CLI: a name on PATH or an absolute path. Blank means `docker`. |
| `remoteFiles.containers` | enum `"workspace"`, `"all"` | `"workspace"` | Which running dev containers are roots. See [Containers](#containers). `enumDescriptions`: `Dev containers whose project folder is an open workspace folder or under one.` / `Every running dev container.` |

Invalid `sshHosts` entries (whatever `parseSshHosts` puts in `invalid`) are skipped, and each one
gets `showWarningMessage('remoteFiles.sshHosts: ignoring invalid entry "<host>"')` once per
session.

The SSH control directory is `/tmp/rfs-<uid>`, created and checked as `ensureControlDir` does
(mode `0700`, owned by the user, length ≤ `MAX_CONTROL_DIR_LENGTH`). If it's unusable, ssh runs
without multiplexing.

### Containers

A dev container is a running container with a `devcontainer.local_folder` label. List them with:

```
docker ps --filter label=devcontainer.local_folder --format '{{.ID}}\t{{.Names}}\t{{.Label "devcontainer.local_folder"}}'
```

Split each line on `\t`. Skip lines with fewer than 3 fields or an empty id or folder. `.ID` is
already the 12-char short id.

- **`workspace` (default):** as devc-vscode's `DockerContainerSource`. A container is a root when
  its `local_folder` is a `file:` workspace folder or under one. The most specific folder wins,
  and the label is `rootLabel(owner, localFolder)`. With no `file:` workspace folders there are no
  container roots.
- **`all`:** every dev container. The label is `basename(localFolder)`. Two containers with the
  same label both get the Docker name appended in the description (description rules below
  already show it when it differs).
- Order: by label, then by Docker name.
- If Docker can't be run at all (spawn error or non-zero exit), there are no container roots. SSH
  roots still list. Don't show an error.

### The view

- `contributes.views.explorer`: `{ "id": "remoteFiles.tree", "name": "Remote Files" }`.
- `createTreeView('remoteFiles.tree', { treeDataProvider, dragAndDropController, canSelectMany: true, showCollapseAll: true })`.
- `dropMimeTypes`: `['text/uri-list', 'application/vnd.code.tree.remotefiles.tree']`.
  **Gotcha:** VS Code lower-cases the view id when it builds the tree mime type. A
  `remoteFiles.tree` spelling makes internal drags drop silently.
  `dragMimeTypes`: `['text/uri-list']`.
- `viewsWelcome` for `remoteFiles.tree` with `when: "true"`, shown when there are no roots:

  ```
  No running dev containers or SSH hosts.
  [Add SSH Host…](command:remoteFiles.addSshHost)
  ```

Roots: container roots first (in the order above), then SSH roots in settings order.

| Row | `label` | `description` | `iconPath` | `contextValue` | `id` | `tooltip` |
| --- | --- | --- | --- | --- | --- | --- |
| Container root | root label | Docker name when it differs from the label, else the 12-char id | `ThemeIcon('vm-running')` | `container` | `container:<id>` | `<Docker name> — <localFolder>` |
| SSH root | `label` (default: host) | the effective root once known, else `~` | `ThemeIcon('remote')` | `sshHost` | `sshHost:<host>` | `SSH host <host>` |
| SSH error (only child of an unreachable SSH root) | `Cannot reach <host>` | — | `ThemeIcon('error')` | `sshError` | `sshError:<host>` | the error message |
| Directory | from `resourceUri` | — | file icon theme | `directory` | `uri.toString()` | — |
| File | from `resourceUri` | — | file icon theme | `file` | `uri.toString()` | — |

- Roots have no `resourceUri`, so the icon theme doesn't paint a folder over them.
- Opening a file row runs `vscode.open` with its URI.
- Children are sorted directories first, then case-insensitively by name (`sortEntries`).
- **Container roots** list `/`. With Show All Files off they list only `/workspaces` when it
  exists, otherwise all of `/` (as devc-vscode does). If a container stops mid-expand, the list
  is empty and there's no toast.
- **SSH roots** list the host's effective root: the configured `root`, else the remote home from
  `ssh <host> sh -c 'printf %s "$HOME"'`, cached per host until Refresh or a `sshHosts` change. A
  failure on the root itself shows the SSH error row.
- **`getParent`** stops at the root, so `TreeView.reveal` works. An SSH path at or above the
  effective root has the SSH root as its parent.
- **Show All Files**: stored in `workspaceState` under `showAllFiles` (default `false`) and
  mirrored to the context key `remoteFiles.showAllFiles`.

### Commands

| Command | Title | Icon | Where | Behaviour |
| --- | --- | --- | --- | --- |
| `remoteFiles.refresh` | Refresh | `$(refresh)` | `view/title` navigation | Clears cached roots, SSH homes and remote users; re-lists. |
| `remoteFiles.showAllFiles` | Show All Files | `$(filter-filled)` | `view/title` navigation, `when: !remoteFiles.showAllFiles` | Container roots list `/`. |
| `remoteFiles.showWorkspacesOnly` | Show Only /workspaces | `$(filter)` | `view/title` navigation, `when: remoteFiles.showAllFiles` | Back to `/workspaces`. |
| `remoteFiles.addSshHost` | Add SSH Host… | `$(add)` | `view/title` navigation | See below. |
| `remoteFiles.terminalHere` | Terminal Here | `$(terminal)` | `view/item/context` inline on roots, and group `4_terminal` on roots, directories and files | See [Terminal Here](#terminal-here). |
| `remoteFiles.newFile` | New File… | — | `view/item/context` `1_new` on roots and directories | Input box `New file in <dir>`; creates an empty file, refreshes the parent, opens it. |
| `remoteFiles.newFolder` | New Folder… | — | `1_new@2`, same rows | Input box `New folder in <dir>`; creates the folder, refreshes. |
| `remoteFiles.rename` | Rename… | — | `2_edit` on directories and files | Input box prefilled with the name, base name selected; `rename(…, { overwrite: false })`. |
| `remoteFiles.delete` | Delete | — | `2_edit@2` on directories and files | Acts on the selection when the clicked row is in it, else on that row alone. Modal: `Delete '<name>'? This cannot be undone — there is no trash.` (or `Delete <n> items? …`), button `Delete`. Recursive. |
| `remoteFiles.copyPath` | Copy Path | — | `3_copy` on everything but `sshError` | Copies the path part (for an SSH root, its effective root). |

- `view/item/context` `when` clauses use `view == remoteFiles.tree && viewItem =~ /…/` with the
  `contextValue`s above.
- **Name validation** for new file, new folder and rename: not blank, no `/`, not `.` or `..`.
  Messages: `Name cannot be empty`, `Name cannot contain "/"`, `Invalid name`.
- **Errors** from file operations: `showErrorMessage('Could not <create|rename|delete> <name>: <message>')`.
- **Keybindings:** `f2` → `remoteFiles.rename` and `delete` → `remoteFiles.delete`, both
  `when: "focusedView == remoteFiles.tree && !inputFocus"`.
- **Command palette:** called without a node, commands act on `treeView.selection[0]`. With
  nothing selected, `showErrorMessage('Select a file or folder in Remote Files first.')`. Hide
  the node-only commands (`terminalHere`, `newFile`, `newFolder`, `rename`, `delete`,
  `copyPath`) from the palette with `commandPalette` `when: "false"`.

**Add SSH Host…**:

1. Quick pick of `sshConfigAliases()` minus hosts already in `remoteFiles.sshHosts`
   (case-insensitive), placeholder `SSH host to add`. With none left:
   `showInformationMessage('No other hosts found in ~/.ssh/config.')`.
2. Input box `Remote directory to start in (blank for the remote home)`. A non-blank value that
   doesn't start with `/` fails validation with `Enter an absolute path, or leave it blank`.
   Escape cancels.
3. Append `{ host }` or `{ host, root }` to `inspect('sshHosts')?.globalValue ?? []` and write it
   with `ConfigurationTarget.Global`.

   **Gotcha:** don't build on `get()`, which folds in the default.

### Drag and drop

Port `handleDrag` / `handleDrop` / `copyInto` / `clearDestination` as they are, with
`SCHEME`/`SSH_SCHEME` replaced by the two new schemes:

- A drop on a file lands in that file's directory. A drop on an SSH root lands in its effective
  root. A drop on `sshError` does nothing.
- **Same scheme and authority:** a move (`rename` with `overwrite: true`). Moving a folder into
  itself or its own subtree is skipped.
- **Anything else** (another root, a local `file:` URI from the Explorer, another extension's
  scheme): a recursive copy through `workspace.fs`.

  **Gotcha:** `workspace.fs.copy` can't cross providers, so walk the tree by hand.
- If the destination exists: modal `<name> already exists. Overwrite?`, button `Overwrite`. A yes
  deletes the destination recursively first.
- Dragging rows out of the tree sets `text/uri-list` (CRLF-joined URIs).

### Terminal Here

The command opens a terminal running in the folder: the row's folder, a file's parent, or a
root's base directory. It goes in the panel (the default location) and is never reused.

- **Name:** `<root label>: <basename of the folder>` (just the root label when the folder is `/`).
- `createTerminal({ name, shellPath, shellArgs, iconPath })`. Use argv, not a host shell, so
  nothing on the local side needs quoting.
- **Container:** `shellPath` is the docker command. `shellArgs`:

  ```
  ['exec', '-it', ...(user ? ['-u', user] : []), '-w', <dir>, <12-char id>, 'sh', '-c',
   's=$(getent passwd "$(id -u)" | cut -d: -f7); exec "${s:-sh}" -l']
  ```

  `iconPath`: `ThemeIcon('vm-running')`.
- **SSH:** `shellPath` is the ssh command. `shellArgs`:

  ```
  ['-t', ...SSH_SAFETY_OPTIONS, ...controlOptions(controlDir), '--', <host>,
   `cd ${shQuote(dir)} && exec "\${SHELL:-sh}" -l`]
  ```

  `iconPath`: `ThemeIcon('remote')`. The host is checked against `remoteFiles.sshHosts` first. An
  unconfigured host shows an error and opens nothing.
- **SSH root before its effective root is known:** resolve it first (as the tree does). If it
  fails, `showErrorMessage(<message>)` and open nothing.
- Put the argv builders in `src/terminals.ts` with no `vscode` import, as
  `containerTerminalArgs(user, dir, id)` / `sshTerminalArgs(host, dir, controlDir)` or similar.

### Live refresh

- **Docker events:** port devc-vscode's `startDockerEventsWatcher` (`docker events --filter
  type=container --filter event=start --filter event=stop --filter event=die --filter
  event=destroy --format '{{json .}}'`). Each event refreshes the roots, debounced 500 ms.
  Restart the watcher when `remoteFiles.dockerPath` changes. Kill it in `deactivate`. If spawning
  fails, just log it to the console.
- **`onDidChangeWorkspaceFolders`:** refresh the roots (the `workspace` scope depends on them) and
  run the guard.
- **`onDidChangeConfiguration`** for `remoteFiles.sshHosts`, `remoteFiles.sshPath`,
  `remoteFiles.containers`: clear SSH homes and refresh the roots.

### Workspace-folder guard

Port `guardWorkspaceFolders` for both schemes: `remotefs-container` and `remotefs-ssh` folders
aren't allowed as workspace folders, because VS Code would read their `.vscode/settings.json`.
Run it on activation and on every `onDidChangeWorkspaceFolders`.

- **When such a folder is one of several:** remove it, highest index first, one per event, as the
  original does. Then
  `showWarningMessage('Remote files can\'t be workspace folders — use the Remote Files view instead.')`.
- **When it's the only folder:** modal
  `showErrorMessage('This window has a remote folder as its workspace. Close it and browse from the Remote Files view.')`.
  Then both providers refuse every call with `FileSystemError.NoPermissions('Remote Files is
  disabled in this window')` until the window is reloaded.

### Docs

- **`README.md` (extension):** what it shows, the settings table, the commands, Terminal Here,
  and the note that devc-vscode's Sandboxes view and herdr-vscode's providers are separate and
  unaffected.
- **`CHANGELOG.md`:** `## 0.0.1` with a one-paragraph summary.
- **Root `README.md`:** change "Three separate VS Code extensions" to "Four", and add a bullet
  after workspace-folders:
  `` [`extensions/remote-files-vscode/`](extensions/remote-files-vscode/README.md): browse and edit files in running dev containers and on SSH hosts. ``

## Validation

Run from `extensions/remote-files-vscode/`.

- [ ] `npm ci && npm run compile && npm run lint` pass with no errors.
- [ ] `npx mocha --ui tdd out/test/sshHosts.test.js out/test/sshConfig.test.js out/test/terminals.test.js out/test/remoteShell.test.js` passes. These modules import no `vscode`. The tests cover:
  - `parseSshHosts`: valid entries, bad host, relative root, duplicate (case-insensitive), label trimming.
  - `sshConfigAliases`: `Include`, wildcards skipped.
  - The container terminal args with and without a user.
  - The SSH terminal args: safety options, control options present or absent, `shQuote` of a dir with a `'` in it.
  - `sshFailure` on exit 255.
- [ ] `npm test` (vscode-test) passes. It includes the ported tests:
  - Tree tests: roots, `/workspaces` narrowing, `getParent` for both schemes, drop move vs copy, overwrite prompt, subtree refusal.
  - `remoteFs` tests: unknown authority refused without spawning, `whenKnown`, `ChangePoller`.
  - Discovery tests on fake `docker ps` output for both `remoteFiles.containers` values.
- [ ] `grep -rn "devc-vscode\.\|herdr\.\|devc-ssh\|herdr-ssh\|herdr-container" src package.json` prints only the `// Ported from` header lines. No command, setting, scheme or context key from another extension is used.
- [ ] `node -e 'const c=require("./package.json").contributes; const ids=new Set(c.commands.map(x=>x.command)); for (const m of Object.values(c.menus).flat()) if(!ids.has(m.command)) throw m.command; console.log("ok")'` prints `ok`.
- [ ] `git diff --stat -- ../devc-vscode ../herdr-vscode` is empty.
- [ ] In VS Code (left to the user): with a running dev container and one reachable SSH host
  configured, both roots show, alongside devc-vscode's Sandboxes view if it is installed.
  - Opening, editing and saving a file works over both schemes.
  - New file, rename (F2) and delete (Del) work.
  - Dragging a local file in copies it; dragging between folders on one root moves it.
  - Terminal Here opens a shell in the right folder on each.
  - Stopping the container removes its root within a few seconds.
  - An unreachable host shows `Cannot reach <host>`.

## Relevant Files

- `extensions/remote-files-vscode/package.json` (new)
- `extensions/remote-files-vscode/package-lock.json` (new)
- `extensions/remote-files-vscode/tsconfig.json` (new)
- `extensions/remote-files-vscode/eslint.config.mjs` (new)
- `extensions/remote-files-vscode/.vscode-test.mjs` (new)
- `extensions/remote-files-vscode/.vscode/launch.json`, `.vscode/tasks.json` (new, copied from workspace-folders-vscode)
- `extensions/remote-files-vscode/.vscodeignore`, `.npmrc`, `.nvmrc`, `LICENSE` (new, copied)
- `extensions/remote-files-vscode/README.md` (new)
- `extensions/remote-files-vscode/CHANGELOG.md` (new)
- `extensions/remote-files-vscode/src/extension.ts` (new)
- `extensions/remote-files-vscode/src/remoteFs.ts` (new)
- `extensions/remote-files-vscode/src/remoteShell.ts` (new)
- `extensions/remote-files-vscode/src/docker.ts` (new)
- `extensions/remote-files-vscode/src/sshHosts.ts` (new)
- `extensions/remote-files-vscode/src/sshConfig.ts` (new)
- `extensions/remote-files-vscode/src/containers.ts` (new)
- `extensions/remote-files-vscode/src/tree.ts` (new)
- `extensions/remote-files-vscode/src/terminals.ts` (new)
- `extensions/remote-files-vscode/src/test/sshHosts.test.ts`, `sshConfig.test.ts`, `terminals.test.ts`, `remoteShell.test.ts`, `remoteFs.test.ts`, `tree.test.ts`, `containers.test.ts` (new; ported from `devc-vscode/src/test/{sshFs,sshConfig,remoteShell,containerTree}.test.ts` and `herdr-vscode/src/test/remoteFs.test.ts`, plus fixtures they need)
- `README.md` (root: extension list)
- `.plans/PLAN.md`
- Read only (sources to port): `extensions/herdr-vscode/src/remoteFs.ts`, `extensions/herdr-vscode/src/remoteShell.ts`, `extensions/devc-vscode/src/{sshFs,sshConfig,containerTree,docker,herdr,extension}.ts`, `extensions/workspace-folders-vscode/` (scaffold)
