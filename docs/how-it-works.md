# How it works

Reference for how each part of the extension behaves. For setup and everyday use, see the [README](../README.md).

## Security model

The extension adds no path for your credentials to reach a container or SSH host:

- **Nothing installed remotely.** Files, links and agent status use `docker exec` and `ssh` running coreutils and herdr's CLI. No VS Code server, no extensions run remotely.
- **No credential forwarding.** `docker exec` passes no host environment or sockets. Every ssh forces `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes` and `PermitLocalCommand=no`, terminals and git included.
- **One direction.** Send and Fetch run on the host and connect out; the host never connects back. Fetch never merges, and it flags files that could run code when merged ([details](ssh-sync.md#fetch)).
- **SSH hosts stay text.** An SSH host is never a workspace folder, so a `.vscode/settings.json`, `tasks.json` or `launch.json` an agent writes there is never applied.

What it can't control:

- **The container's own config.** A `devcontainer.json` can mount `~/.ssh`, pass tokens in environment variables, or mount the Docker socket. Check what yours grants. devc's default container has no git credentials; its [bridge](https://github.com/devc-tools/devc-tools/blob/main/docs/bridge-github.md) offers a few named GitHub actions instead.
- **The bind-mounted project folder.** A dev container's project folder is also the folder open in your VS Code window. Anything an agent writes there, such as `.vscode/tasks.json` or a git hook, lands in your host workspace and can run there. Workspace Trust and devc's [git protection](https://github.com/devc-tools/devc-tools/blob/main/devc/README.md#git-protection-frozen-gitconfig-and-githooks) reduce this; SSH hosts with Send / Fetch avoid it.
- **Using VS Code's remote extensions on the same container or host.** Opening it with Dev Containers or Remote-SSH brings their credential forwarding back.
- **Agents on this machine.** Agents started on the host run with your full user account.

## Which containers show up

A running dev container gets a root in the Sandboxes view when its project folder is an open workspace folder or sits under one. The project folder comes from the container's `devcontainer.local_folder` label, which devc, the devcontainer CLI and VS Code Dev Containers all set. A container started for a subfolder gets its own root beside the workspace folder's.

- **Label:** the host folder's basename, or `basename/path/to/subfolder` for a subfolder's container. Docker's container name is the subtitle.
- **Root:** the container's `/`, so `/etc` and `/usr` are as close as the project directory.
- **Live updates:** `docker events` is watched, so roots appear when a container starts and vanish when it stops.

The view is a view, never a workspace folder. Opening it never reloads the window or converts it to multi-root.

## File system

Container files use a `devc-vscode://<container-id>/<path>` file system provider backed by `docker exec` (`stat`, `find`, `cat`, `mkdir`, `rm`, `mv`). SSH host files use `devc-ssh://<host>/<path>`, running the same commands over `ssh`. Both need GNU coreutils and findutils in the environment.

## Terminal links

Paths printed in a container or SSH terminal become links when they exist there. Clicking a file opens it at any `:line:col` suffix; clicking a folder reveals it in the Sandboxes view.

- **Absolute paths** always resolve.
- **`~`** resolves against the environment user's `$HOME`.
- **Relative paths** resolve against the terminal's live working directory. The extension finds the terminal's pty in the container and reads `/proc/<pid>/cwd` for its foreground process (or its shell), so every `cd` is followed within a few seconds. Until that pty is found, relative paths resolve against the folder's mount in the container.
- **Left as plain text:** `~user/...`, unexpanded `$HOME/...`, relative paths when the mount is unknown, and bare filenames with no `/`.

Container terminals are created with `hideFromUser` and shown right away. That is the only creation option the Python extension checks before injecting `source .../activate`, so a host virtualenv stays out of container shells. There is no supported API for this ([vscode-python#11963](https://github.com/microsoft/vscode-python/issues/11963)), so it may need revisiting if that check changes.

## Container terminals

A container's terminal runs `openFolderCommand` (`devc herdr`) from its host folder. With no devc found and the setting unset, it runs this instead:

```sh
docker exec -it -u <remoteUser> -w <mount> <id> sh -c '… exec herdr --session=devc, else the user's login shell'
```

It attaches to the container's herdr when it has one, otherwise opens the user's login shell from `/etc/passwd`. After a reload it is rebuilt for whichever container is running.

## Tool detection

On startup, on **Refresh**, when a related setting changes, and when the window regains focus (at most every 30 s), the extension checks for:

- **Docker:** `<dockerPath> --version` exits 0. A stopped daemon still counts as installed.
- **herdr on this machine:** `herdr --version` exits 0, with `~/.local/bin` added to PATH. Always off on Windows.
- **devc:** an executable `devc` in `~/.local/bin` or on the PATH VS Code started with.

A command setting (`openFolderCommand`, `herdrAttachCommand`, `stopCommand`, `downCommand`) counts as available when devc was found or you set it to a non-blank value. Menus use these context keys: `devc-vscode.hasDocker`, `hasHostHerdr`, `hasSshHosts`, `canOpenFolder`, `canStop`, `canDown`.

herdr in a container or on an SSH host is checked per environment, when it is used.

## Agent status

The Agents view shows what herdr's own sidebar shows. herdr classifies each pane from its output (spinners, titles, prompt boxes, permission dialogs), and the extension reads the result from herdr's API.

### Environments

- **This machine:** the window's own herdr session, shown while it runs or while agents are detected in plain host terminals. A session attached in one of the window's terminals (`herdr --session <name>`, or bare `herdr`) shows all its agents; otherwise only agents working in one of the window's folders show.
- **Dev containers:** each running container serving the workspace. Its herdr agents sit under a **default** row; agents found in its plain terminals sit directly under it. A container whose herdr isn't running says **herdr not running**, and **Attach Terminal** starts it.
- **SSH hosts:** each reachable host, using this window's session there.

This machine's row comes first, then containers sorted by label. Each description counts agents per state.

### The window's session name

The `devc-vscode.herdrSession` setting when set. Otherwise the name `herdrs` gives the workspace file's directory (or the first folder): its path under your home folder (or its absolute path outside it), one part per folder joined with `.`. So `~/code/tools/devc-vscode` is `code.tools.devc-vscode`.

- Each folder name is lowercased, `.` becomes `_`, and other characters herdr rejects become `-`.
- Names over 40 characters, which would overflow herdr's socket path, keep their last folders and gain a short hash.

herdr-plugins' `scripts/bash_aliases.sh` applies the same rule.

### Watching a container

Each container gets one long-lived `docker exec -i -u <remoteUser> <id> sh -c …` that runs `herdr api snapshot` once a second and prints only when it changes. It needs only `sh` and herdr (on `PATH` or in `~/.local/bin`) in the container. It runs as the container's `remoteUser` from the `devcontainer.metadata` label, because herdr's socket lives in that user's home.

`docker exec` doesn't stop its process when the client exits, so the loop runs in the background and ends when the exec's stdin closes: on dispose, when the container stops, or when VS Code exits.

## Multiple windows

Each window writes what its Agents view shows to a file in the extension's global storage and watches the other windows' files. Their agents show under **Other Workspaces**, one row per window, and the badge counts agents needing attention in every window.

Clicking another window's agent leaves a focus request for that window, which reveals its terminal and herdr pane, then brings the window to the front with `vscode.openFolder`. An untitled multi-root workspace has nothing to reopen, so its agents are listed but not switchable.

Files are written to a temp name and renamed. A window removes its file when it closes; a crashed window's file is dropped once its extension host process is gone. A re-read every 10 s covers missed file-watch events.

## SSH hosts

SSH hosts are for browsing a sandbox without Remote-SSH, whose server relays your git credentials to anything running on the remote. Plain `ssh` carries none of that. Nothing is installed on the host, and it is never a workspace folder, so a `.vscode/settings.json`, `tasks.json` or `launch.json` an agent writes there is never applied.

- **Configuration:** hosts come only from **user** settings (`devc-vscode.sshHosts` is application-scoped), so a workspace can't add one. A `devc-ssh://` URI naming any other host is refused before anything runs.
- **Entry:** `{ "host": "<alias>", "root": "<absolute dir>", "label": "<name>" }`. `root` defaults to the remote home.
- **Reachability:** every window shows every configured host. An unreachable one shows **Cannot reach <host>** and is retried every 5 s, backing off to a minute. The extension never starts, stops or provisions a host.
- **Sessions:** each window uses its own herdr session on the host, named as on this machine. **Attach Terminal** runs `ssh -t <host>` attached to it (a login shell when the host has no herdr). **Stop / Delete herdr Session** end only that session.
- **Forwarding:** every ssh forces `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes` and `PermitLocalCommand=no` on the command line, overriding `~/.ssh/config`, terminals included.
- **Connections:** file and herdr commands add `BatchMode=yes` (keys only) and share one connection per host through a control socket in `/tmp/devc-<uid>`, used only when that directory is private to you.
- **Host requirements:** GNU coreutils/findutils and procps. Anything the remote shell's startup files print for non-interactive shells corrupts file reads (Ubuntu's `.bashrc` already returns early). herdr is needed on the host for it to appear in the Agents view.
