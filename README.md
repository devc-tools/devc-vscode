# Dev Container File Tree

Browse and edit files inside a running dev container from VS Code on the host — no remote server, no container attach. Files are read and written over `docker exec`.

## How it works

Registers a `devc-vscode://<container-id>/<path>` filesystem provider backed by `docker exec` (`stat`, `ls`, `cat`, `mkdir`, `rm`, `mv`).

With `devc-vscode.autoAttach` on (the default), containers whose bind mounts match an open host folder are added to the workspace automatically as `[container] <name>`, and removed when the container stops (`docker events` is watched live). Turn it off to attach file trees only on demand.

## Commands

| Command | Description |
| --- | --- |
| `Dev Container FS: Show Container File Tree` | Pick a running dev container and mount a path from it |
| `Dev Container FS: Refresh Container Files` | Re-read tracked container folders |
| `Dev Container FS: Open Folder in Container` | Context menu on a **host** folder in the explorer — opens a terminal running `devc-vscode.openFolderCommand` |

File paths printed in that terminal become clickable links that open the file inside the container. Clicking a *folder* reveals it in the explorer, attaching that container's file tree first if it isn't shown yet — so this works even with `autoAttach` off.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devc-vscode.dockerPath` | `docker` | Docker CLI command (name on PATH or absolute path) |
| `devc-vscode.autoAttach` | `true` | Attach/detach container file trees automatically as containers start and stop |
| `devc-vscode.openFolderCommand` | `devc herdr` | Command sent to the terminal by "Open Folder in Container" |

## Requirements

Docker CLI on the host PATH; a dev container started by the devcontainer CLI (or any container with bind mounts to your workspace).

## Develop

```sh
npm install
npm run compile   # or: npm run watch
npm test
```

Press <kbd>F5</kbd> to launch an Extension Development Host.
