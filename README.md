# Dev Container File Tree

Browse and edit files inside a running dev container from VS Code on the host — no remote server, no container attach. Files are read and written over `docker exec`.

## How it works

Registers a `devc-vscode://<container-id>/<path>` filesystem provider backed by `docker exec` (`stat`, `find`, `cat`, `mkdir`, `rm`, `mv`), and contributes a **Dev Containers** tree view into the Explorer panel.

The tree is scoped to the window's workspace by a single rule: a running dev container gets a root when its project folder — the devcontainer CLI's `devcontainer.local_folder` label — is an open host folder **or sits under one**. So a container started for a subfolder gets its own root alongside the workspace folder's, and no unrelated dev container on the machine can appear. Roots are labelled with the **host folder's basename**, or `basename/path/to/subfolder` for a container serving a subfolder; docker's generated container name is the subtitle.

Each root is the container's filesystem root, `/`. The workspace association decides *which* containers show up and what they are called; it does not narrow what you can browse, so `/etc` and `/usr` are a couple of clicks away just like the project directory.

`docker events` is watched live, so roots appear when a container starts and vanish when it stops. There is no way to add anything else to the tree: the rule above is the whole of it, so a window with no folder open shows nothing.

Nothing is added to your workspace. The tree is a view, not a workspace folder, so no window reload, no multi-root conversion, and no dead container roots restored after a reload. The extension never calls `updateWorkspaceFolders`.

File paths printed in a container terminal become clickable links. Clicking a *file* opens it, jumping to the line and column when the output carries a `:line:col` suffix; clicking a *folder* focuses the tree and reveals it.

Absolute paths always resolve. `~` resolves against the container user's `$HOME`. Relative paths resolve against the terminal's actual working directory inside the container: the terminal's own pty is identified in the container (the same one agent detection reads), and the working directory of its foreground process, or of its shell otherwise, is read from `/proc/<pid>/cwd`. That follows every `cd` with no shell integration in the container, a few seconds behind at most. Until the pty has been found, relative paths resolve against wherever the terminal's host folder is mounted inside the container. Anything that cannot be resolved with certainty is left as plain text rather than guessed at: `~user/...`, unexpanded `$HOME/...`, and every relative path when the mount destination is unknown. Bare filenames with no `/` are never linked.

The terminal is created with `hideFromUser` and then immediately shown. That is deliberate: it is the only creation option the Python extension checks before injecting `source .../activate` into a new terminal, so this keeps a host venv out of a container shell. There is no supported API for this ([vscode-python#11963](https://github.com/microsoft/vscode-python/issues/11963) is open), so it may need revisiting if that check changes.

## Agent status

A second Explorer view, **Agents**, lists the coding agents [herdr](https://herdr.dev) is running inside each in-scope container, with each agent's state: working, blocked, done, idle or unknown. It also lists agents in herdr sessions running on the host (macOS and Linux): every agent of a session attached in one of the window's terminals (`herdr --session <name>`, or a bare `herdr` for the default session), and otherwise only the agents working in one of the window's folders. Every dev container serving the workspace has a row, running or stopped, with or without agents; its description says when it is stopped or its herdr is not running. The window's primary folder (its workspace file's directory, else its first folder) always has one: a **not created** placeholder when it has no container, since `devc` can create one for any folder. Other folders show only containers that exist, so taking one down removes its row. A host session's row shows while it is attached here or is the window's own session, and the window's own session shows as a **not running** placeholder until it starts. The window's own session is the `devc-vscode.herdrSession` setting when set, else the name `herdrs` gives the directory of its workspace file, or its first folder: its path under your home folder (or its absolute path outside it), one part per folder joined with `.`, so `~/code/tools/devc-vscode` is `code.tools.devc-vscode`. Each folder name is lowercased, with `.` made `_` and other characters herdr does not allow made `-`. Names over 40 characters, which would overflow herdr's socket path, keep their last folders and gain a short hash. When no terminal in the window is on it, the row has an inline **Attach Terminal** action that opens one attached to herdr, starting whatever is not running: `herdr --session <name>` for a host session, the `herdrAttachCommand` (`devc herdr`) for a container, which also starts or creates the container. Host session rows come first, then container rows, each sorted by label. Both are labelled with their folder's basename (a session's last `.` part, or `default`), and their description starts with **herdr** or **container** to tell them apart, followed by a count per state. A container's herdr agents sit under a **default** child row (herdr's session in the container), described the same way as a host session; agents detected in its plain terminals sit directly under the container. The view's title bar has **Expand All** and **Collapse All** actions. The view's badge counts agents that are blocked or done, since those are waiting on you. Clicking an agent reveals the terminal showing it and tells herdr to focus the agent's pane; for a host session with no attached terminal, one is opened.

The extension does no detection of its own. herdr already classifies every pane from its output (spinners, OSC titles, prompt boxes, permission dialogs), and its socket API reports the result, so the view shows exactly what herdr's sidebar shows. Reading herdr's state avoids reading the VS Code terminal at all. With herdr running, that terminal only ever carries herdr's composited screen, never the agent's raw output.

Each container gets one long-lived `docker exec -i -u <remoteUser> <id> sh -c …`. Inside it, a loop runs `herdr api snapshot` once a second and prints only when the snapshot changes. It needs only `sh` and herdr (found on `PATH` or in `~/.local/bin`), with no `socat`, native Node modules or VS Code server in the container. `docker exec` does not stop its process when the client exits, so the loop runs in the background and ends when the exec's stdin closes: on dispose, on a stopped container, or when VS Code exits. It runs as the container's `remoteUser` from the `devcontainer.metadata` label, because herdr's socket lives in that user's home. A container with no herdr server running is left out until herdr starts.

### Across windows

Each VS Code window publishes what its Agents view shows to a file in the extension's global storage, which every window shares, and watches that directory for the other windows' files. Once another window has agents, this window's groups move under a node labelled with its workspace name, followed by a collapsed **Other Windows** node holding one node per other window labelled with its workspace name, so it's always clear which window a click lands in. The badge counts agents needing attention in every window.

Clicking an agent owned by another window drops a focus request for that window, which reveals its own terminal and herdr pane, then brings that window to the front with `vscode.openFolder` on its workspace. VS Code focuses a window that already has that folder or workspace open rather than opening a second one. An untitled multi-root workspace has nothing to reopen, so its agents are listed but not switchable.

Files are written to a temp name and renamed, so a reader never sees a partial file. A window removes its file when it closes; a file left by a crashed window is dropped once its extension host process is gone. A re-read every 10 s covers any missed file-watch event.

## SSH hosts

An SSH host — typically an agent sandbox VM — can be an environment too, working like a dev container with plain `ssh` in place of `docker exec`: a root in the **Dev Containers** view, terminals, terminal links, and an entry in the Agents view with its herdr and terminal-detected agents. It is for browsing a sandbox **without Remote-SSH**: VS Code's remote server relays the host's git credentials to anything running on the remote, and plain `ssh` carries none of that. Nothing is installed on the remote, and it is never opened as a workspace folder, so a `.vscode/settings.json`, `tasks.json` or `launch.json` an agent writes there is never applied — it is just text.

Hosts come only from **user** settings (`devc-vscode.sshHosts` is application-scoped; a workspace cannot add one). **Add SSH Host…** (the `+` in the Dev Containers view's title bar, the Add Agent picker, or the command palette) lists the concrete aliases in `~/.ssh/config` and the files it includes, asks for a start directory, and adds the entry for you:

```jsonc
"devc-vscode.sshHosts": [
  { "host": "agent-vm", "root": "/home/ubuntu/work", "label": "Sandbox" }
]
```

`host` must be an alias ssh can reach with keys alone — accept its host key once by running `ssh <host>` in a terminal. `root` is where the tree, terminals and agents start (default: the remote home). A `devc-ssh://` URI naming any other host is refused before anything is run, since its host becomes an ssh argument.

A configured host is pinned: every window shows it, and it is simply up or not — the extension never starts, stops or provisions it. In the Agents view it shows while it is reachable, under an **SSH Hosts** root beside Workspace; the root itself shows only while some host is reachable. Each window uses its own herdr session there, named as its host workspace session is (`devc-vscode.herdrSession`, else the `herdrs` name for the workspace), because one host serves many projects. **Attach Terminal** opens `ssh -t <host>` attached to that session (a login shell when herdr is not installed); **Add Agent** starts the session when needed and launches the agent in `root`; **Stop / Delete herdr Session** end only that session. Other windows' agents on the host show under Other Workspaces. An unreachable host shows **Cannot reach <host>** in the tree with ssh's error as the tooltip, and is retried every 5 s, backing off to a minute.

Every ssh the extension runs forces `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes` and `PermitLocalCommand=no` on the command line, overriding `~/.ssh/config` — terminals included, so the host's ssh agent never reaches the remote. File and herdr commands also use `BatchMode=yes` (keys only, no prompts) and share one connection per host through a control socket in `/tmp/devc-<uid>` (skipped when that directory is not private to you).

The host needs GNU coreutils/findutils and procps, like a container. Keep output out of the remote shell's startup files for non-interactive shells (Ubuntu's `.bashrc` already returns early): anything printed there corrupts file reads. A host without herdr gets no Agents view entry, since that entry is driven by herdr's watcher.

## Using the tree

| Action | How |
| --- | --- |
| Open a file | Click it |
| New file / folder | Right-click a container, SSH host or folder |
| Rename | <kbd>F2</kbd>, or right-click |
| Delete | <kbd>Delete</kbd>, or right-click — multi-select is supported |
| Move | Drag within a container or SSH host |
| Copy in | Drag from the host Explorer, or from another container's or SSH host's tree |
| Copy the container-side path | Right-click → **Copy Container Path** |

Deletes are permanent: neither a container nor an SSH host has a trash, so the confirmation prompt is the only safeguard.

## Commands

| Command | Description |
| --- | --- |
| `Dev Container FS: Refresh Container Files` | Re-read the tree |
| `Dev Container FS: Open Folder in Container` | Context menu on a **host** folder in the explorer — opens a terminal running `devc-vscode.openFolderCommand` (rejected on container folders) |
| `Dev Container FS: Add SSH Host…` | Pick an alias from `~/.ssh/config` and add it to `devc-vscode.sshHosts` |

`New File`, `New Folder`, `Rename`, `Delete` and `Copy Container Path` are also commands; from the palette they act on the current tree selection. `Focus Agent` is run by clicking an agent in the Agents view and is hidden from the palette.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devc-vscode.dockerPath` | `docker` | Docker CLI command (name on PATH or absolute path) |
| `devc-vscode.openFolderCommand` | `devc herdr` | Command sent to the terminal by "Open Folder in Container" |
| `devc-vscode.sshHosts` | `[]` | SSH hosts shown as environments (user settings only) — see [SSH hosts](#ssh-hosts) |
| `devc-vscode.sshPath` | `ssh` | ssh client (name on PATH or absolute path; user settings only) |

## Requirements

Docker CLI on the host PATH; a dev container started by the devcontainer CLI (or any container with bind mounts to your workspace). The container needs GNU coreutils/findutils — BusyBox (Alpine) is not supported.

This extension runs on the host and talks to the host Docker daemon. It is not meant to be loaded into a container-attached window.

## Develop

```sh
npm install
npm run compile      # or: npm run watch
npm test             # .npmrc sets ignore-scripts, so compile first — pretest does not run
npx vsce package     # -> devc-vscode-<version>.vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. Setting *defaults* come from the installed
manifest, so after editing `package.json` reinstall the `.vsix` (or restart the dev host) — an edit alone
will not change what a running VS Code sees.

Development can happen inside a dev container while VS Code runs on the host against the same
bind-mounted tree. The `ContainerTreeDataProvider` suite uses injected fakes and needs no Docker
socket; the `DevContainerFileSystemProvider` suite skips itself when no container is reachable, so
run it from the host to exercise it. A headless container also needs `xvfb` and Electron's shared
libraries before `xvfb-run -a npm test` will start.
