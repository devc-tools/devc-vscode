# Change Log

## [Unreleased]

### Changed

- Container files are now shown in a **Dev Containers** tree view in the Explorer panel instead of being added as workspace folders. No window reload, no multi-root conversion, and no stale container roots restored after a reload.
- `Show Container File Tree` now reveals the chosen path in the tree rather than adding a workspace folder.
- Tree roots are scoped to the containers serving the open workspace folders and labelled with the host folder's basename, matching the old `[container] <name>` workspace-folder label. Docker's container name is shown as the subtitle. Each root is the container's `/`, so the whole container filesystem stays browsable.
- The tree supports New File, New Folder, Rename, Delete (multi-select), Copy Container Path, and drag-and-drop — moves within a container, copies across containers and from the host Explorer.

### Added

- `Add Container Folder to Workspace` — opt in to a native Explorer root when you want one.
- Terminal links resolve `~` (against the container user's `$HOME`) and relative paths (against the bind-mount destination for the terminal's host folder). Paths that cannot be resolved with certainty are left as plain text.
- Clicking a terminal link with a `:line` or `:line:col` suffix opens the file at that position.

### Fixed

- A relative path anywhere in a terminal line suppressed the links for that whole line, including valid absolute paths, because building a URI from a non-absolute path threw.
- `:line:col` suffixes were only matched after relative paths, never absolute ones, so the line number was not part of the link and clicking it did nothing.
- `:line:col` was only half-stripped, leaving `path:42`, which never resolved.
- A failed container lookup was cached even when the `docker events` watcher was not running, leaving terminal links dead for the rest of the session with no way to recover.

### Removed

- The `devc-vscode.autoAttach` setting. The tree tracks running containers by construction, so there is nothing to attach or detach.

## [0.0.1]

- Initial release
