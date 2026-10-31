# herdr-vscode

herdr sessions, spaces, agents and panes in VS Code, for people who already use
[herdr](https://herdr.dev). The **herdr** activity-bar container has three views:

- **Sessions**: every herdr session on this machine, on the SSH hosts in `herdr.sshHosts`, and
  in every running dev container. Each running session shows its agents' counts
  (`2 blocked · 1 working`) and an icon for its worst status. Click a running session to select
  it; **Attach in Terminal** (the inline terminal icon) opens an integrated terminal attached to
  it.
- **Spaces**: the selected session's spaces, tabs and panes. Click a pane to focus it in herdr.
- **Agents**: every agent pane across all connected sessions, blocked first. The title bar
  filters to blocked or working agents. The number of blocked agents shows as a badge on the
  herdr icon and as a `<n> blocked` warning in the status bar; clicking the status bar item
  shows the blocked agents.

This release is read-only apart from attach and focus. Panes are not rendered in VS Code yet.

## Requirements

- herdr **0.9.5 or later** in each environment, on `PATH` or in `~/.local/bin`. Older herdr
  lacks `remote-api-bridge`; its sessions are listed as `needs herdr 0.9.5 or later`.
- Dev containers: the Docker CLI (`herdr.dockerPath`). Without Docker there are simply no
  container rows. herdr runs in the container as its dev container remote user.
- SSH hosts: an alias in `~/.ssh/config` that connects without a prompt (keys or an agent;
  `ssh` runs with `BatchMode=yes`). Hosts that cannot be reached show `unreachable`.
- This machine is not shown on Windows.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `herdr.sshHosts` | `[]` | ssh aliases from `~/.ssh/config` whose herdr sessions are shown (application scope) |
| `herdr.sshPath` | `"ssh"` | ssh client (application scope) |
| `herdr.dockerPath` | `"docker"` | Docker CLI (application scope) |
| `herdr.showStoppedSessions` | `false` | list stopped sessions too |

How discovery, the bridge protocol and refreshing work: [docs/how-it-works.md](docs/how-it-works.md).

herdr-vscode lives in the devc-vscode repo, in its own folder beside `devc-vscode/`, and is a
self-contained extension: its own `package.json`, lockfile, `node_modules`, build and tests.
Nothing is shared with devc-vscode at build time (a few helpers are copied, see
`src/remoteShell.ts`), and both extensions can be installed side by side.

## Development

```sh
cd herdr-vscode
npm ci
npm run build      # tsc type-check (out/) + esbuild bundle (dist/extension.js)
npm run lint
npm test           # .npmrc sets ignore-scripts, so pretest does not run: build first
npm run package:dev   # build a .vsix and install it into `code`
```

`npm test` never discovers the machine's herdr sessions (`.vscode-test.mjs` sets
`HERDR_VSCODE_NO_DISCOVERY=1`). Two opt-in suites run against a throwaway session:

- `HERDR_VSCODE_LIVE_SESSION=<name>`: connects to that running session on this machine (it
  needs one workspace), splits a pane and reports agent states in it.
- `HERDR_VSCODE_LIVE_HOME=<dir>`: points `HOME` at `<dir>` for the suite and runs full
  discovery there, so it must hold only a running throwaway session named `hv-test`. Add
  `HERDR_VSCODE_LIVE_STOP=1` to also stop that session and check it drops out. Keep `<dir>`
  short: herdr's socket path must fit in `sun_path` (about 100 bytes).

Open `herdr-vscode/` as the folder in VS Code and press <kbd>F5</kbd> (**Run Extension**) to build
it and open an Extension Development Host with it loaded.
