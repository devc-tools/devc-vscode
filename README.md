# Dev Container File Tree

Browse, edit and run agents in your dev containers and SSH sandboxes from VS Code on the host, with no remote server and no container attach.

- **Sandboxes view:** the files of every running dev container for your workspace, plus any SSH hosts you add.
- **Agents view:** the coding agents [herdr](https://herdr.dev) is running in those containers, on SSH hosts and on this machine, with their status.
- **Terminals:** file paths printed in container and SSH terminals are clickable.
- **Send / Fetch:** move a Git repo's commits to an SSH host and review what comes back.

## Why

VS Code's remote extensions (Dev Containers, Remote-SSH) install a VS Code server on the remote and pass your credentials through to it: git credential helpers, your ssh agent, your `.gitconfig`. Anything running there, including a coding agent, can use them.

This extension keeps the remote at arm's length. It installs nothing there, reads and writes files with plain `docker exec` and `ssh`, forces ssh agent and port forwarding off, and never opens an SSH host as a workspace. You get files, terminals and agent status for a sandbox without handing the sandbox your keys. See [Security model](docs/how-it-works.md#security-model) for what that does and doesn't cover.

## Install

1. Build and install the extension (Node 24, see `.nvmrc`):

   ```sh
   npm install
   npm run package:dev   # compiles, builds devc-vscode-dev.vsix and installs it with `code`
   ```

2. Install the tools for the features you want. Each one is optional, and the extension offers only what the installed tools support.

   | Tool | Gives you |
   | --- | --- |
   | [Docker](https://docs.docker.com/get-docker/) | Dev container files, terminals, links and agents |
   | [devc](https://github.com/devc-tools/devc-tools) | One-click start, stop and create for dev containers |
   | [herdr](https://herdr.dev) on this machine | Agents on this machine |
   | herdr in a container or on an SSH host | Agents there |
   | ssh and git | SSH hosts and Send / Fetch |

Run VS Code on the host, not in a container-attached window.

## Quick start

### Dev containers

1. Open your project folder in VS Code.
2. Start its dev container: right-click the folder in the Explorer and choose **Open Folder in Container**, or run `devc herdr` in a terminal. A container started by the devcontainer CLI or VS Code Dev Containers works too.
3. The container appears in the Explorer's **Sandboxes** view. Expand it to browse and edit its files.

Click the terminal icon on the container to open a terminal in it.

### Agents

1. In the **Agents** view, click **+** on **Workspace**.
2. Pick where to run it (this machine, a dev container or an SSH host), then which agent.

Each agent shows as working, blocked, done or idle. The view's badge counts agents waiting on you. Click an agent to jump to its terminal.

### SSH hosts

1. Make sure `ssh <host>` connects without a password prompt. Run it once in a terminal to accept the host key.
2. Click **+** in the Sandboxes view's title bar (**Add SSH Host…**), pick the alias from `~/.ssh/config`, and choose a start directory.

The host gets a root in Sandboxes and an entry under **SSH Hosts** in the Agents view.

### Send / Fetch

Right-click a Git repo folder in the Explorer:

- **Send to SSH Host…** pushes your current branch to the same path under home on the host.
- **Fetch from SSH Host…** brings the host's branches back and opens a review diff. You merge yourself.

On an SSH host's tree, folders that are worktrees of a local repo have inline **Send from Local** and **Fetch to Local** buttons.

## Using the views

### Sandboxes

| Action | How |
| --- | --- |
| Open a file | Click it |
| See outside `/workspaces` | Click the filter button in the title bar; containers show only `/workspaces` until you do |
| New file / folder | Right-click a container, SSH host or folder |
| Rename | <kbd>F2</kbd>, or right-click |
| Delete | <kbd>Delete</kbd>, or right-click (multi-select works) |
| Move | Drag within a container or SSH host |
| Copy in | Drag from the Explorer, or from another container or SSH host |
| Copy the path inside the container | Right-click → **Copy Container Path** |
| Open a terminal | Terminal icon on a container or SSH host |

Deletes are permanent. Containers and SSH hosts have no trash.

### Container paths for host files

Right-click a host file → **Copy Container Path** to copy the path the file is bind-mounted at in a running container. The action is on:

- the Explorer (multi-select works)
- editor tabs, including GitHub Pull Requests review diffs
- files in the GitHub Pull Requests views (**Changes in Pull Request** and the files under each pull request)

The most specific bind mount wins. When two containers mount the same folder, the one whose project folder holds the file is used.

### Focus on features

**Focus Features…** (command palette, or the `…` menu of the Sandboxes or Agents view) lists every repo and Git worktree behind the workspace: the repos your folders are in, and the ones a running dev container mounts under `/workspaces`, such as `project` and the branches in `project.worktrees`. Tick the ones to work on. They become workspace folders, the rest are removed, and the Source Control view follows.

This command, **Focus on Active Agents** and **Add Active herdr Space to Workspace** are off by default. Set `devc-vscode.featureFolders` to `true` to turn them on.

- The first workspace folder always stays, and so do folders that are not repos or worktrees.
- Everything a running dev container for the workspace mounts under `/workspaces` stays on the list, so a removed folder can be picked again. The container is found from its project folder, the folder of the `.code-workspace` file, or any open folder it mounts.
- A repo whose folder is removed is closed in Source Control, even with one of its files still open in an editor. VS Code remembers the close for the workspace: the repo stays out of Source Control, even after a reload or when its folder is added back by hand, until **Git: Reopen Closed Repositories…**.
- Each change is written to the `.code-workspace` file. A linked worktree is added under the name `repo/folder`, such as `project/feature-a`; a repo's main folder keeps its own name.

#### Workspace Folders

The **Workspace Folders** view in the Explorer keeps a standing list instead of a one-shot picker.

1. Click **+** (**Pin Folder…**) and pick one or more folders. A repo is listed with its Git worktrees under it, and picking a worktree pins its main repo. Any other folder is pinned by itself.
2. Tick or untick a folder, a repo (its main folder) or any of its worktrees. Changed rows are marked *will open* or *will close*.
3. Click **✓** (**Apply**) to add and remove the folders, or **Discard Changes** to drop the ticks.

Source Control follows, as with Focus Features…. If a repo you opened hasn't appeared there after a few seconds, a warning offers **Reopen Closed Repositories** and **Reload Window**.

- The window's first folder is always listed first, pinned automatically: its repo when it is a repo or a worktree, else the folder itself. Its row says *workspace root* and has no checkbox, since it always stays in the workspace.
- Other pins belong to that first folder, so they survive a reload and a single-folder window becoming multi-root.
- **Unpin** (the **×** on a pin) only takes it off the list. Its folders stay.
- Worktrees added or removed outside VS Code show up on **Refresh** or when the view is shown again.
- The view does not need `devc-vscode.featureFolders`. Hide it from the Explorer's `…` menu if you don't use it. Like Focus Features…, a repo it closes stays closed in this workspace until it is opened again here or with **Git: Reopen Closed Repositories…**.

Three more commands tie features to herdr in the dev container. None runs by itself:

| Command | What it does |
| --- | --- |
| **Focus on Active Agents** | Makes the workspace's features the ones your agents are working in |
| **Open herdr Space for Feature…** | Creates a herdr space labelled `project / branch`, starting in that feature's folder in the container that mounts it |
| **Add Active herdr Space to Workspace** | Adds the repo or worktree herdr's focused pane is in as a workspace folder |

**Add Agent** on a feature folder starts the agent in the running container that mounts it, in the feature's folder.

#### Window title

In a saved `.code-workspace`, the window title can name the branch herdr's focused pane is working in, such as `feature-a (my-workspace)`, so a time tracker reading window titles sees which branch you are on. It follows herdr's focus, not the active editor.

- This is off by default. Set `devc-vscode.windowTitle` to turn it on, for example to `${branch} (${rootNameShort})`. Set it back to `null` to turn it off and restore your own title. `${branch}`, `${project}`, `${folder}`, `${space}` (the herdr space's label) and `${title}` (the title the pane's program sets, such as what an agent is doing) come from the focused pane; anything else, such as `${rootNameShort}` or `${activeEditorShort}`, is one of `window.title`'s own variables.
- `${title}` is empty for a shell whose title only names its folder. Surround it with VS Code's `${separator}`, which is dropped next to an empty value: `${project}:${branch}${separator}${title}${separator}devcd` gives devc web's title, `devc-tools:main — Fixing the title — devcd`, with `window.titleSeparator` set to ` — `.
- The title returns to your own `window.title` when the focused pane is not in a repo on this machine, or herdr is not running.
- The title is written to `window.title` in the `.code-workspace` file each time the feature changes, so a workspace file tracked in Git will show a diff.

### Agents

- **Workspace** holds this machine's herdr session for the window, and each running dev container.
- **SSH Hosts** holds each reachable SSH host.
- **Other Workspaces** holds agents in your other VS Code windows. Clicking one switches to that window.

Hover over a row for its actions: **Attach Terminal**, **Add Agent**, **Stop / Down Container**, and **Stop / Delete herdr Session**. **Close Agent** ends an agent's herdr pane or terminal.

### Ask an agent about code

Ask a herdr agent in a dev container about a host file you're reading, including either side of a Git diff or a GitHub Pull Requests review diff. The file must be bind-mounted into a running container.

1. Click the gutter **+** on a line (or drag across lines) and pick **Agent (devc)** if VS Code asks which provider to use. Or select lines and right-click → **Ask Agent About Selection**, which skips that question.
2. Type your question and click **Ask Agent**. It's typed into the agent's herdr pane with the file's container path, the line range and the selected code.
3. The agent's answer appears as a reply in the thread. Reply again in the same thread to ask a follow-up.

The thread's header names the version of the file it's about (`Working tree`, the Git diff's ref, or the PR diff side and commit) and, once sent, the agent answering.

With several agents in the container, you pick one the first time; later threads reuse it. Threads stay in the window until it reloads and are never posted to GitHub. On each thread, **Show Agent** jumps to the agent's pane and **Delete Thread** removes it. A question that couldn't be sent is marked **Not sent**, with **Resend** beside it.

Claude Code in its default permission mode asks before writing the reply file; approve it in the agent's pane to see the answer.

### devc web

The **devc web** view in the activity bar shows [devc web](https://github.com/devc-tools/devc-tools)'s sidebar: containers, panes in use, pinned files and tasks. **Open devc web Tiles** (the globe in the view's title bar) opens its tiling area of terminals, files and diffs in VS Code's integrated browser. A pane or file clicked in the view opens in the tiles.

- Every VS Code window shares one `devc web --no-open` the extension runs on port `devc-vscode.devcWebPort` (48229, so it doesn't clash with a devc web you run yourself on 48228), started by the first window that shows either. It stops about 10 seconds after the last window using it closes or reloads away, even after a crash. Its token is kept in VS Code's secret storage for the other windows; nothing logs it or writes it to a file.
- **Restart devc web** starts a new one, with a new token, for every window. The views reload; a tiles tab still points at the old server, so reopen it.
- To run devc web from a devc-tools checkout before publishing, set `devc-vscode.devcWebDevc` to `"devc2"`. The `devc2` alias is a shell function the extension can't call, so it runs `$DEVC_BIN`, the same from-source command that sourcing devc-tools' `scripts/bash_aliases.sh` exports. It's read from VS Code's environment, else your login shell's. An absolute path to a devc binary works too.
- Pass extra arguments in `devc-vscode.devcWebArgs`, such as `["--live"]`.
- The view and the tiles start in zen mode: the focused tile alone, and in the sidebar its repo card and Tasks. Set `devc-vscode.devcWebZen` to `container` to show its whole container instead, or `off`. The zen button and `Ctrl+Alt+Z` still toggle it; the setting is only where they start. It needs a devc web new enough to read `?zen=`; an older one ignores it.
- The view needs a devc whose devc web allows being framed by VS Code (devc-tools' `devc-web-vscode-embedding`). Until then it stays blank; the tiles in the integrated browser work regardless.
- The view's layout and settings are stored apart from the same page's in a browser tab.

### Terminal links

In container and SSH terminals, click a printed path to open it. A `:line:col` suffix jumps to that spot, and a folder is revealed in the Sandboxes view.

## Commands

All commands are under **Dev Container FS** in the command palette.

| Command | What it does |
| --- | --- |
| Refresh Container Files | Re-read the Sandboxes view and re-check installed tools |
| Open Folder in Container | Run `openFolderCommand` in a terminal for a host folder |
| Add SSH Host… | Add an alias from `~/.ssh/config` to `sshHosts` |
| Focus Features… | Pick which repos and worktrees are workspace folders (see [Focus on features](#focus-on-features)) |
| Focus on Active Agents | Make the workspace's features the ones your agents are working in |
| Open herdr Space for Feature… | Create a herdr space for a repo or worktree in its dev container |
| Add Active herdr Space to Workspace | Add the focused herdr pane's repo or worktree as a workspace folder |
| Send to SSH Host… / Fetch from SSH Host… | Sync a local repo with an SSH host |
| Send from Local / Fetch to Local | The same, from an SSH folder in the Sandboxes view |
| New File, New Folder, Rename, Delete, Copy Container Path | Act on the Sandboxes selection |
| Open devc web Tiles | Open devc web's tiles in the integrated browser (see [devc web](#devc-web)) |
| Restart devc web | Restart the shared devc web, with a new token, for every window |
| Ask Agent About Selection | Open an agent comment thread on the selected lines (see [Ask an agent about code](#ask-an-agent-about-code)) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `devc-vscode.dockerPath` | `docker` | Docker CLI (name on PATH or absolute path) |
| `devc-vscode.openFolderCommand` | `devc herdr` | Run by Open Folder in Container and a container's Attach Terminal |
| `devc-vscode.herdrAttachCommand` | `devc herdr` | Opens a terminal on a container's herdr from the Agents view |
| `devc-vscode.stopCommand` | `devc stop` | Run by Stop Container |
| `devc-vscode.downCommand` | `devc down` | Run by Down Container |
| `devc-vscode.agentKinds` | `["claude", "copilot", "pi"]` | Agents offered by Add Agent (herdr `--kind` values) |
| `devc-vscode.herdrSession` | *(from folder)* | herdr session for this window, on this machine and SSH hosts |
| `devc-vscode.featureFolders` | `false` | Turns on the commands that change workspace folders from features (see [Focus on features](#focus-on-features)) |
| `devc-vscode.windowTitle` | `null` | The window title while herdr's focused pane is in a repo or worktree, such as `${branch} (${rootNameShort})`; `null` turns it off (see [Window title](#window-title)) |
| `devc-vscode.devcWebDevc` | `installed` | Which devc runs devc web: `installed`, `devc2` (`$DEVC_BIN`, from source) or an absolute path (also per workspace) |
| `devc-vscode.devcWebPort` | `48229` | The port of the devc web every window shares (see [devc web](#devc-web)) |
| `devc-vscode.devcWebZen` | `repo` | How the devc web view and tiles start: zen mode by `repo` card or `container`, or `off` (see [devc web](#devc-web)) |
| `devc-vscode.devcWebArgs` | `[]` | Extra arguments after `devc web --no-open` (also per workspace; see [devc web](#devc-web)) |
| `devc-vscode.sshHosts` | `[]` | SSH hosts (user settings only; use **Add SSH Host…**) |
| `devc-vscode.sshPath` | `ssh` | ssh client (user settings only) |

If you run devc through a shell function or alias, or want another tool, set the four command settings. A command you set is always offered.

## Troubleshooting

- **A command or Add Agent target is missing.** Its tool wasn't found. Install it and click **Refresh**. devc is looked for in `~/.local/bin` and on the PATH VS Code started with. The **Workspace** row's tooltip names a missing herdr or Docker.
- **A container's files won't list.** The container needs GNU coreutils and findutils. Alpine's BusyBox isn't supported.
- **SSH host shows "Cannot reach".** Hover for ssh's error. Check that `ssh <host>` works without a prompt. The extension keeps retrying.
- **SSH file reads are garbled.** Something in the remote shell's startup files prints output for non-interactive shells. Make it print only in interactive shells.
- **Send / Fetch fails on the host.** The host needs Git 2.36 or newer.

## More

- [How it works](docs/how-it-works.md): container scoping, the file system, terminal links, agent status, agent review comments, devc web, multiple windows, SSH security.
- [Syncing with an SSH host](docs/ssh-sync.md): Send / Fetch in detail, including what Fetch flags for review.

## Develop

```sh
npm install
npm run compile      # or: npm run watch
npm test             # .npmrc sets ignore-scripts, so compile first — pretest does not run
npx vsce package     # -> devc-vscode-<version>.vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host. Setting defaults come from the installed manifest, so reinstall the `.vsix` (or restart the dev host) after editing `package.json`.

You can develop inside a dev container while VS Code runs on the host against the same bind-mounted tree. The `ContainerTreeDataProvider` suite uses fakes and runs anywhere. The `DevContainerFileSystemProvider` suite needs a reachable container, so run it from the host. A headless container needs `xvfb` and Electron's shared libraries for `xvfb-run -a npm test`.
