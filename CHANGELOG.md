# Change Log

## [Unreleased]

### Changed

- Container files are now shown in a **Dev Containers** tree view in the Explorer panel instead of being added as workspace folders. No window reload, no multi-root conversion, and no stale container roots restored after a reload.
- Tree roots are scoped by one rule: a running dev container is shown when its `devcontainer.local_folder` is an open workspace folder or sits under one. A container started for a subfolder now gets its own root, which it previously did not. Roots are labelled with the host folder's basename, or `basename/path/to/subfolder` for a subfolder container, with docker's container name as the subtitle. Each root is the container's `/`, so the whole container filesystem stays browsable.
- The tree supports New File, New Folder, Rename, Delete (multi-select), Copy Container Path, and drag-and-drop — moves within a container, copies across containers and from the host Explorer.

### Added

- Terminal links resolve `~` (against the container user's `$HOME`) and relative paths (against the bind-mount destination for the terminal's host folder). Paths that cannot be resolved with certainty are left as plain text.
- Clicking a terminal link with a `:line` or `:line:col` suffix opens the file at that position.

### Fixed

- A relative path anywhere in a terminal line suppressed the links for that whole line, including valid absolute paths, because building a URI from a non-absolute path threw.
- `:line:col` suffixes were only matched after relative paths, never absolute ones, so the line number was not part of the link and clicking it did nothing.
- `:line:col` was only half-stripped, leaving `path:42`, which never resolved.
- A failed container lookup was cached even when the `docker events` watcher was not running, leaving terminal links dead for the rest of the session with no way to recover.

### Removed

- `Show Container File Tree`. The tree is derived entirely from running containers that match the scoping rule, so there is nothing to add to it by hand — and with it goes the fallback that could pin an unrelated dev container as a root.
- Root discovery no longer falls back to scanning bind mounts. A container's project folder is the `devcontainer.local_folder` label; a container without one is not treated as belonging to this workspace.
- `Add Container Folder to Workspace`, and with it the last `updateWorkspaceFolders` call. The tree view is now the only way container files are surfaced, so nothing the extension does can mutate the workspace or restart the extension host.
- The `devc-vscode.autoAttach` setting. The tree tracks running containers by construction, so there is nothing to attach or detach.

## [0.0.1]

- Initial release
