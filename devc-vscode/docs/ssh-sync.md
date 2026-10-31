# Syncing with an SSH host

**Send to SSH Host…** and **Fetch from SSH Host…** move a Git repo's commits to a configured SSH host and back, with plain `git` over plain `ssh`. You always start the transfer, and only committed work moves.

## Paths

The folder must be the root of a Git repository or worktree under your home folder. It lives at the **same path relative to home** on the host:

- `~/code/some-repo` goes to `~/code/some-repo`.
- A worktree `~/code/some-repo.worktrees/some-feature` becomes a worktree at the same path, of the host's `~/code/some-repo`.

So paths an agent prints read the same as yours. The local repo gets a Git remote named after the host alias (e.g. `agent-vm`), shared by all its worktrees.

## Send

Send pushes the folder's current branch.

- The first send creates the host repo, set to update its checkout when pushed to (`receive.denyCurrentBranch updateInstead`) and marked with the local path it came from (`git config devc.hostPath`). A repo at that path created from somewhere else is refused.
- Pushing to a branch checked out on the host asks first, because a clean checkout there is updated in place. A checkout with uncommitted changes refuses the push.
- Send never force-pushes.

## Fetch

Fetch downloads the host's branches into `<host>/<branch>` and opens a multi-file diff of the changed branch against where it split from yours. It **never merges or checks out anything**: merge yourself, for example from Source Control.

Merging agent commits into an open, trusted folder applies them at once. So files that can run code without you running them are listed first in the diff and named in a warning:

- `.vscode/`, `.devcontainer/`, `.github/`, `.husky/`
- `.gitmodules`, `.gitattributes`, `.envrc`
- any `package.json`, `.npmrc`, `Makefile`, `*.code-workspace` or `.pre-commit-config.yaml`

Fetch also warns when the host has uncommitted changes, which it can't bring back.

## From the SSH host's tree

In the Sandboxes view, folders on an SSH host that are worktrees of a local repo have inline **Send from Local** and **Fetch to Local** buttons, with the host's branch beside the name. They run Send and Fetch with the matching local worktree, so there is nothing to pick.

- **Which folders:** a folder is marked when the host's `git worktree list` for the mirrored repo includes it. The local repos checked are the ones each workspace folder is in, plus repos directly inside a workspace folder (so opening `~/code` works).
- **Host-only worktrees:** a worktree an agent created on the host shows `<branch> (not local)` with **Fetch to Local** only, which fetches into the local main worktree.
- **First send:** a repo that was never sent has no folder on the host, so send it from the Explorer first.
- **Updates:** marks are computed on first expand, and recomputed after each Send or Fetch, when workspace folders change, and on **Refresh**.

## Requirements

- Git 2.36 or newer on the host.
- git's ssh gets the same forced options as every other ssh the extension runs (through `GIT_SSH_COMMAND`, overriding `core.sshCommand`), plus `BatchMode=yes`.
- The review diff uses VS Code's built-in Git extension.
