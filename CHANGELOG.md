# Change Log

## [Unreleased]

### Changed

- A missing Docker CLI no longer empties the Sandboxes view: SSH host roots still list.

- The Explorer tree view is renamed from **Dev Containers** to **Sandboxes**, since it holds SSH hosts as well as dev containers. Its view id (`devc-vscode.containers`) is unchanged.

- Window snapshots shared between windows are now version 5 (they carry SSH hosts); windows running an older build of the extension ignore them until updated.

- Container files are now shown in a **Dev Containers** tree view in the Explorer panel instead of being added as workspace folders. No window reload, no multi-root conversion, and no stale container roots restored after a reload.
- Tree roots are scoped by one rule: a running dev container is shown when its `devcontainer.local_folder` is an open workspace folder or sits under one. A container started for a subfolder now gets its own root, which it previously did not. Roots are labelled with the host folder's basename, or `basename/path/to/subfolder` for a subfolder container, with docker's container name as the subtitle. Each root is the container's `/`, so the whole container filesystem stays browsable.
- The tree supports New File, New Folder, Rename, Delete (multi-select), Copy Container Path, and drag-and-drop — moves within a container, copies across containers and from the host Explorer.

### Added

- **Every host tool is optional.** The extension checks for the Docker CLI, devc and host herdr on startup, on Refresh, when a related setting changes and when the window regains focus, and offers only what they support. Open Folder in Container and Stop / Down Container show when devc is found in `~/.local/bin` or on PATH, or when their command setting is set. Add Agent lists the host only when host herdr runs, and a container folder only when devc can start it or its container is running. Send / Fetch to SSH Host show once an SSH host is configured. The Agents view's Workspace tooltip names a missing herdr or Docker.
- **Container terminals without devc.** With no devc and the command setting unset, a container's Attach Terminal (and a herdr agent's focus, and Add Agent on a running container) opens `docker exec -it` into the workspace mount, attached to the container's herdr when it has one, else the user's login shell. These terminals are rebuilt for the current container on restore.

- **Send from Local / Fetch to Local** inline on SSH folders in the Sandboxes view that are Git worktrees of a local repo (the local repos behind the workspace folders, matched at the mirrored path against the host's worktree list). The host's branch shows beside the folder. Worktrees that exist only on the host are marked `(not local)` and offer Fetch into the local main worktree.
- **Send to SSH Host… / Fetch from SSH Host…** on local folders in the Explorer: push a repo's current branch to a configured SSH host at the same home-relative path (worktrees become worktrees there), and fetch the host's branches back into a review diff that lists files that can run code first. Fetch never merges or checks out. git's ssh gets the same forced-off forwarding as the extension's own.
- **SSH hosts as environments.** Hosts from the new user-only `devc-vscode.sshHosts` setting get a root in the Dev Containers view (`devc-ssh://<host>/<path>`, read and written with coreutils over plain `ssh`), terminals attached to this window's herdr session on the host, terminal links, and an Agents view entry with its herdr and terminal-detected agents, Add Agent, and Stop / Delete herdr Session. Every ssh forces agent, X11 and port forwarding off. No VS Code server is installed on the host and it is never a workspace folder; one added by hand is removed. **Add SSH Host…** adds an alias from `~/.ssh/config`. New settings: `devc-vscode.sshHosts`, `devc-vscode.sshPath`.

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
