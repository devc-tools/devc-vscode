# Dev Container File Tree

Browse and edit files inside a running dev container from VS Code on the host — no remote server, no container attach. Files are read and written over `docker exec`.

## How it works

Registers a `devc-vscode://<container-id>/<path>` filesystem provider backed by `docker exec` (`stat`, `find`, `cat`, `mkdir`, `rm`, `mv`), and contributes a **Dev Containers** tree view into the Explorer panel.

The tree is scoped to the window's workspace by a single rule: a running dev container gets a root when its project folder — the devcontainer CLI's `devcontainer.local_folder` label — is an open host folder **or sits under one**. So a container started for a subfolder gets its own root alongside the workspace folder's, and no unrelated dev container on the machine can appear. Roots are labelled with the **host folder's basename**, or `basename/path/to/subfolder` for a container serving a subfolder; docker's generated container name is the subtitle.

Each root is the container's filesystem root, `/`. The workspace association decides *which* containers show up and what they are called; it does not narrow what you can browse, so `/etc` and `/usr` are a couple of clicks away just like the project directory.

`docker events` is watched live, so roots appear when a container starts and vanish when it stops. There is no way to add anything else to the tree: the rule above is the whole of it, so a window with no folder open shows nothing.

Nothing is added to your workspace. The tree is a view, not a workspace folder, so no window reload, no multi-root conversion, and no dead container roots restored after a reload. The extension never calls `updateWorkspaceFolders`.

File paths printed in a container terminal become clickable links. Clicking a *file* opens it, jumping to the line and column when the output carries a `:line:col` suffix; clicking a *folder* focuses the tree and reveals it.

Absolute paths always resolve. `~` resolves against the container user's `$HOME`, and relative paths resolve against wherever the terminal's host folder is mounted inside the container — not against the shell's actual working directory, which the extension cannot see, so a link will not appear after you `cd` somewhere else unless the same relative path also exists under the mount. Anything that cannot be resolved with certainty is left as plain text rather than guessed at: `~user/...`, unexpanded `$HOME/...`, and every relative path when the mount destination is unknown. Bare filenames with no `/` are never linked.

The terminal is created with `hideFromUser` and then immediately shown. That is deliberate: it is the only creation option the Python extension checks before injecting `source .../activate` into a new terminal, so this keeps a host venv out of a container shell. There is no supported API for this ([vscode-python#11963](https://github.com/microsoft/vscode-python/issues/11963) is open), so it may need revisiting if that check changes.

## Agent status

A second Explorer view, **Dev Container Agents**, lists the coding agents [herdr](https://herdr.dev) is running inside each in-scope container, with each agent's state: working, blocked, done, idle or unknown. Each container row also shows a count per state. The view's badge counts agents that are blocked or done, since those are waiting on you. Clicking an agent reveals that container's terminal and tells herdr to focus the agent's pane.

The extension does no detection of its own. herdr already classifies every pane from its output (spinners, OSC titles, prompt boxes, permission dialogs), and its socket API reports the result, so the view shows exactly what herdr's sidebar shows. Reading herdr's state avoids reading the VS Code terminal at all. With herdr running, that terminal only ever carries herdr's composited screen, never the agent's raw output.

Each container gets one long-lived `docker exec -i -u <remoteUser> <id> sh -c …`. Inside it, a loop runs `herdr api snapshot` once a second and prints only when the snapshot changes. It needs only `sh` and herdr (found on `PATH` or in `~/.local/bin`), with no `socat`, native Node modules or VS Code server in the container. `docker exec` does not stop its process when the client exits, so the loop runs in the background and ends when the exec's stdin closes: on dispose, on a stopped container, or when VS Code exits. It runs as the container's `remoteUser` from the `devcontainer.metadata` label, because herdr's socket lives in that user's home. A container with no herdr server running simply shows no agents until herdr starts.

## Using the tree

| Action | How |
| --- | --- |
| Open a file | Click it |
| New file / folder | Right-click a container or folder |
| Rename | <kbd>F2</kbd>, or right-click |
| Delete | <kbd>Delete</kbd>, or right-click — multi-select is supported |
| Move | Drag within a container |
| Copy in | Drag from the host Explorer, or from another container's tree |
| Copy the container-side path | Right-click → **Copy Container Path** |

Deletes are permanent: a container has no trash, so the confirmation prompt is the only safeguard.

## Commands

| Command | Description |
| --- | --- |
| `Dev Container FS: Refresh Container Files` | Re-read the tree |
| `Dev Container FS: Open Folder in Container` | Context menu on a **host** folder in the explorer — opens a terminal running `devc-vscode.openFolderCommand` (rejected on container folders) |

`New File`, `New Folder`, `Rename`, `Delete` and `Copy Container Path` are also commands; from the palette they act on the current tree selection. `Focus Agent` is run by clicking an agent in the Agents view and is hidden from the palette.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devc-vscode.dockerPath` | `docker` | Docker CLI command (name on PATH or absolute path) |
| `devc-vscode.openFolderCommand` | `devc herdr` | Command sent to the terminal by "Open Folder in Container" |

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
