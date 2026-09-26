# SSH File Tree

Browse and edit files on an SSH host (primarily the agent sandbox VM from `devc-dev`'s
`agent-sandbox-vm` plan) from the **host** VS Code, with **no VS Code server on the remote** and
**no workspace folder** for it. Same shape as the Dev Containers tree: a `FileSystemProvider`
that shells out to coreutils, surfaced by a contributed Explorer `TreeView` — with `ssh <host>`
in place of `docker exec <container>`.

**Depends on** [explorer-tree-view.md](explorer-tree-view.md) (phase 1): reuses its tree,
command, and drag-and-drop patterns. Its code is in; only its host-only validation is open.

## Why this shape

Measured in `devc-dev` (`docs/agent-sandbox-vm-findings.md` once plan 21 lands; T-2..T-7): VS Code
**Remote-SSH** installs a server in the remote whose git askpass relay silently hands the host's
GitHub session to any process there, and remote Machine settings can re-enable it past any
host-side setting. Plain `ssh` carries none of that. This extension runs entirely on the host and
only ever spawns plain `ssh`, so the remote gets file operations and nothing else.

Keeping the remote out of the **workspace** matters separately: VS Code applies a workspace
folder's `.vscode/settings.json`, `tasks.json` and `launch.json` on the host. Files opened by URI
from a tree view contribute no configuration, so agent-written config is inert text.

## Decisions

**New scheme `devc-ssh`, URI `devc-ssh://<host>/<absolute path>`**, where `<host>` is an SSH
config alias (e.g. `agent-vm`). A separate scheme, not a second authority form of `devc-vscode`,
so the two providers never share URI parsing.

**Hosts come only from user settings.** `devc-vscode.sshHosts` and `devc-vscode.sshPath` are
`"scope": "application"` — user settings only, not overridable by a workspace. The provider
**rejects any URI whose authority is not a configured host** (`FileSystemError.NoPermissions`)
*before* spawning anything. Any `devc-ssh://` URI from anywhere (a link in a markdown file, a
terminal link, another extension) reaches the provider, and its authority becomes an `ssh`
argument — an unvalidated authority such as `-oProxyCommand=…` would be command execution on the
host.

**System `ssh`, not an SSH library.** It honours the user's `~/.ssh/config` (keys, `HostName`,
known hosts), and the extension forces the safety options on the command line, where they
override the config. Connections are multiplexed with `ControlMaster` so tree expansion does not
pay a handshake per `stat`.

**One coreutils implementation for both providers.** Extract the command logic of
`DevContainerFileSystemProvider` (the `stat`/`find`/`cat`/`sh -c 'cat > "$1"'`/`mkdir`/`rm`/
`rmdir`/`mv` invocations and the stderr → `FileSystemError` mapping) so Docker and SSH differ
only in how an argv is run. Do not copy-paste it. Docker behaviour must be byte-for-byte
unchanged.

**No workspace folders, and a guard that removes them.** Nothing in the extension ever calls
`updateWorkspaceFolders` to add a `devc-ssh` folder, and no command offers "Open Folder" for it.
The guard (below) is cleanup for a user who adds one by hand — it is **not** prevention: VS Code
may read that folder's configuration before the guard removes it.

**Error roots, not error dialogs.** An unreachable host still shows its root; expanding it shows
one child explaining why.

## Contract

### Settings

```json
"devc-vscode.sshHosts": {
  "type": "array",
  "scope": "application",
  "default": [],
  "items": {
    "type": "object",
    "required": ["host", "root"],
    "properties": {
      "host":  { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      "root":  { "type": "string", "pattern": "^/" },
      "label": { "type": "string" }
    }
  },
  "markdownDescription": "SSH hosts shown in the SSH Files view. `host` is an alias from `~/.ssh/config`; `root` is the absolute remote path the tree starts at. User settings only."
},
"devc-vscode.sshPath": {
  "type": "string",
  "scope": "application",
  "default": "ssh",
  "description": "ssh client used by the SSH Files view (a name on PATH or an absolute path). User settings only."
}
```

At read time, entries whose `host` fails the pattern or whose `root` is not absolute are dropped
and reported once per session with
`showWarningMessage('devc-vscode.sshHosts: ignoring invalid entry "<host>"')`. The JSON schema
`pattern` only produces editor squiggles; the runtime check is the enforcement.

Authority comparison is case-insensitive (lower-case both sides).

### ssh invocation (exact argv)

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

- `<remote command string>` is the coreutils argv with **every element single-quoted** and joined
  by spaces. Quote as `'` + s.replaceAll(`'`, `'\''`) + `'`.
  **Gotcha:** ssh does not pass an argv; it concatenates its trailing arguments into one string
  that the remote login shell parses. Unquoted, a filename like `a b` splits and `$(…)` executes
  (on the remote). `docker exec` has no such step, which is why the Docker provider never needed
  quoting. The `find -printf '%f\\0%y\\0'` format keeps its literal backslash-zero through quoting.
- `<controlDir>` = `path.join(os.tmpdir(), 'dcs')`, created with mode `0700`. Before use,
  `fs.lstatSync` must show a directory owned by `process.getuid()` with mode `0700`; otherwise omit
  the three `Control*` options (no multiplexing) and log once to the output channel.
  **Gotcha:** Unix socket paths are limited to 104 bytes on macOS. `%C` is a 40-char hash; the
  short `dcs` directory under `os.tmpdir()` (≈49 chars on macOS) keeps it under the limit. Do not
  put the socket under `context.globalStorageUri` — that path is far too long.
- Timeout: 30 s per operation; on timeout kill the child and throw `FileSystemError.Unavailable`.
- **Exit code 255 is ssh's own failure** (connection, auth, host key) → `FileSystemError.Unavailable`
  with the stderr text. If stderr contains `Host key verification failed`, the message is
  `<host>: unknown host key — run "ssh <host>" once in a terminal to accept it.` Any other
  non-zero exit goes through the shared stderr mapping.
- **Gotcha:** anything the remote shell's init prints to stdout corrupts `readFile`/`stat` output.
  Ubuntu's `.bashrc` returns early for non-interactive shells, so the default is safe; the README
  says to keep output out of shell init on the remote.

### View

```json
"views": {
  "explorer": [
    { "id": "devc-vscode.agents", "name": "Agents" },
    { "id": "devc-vscode.containers", "name": "Dev Containers" },
    { "id": "devc-vscode.sshFiles", "name": "SSH Files" }
  ]
}
```

- Roots: one per valid `sshHosts` entry, in settings order. `contextValue` `sshHost`, label
  `label ?? host`, `description` = `root`, `iconPath` `new vscode.ThemeIcon('remote')`,
  `id` `sshHost:<host>`. No `resourceUri` on roots (same reason as container roots).
- A root expands to `readDirectory(devc-ssh://<host><root>)`; below that, identical to the
  container tree: `contextValue` `directory` / `file`, directories first then case-insensitive,
  `id` = `uri.toString()`, `resourceUri` set, files open with `vscode.open`.
- If listing a root fails, its only child is a non-collapsible item with `contextValue`
  `sshError`, label `Cannot reach <host>`, `tooltip` = the error message, icon `ThemeIcon('error')`.
- Changing `devc-vscode.sshHosts` refreshes the whole view (`onDidChangeConfiguration`).

### Commands and menus

Reuse the existing commands; do not add SSH-specific copies. Each one must accept nodes from
either view:

| Command | Change |
| --- | --- |
| `devc-vscode.newFile`, `devc-vscode.newFolder` | also on `sshHost` and `directory` in `devc-vscode.sshFiles` |
| `devc-vscode.rename`, `devc-vscode.delete` | also on `directory` / `file` in `devc-vscode.sshFiles` |
| `devc-vscode.copyPath` | also in `devc-vscode.sshFiles`; copies the remote path (`uri.path`) |
| `devc-vscode.refresh` | also in `view/title` of `devc-vscode.sshFiles`; refreshes that view |

Menu `when` clauses and the `f2` / `delete` keybindings gain the `devc-vscode.sshFiles` view with
the matching `viewItem` values. Palette invocation falls back to the **focused** view's
selection.

### Drag and drop

`dropMimeTypes: ['text/uri-list', 'application/vnd.code.tree.devc-vscode.sshfiles']`,
`dragMimeTypes: ['text/uri-list']`. Same rules as the container tree: same authority → move;
any other source (other host, a container, `file://`) → copy via `readFile`/`writeFile`;
overwrite prompt unchanged.
**Gotcha:** the internal mime type is the view id **lower-cased** — `sshFiles` becomes `sshfiles`.

### Activation

`activationEvents` adds `"onFileSystem:devc-ssh"`. Register the provider with
`{ isCaseSensitive: true }`.

### Workspace-folder guard

On activation and on every `workspace.onDidChangeWorkspaceFolders`:

- If any workspace folder has scheme `devc-ssh` and the window has more than one folder, remove
  each such folder with `updateWorkspaceFolders(index, 1)`, highest index first, then
  `showWarningMessage('SSH folders cannot be workspace folders — use the SSH Files view instead.')`.
- If the window's **only** folder is `devc-ssh` (opened with `--folder-uri`), removal is not
  possible; show `showErrorMessage('This window has an SSH folder as its workspace. Close it and browse the host from the SSH Files view.', { modal: true })`
  and do not register the SSH tree view's commands in that window.
- **Gotcha:** removing folder 0 restarts the extension host. The guard runs again on activation
  and finds nothing, so this terminates.

### Tests

- `src/test/sshFs.test.ts`, **no ssh required** (must run and pass in a dev container):
  - quoting round-trip: for each of `a b`, `it's`, `$(touch /tmp/x)`, `` `id` ``, `a\nb`,
    `back\\slash`, `-rf`, `%f\\0%y\\0`, the quoted string passed to a local `sh -c 'printf %s …'`
    prints the original exactly;
  - authority allowlist: a configured host passes; an unconfigured host, an empty authority, and
    `-oProxyCommand=x` all throw `NoPermissions` **without spawning** (inject the spawner and
    assert it was not called);
  - the exact argv above for a sample host, with and without a usable control directory;
  - exit 255 → `Unavailable`; host-key stderr → the exact message;
  - settings parsing drops invalid entries.
- Live suite in the same file, skipped unless `DEVC_SSH_TEST_HOST` and `DEVC_SSH_TEST_ROOT` are
  set: `createDirectory`, `writeFile`, `readFile`, `stat`, `readDirectory`, `rename`, `delete` in a
  fresh `<root>/devc-ssh-test-<random>` directory, including a filename containing a space and a
  single quote; the directory is removed at the end.
- The existing Docker suites must still pass unchanged.

### README / CHANGELOG

README gains an **SSH Files** section: what it is for (browsing a sandbox VM without
Remote-SSH), the two settings with an example, that hosts must be in `~/.ssh/config` and their
host key accepted once, that it never opens remote folders as workspace folders (and why), the
shell-init stdout caveat, and the requirement for GNU coreutils/findutils on the remote.
CHANGELOG: an entry for the new view, scheme and settings.

## Checklist

- [ ] Extract the shared coreutils provider logic; `DevContainerFileSystemProvider` keeps its public behaviour
- [ ] ssh runner: argv builder, quoting, control-directory check, timeout, exit-255 mapping
- [ ] `devc-ssh` provider with the authority allowlist checked before any spawn
- [ ] `devc-vscode.sshHosts` / `devc-vscode.sshPath` settings with runtime validation
- [ ] `devc-vscode.sshFiles` view: roots, children, error child, config-change refresh
- [ ] Extend the six commands, menus and keybindings to the SSH view
- [ ] Drag and drop for the SSH view
- [ ] `onFileSystem:devc-ssh` activation
- [ ] Workspace-folder guard
- [ ] `src/test/sshFs.test.ts` (offline + gated live suite)
- [ ] README SSH Files section; CHANGELOG entry

## Validation

### In a dev container (no Docker, no ssh host required)

- [ ] `npm run compile` and `npm run lint` exit 0
- [ ] `xvfb-run -a npm test` exits 0; the offline `sshFs` tests are **passed, not skipped**; the live SSH suite reports skipped
- [ ] `grep -n "updateWorkspaceFolders" src/*.ts` shows calls only inside the guard (removal), never an addition
- [ ] `node -e 'const p=require("./package.json").contributes.configuration.properties; for (const k of ["devc-vscode.sshHosts","devc-vscode.sshPath"]) if (p[k].scope!=="application") process.exit(1)'` exits 0

### Host only (needs the agent sandbox VM, `Host agent-vm` in `~/.ssh/config`, host key accepted)

- [ ] `DEVC_SSH_TEST_HOST=agent-vm DEVC_SSH_TEST_ROOT=/home/ubuntu/work npm test` exits 0 with the live SSH suite **running**
- [ ] With `"devc-vscode.sshHosts": [{ "host": "agent-vm", "root": "/home/ubuntu/work" }]` in user settings, F5:
  - [ ] "SSH Files" shows `agent-vm` with description `/home/ubuntu/work`; expanding lists the VM's directories first; `vscode.workspace.workspaceFolders` is unchanged (Debug Console)
  - [ ] Open a file, edit, save; `ssh agent-vm cat <path>` shows the edit
  - [ ] New File / New Folder / F2 / Delete each visible in `ssh agent-vm ls`
  - [ ] Drag a host file from the native Explorer into the tree: copied to the VM
  - [ ] **No VS Code server was installed:** `ssh agent-vm 'test -f ~/.vscode-server && ! test -d ~/.vscode-server'` exits 0
  - [ ] **No credentials cross:** `ssh agent-vm '~/credtest.sh <private repo>'` still exits 0 after the above
  - [ ] Put the same setting in **workspace** settings only (remove it from user settings): the view shows no roots
  - [ ] Stop the VM (`multipass stop agent`), refresh: the root shows `Cannot reach agent-vm` with the ssh error as tooltip; start it, refresh: files return
  - [ ] From the Debug Console, `vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('devc-ssh://-oProxyCommand=touch%20%2Ftmp%2Fdevc-ssh-pwned/x'))`: fails with a permission error, and `ls /tmp/devc-ssh-pwned` on the host reports no such file
  - [ ] "Add Folder to Workspace…" with `devc-ssh://agent-vm/home/ubuntu/work` (Debug Console: `vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: vscode.Uri.parse('devc-ssh://agent-vm/home/ubuntu/work') })`): the folder is removed and the warning shown
  - [ ] **Formatter probe:** in the VM, `~/work/fmt-probe/` containing `x.js` and a `prettier.config.js` whose body is `require('fs').writeFileSync('/tmp/devc-ssh-prettier-marker', 'ran'); module.exports = {};`. With the Prettier extension installed and `editor.formatOnSave: true`, open `x.js` from the SSH tree, edit, save. `/tmp/devc-ssh-prettier-marker` must **not** exist on the host. If it does, record the extension and version in README § SSH Files as a known risk ("disable format-on-save for SSH files") and note it under this item.

## Relevant Files

| File | Change |
| --- | --- |
| `src/devcontainerFs.ts` | Shared coreutils logic extracted; Docker provider becomes a thin runner over it, behaviour unchanged |
| `src/sshFs.ts` | **New.** ssh runner (argv, quoting, control dir, timeout, errors) and the `devc-ssh` provider |
| `src/sshTree.ts` | **New.** `devc-vscode.sshFiles` tree data provider and drag-and-drop controller (share helpers with `containerTree.ts` where they fit) |
| `src/containerTree.ts` | Only if helpers (sorting, node shapes, drop resolution) are shared with `sshTree.ts` |
| `src/extension.ts` | Register provider and view; extend command handlers to SSH nodes; workspace-folder guard; config-change refresh |
| `src/test/sshFs.test.ts` | **New.** Offline tests + gated live suite |
| `package.json` | Settings, view, menus, keybindings, activation event |
| `README.md` | SSH Files section |
| `CHANGELOG.md` | Entry |
| `.plans/PLAN.md` | Status entry and phase row |

## Not in this plan

- Watching remote changes (`watch()` stays a no-op; refresh is manual, as for containers).
- A terminal to the host — use `ssh <host>` in a normal host terminal.
- Password or keyboard-interactive auth (`BatchMode=yes` forbids prompts; keys only).
- Windows host support (`os.tmpdir()` control sockets and `process.getuid()` assume macOS/Linux).
