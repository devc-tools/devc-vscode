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

## Agent review comments

A comment controller (**Agent (devc)**) offers comment ranges on every line of a `file`, `git`, `review` or `pr` document whose path is bind-mounted into a running container. `git` is the old side of a VS Code Git diff; `review` and `pr` are GitHub Pull Requests' diff sides. Their URI path is the host path, and the ref, diff side or commit comes from the URI's JSON query. Bind mounts are cached for 10 s for the range provider and re-read when a question is sent.

**Sending.** On submit, the extension runs `herdr --session=devc api snapshot` in the container to find its agents, then `mkdir -p /tmp/devc-vscode/review/<thread>` and `herdr --session=devc agent prompt <pane> <text>` as the container's `remoteUser`. The text is passed as an argument, never through a shell string. It starts with `[devc review <thread>#<seq>]` and holds the container path, the 1-based line range, the diff side, the commented lines (read from the editor, so a base-side diff quotes base-side code; over 200 lines, the agent is told to read the file), your question, and an instruction to write the answer as Markdown to `/tmp/devc-vscode/review/<thread>/<seq>.md`. A follow-up omits the code. The agent's pane is not focused. herdr 0.9.3 or later is required in the container.

**Replies.** While a container has questions awaiting replies, one `docker exec` runs `cksum /tmp/devc-vscode/review/*/*.md` every second and prints the listing when it changes, ending when its stdin closes, as the agent watcher does. A file whose checksum or size changed is read with `cat` and replaces the thread's *Waiting* placeholder, or updates the reply already shown, so a rewritten answer shows its latest version. Files of threads this window doesn't know are ignored.

**Permission prompts.** Claude Code's default permission mode asks before writing outside the project, so the reply waits until you approve the write in the agent's pane. In auto mode the reply arrives without a prompt.

**Failures.** A non-zero exit from `agent prompt` marks the question **Not sent** and shows herdr's error. `agent_blocked` (the agent is at a prompt in its pane) and `agent_not_found` get their own messages; the latter also forgets the remembered agent. **Resend** picks the agent again and re-sends.

**Lifetime.** Threads live in the window's memory and are gone after a reload. Their reply files stay in the container's `/tmp` until **Delete Thread** removes the thread's directory or the container is recreated.

## Features and the window title

A feature is a local repo's main worktree or one of its linked worktrees. Focus Features… finds them from the workspace folders and from what the workspace's containers mount under `/workspaces`, then lists each repo's `git worktree list`.

**herdr focus.** The agent watcher's snapshots also carry herdr's focused pane. Its working directory (`foreground_cwd`, else `cwd`) is mapped back to a host path through the container's bind mounts, most specific destination first, and `git rev-parse --show-toplevel --git-common-dir` there gives the worktree and its repo. When several containers are watched, the one whose focus changed last counts.

**Window title.** VS Code has no API for the title, only the `window.title` setting, and only its workspace value belongs to one window. So the title is managed only in a saved `.code-workspace`, never in a folder's `.vscode/settings.json`. The value written is `devc-vscode.windowTitle` with `${branch}`, `${project}`, `${folder}`, `${space}` and `${title}` filled in; other variables are left for VS Code to expand. `${title}` is the focused pane's `terminal_title_stripped`, left out as devc web leaves it out: when it repeats the pane's label or folder, or, outside an agent, one of its folders. A `$` in a filled-in value is written as `＄`, since VS Code takes any `$` in `window.title` to start a variable and drops what follows.

- It is re-resolved when herdr's focus or the focused pane's directory or title changes, and every 15 s to catch a branch switch. The setting is written only when the text changes.
- The value last written is remembered in workspace state. A `window.title` that differs from it was set by you, and becomes the title to restore.
- With no feature to show, or with `devc-vscode.windowTitle` at its default `null`, the workspace's own value is restored. A title left behind when VS Code closed is dropped a few seconds after the next start unless a pane is focused.

**Open herdr Space for Feature…** runs `herdr --session=devc workspace create --cwd <mounted path> --label "<project> / <branch>" --focus` in the container, then reveals the herdr terminal and focuses the new pane as for an agent.

## devc web

**The server.** The extension runs `devc web --no-open` plus `devc-vscode.devcWebArgs`, using the devc `findDevc` finds, the first time the **devc web** view is shown or **Open devc web Tiles** runs. It never passes `--port`: devc picks a free one. The URL comes from the stdout line `devc web: http://127.0.0.1:<port>/#token=<64 hex>`, matched exactly as devc-desktop matches it. stdout carries the token, so it is read for that line and otherwise discarded; it never reaches a log, an output channel, a notification or a file. The last 50 stderr lines are shown in the view only when devc web exits before that line or doesn't print it within 10 s. The server is this window's own, apart from one run in a terminal or by devc-desktop; they share devc's files on disk (pinned files, tasks, projects).

**Stopping.** On deactivate and on **Restart devc web**: SIGTERM to devc, then SIGKILL to its process group after 5 s. devc web runs in a process group of its own, so the kill also reaches the server devc's supervisor started. When it exits by itself, the view says so with a **Restart** link (a `command:` URI, the only one the view allows).

**Pairing.** devc web pairs a `/sidebar` page and `/main` pages that share a `view` id and relays between them. Each window makes one at activation, `vscode-` plus 12 random hex characters, kept in memory. It names no herdr session, workspace or window. Both URLs go through `vscode.env.asExternalUri`, a no-op locally that forwards the port in a remote window.

**The view.** A `WebviewView` holding one full-size iframe of `/sidebar`, retained while hidden so its WebSocket and state survive. The webview has scripts enabled, since VS Code sandboxes a webview's frames without `allow-scripts` otherwise, but its own document runs none: its CSP is `default-src 'none'; frame-src <server origins>; style-src 'unsafe-inline'`. The framed page is third-party in the webview, so Chromium partitions its `localStorage` apart from the same page's in a browser tab. devc web must allow `frame-ancestors` for VS Code's webviews; until it does, the view stays blank.

**The tiles.** `/main` opens in the integrated browser with `workbench.action.browser.open` (registered by VS Code 1.138+; it takes the URL as its argument), found in `vscode.commands.getCommands(true)`. Without it, `simpleBrowser.show` is used, which is an iframe in a webview and needs devc web's framing too. Each run opens another tab; several tiles pages on one view all follow the sidebar. A restart leaves an open tab on the dead server.

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
