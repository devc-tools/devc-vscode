# SSH Workspace Sync

Send a workspace folder's Git repo to an SSH host, and fetch the agent's commits back for review,
from Explorer actions. The repo lives at the **same home-relative path** on both sides
(`~/code/some-repo`, `~/code/some-repo.worktrees/some-feature`), so the two sides never
collide and paths the agent prints read the same as yours.

Everything is plain `git` over plain `ssh`, started from the local machine. The remote never
connects back, and nothing is merged or checked out locally on the user's behalf.

**Depends on** [ssh-environments.md](ssh-environments.md), whose code is complete: `SshShell`,
`SSH_SAFETY_OPTIONS`, `controlOptions`, `ensureControlDir`, `devc-vscode.sshHosts` /
`sshPath`, the `devc-ssh` provider, and SSH terminal links.

## Background

- **Why fetch never merges:** a local workspace folder is trusted, so once agent commits land
  in it VS Code applies the agent's `.vscode/settings.json`, folder-open tasks and similar on
  the host. Review before merge is the only safeguard. The fetch action exists to make that
  review easy and to flag the paths that run code.
- **Why git's ssh needs our options:** `git push` / `git fetch` start their own ssh, which reads
  only `~/.ssh/config`. Without `GIT_SSH_COMMAND` the extension's "every ssh forwards nothing"
  guarantee would not cover these commands.

## Decisions

1. **Mirroring rule.** `mirror(localPath) = remoteHome + localPath.slice(localHome.length)`. `localHome` = `fs.realpathSync(os.homedir())`. `remoteHome` = the
   existing per-host resolved `$HOME` (`sshHome`). Before mapping, a local path is
   `fs.realpathSync`'d and must equal `localHome` or start with `localHome + '/'`. Otherwise the
   action fails with `<path> is outside your home folder — only folders under ~ can be sent.`
   Compare exactly, with no case folding.
   **Gotcha:** on macOS, `uri.fsPath` and `os.homedir()` can differ from their realpaths through
   symlinks such as `/tmp` or a relocated home. Realpath both before relating them.

2. **One remote repo per local repo, at the mirrored path of its main worktree.** For a folder
   `F`:
   - `T` = `git -C F rev-parse --show-toplevel`. `F` must equal `T` after realpath, else
     `<F> is not the root of a Git repository or worktree.`
   - `C` = `git -C F rev-parse --path-format=absolute --git-common-dir`. If
     `basename(C) !== '.git'`, fail with `Bare repositories are not supported.` Otherwise the main
     worktree is `P = dirname(C)`.
   - The remote paths are `RP = mirror(P)` and `RT = mirror(T)`. `T === P` means `F` is the
     main worktree.
   - Paths containing `'`, `\`, a newline, or any control character are refused with
     `<path> contains characters that can't be sent over ssh.`

3. **Git remote.** Named exactly the host alias (e.g. `agent-vm`), with URL `<host>:<RP>`
   (scp-like). If a remote with that name exists and its URL (`git remote get-url <host>`) is
   different, fail with
   `Remote "<host>" already points at <url> — rename or remove it to sync with <host>.` Never
   rewrite it. Worktrees share config, so one remote serves every worktree of the repo.

4. **Every git process** runs through `execFile('git', args, { cwd, env, timeout })`. `git` comes
   from `PATH`, with **no** `git.path` lookup. Timeouts: 120 s for `push` / `fetch`, 30 s
   otherwise. `env` = `process.env` plus:

   ```
   GIT_SSH_COMMAND=<shQuote(sshPath)> -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no -o BatchMode=yes [<controlOptions> each shQuote'd]
   GIT_SSH_VARIANT=ssh
   GIT_TERMINAL_PROMPT=0
   ```

   Build the forwarding flags from `SSH_SAFETY_OPTIONS` and `controlOptions(ensureControlDir())`
   so they can't drift. Each element is `shQuote`d, because git runs `GIT_SSH_COMMAND` through
   a shell. `GIT_SSH_COMMAND` overrides the user's `core.sshCommand`, which is intended. Log
   every git argv and its stderr to the `Devc` output channel.

5. **Remote-side commands** go through the existing `SshShell` runner (`sh -c <script> sh <args…>`,
   30 s timeout). The scripts are constants, and paths are passed only as positional args. The
   exact scripts are under [Remote scripts](#remote-scripts).

6. **Ownership record.** A repo created by this extension gets
   `git config devc.hostPath <P>` (the local main worktree's realpath). Send and Fetch refuse a
   repo at `RP` whose `devc.hostPath` is missing or different:
   `<host>:<RP> exists but wasn't created from <P> — move it aside on <host> to sync.`

7. **Hand-off rule.** Send never moves a branch that the agent has checked out without a modal
   confirm. See Send, step 6.

8. **Fetch never merges, checks out, resets or rebases** anything locally. It fetches, then opens
   a review diff.

## Contract

### Settings

None new. The host list is `devc-vscode.sshHosts`.

### Commands and menus

| Command id | Title | Category |
| --- | --- | --- |
| `devc-vscode.sendToSshHost` | `Send to SSH Host…` | `Dev Container FS` |
| `devc-vscode.fetchFromSshHost` | `Fetch from SSH Host…` | `Dev Container FS` |

- `explorer/context`, group `devc@1`, for both sync commands:
  `explorerResourceIsFolder && resourceScheme != devc-vscode && resourceScheme != devc-ssh`.
  The handler rejects a non-`file:` URI, and a folder that isn't a repo or worktree root fails
  with decision 2's message. That makes it a repo-root action rather than a workspace-root one.
  **Gotcha:** Explorer resource context keys are unset on the first right-click, so a positive
  `resourceScheme == file` (or `explorerResourceIsRoot`) test can hide the item. This is the
  same reasoning as `openFolderInContainer`'s `when`. With no hosts configured, the handler
  reports `No SSH hosts configured — use Add SSH Host…`.
- Invoked from the palette, the sync commands pick the folder: the only `file:` workspace
  folder, else a `showWorkspaceFolderPick`.
- **Host choice**, for both commands: with one configured host, use it. With several,
  `showQuickPick` of `label ?? host` (description `host`). A cancel aborts silently.
- Everything runs inside `withProgress({ location: Notification, title: '<Sending|Fetching> <repo basename> — <host>' })`.

### Send to SSH Host…

For folder `F` and host `H`, in order. Any failure stops the flow and shows
`showErrorMessage(<message>)`. Git or remote stderr gets a **Show Log** button that reveals the
`Devc` channel.

1. Resolve `T`, `C`, `P`, `RP` and `RT` (decisions 1–2).
2. `B` = `git -C T symbolic-ref --quiet --short HEAD`. If it fails, error with
   `<T> is on a detached HEAD — check out a branch to send it.`
3. Run the remote script `ensure-repo` with args `RP P <initBranch>` (below). `<initBranch>` is
   `B` when `T === P`, otherwise the local main worktree's branch
   (`git -C P symbolic-ref --quiet --short HEAD`). A new repo's main worktree must not start on
   `B` when `B` needs its own worktree, because Git won't check one branch out in two worktrees.
   If `P` is detached, fail with
   `<P> (the main worktree) is on a detached HEAD — check out a branch there first.` Exit 3 means
   `<H>:<RP> exists and is not a Git repository.` Exit 4 is the decision 6 message.
4. Ensure the local remote (decision 3): `git -C T remote add H H:RP` when absent.
5. Run the remote script `worktrees` with arg `RP`, and parse its output (below) into
   `{ path, branch }[]`. `branch` is undefined for detached or unborn heads.
6. **Hand-off check.** Find the remote worktrees whose `branch === B`. If any exist, **and**
   `refs/heads/B` already exists on the remote (the same listing's `refs` section), show:
   `showWarningMessage('<B> is checked out on <H> at <path>. Pushing updates the files there if that checkout is clean. Continue?', { modal: true }, 'Push')`.
   Anything but **Push** aborts. The first push into a fresh repo (unborn `B`) doesn't prompt.
7. `git -C T push H refs/heads/B:refs/heads/B`, with no `--force`. On failure, show git's last
   stderr line. That covers non-fast-forward and "updateInstead" refusals caused by a dirty
   remote checkout.
8. **Worktree mirroring.** Only when `T !== P` and no remote worktree has `path === RT`: run the
   remote script `add-worktree` with args `RP RT B`. Exit 5 means
   `<H>:<RT> already exists and is not a worktree of <RP>.`
9. If the remote worktree at `RT` exists and its `branch` isn't `B` (re-read with step 5's
   script), show
   `showInformationMessage('Sent <B>. <H> has <other> checked out at <RT>.', 'Check Out <B> on <H>')`.
   The button runs `git -C RT switch B` remotely through `SshShell` and shows its stderr on
   failure. This doesn't apply on the first send, when step 3 creates the repo with `B`.
10. Local uncommitted changes (`git -C T status --porcelain` non-empty) are reported once, after
    success: `Sent <B> to <H>. Uncommitted local changes were not sent.` Otherwise the message
    is `Sent <B> to <H>.`

### Fetch from SSH Host…

1. Resolve `T`, `P` and `RP`. The local remote `H` must exist with URL `H:RP`. If it's absent,
   fail with `<repo basename> hasn't been sent to <H> yet — use Send to SSH Host first.` A
   different URL gets the decision 3 message.
2. Run `ensure-repo` in check mode (args `RP P ''`, where an empty branch means "don't create").
   Exit 6 means `<H>:<RP> no longer exists.` Exit 3 and 4 are as in Send.
3. Run the remote script `dirty` with arg `RP`. It prints `<count>\t<worktree path>` per remote
   worktree with uncommitted changes. Keep these for step 7.
4. Snapshot `git -C T for-each-ref --format='%(refname) %(objectname)' refs/remotes/H/`, then
   run `git -C T fetch --prune H`, then snapshot again. **Changed** refs are new ones, or ones
   whose sha differs. Deleted refs are ignored.
5. If nothing changed: `No new commits on <H>.`, plus step 7's warning if any. Stop.
6. Pick a branch: with one changed, use it. With several, `showQuickPick` of the branch names
   (`refs/remotes/H/<b>` → `<b>`), with the description `new` or `updated`.
7. If step 3 found uncommitted changes, show (not modal)
   `<H> has uncommitted changes that weren't fetched: <path> (<count> files)[, …]`.
8. **Review diff.** Compute `base`:
   - If local `refs/heads/<b>` exists, `base = git merge-base refs/heads/<b> refs/remotes/H/<b>`.
   - Otherwise `base = git merge-base HEAD refs/remotes/H/<b>`.

   `files = git diff --name-status -z --no-renames <base> refs/remotes/H/<b>`. Build URIs with
   the built-in Git extension's API (`vscode.extensions.getExtension('vscode.git').exports.getAPI(1).toGitUri(fileUri, ref)`).
   The original side uses `base`, and the modified side uses `refs/remotes/H/<b>`. For an added
   file the original is `undefined`, and for a deleted file the modified side is `undefined`.
   Open it with
   `vscode.commands.executeCommand('vscode.changes', '<H>/<b> vs <local b or HEAD>', resources)`,
   where each resource is the triple `[Uri.file(<T>/<path>), originalUri | undefined, modifiedUri | undefined]`.
   If the Git extension is unavailable, fail with
   `The built-in Git extension is disabled — it's needed to show the review diff.`
9. **Sensitive paths** go first in `resources`. If any exist, show before the diff opens (not
   modal):
   `These changes touch files that can run code on this machine — review them before merging: <paths, comma-separated, max 5, then "and N more">`.
   The match is on the repo-relative path, and the patterns are exact:

   ```
   .vscode/**   .devcontainer/**   .github/**   .husky/**   .gitmodules   .gitattributes   .envrc
   **/package.json   **/.npmrc   **/Makefile   **/*.code-workspace   **/.pre-commit-config.yaml
   ```

10. Nothing else. No merge, no checkout. The Source Control view's normal merge is how the user
    proceeds.

### Remote scripts

POSIX `sh`. The arguments are positional. Each script is a constant in the source and runs as
`sh -c <script> sh <args…>` via `SshShell`. They run in the remote login's default directory,
and every path is absolute.

`ensure-repo` (args: `repo hostPath branch`):

```sh
repo="$1"; host_path="$2"; branch="$3"
if [ -e "$repo" ]; then
  [ -d "$repo/.git" ] || exit 3
  [ "$(git -C "$repo" config --get devc.hostPath)" = "$host_path" ] || exit 4
  exit 0
fi
[ -n "$branch" ] || exit 6
mkdir -p "$(dirname "$repo")" &&
git init -q -b "$branch" "$repo" &&
git -C "$repo" config receive.denyCurrentBranch updateInstead &&
git -C "$repo" config devc.hostPath "$host_path"
```

`worktrees` (arg: `repo`). It prints the `git worktree list --porcelain -z` output, then a
`\0\0REFS\0` separator, then the branch names:

```sh
git -C "$1" worktree list --porcelain -z && printf '\0\0REFS\0' &&
git -C "$1" for-each-ref --format='%(refname:short)%00' refs/heads/
```

Parse the porcelain output: records are separated by an empty `\0` field. `worktree <path>`
starts a record, and `branch refs/heads/<b>` sets its branch. **Gotcha:** an unborn branch in a
fresh repo shows `branch refs/heads/<b>` but has no ref yet. The `REFS` section is what says
whether the ref exists.

`add-worktree` (args: `repo worktree branch`):

```sh
if [ -e "$2" ]; then exit 5; fi
mkdir -p "$(dirname "$2")" && git -C "$1" worktree add -q "$2" "$3"
```

`dirty` (arg: `repo`):

```sh
git -C "$1" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
  n=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && printf '%s\t%s\n' "$n" "$wt"
done; true
```

The remote-side Git version must be ≥ 2.36: `worktree list -z` needs 2.36, which also covers
`updateInstead` honoring linked worktrees and `init -b` (2.28). Check `git --version` once per
host per session before the first remote script, and fail with
`<H> has Git <v>; 2.36 or newer is needed.` Ubuntu 24.04 ships 2.43.

## Checklist

- [x] Pure module: `mirror`, path-character check, worktree-listing parser, sensitive-path matcher, `GIT_SSH_COMMAND` builder
- [x] Git runner (`execFile`, env from decision 4, timeouts, `Devc` logging)
- [x] Remote scripts as constants, run via `SshShell`; remote Git version check
- [x] `sendToSshHost` flow (Send steps 1–10)
- [x] `fetchFromSshHost` flow (Fetch steps 1–10), review via `vscode.changes` + Git extension `toGitUri`
- [x] `package.json`: commands and menus
- [x] Tests (see Validation)
- [x] README: a new "Syncing a workspace with an SSH host" section (mirroring rule, Send / Fetch behavior, hand-off rule, "fetch never merges" + sensitive paths, only committed work moves), the two commands in the commands table
- [x] `ssh-environments.md` "Not in this plan": replace the "Open Folder in SSH Host … host paths don't map" bullet with a pointer to this plan
- [x] CHANGELOG entry

## Validation

### Offline (in a dev container: no Docker, no ssh host)

- [x] `npm run compile` and `npm run lint` exit 0
- [ ] `xvfb-run -a npm test` exits 0 with the new suites **passing, not skipped**. Not run yet: the devc-dev container has no Xvfb or `libglib-2.0`, so VS Code's test host can't start there. `src/test/workspaceSync.test.ts` has no `vscode` import, and `npx mocha --ui tdd out/test/workspaceSync.test.js` passes 24/24 there.
- [x] Unit tests cover:
  - `mirror`: home itself, a nested path, outside home, a sibling prefix (`/Users/bo` vs `/Users/bob`), and rejected characters
  - worktree-listing parsing: main-only, main plus linked, detached, unborn branch, and a path with a space
  - the sensitive-path matcher against every pattern, plus non-matches (`src/package.json.bak`, `docs/.vscode.md`)
  - the `GIT_SSH_COMMAND` string: contains every `SSH_SAFETY_OPTIONS` flag, `BatchMode=yes`, and a quoted `sshPath` with a space
- [x] **End-to-end with a fake ssh:** a test script set as `devc-vscode.sshPath` that ignores its options and host, sets `HOME` to a temp "remote home", and runs `sh -c "<last argument>"`. It serves both `SshShell` and git's `GIT_SSH_COMMAND`. Local and remote homes are both temp dirs (make the local home injectable). Cases:
  *(As built, the fake ssh is passed as `sshPath` to `SshShell` and `gitSshCommand` through injected `SyncDeps`, not set in settings. A further case checks that git's own ssh receives every forwarding option.)*
  - First Send from a main worktree creates `RP` with `devc.hostPath`, `receive.denyCurrentBranch=updateInstead`, and `B` checked out with the files present
  - Send from a linked worktree `~/code/r.worktrees/f` creates the remote worktree `~/code/r.worktrees/f` on branch `f`
  - A second Send with new commits updates the remote checkout (clean), and is refused with git's error when the remote checkout is dirty
  - The hand-off modal is requested when `B` exists and is checked out remotely (stub `showWarningMessage` and assert on its message), and isn't requested on the first send
  - A mismatched `devc.hostPath` fails with the decision 6 message, and an existing remote `H` with another URL fails with the decision 3 message and isn't changed
  - Fetch after a remote commit on `B` reports one changed ref and passes `vscode.changes` a resource list whose first entry is a sensitive path when the commit touched `.vscode/settings.json`. Stub `executeCommand` to capture it
  - Fetch with a dirty remote worktree produces the step 7 warning
  - The local repo's `HEAD`, branches and working tree are byte-identical before and after Fetch (no merge or checkout)
### Host only (the agent sandbox VM, `Host agent-vm`, host key accepted)

- [ ] Manual, F5: right-click a repo root under `~/code` → **Send to SSH Host…**. `ssh agent-vm ls ~/code/<repo>` shows the files, and `ssh agent-vm git -C ~/code/<repo> config devc.hostPath` prints the Mac path
- [ ] Same from a `~/code/<repo>.worktrees/<branch>` worktree, which creates the matching remote worktree
- [ ] Commit on the VM, then **Fetch from SSH Host…**: the multi-diff opens with the change, and local `git status` / `git log -1` are unchanged
- [ ] `ps -ef | grep 'ssh .*agent-vm'` during a push shows `ForwardAgent=no` and `ClearAllForwardings=yes` on git's ssh

## Relevant Files

| File | Change |
| --- | --- |
| `src/workspaceSync.ts` | **New.** Mirroring, path checks, worktree parser, sensitive paths, git runner, remote scripts, Send and Fetch flows |
| `src/extension.ts` | Register the two commands |
| `src/remoteShell.ts` | Export whatever `GIT_SSH_COMMAND` needs if not already exported (reuse `SSH_SAFETY_OPTIONS`, `controlOptions`, `shQuote`) |
| `src/test/workspaceSync.test.ts` | **New.** Unit and fake-ssh end-to-end tests |
| `src/test/fixtures/fake-ssh.sh` | **New.** The fake ssh |
| `package.json` | Commands and menus |
| `README.md` | New sync section; commands table |
| `CHANGELOG.md` | Entry |
| `.plans/ssh-environments.md` | "Not in this plan" bullet updated |
| `.plans/PLAN.md` | Pending entry and phase row |

## Not in this plan

- Syncing uncommitted files or non-Git folders (the tree's drag-to-copy already copies files in).
- Merging, rebasing or checking out fetched work locally.
- Force pushes, deleting remote branches, or cleaning up remote worktrees.
- Paths outside home, bare repos, and submodules (they're not sent, and nothing in them is initialized remotely).
- Multi-repo "send the whole workspace" in one action. Each workspace folder is sent on its own.
- Opening local files from terminal links or remote editors. SSH terminal links keep opening the host's copy over ssh (`devc-ssh://`), as they already do, because the local copy may not match.
- Updating `devc-dev`'s agent-sandbox README (`~/work/REPO` → the mirrored layout). Follow-up there.
