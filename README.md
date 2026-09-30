# Dev Container File Tree

Browse, edit and run agents in your dev containers and SSH sandboxes from VS Code on the host, with no remote server and no container attach.

- **Sandboxes view:** the files of every running dev container for your workspace, plus any SSH hosts you add.
- **Agents view:** the coding agents [herdr](https://herdr.dev) is running in those containers, on SSH hosts and on this machine, with their status.
- **Terminals:** file paths printed in container and SSH terminals are clickable.
- **Send / Fetch:** move a Git repo's commits to an SSH host and review what comes back.

## Install

1. Build and install the extension (Node 24, see `.nvmrc`):

   ```sh
   npm install
   npm run compile
   npm run package:dev   # builds devc-vscode-dev.vsix and installs it with `code`
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
| New file / folder | Right-click a container, SSH host or folder |
| Rename | <kbd>F2</kbd>, or right-click |
| Delete | <kbd>Delete</kbd>, or right-click (multi-select works) |
| Move | Drag within a container or SSH host |
| Copy in | Drag from the Explorer, or from another container or SSH host |
| Copy the path inside the container | Right-click → **Copy Container Path** |
| Open a terminal | Terminal icon on a container or SSH host |

Deletes are permanent. Containers and SSH hosts have no trash.

### Agents

- **Workspace** holds this machine's herdr session for the window, and each running dev container.
- **SSH Hosts** holds each reachable SSH host.
- **Other Workspaces** holds agents in your other VS Code windows. Clicking one switches to that window.

Hover over a row for its actions: **Attach Terminal**, **Add Agent**, **Stop / Down Container**, and **Stop / Delete herdr Session**. **Close Agent** ends an agent's herdr pane or terminal.

### Terminal links

In container and SSH terminals, click a printed path to open it. A `:line:col` suffix jumps to that spot, and a folder is revealed in the Sandboxes view.

## Commands

All commands are under **Dev Container FS** in the command palette.

| Command | What it does |
| --- | --- |
| Refresh Container Files | Re-read the Sandboxes view and re-check installed tools |
| Open Folder in Container | Run `openFolderCommand` in a terminal for a host folder |
| Add SSH Host… | Add an alias from `~/.ssh/config` to `sshHosts` |
| Send to SSH Host… / Fetch from SSH Host… | Sync a local repo with an SSH host |
| Send from Local / Fetch to Local | The same, from an SSH folder in the Sandboxes view |
| New File, New Folder, Rename, Delete, Copy Container Path | Act on the Sandboxes selection |

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

- [How it works](docs/how-it-works.md): container scoping, the file system, terminal links, agent status, multiple windows, SSH security.
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
