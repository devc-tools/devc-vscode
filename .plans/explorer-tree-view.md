# Container File Tree as a Contributed Explorer View

Replace workspace-folder grafting (`updateWorkspaceFolders`) with a `TreeView` contributed
into the Explorer view container, backed by the existing `DevContainerFileSystemProvider`.

The FS provider stays exactly as-is. Only the *surfacing* changes: `showTextDocument`,
`workspace.fs.*`, and terminal links all work on `devc-vscode://` URIs without workspace
membership, so no capability is lost — see "What this removes" below.

## Decisions

**Roots are running dev containers, discovered live.** The tree lists every running container
matching `label=devcontainer.config_file`. There is no attach/detach concept, so the
`devc-vscode.autoAttach` setting is **removed**. Containers appear when they start and vanish
when they stop, driven by the existing `docker events` watcher.

**Each container root expands to a base path**, not to `/`: the bind-mount destination whose
source matches an open host workspace folder, else `/`. `findMatchingBindMount` already
computes this and returns `destPath`.

**The workspace-folder path survives as an explicit command.** `devc-vscode.addToWorkspace`
keeps `updateWorkspaceFolders` for users who want the native Explorer. Because the user
invoked it, an extension-host restart is acceptable and the `globalState` reveal-replay hack
is not needed.

**Dependencies are constructor-injected, so the tree is testable without Docker.**
`ContainerTreeDataProvider` takes a `ContainerSource` (`listRunning(): Promise<ContainerInfo[]>`,
`basePath(id): Promise<string>`) and a `FileOps` (`readDirectory`, `stat`, `rename`, `delete`,
`createDirectory`, `readFile`, `writeFile` over `vscode.Uri`) rather than calling `execDocker`
or `vscode.workspace.fs` directly. Production wires these to `execDocker` and
`vscode.workspace.fs`; tests pass fakes. This is what lets sort order, `getParent`, and drop
resolution be verified in an environment with no Docker socket.

**No `FileDecorationProvider`.** `TreeItem.iconPath` and `.description` cover every state the
tree needs; a decoration provider would add a second source of truth for the same labels.

## What this removes

Delete from `src/extension.ts`: `PENDING_REVEAL_KEY`, `PENDING_REVEAL_TTL_MS`,
`PendingReveal`, `resumePendingReveal`, `revealWithRetry`, `ensureFolderVisible`,
`waitForFolderContaining`, `hasFolderContaining`, `cleanupStaleFolders`,
`autoOpenContainers`, `hasContainerForHostFolder`, `getBindMounts`, `BindMount`,
`containerFolderLabel`, `isAutoAttachEnabled`, `getTrackedContainerIds`, `isPathWithin`.

`onContainerStarted` / `onContainerStopped` shrink to a single `treeProvider.refresh()`.

## Contract

### View

```json
"views": {
  "explorer": [
    { "id": "devc-vscode.containers", "name": "Dev Containers" }
  ]
}
```

`contextValue` on tree items is exactly one of `container`, `directory`, `file`.
Container root items set `description` to the short container id (first 12 chars) and
`iconPath` to `new vscode.ThemeIcon('vm-running')`.

### Commands

| Command id | Title | Category |
| --- | --- | --- |
| `devc-vscode.newFile` | `New File` | `Dev Container FS` |
| `devc-vscode.newFolder` | `New Folder` | `Dev Container FS` |
| `devc-vscode.rename` | `Rename` | `Dev Container FS` |
| `devc-vscode.delete` | `Delete` | `Dev Container FS` |
| `devc-vscode.copyPath` | `Copy Container Path` | `Dev Container FS` |
| `devc-vscode.addToWorkspace` | `Add Container Folder to Workspace` | `Dev Container FS` |
| `devc-vscode.refresh` | `Refresh Container Files` | `Dev Container FS` |
| `devc-vscode.openFolderInContainer` | `Open Folder in Container` | `Dev Container FS` |
| `devc-vscode.showContainerFileTree` | `Show Container File Tree` | `Dev Container FS` |

`devc-vscode.showContainerFileTree` keeps its id but changes behavior: it prompts for a
container and path as it does today, then focuses the view and reveals that path. It no
longer calls `updateWorkspaceFolders`.

`devc-vscode.refresh` fires the tree's `onDidChangeTreeData` instead of walking
`workspaceFolders`.

Every item command accepts the tree node as its first argument and falls back to
`treeView.selection[0]` when invoked from the command palette with no argument. With no
selection, item commands show `No container file selected.` via `showErrorMessage` and return.

### Menus

```json
"menus": {
  "view/title": [
    { "command": "devc-vscode.refresh", "when": "view == devc-vscode.containers", "group": "navigation" }
  ],
  "view/item/context": [
    { "command": "devc-vscode.newFile",   "when": "view == devc-vscode.containers && viewItem =~ /^(container|directory)$/", "group": "1_new" },
    { "command": "devc-vscode.newFolder", "when": "view == devc-vscode.containers && viewItem =~ /^(container|directory)$/", "group": "1_new" },
    { "command": "devc-vscode.rename",    "when": "view == devc-vscode.containers && viewItem != container", "group": "2_edit" },
    { "command": "devc-vscode.delete",    "when": "view == devc-vscode.containers && viewItem != container", "group": "2_edit" },
    { "command": "devc-vscode.copyPath",  "when": "view == devc-vscode.containers", "group": "3_copy" },
    { "command": "devc-vscode.addToWorkspace", "when": "view == devc-vscode.containers && viewItem =~ /^(container|directory)$/", "group": "4_workspace" }
  ],
  "explorer/context": [
    { "command": "devc-vscode.openFolderInContainer", "when": "explorerResourceIsFolder && resourceScheme != devc-vscode" }
  ]
}
```

### Keybindings

```json
"keybindings": [
  { "command": "devc-vscode.rename", "key": "f2",     "when": "view == devc-vscode.containers && listFocus && !inputFocus" },
  { "command": "devc-vscode.delete", "key": "delete", "when": "view == devc-vscode.containers && listFocus && !inputFocus" }
]
```

### Settings

Remove `devc-vscode.autoAttach`. Keep `devc-vscode.dockerPath` and
`devc-vscode.openFolderCommand` unchanged.

### Activation

`activationEvents` becomes `["onFileSystem:devc-vscode", "onStartupFinished"]`. The `*` entry
goes away; the view contribution activates on view resolution, and `onStartupFinished` covers
the `docker events` watcher and terminal link provider.

### Drag and drop

`dropMimeTypes: ['text/uri-list', 'application/vnd.code.tree.devc-vscode.containers']`,
`dragMimeTypes: ['text/uri-list']`.

- Drop within the same container (same `uri.authority`) → **move**, via `workspace.fs.rename`.
- Drop from another container or from a `file://` source → **copy**: `workspace.fs.readFile`
  the source, `workspace.fs.writeFile` the destination. Directories recurse via
  `readDirectory`. `workspace.fs.copy` is not used — it cannot cross providers.
- Drop target resolution: a `file` node drops into its parent directory; a `directory` or
  `container` node drops into itself.
- A drop onto a destination that already exists prompts
  `showWarningMessage('<name> already exists. Overwrite?', { modal: true }, 'Overwrite')`
  and aborts unless `Overwrite` is chosen.

## Gotchas

1. **`TreeView.reveal` requires `getParent()`.** A `TreeDataProvider` without a working
   `getParent` makes `reveal` silently no-op. Implement it by walking one path segment up
   and returning the container root when the path equals the base path.

2. **Reveal needs the view resolved.** Call
   `await vscode.commands.executeCommand('devc-vscode.containers.focus')` before
   `treeView.reveal(...)`. The `<viewId>.focus` command is generated by VS Code from the view
   contribution; it is not declared in `package.json`.

3. **Internal-drag mime type is lowercased by VS Code.** The tree mime is
   `application/vnd.code.tree.` + the view id **lowercased**. `devc-vscode.containers` is
   already lowercase, so it matches verbatim — do not change the view id casing or the drop
   handler will stop receiving internal drags with no error.

4. **`text/uri-list` is CRLF-delimited.** Split with `/\r?\n/` and drop empty lines; do not
   assume `\n`.

5. **`TreeItem.id` must be stable and unique** or expansion state and `reveal` break across
   refreshes. Use `uri.toString()`; for container roots use `container:<id>`.

6. **`resourceUri` on a `TreeItem` gets file-type icons for free** from the active icon theme.
   Set it on file and directory nodes. Do not set it on container roots — the theme would
   render a folder icon over the `vm-running` `ThemeIcon`.

7. **`contextValue` regex matching in `when` clauses needs `=~ /.../`**, not `==`, for the
   multi-value cases above.

8. **The FS provider does not watch.** `watch()` is a no-op stub, so nothing refreshes the
   tree on container-side changes. Every mutating command must call `treeProvider.refresh(uri)`
   on the parent after the operation completes.

9. **`docker events` can fire before the container accepts `exec`.** The existing 500ms delay
   in `handleDockerEvent` for `start` must be kept.

## Checklist

- [x] Define `ContainerSource` and `FileOps` interfaces plus their production implementations (`DockerContainerSource`, `WorkspaceFileOps`) in `src/containerTree.ts`
- [x] Add `src/containerTree.ts` with `ContainerTreeDataProvider implements vscode.TreeDataProvider<ContainerNode>, vscode.TreeDragAndDropController<ContainerNode>`, taking `ContainerSource` and `FileOps` as constructor arguments
- [x] Define `ContainerNode` as a discriminated union over `container` / `directory` / `file`, each carrying its `vscode.Uri`
- [x] Implement `getChildren`: no element → running dev containers; container → `readDirectory` of its base path; directory → `readDirectory` of its path
- [x] Sort children directories-first, then case-insensitive by name
- [x] Implement `getTreeItem` setting `id`, `resourceUri`, `contextValue`, `collapsibleState`, and `command` (`vscode.open`) on file nodes
- [x] Implement `getParent` per gotcha 1
- [x] Implement `refresh(uri?)` firing `onDidChangeTreeData` scoped to the node, or the whole tree when called with no argument
- [x] Implement `handleDrag` / `handleDrop` per the drag-and-drop contract
- [x] Register the view in `package.json` `contributes.views.explorer`
- [x] Add the nine commands, menu contributions, and two keybindings to `package.json`
- [x] Remove the `devc-vscode.autoAttach` setting from `package.json`
- [x] Change `activationEvents` to `["onFileSystem:devc-vscode", "onStartupFinished"]`
- [x] Create the tree view in `activate` with `createTreeView(..., { canSelectMany: true, dragAndDropController, showCollapseAll: true })` and push it to `context.subscriptions`
- [x] Implement `devc-vscode.newFile` / `devc-vscode.newFolder` (`showInputBox` for the name, then `workspace.fs.writeFile` with an empty body / `createDirectory`)
- [x] Implement `devc-vscode.rename` (`showInputBox` seeded with the current basename, then `workspace.fs.rename`)
- [x] Implement `devc-vscode.delete` (modal confirm, then `workspace.fs.delete` with `recursive: true` for directories)
- [x] Implement `devc-vscode.copyPath` (`env.clipboard.writeText(uri.path)`)
- [x] Implement `devc-vscode.addToWorkspace` retaining `updateWorkspaceFolders` and the `[container] <name>` label
- [x] Rewrite `devc-vscode.showContainerFileTree` to focus and reveal instead of adding a workspace folder
- [x] Rewrite `devc-vscode.refresh` to refresh the tree
- [x] Rewrite `revealContainerFolder` (terminal folder links) to focus the view and `treeView.reveal`, deleting the `globalState` replay path
- [x] Reduce `onContainerStarted` / `onContainerStopped` to `treeProvider.refresh()`
- [x] Delete every symbol listed under "What this removes"
- [x] Add `src/test/containerTree.test.ts` covering child listing, sort order, `getParent` round-trip, `getTreeItem` contextValue mapping, and drop-target resolution against **fake** `ContainerSource` / `FileOps` — no Docker
- [x] Update `README.md`: replace the attach/autoAttach narrative with the tree view, refresh the commands and settings tables, and drop the extension-host-restart paragraph
- [x] Add a `CHANGELOG.md` entry noting the removed `autoAttach` setting and the changed `showContainerFileTree` behavior

## Validation

Split by what the environment can prove. Items under "In a dev container" need no Docker
socket; items under "Host only" do.

Development happens in a dev container started by the devcontainer CLI, while VS Code runs on
the host against the same bind-mounted working tree. So `npm run compile` in the container and
F5 on the host operate on the same `out/`, with no copy step. The extension always runs on the
host — do **not** add an `extensionKind` entry to `package.json` to make it load in a
container-attached window.

### In a dev container (no Docker required)

- [x] `npm run compile` exits 0
- [x] `npm run lint` exits 0
- [x] `grep -c autoAttach package.json src/*.ts README.md` reports 0 matches in all files
- [x] `grep -c pendingReveal src/extension.ts` reports 0
- [x] `grep -n updateWorkspaceFolders src/extension.ts` shows exactly one call site, inside the `devc-vscode.addToWorkspace` handler
- [x] `grep -n execDocker src/containerTree.ts` shows matches only in `DockerContainerSource` and the module-level `findMatchingBindMount` it calls — never inside `ContainerTreeDataProvider`
- [x] `npx vsce package` produces a `.vsix` without warnings about missing contribution points
- [x] `sudo apt-get install -y xvfb` once, then `xvfb-run -a npm test` exits 0 (first run downloads VS Code)
- [x] That run reports the `ContainerTreeDataProvider` suite as **passed, not skipped** — it uses fakes, so it must execute with no Docker present. A skip here means the injection seam is wrong.
- [x] The live `DevContainerFileSystemProvider` suite reports as *skipped* in this environment, and that skip is expected — it is not evidence the FS provider still works

### Host only (requires a Docker socket)

- [ ] `docker ps --filter label=devcontainer.config_file -q` prints at least one id, then `npm test` exits 0 with the live FS suite **running, not skipped**
- [ ] Manual, in an Extension Development Host (F5) with a dev container running:
  - [ ] The "Dev Containers" view appears in the Explorer panel with the running container as a root, and `workspaceFolders` is unchanged (check in the Debug Console: `vscode.workspace.workspaceFolders.length`)
  - [ ] Expanding the container lists its workspace directory, directories before files
  - [ ] Clicking a file opens it; editing and saving writes through to the container (`docker exec <id> cat <path>` confirms)
  - [ ] F2 renames, `Delete` deletes after the modal confirm, `New File` and `New Folder` create — each visible in `docker exec <id> ls`
  - [ ] Dragging a file onto another directory in the same container moves it; dragging a host file from the native Explorer into the tree copies it in
  - [ ] Clicking a folder path in an `Open Folder in Container` terminal reveals it in the tree with no window reload
  - [ ] `docker stop <id>` removes the root from the tree within a few seconds; `docker start <id>` brings it back
  - [ ] `Add Container Folder to Workspace` adds the `[container] <name>` root to the native Explorer

## Relevant Files

| File | Change |
| --- | --- |
| `src/containerTree.ts` | **New.** `ContainerNode`, `ContainerTreeDataProvider`, drag-and-drop controller |
| `src/extension.ts` | Create the tree view; add the six file-operation commands; rewrite `showContainerFileTree`, `refresh`, `revealContainerFolder`, `onContainerStarted`, `onContainerStopped`; delete the workspace-folder machinery |
| `src/devcontainerFs.ts` | Unchanged — listed because the tree depends on its exact `FileSystemError` codes for error messages |
| `src/docker.ts` | Unchanged — `execDocker` is reused for container discovery |
| `src/test/containerTree.test.ts` | **New.** Tree provider tests against fake `ContainerSource` / `FileOps` — runnable without Docker |
| `src/test/extension.test.ts` | `dockerPsIds` now catches a spawn failure so the live suite *skips* instead of erroring when no Docker CLI exists. Pre-existing gap, surfaced by running the suite in a dev container. |
| `package.json` | `contributes.views`, `contributes.commands`, `contributes.menus`, `contributes.keybindings`, remove `autoAttach`, narrow `activationEvents` |
| `README.md` | How it works, Commands table, Settings table |
| `CHANGELOG.md` | Entry for the removed setting and changed command behavior |
| `.plans/PLAN.md` | Status entry and phase row |
| `.vscodeignore` | Exclude `.plans/**` from the packaged `.vsix` |
