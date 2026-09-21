# Dev Container File Tree

Browse and edit files inside a running dev container from VS Code on the host — no remote server, no container attach. Files are read and written over `docker exec`.

## How it works

Registers a `devc-vscode://<container-id>/<path>` filesystem provider backed by `docker exec` (`stat`, `ls`, `cat`, `mkdir`, `rm`, `mv`).

Container file trees attach on demand: `Show Container File Tree`, or clicking a folder link in a container terminal. Turning on `devc-vscode.autoAttach` instead adds any container whose bind mounts match an open host folder as `[container] <name>` the moment it starts, and removes it when it stops (`docker events` is watched live). Note that with `autoAttach` off nothing is detached either — a tree attached by hand stays in the workspace, and VS Code restores it on reload, even once its container is gone.

## Commands

| Command | Description |
| --- | --- |
| `Dev Container FS: Show Container File Tree` | Pick a running dev container and mount a path from it |
| `Dev Container FS: Refresh Container Files` | Re-read tracked container folders |
| `Dev Container FS: Open Folder in Container` | Context menu on a **host** folder in the explorer — opens a terminal running `devc-vscode.openFolderCommand` |

File paths printed in that terminal become clickable links that open the file inside the container. Clicking a *folder* reveals it in the explorer, attaching that container's file tree first if it isn't shown yet. Attaching the first such tree can restart the extension host (VS Code does this when a single-folder window becomes multi-root), so the pending reveal is parked in `globalState` and replayed on the next activation.

The terminal is created with `hideFromUser` and then immediately shown. That is deliberate: it is the only creation option the Python extension checks before injecting `source .../activate` into a new terminal, so this keeps a host venv out of a container shell. There is no supported API for this ([vscode-python#11963](https://github.com/microsoft/vscode-python/issues/11963) is open), so it may need revisiting if that check changes.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devc-vscode.dockerPath` | `docker` | Docker CLI command (name on PATH or absolute path) |
| `devc-vscode.autoAttach` | `false` | Attach/detach container file trees automatically as containers start and stop |
| `devc-vscode.openFolderCommand` | `devc herdr` | Command sent to the terminal by "Open Folder in Container" |

## Requirements

Docker CLI on the host PATH; a dev container started by the devcontainer CLI (or any container with bind mounts to your workspace).

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
