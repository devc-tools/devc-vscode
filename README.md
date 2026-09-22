# Dev Container File Tree

Browse and edit files inside a running dev container from VS Code on the host — no remote server, no container attach. Files are read and written over `docker exec`.

## How it works

Registers a `devc-vscode://<container-id>/<path>` filesystem provider backed by `docker exec` (`stat`, `find`, `cat`, `mkdir`, `rm`, `mv`), and contributes a **Dev Containers** tree view into the Explorer panel.

The tree is scoped to the window's workspace: each open host folder contributes at most one root — the running container that serves it, found by the devcontainer CLI's `devcontainer.local_folder` label and falling back to a bind-mount scan. Roots are labelled with the **host folder's basename**, not docker's generated container name, which appears as the subtitle.

Each root is the container's filesystem root, `/`. The workspace association decides *which* containers show up and what they are called; it does not narrow what you can browse, so `/etc` and `/usr` are a couple of clicks away just like the project directory.

`docker events` is watched live, so roots appear when a container starts and vanish when it stops. `Show Container File Tree` can still reach a container this workspace has no bind mount for — it is pinned as an extra root for the session, and drops away when that container stops. In a window with no folder open there is nothing to scope to, so every running dev container is listed.

Nothing is added to your workspace. The tree is a view, not a workspace folder, so no window reload, no multi-root conversion, and no dead container roots restored after a reload. If you do want a container folder in the native Explorer — for drag-and-drop against host files, or per-folder settings — use **Add Container Folder to Workspace**, which is the one place that still mutates the workspace.

File paths printed in a container terminal become clickable links. Clicking a *file* opens it, jumping to the line and column when the output carries a `:line:col` suffix; clicking a *folder* focuses the tree and reveals it.

Absolute paths always resolve. `~` resolves against the container user's `$HOME`, and relative paths resolve against wherever the terminal's host folder is mounted inside the container — not against the shell's actual working directory, which the extension cannot see, so a link will not appear after you `cd` somewhere else unless the same relative path also exists under the mount. Anything that cannot be resolved with certainty is left as plain text rather than guessed at: `~user/...`, unexpanded `$HOME/...`, and every relative path when the mount destination is unknown. Bare filenames with no `/` are never linked.

The terminal is created with `hideFromUser` and then immediately shown. That is deliberate: it is the only creation option the Python extension checks before injecting `source .../activate` into a new terminal, so this keeps a host venv out of a container shell. There is no supported API for this ([vscode-python#11963](https://github.com/microsoft/vscode-python/issues/11963) is open), so it may need revisiting if that check changes.

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
| `Dev Container FS: Show Container File Tree` | Pick a container and a path, then reveal it in the tree |
| `Dev Container FS: Refresh Container Files` | Re-read the tree |
| `Dev Container FS: Add Container Folder to Workspace` | Add the selected container folder to the workspace as `[container] <name>` |
| `Dev Container FS: Open Folder in Container` | Context menu on a **host** folder in the explorer — opens a terminal running `devc-vscode.openFolderCommand` (rejected on container folders) |

`New File`, `New Folder`, `Rename`, `Delete` and `Copy Container Path` are also commands; from the palette they act on the current tree selection.

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
npm test
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
