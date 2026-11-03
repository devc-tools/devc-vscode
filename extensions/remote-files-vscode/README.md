# Remote Files

A VS Code Explorer view for browsing and editing files in running dev containers and on SSH hosts. No VS Code server runs on the other side: files are read and written with `docker exec` and plain `ssh` running coreutils.

The **Remote Files** view lists running dev containers first, then the SSH hosts in `remoteFiles.sshHosts`, in settings order.

- **Dev containers** are running containers with a `devcontainer.local_folder` label. By default only the ones whose project folder is an open workspace folder (or under one) are shown; set `remoteFiles.containers` to `all` to see every one. A container root shows just `/workspaces` until you click **Show All Files**. Containers come and go as they start and stop.
- **SSH hosts** start at the host's `root`, or at the remote home. A host that can't be reached shows **Cannot reach *host*** with ssh's error in its tooltip. Use **+** (**Add SSH Host…**) to pick an alias from `~/.ssh/config`.

Click a file to open it. Editors on remote files reload when the file changes on the other side (checked every 5 s), and save back in place.

Right-click a row for:

- **New File…** and **New Folder…** (on roots and folders)
- **Rename…** (<kbd>F2</kbd>) and **Delete** (<kbd>Delete</kbd>). There is no trash: a delete can't be undone. With several rows selected, Delete removes them all.
- **Copy Path**: the path inside the container or on the host.
- **Terminal Here**: a login shell in that folder (a file's folder; a root's starting folder), in the terminal panel. Containers run it as the container's remote user with `docker exec`; SSH hosts with `ssh -t`. Roots also have it as an inline button.

Drag rows to move them within one container or host. Dropping onto another root, or dragging files in from the Explorer, copies them. Dropping onto a file drops into its folder, and you're asked before anything is overwritten.

Editor tabs read `container: <label> › <path>` and `ssh: <host> › <path>`.

## Settings

All are user settings only (application scope), so a workspace can't change them.

| Setting | Default | |
| --- | --- | --- |
| `remoteFiles.sshHosts` | `[]` | SSH hosts: `{ "host": "<~/.ssh/config alias>", "root": "/absolute/start/dir", "label": "Shown name" }`. Only `host` is required. |
| `remoteFiles.sshPath` | `ssh` | The ssh client: a name on `PATH` or an absolute path. |
| `remoteFiles.dockerPath` | `docker` | The Docker CLI: a name on `PATH` or an absolute path. |
| `remoteFiles.containers` | `workspace` | `workspace`: dev containers for the open workspace folders. `all`: every running dev container. |

## Safety

- Only hosts in `remoteFiles.sshHosts` are ever passed to ssh, and only containers currently shown are passed to Docker. A `remotefs-ssh://` or `remotefs-container://` link to anything else fails before anything runs.
- ssh runs with agent, X11 and port forwarding off, and `BatchMode=yes` for file commands. Connections are shared through sockets in `/tmp/rfs-<uid>` when that directory is private to you.
- Remote folders can't be workspace folders, since VS Code would read their `.vscode/settings.json`. One added by hand is removed. A window whose only folder is a remote one disables Remote Files until it's reloaded.

## Requirements

GNU coreutils and findutils on the remote side (`stat`, `find`, `cat`, `mkdir`, `rm`, `mv`), as on Debian and Ubuntu images. BusyBox (Alpine) isn't supported.

## Other extensions

devc-vscode's **Sandboxes** view (`devc-vscode://`, `devc-ssh://`) and herdr-vscode's file providers (`herdr-container://`, `herdr-ssh://`) are separate and unaffected. Each extension has its own SSH host setting.

## Development

Self-contained like the other extensions in `extensions/`: its own `package.json`, lockfile, build and tests. Node 24 (see `.nvmrc`).

```sh
npm install
npm run compile
npx mocha --ui tdd out/test/sshHosts.test.js out/test/sshConfig.test.js out/test/terminals.test.js out/test/remoteShell.test.js out/test/containers.test.js   # no VS Code needed
npm test                    # every suite, in a VS Code test host
npm run package:dev         # builds remote-files-vscode-dev.vsix and installs it with `code`
```

Open `extensions/remote-files-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to try it in an Extension Development Host.

The file system providers and shells are ported from herdr-vscode, and the tree, ssh config parsing and container discovery from devc-vscode. Each file says where it came from in its first line. They are maintained separately.
