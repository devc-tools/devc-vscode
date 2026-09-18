# Dev Container File Tree

Browse and edit files inside a **running dev container** from VS Code running on the host — without using VS Code's Dev Containers extension or attaching a window to the container.

The extension registers a `FileSystemProvider` for the `devcontainer-filetree://` scheme. File trees and file contents are sourced from the container by shelling out to `docker exec` on the host, so it works with containers started by the [devcontainer CLI](https://github.com/devcontainers/cli) (`devcontainer up`), plain `docker run`, or anything else — as long as the container is running and reachable via the host's Docker CLI.

## Usage

1. Start your dev container on the host, e.g. `devcontainer up --workspace-folder .`
2. In VS Code (on the host), run **Dev Container FS: Open Folder in Dev Container...**
   - If the current workspace folder matches a running container's `devcontainer.local_folder` label, that container is used automatically; otherwise you pick from all running dev containers.
   - Confirm or edit the path inside the container (defaults to `/workspaces/<folder name>`).
3. The container folder is added to your workspace like any other folder: expand the tree, open files, edit and save — writes go back into the container.
4. **Dev Container FS: Refresh Container Files** re-reads the tree after changes made inside the container.

URI shape: `devcontainer-filetree://<container-id>/<absolute path in container>`

## Requirements

- Docker CLI on the host (`docker` on `PATH`, or set `devcontainer-filetree.dockerPath`).
- A running container with GNU coreutils/findutils (`stat`, `find`, `cat`, `mkdir`, `rm`, `mv`, `rmdir`) and `sh` — true for typical dev container images (Debian/Ubuntu based). BusyBox-only images (Alpine) are not supported.
- Files are read/written as the container's default user (the image's `USER`, e.g. `vscode` in devcontainer images).

## Extension Settings

* `devcontainer-filetree.dockerPath`: Docker CLI command used to talk to containers (a name on `PATH` or an absolute path). Default: `docker`.

## Known Issues

- **No file watching**: changes made inside the container don't appear automatically. Run **Dev Container FS: Refresh Container Files** (or collapse/re-expand the tree) to pick them up.
- **Latency**: every operation is a separate `docker exec` (~100–300 ms), so expanding large trees feels slower than a local filesystem.
- Container restarts keep the same container id, but a *recreated* container gets a new id — re-open the folder if that happens.

## Development

- `npm run compile` / `npm run watch` — build
- `npm run lint` — lint
- `npm test` — runs the integration suite in a real VS Code extension host on the host, against a live container (the one labeled `devcontainer.local_folder=<this repo>`, any other running dev container, or `$DEVCONTAINER_FILETREE_TEST_CONTAINER`). Skips gracefully when no container is available.
