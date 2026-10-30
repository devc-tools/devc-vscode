# herdr-vscode: Pane Context (files follow the focused pane)

Mockup board C (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): a **Pane Context** view shows
the repo, changes and file tree of the herdr pane you are working with, so VS Code's editing is
one click from any agent. It follows the last pane you clicked into (a tile in VS Code, or
herdr's own focus when no tile has been focused yet); clicking into a file editor does not
change it; **Pin** stops it following. Paths printed in tiles become links that open the file
beside the tile.

Every file the view or a link can reach is editable. Local paths (host, and container paths on a
bind mount) open as plain `file:` URIs with all of VS Code's features. Everything else (container
paths outside the mount, SSH hosts) opens through read-write file system providers ported from
devc-vscode; those edit and save normally but get no language servers, Source Control or search,
because those features need local files.

Workspace folders are never changed automatically: **Add to Workspace** is an explicit action,
offered only for local paths.

Depends on [herdr-mirrored-tabs](herdr-mirrored-tabs.md) (focus tracking, webview). Paths are
under `herdr-vscode/`.

## Checklist

- [ ] 1. Followed-pane rule, pin state, and the view header
- [ ] 2. Environment paths → VS Code URIs: host `file:`, container bind mounts → host `file:`,
      other container paths → `herdr-container:`, SSH → `herdr-ssh:`
- [ ] 3. Port devc-vscode's read-write providers (`CoreutilsFileSystemProvider` and its container
      and SSH subclasses) as `herdr-container` and `herdr-ssh`, with authority checks and
      change polling for open documents
- [ ] 4. Git in the environment: toplevel, branch, ahead/behind, changed files
- [ ] 5. `herdr.paneContext` view: Repo row, Changes, Files, Other Panes in This Space
- [ ] 6. Actions: Add to Workspace, Split Pane Here, Show Pane, Open Changes, Pin / Unpin
- [ ] 7. Terminal links in tiles (webview link provider → resolve in the environment → open beside)
- [ ] 8. Refresh rules
- [ ] 9. Tests (list under Validation)
- [ ] 10. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Followed pane

- When not pinned, the followed pane is, in order:
  1. the window's last focused pane (from herdr-mirrored-tabs), else
  2. the selected session's `focused_pane_id`, updated on `pane.focused` events.
- Once any tile has been focused in this window, rule 2 is no longer used, so focus in the herdr
  TUI does not pull the view away while you work in VS Code.
- Focusing a text editor, the explorer or any other view does not change it.
- Pin: `herdr.paneContext.pin` (`$(pin)`) / `herdr.paneContext.unpin` (`$(pinned)`) in the view
  title, toggling context key `herdr.paneContextPinned`. Not persisted across reloads.
- `TreeView.message`: `<label> · <space label> › <tab label>`, then ` · pinned` when pinned, then
  ` · not open in a tile` when no tile in this window shows it. With no followed pane:
  "Click into a herdr pane to see its files.".

### Paths and URIs

The pane's directory is `foreground_cwd ?? cwd`.

- **Host**: `file://<path>`.
- **Container**: bind mounts from
  `docker inspect --format '{{json .Mounts}}' <id>` (entries with `"Type":"bind"`, using
  `Source` and `Destination`). A path under a `Destination` (longest match first) maps to
  `file://<Source><rest>`. Unmapped paths → `herdr-container://<id12><path>`.
- **SSH**: `herdr-ssh://<alias><path>`.
- Both schemes are registered read-write (`{isCaseSensitive: true}`, no `isReadonly`). Mounts
  are cached per container and re-read when the container restarts.

### `herdr-container` and `herdr-ssh` providers (read-write, ported)

- Copy devc-vscode's `src/devcontainerFs.ts` (`CoreutilsFileSystemProvider` and the container
  provider) and the `SshFileSystemProvider` class from `src/sshFs.ts` into
  `herdr-vscode/src/remoteFs.ts`, starting with
  `// Ported from devc-vscode src/devcontainerFs.ts and src/sshFs.ts at <short commit>; maintained separately.`
  devc-vscode's files are not changed, and its `devc-vscode:` / `devc-ssh:` schemes are unaffected.
- Behavior kept exactly as devc-vscode's (it is the contract):
  - `stat`: `stat -L -c '%F\n%s\n%Y\n%W' -- <path>`; `readDirectory` via `find`; `readFile`:
    `cat -- <path>`.
  - `writeFile`: content on stdin to `sh -c 'cat > "$1"' sh <path>` (the path travels as `$1`,
    never inside the script). Overwrites in place, so the file keeps its owner and mode; it is
    not atomic.
  - `createDirectory`: `mkdir -- <path>` (no `-p`: a missing parent is `FileNotFound`).
  - `delete`: `rmdir` for an empty-directory non-recursive delete, else `rm -rf --`.
  - `rename`: `mv --`; across two authorities → `NoPermissions` ("Cannot rename across
    containers" / "Cannot rename across SSH hosts").
  - Errors from stderr map to `FileNotFound`, `FileExists`, `NoPermissions` as devc-vscode maps
    them; a command failing with empty stderr uses the provider's exec-failed message.
  - Needs GNU coreutils and findutils in the environment; BusyBox (Alpine) is unsupported.
- Shells: `herdr-container` runs `DockerShell` as the container's remote user (so new files are
  owned by that user); `herdr-ssh` runs `SshShell` with `SSH_SAFETY_OPTIONS`.
- **Authority checks before anything is spawned** (any URI of these schemes, from anywhere,
  reaches the provider): a `herdr-container` authority must be the 12-char id of a running dev
  container in herdr-vscode's current environments; a `herdr-ssh` authority must be in
  `herdr.sshHosts`. Otherwise throw `FileSystemError.Unavailable` with "Not a known dev
  container" / "SSH host is not in herdr.sshHosts".
- **Change polling (new; devc-vscode's `watch` is a no-op):** agents edit these files while they
  are open. Every 5 s, for each open text document of either scheme, `stat` it; when `mtime` or
  `size` differs from the last seen value, fire `FileChangeType.Changed` for it so VS Code
  reloads a clean editor (or shows its usual conflict prompt for a dirty one). A document's
  polling stops when it closes. `watch` itself stays a no-op.

### Git (run in the pane's environment)

- Toplevel: `git -C <dir> rev-parse --show-toplevel`; non-zero → not a repo (the view shows the
  directory itself as the root, no Changes section).
- Status: `git -C <toplevel> status --porcelain=v1 -z --branch`.
  - First record `## <branch>[...<upstream>][ [ahead N][, behind M]]`; `## HEAD (no branch)`
    means detached (branch shown as the short SHA from `git -C <toplevel> rev-parse --short HEAD`).
  - Other records: `XY<space><path>`; a rename/copy record (`X` is `R` or `C`) is followed by a
    second NUL-terminated record holding the original path, which is skipped.
  - Changed count = number of path records.

### View `herdr.paneContext` "Pane Context"

Added to `views.herdr` after Agents. Rows:

1. **Repo row**: label = toplevel basename (or the directory's basename); description
   `⎇ <branch>`, then ` · ● <changed>` when > 0, ` ↑<ahead>` / ` ↓<behind>` when > 0; icon
   `repo` (or `folder`). Inline actions:
   - `herdr.paneContext.addToWorkspace` (`$(root-folder-opened)`, "Add to Workspace"): only when
     the root maps to a `file:` URI and is not already a workspace folder;
     `updateWorkspaceFolders(workspaceFolders.length, 0, {uri})`.
   - `herdr.paneContext.splitPane` (`$(split-horizontal)`, "Split Pane Here"): request
     `pane.split` with `{"target_pane_id":"<followed>","direction":"down","cwd":"<root path in the environment>","focus":false}`.
   - `herdr.paneContext.showPane` (`$(window)`, "Show Pane"): only when no tile shows the
     followed pane; runs `herdr.addToLayout` or `herdr.openPaneTab` per `herdr.openPaneIn`.
2. **Changes** (collapsible, expanded; omitted when not a repo or nothing changed): one row per
   changed path; label = file name, description = `<dir> · <XY trimmed>`. Click opens the file.
   Inline `herdr.paneContext.openChanges` (`$(diff)`): `vscode.diff` of
   `herdr-git://<env key>/<toplevel>/<path>?HEAD` (a `TextDocumentContentProvider` running
   `git -C <toplevel> show HEAD:<path>` in the environment; empty for added files) against the
   file's URI; title `<file> (HEAD ↔ working tree)`.
3. **Files** (collapsible, expanded): the root's directory tree through
   `workspace.fs.readDirectory` on the mapped URI; directories first, then files, each
   alphabetical; `resourceUri` set so file icons apply; click opens the file.
4. **Other Panes in This Space** (collapsible, collapsed): the other panes of the followed pane's
   workspace, same label/description/icon/click as Spaces pane rows.

### Terminal links in tiles

- The webview registers an xterm link provider matching tokens with
  `/(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?|[\w.@+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g`
  (paths with a `/`, or a bare file name with an extension), with an optional `:line[:col]`.
- Activating posts `{"type":"openLink","paneKey","text"}`. The extension resolves the path in
  the pane's environment: absolute as is; `~/…` against the environment's `$HOME`
  (`printenv HOME`, cached per environment); otherwise relative to the pane's directory. It
  checks `test -e <path>` there; a missing path does nothing. A directory reveals it in the
  Files section (when under the root) else does nothing. A file opens via its mapped URI in
  `ViewColumn.Beside` with the selection at `line:col` (1-based in the text, 0-based in the
  `Selection`).

### Refresh

- On followed-pane change, on `pane.updated` for the followed pane (its directory may change),
  and on **Refresh** (`herdr.paneContext.refresh`, `$(refresh)` in the view title).
- Git status re-read every 5 s while the view is visible; host roots also refresh from a
  `FileSystemWatcher` on the root.

## Validation

- [ ] `npm test` (in `herdr-vscode/`) passes, including unit tests for: followed-pane rule (TUI focus
      used before any tile focus, ignored after; pinned ignores both); bind-mount mapping
      (longest destination wins; unmapped → `herdr-container:`); porcelain parsing (branch with
      upstream ahead/behind, detached, no upstream, rename record skipping, `??` untracked);
      repo-row description strings; link regex on `src/a.ts:12:3`, `./x/y.md`, `~/n.txt`,
      `README.md`, and not on `http://x.y/z` or `1.2.3`; provider argv for each operation
      (ported tests from devc-vscode's `src/test/containerTree.test.ts` / `sshFs.test.ts` where
      they cover the provider); unknown container and unconfigured SSH authorities rejected
      without spawning; change polling fires `Changed` once per mtime change and stops on close
- [ ] Manual, host: focus a tile whose pane is in a git repo with changes; Pane Context shows the
      repo, branch, change count, the changed files and the tree; clicking a file opens it
      editable
- [ ] Manual: focus a different tile; the view switches. Click into a text editor; it does not.
      **Pin**, then focus another tile; it does not switch until **Unpin**
- [ ] Manual: before focusing any tile in a fresh window, changing focus in the herdr TUI changes
      the view; after focusing a tile, TUI focus no longer does
- [ ] Manual, container: a pane in a devc container's project folder shows `file:` paths, and
      Source Control and language features work on them
- [ ] Manual, container: a pane `cd`'d to the container user's home (outside the mount) shows
      `herdr-container:` files; edit and save one, then `cat` it in the pane shows the change and
      `ls -l` shows the remote user as owner; create, rename and delete a file from the Files
      section; saving a root-owned file (e.g. under `/etc`) shows a permission error
- [ ] Manual, SSH: open a file on an SSH host through `herdr-ssh:`, edit, save; `cat` in an SSH
      pane shows the change
- [ ] Manual, change polling: with a `herdr-container:` file open and unmodified, have the agent
      (or `echo x >> file` in the pane) change it; the editor shows the new content within 6 s
- [ ] Manual: **Open Changes** on a modified file shows a HEAD ↔ working tree diff
- [ ] Manual: **Add to Workspace** adds the repo root as a workspace folder and Source Control
      lists it; the action then disappears for that root
- [ ] Manual: **Split Pane Here** creates a herdr pane below the followed one, in the repo root
- [ ] Manual: a path printed by an agent in a tile (`src/auth/middleware.ts:19`) is underlined on
      hover and opens beside the tiles at line 19; a non-existent path does nothing
- [ ] Manual: the header says `not open in a tile` while following a TUI-focused pane, and
      **Show Pane** opens it per `herdr.openPaneIn`

## Relevant Files

- `herdr-vscode/package.json` (view, commands, menus, `onFileSystem:herdr-container` and
  `onFileSystem:herdr-ssh` activation)
- `herdr-vscode/src/paneContext.ts` (new: followed pane, view)
- `herdr-vscode/src/paths.ts` (new: bind mounts, URI mapping, `$HOME` cache)
- `herdr-vscode/src/remoteFs.ts` (new: ported read-write providers, authority checks, change polling)
- `src/devcontainerFs.ts`, `src/sshFs.ts`, `src/test/containerTree.test.ts`,
  `src/test/sshFs.test.ts` (devc-vscode, read only: the source of the port)
- `herdr-vscode/src/git.ts` (new: toplevel, porcelain parsing, `herdr-git` content provider)
- `herdr-vscode/src/focus.ts` (expose TUI focus fallback)
- `herdr-vscode/src/tilesPanel.ts` (route `openLink`)
- `herdr-vscode/src/webview/tiles.ts` (link provider)
- `herdr-vscode/src/extension.ts`
- `herdr-vscode/src/test/*.test.ts`
- `herdr-vscode/README.md`, `CHANGELOG.md`, `docs/how-it-works.md`
- `.plans/PLAN.md`
