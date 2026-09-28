# SSH Tree Sync Actions

Inline **Send** / **Fetch** actions on the folders in an SSH host's tree (Sandboxes view) that
are Git worktrees of a local repo. They are the same flows as the Explorer's
`Send to SSH Host…` / `Fetch from SSH Host…`
([ssh-workspace-sync.md](ssh-workspace-sync.md)), but started from the remote side. The local
folder and the host come from the node, so there are no pickers.

**Depends on** [ssh-workspace-sync.md](ssh-workspace-sync.md), whose code is complete:
`mirror`, `parseWorktrees`, `WORKTREES_SCRIPT`, `makeGit`, `sendToSshHost`, `fetchFromSshHost`,
`syncDeps`, `showSyncError`.

## Detection

A node is marked by matching **local** worktrees against the **remote** worktree listing.
Nothing is guessed from folder names.

1. **Local repos.** For each `file:` workspace folder `W` (realpath'd):
   - The repo containing `W`: `git -C W rev-parse --path-format=absolute --git-common-dir`.
   - Every immediate child directory `W/<name>` that has a `.git` entry (file or directory), handled
     the same way. This covers opening `~/code` itself. Only one level deep.
   - Keep a common dir `C` only when `basename(C) === '.git'`, so bare repos are skipped. The main
     worktree is `P = dirname(realpath(C))`. Dedupe by `P`.
2. **Local worktrees.** For each `P`: `git -C P worktree list --porcelain -z`, parsed with
   `parseWorktrees` (it handles output with no `REFS` marker). Realpath each worktree path and
   drop the ones that fail (prunable). A worktree `mirror` rejects (outside home, or bad
   characters) is dropped and logged once to the `Devc` channel. Nothing is shown for it.
3. **Remote worktrees**, per host `H` and repo `P`: `RP = mirror(P, localHome, sshHome(H))`.
   Run `WORKTREES_SCRIPT` with arg `RP` through `SshShell`, after `checkRemoteGit`. A non-zero
   exit (`RP` missing or not a repo) means no targets for that repo, with nothing shown and
   nothing logged. Run the repos for a host in parallel.
4. **Targets.** For each remote worktree `{ path: R, branch }` of `RP`:
   - If a local worktree `L` of `P` has `mirror(L) === R`, the target is **sync**: `{ remotePath: R, localPath: L, mainWorktree: P, remoteBranch: branch, localBranch }`.
   - Otherwise it is **fetch-only**: `{ remotePath: R, localPath: P, mainWorktree: P, remoteBranch: branch }`. This is a worktree the agent created on the VM, and fetching into `P` brings its branch back.
5. **Cache.** One `Promise<Map<remotePath, Target>>` per host, filled on the first expand of any
   directory under that host. It is cleared (all hosts) by `onDidChangeWorkspaceFolders`,
   `devc-vscode.refresh`, and a change to `devc-vscode.sshHosts`, and cleared for `H` after any
   Send or Fetch to `H` finishes (success or failure). A rejected fill counts as an empty map and
   is not cached.

`devc.hostPath` is **not** checked during detection. The flows check it on use and give their
existing message.

## Contract

### Tree nodes

Only `directory` nodes whose URI scheme is `devc-ssh` are marked. SSH root nodes (`sshHost`)
and container nodes are never marked, even when an SSH root's path is a worktree.

| Target | `contextValue` | `description` | `tooltip` |
| --- | --- | --- | --- |
| sync | `directory.sync` | `<remoteBranch>` | `Worktree of <localPath> — <H> has <remoteBranch>, local has <localBranch>` |
| fetch-only | `directory.fetch` | `<remoteBranch> (not local)` | `Worktree on <H> only — Fetch brings it into <mainWorktree>` |
| none | `directory` (unchanged) | none | none |

An undefined branch (detached or unborn) is shown as `detached`. The match is exact on the
normalized path (no trailing slash). The `resourceUri` and folder icon are unchanged.

A failure to compute targets never breaks listing. Children are listed unmarked.

### Commands

| Command id | Title | Icon | Category |
| --- | --- | --- | --- |
| `devc-vscode.sendFromTree` | `Send from Local` | `$(cloud-upload)` | `Dev Container FS` |
| `devc-vscode.fetchFromTree` | `Fetch to Local` | `$(cloud-download)` | `Dev Container FS` |

- Both are `"when": "false"` in `commandPalette`.
- `view/item/context`:
  - `sendFromTree`: `view == devc-vscode.containers && viewItem == directory.sync`, group
    `inline@1`, and again in group `4_sync@1`.
  - `fetchFromTree`: `view == devc-vscode.containers && viewItem =~ /^directory\.(sync|fetch)$/`,
    group `inline@2`, and again in group `4_sync@2`.
- The existing menus that match `^directory$` (`newFile`, `newFolder`) and `^(directory|file)$`
  (`rename`, `delete`) are widened to `^directory(\.(sync|fetch))?$` and
  `^(directory(\.(sync|fetch))?|file)$`, so marked folders keep every action they had.
- **Handler.** Given a node (the tree passes it as the first argument), take `H = node.uri.authority`
  and the node's target. With no target (a stale node), show
  `<path> is no longer a worktree of a local repo — refresh the Sandboxes view.` Otherwise run
  the existing flow with `folder = target.localPath` and host `H`. Use the same `withProgress`
  title (`<Sending|Fetching> <basename(folder)> — <label>`) and `showSyncError` as the Explorer
  commands. Refactor `syncWithSshHost` so the Explorer and tree paths share everything after
  folder and host are chosen.
- **After Send or Fetch finishes** (success or failure), clear `H`'s cache (Detection 5) and fire
  a tree change for the node's parent. Send may have created a remote worktree, and its branch
  may have changed.

## Checklist

- [x] `workspaceSync.ts`: local repo and worktree discovery (Detection 1–2), and a function that builds a host's target map from local worktrees plus remote `WORKTREES_SCRIPT` results (Detection 3–4). It has no `vscode` import. Git and remote calls come through `SyncDeps`.
- [x] Per-host target cache with the invalidation in Detection 5 (in `extension.ts` or a small class; implementer's choice)
- [x] `containerTree.ts`: an optional injected target source. `getChildren` and `nodeForUri` attach the target to SSH `directory` nodes, and `getTreeItem` sets `contextValue` / `description` / `tooltip` per the table
- [x] `extension.ts`: the two commands, the shared flow runner, and post-sync invalidation and refresh
- [x] `package.json`: commands, inline and context menus, palette hiding, widened `directory` regexes
- [x] Tests (see Validation)
- [x] README: in "Syncing a workspace with an SSH host", a paragraph on the tree actions (what gets marked, sync vs fetch-only, refresh to pick up new worktrees). Add the two commands to the commands table.
- [x] CHANGELOG entry under `### Added`

## Validation

### Offline (dev container)

- [x] `npm run compile` and `npm run lint` exit 0
- [x] `npx mocha --ui tdd out/test/workspaceSync.test.js` passes, including new cases, using the existing fake ssh and temp local and remote homes:
  - A workspace folder that is a main worktree with one linked worktree, both sent: the map has two **sync** targets whose `remotePath`s are the mirrored paths and whose `localPath`s are the local worktrees
  - A workspace folder `~/code` with child repos `a` (sent) and `b` (never sent): targets only for `a`. `b` causes no error.
  - A remote worktree added on the "remote" with `git worktree add` and no local counterpart: a **fetch-only** target with `localPath === P`
  - A remote detached worktree: target with `remoteBranch` undefined
  - A workspace folder outside the local home: no targets, no throw
  - A bare local repo as a child of the workspace folder: skipped
- [ ] `xvfb-run -a npm test` exits 0 (host only if the container lacks Xvfb), with new `containerTree.test.ts` cases using a fake target source: *Not run yet: this container has no Xvfb. The new cases compile and lint.*
  - An SSH directory at a sync target's path gets `contextValue === 'directory.sync'` and `description` = the remote branch. At a fetch-only path it gets `directory.fetch` and `<branch> (not local)`.
  - Unmatched SSH directories and all container directories stay `directory` with no description
  - A target source that rejects still lists the children, unmarked
- [ ] `package.json` check: every `view/item/context` entry for `newFile`, `newFolder`, `rename`, `delete` matches `directory.sync` and `directory.fetch` (a unit test that evaluates the regexes from the manifest) *Written in `src/test/extension.test.ts`, which needs the VS Code test host, so not run here. The same regex logic was checked against `package.json` with plain node and gave the expected result for every entry.*

### Host only (agent sandbox VM)

- [ ] F5 with `~/code/<repo>` open, after one Explorer **Send to SSH Host…**: expanding `~/code` under the SSH root shows `<repo>` with its branch as the description and cloud-upload / cloud-download inline icons. A never-sent sibling repo has no icons.
- [ ] `ssh agent-vm 'git -C ~/code/<repo> worktree add ~/code/<repo>.worktrees/x -b x'`, then Refresh: `x` shows `x (not local)` with only the download icon. **Fetch to Local** opens the review diff for `x` (after a commit there).
- [ ] Commit locally, then **Send from Local** on the node: the VM checkout updates. The node's description follows a branch switch after the send.

## Relevant Files

| File | Change |
| --- | --- |
| `src/workspaceSync.ts` | Local discovery and target map builder |
| `src/containerTree.ts` | Target source seam, and marking of SSH directory nodes |
| `src/extension.ts` | Cache and invalidation, two commands, shared flow runner, refresh after sync |
| `package.json` | Commands, menus, palette hiding, widened regexes |
| `src/test/workspaceSync.test.ts` | Discovery and target-map cases |
| `src/test/containerTree.test.ts` | Marking cases |
| `src/test/extension.test.ts` | Manifest regex check |
| `README.md` | Tree actions paragraph, commands table |
| `CHANGELOG.md` | Entry |
| `.plans/PLAN.md` | Pending entry and phase row |

## Not in this plan

- Marking a remote folder for a local repo that was never sent. That folder doesn't exist
  remotely, so there's no node. The first Send stays the Explorer action.
- Marking SSH root nodes, or folders nested deeper than one level under a workspace folder
  (other than worktrees of a discovered repo, which are found wherever they live).
- Live updates when worktrees change on either side. Use Refresh.
- Creating a local worktree for a fetch-only remote worktree.
