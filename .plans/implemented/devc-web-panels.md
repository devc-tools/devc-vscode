# devc web panels: the sidebar in a VS Code view, the tiles in the integrated browser

Decided with the user on 2026-10-22. Phase 5 of 5 of devc-tools' work on running devc web's
sidebar and tiling area as separate pages (devc-tools `.plans/archived/devc-web-sidebar-main-routes.md`).
devc web (in `/workspaces/tools/devc-tools`, `devc/web/`) now serves:

- `/sidebar#token=<t>&view=<id>`: the sidebar alone (containers, In use, pinned files, tasks);
- `/main#token=<t>&view=<id>`: the tiling area alone (terminals, file and diff tiles).

Pages with the same `view` id are paired: the server relays the sidebar's clicks to the tiles and
the tiles' state back. This plan puts the sidebar in a VS Code view and opens the tiles in VS
Code's integrated browser, both against a `devc web` **the extension starts itself** (the user's
choice: like devc-desktop, so the token never leaves memory).

Depends on devc-tools' [devc-web-vscode-embedding](../../../devc-tools/.plans/devc-web-vscode-embedding.md)
for the sidebar view: until it lands, devc web sends `frame-ancestors 'none'` and the view's iframe
stays blank. The integrated browser (not an iframe) works without it. Dragging a sidebar row into
the tiles needs devc-tools' `devc-web-cross-page-drag`; nothing here depends on it.

## Checklist

- [x] 1. `src/devcWeb.ts`: start, find the URL of, and stop the extension's `devc web` (pure parts tested)
- [x] 2. The **devc web** view: an activity-bar container with a `WebviewView` showing `/sidebar`
- [x] 3. **Open devc web Tiles**: `/main` in the integrated browser
- [x] 4. **Restart devc web**, and stopping it on deactivate
- [x] 5. Settings, README, CHANGELOG, `docs/how-it-works.md`
- [x] 6. Validation (below), then commit

## Touchpoints

| File | Role |
|---|---|
| `src/devcWeb.ts` (new) | The child process and its URL. No `vscode` import in the pure parts (ready-line parsing, URL building, webview HTML), so they test under plain mocha like `src/features.ts`. |
| `src/extension.ts` | Registers the view provider and the commands; stops the child in `deactivate`. |
| `src/tools.ts` | `findDevc()` (existing) is how `devc` is found. |
| `package.json` | `viewsContainers.activitybar`, `views`, `commands`, `menus` (`view/title`), the setting. |
| `src/test/devcWeb.test.ts` (new) | Tests of the pure parts. |
| `README.md`, `CHANGELOG.md`, `docs/how-it-works.md` | User and design docs, in their existing style. |
| `.plans/PLAN.md` | This plan's row. |

## Contracts

### The extension's `devc web`

- Found with `findDevc()`. Not found: the view shows a short message ("devc web needs devc:
  install it or put it on PATH") and the commands say the same; nothing is spawned.
- Started lazily, the first time the view is shown or **Open devc web Tiles** runs, once per
  window: `devc web --no-open` followed by `devc-vscode.devcWebArgs` (default `[]`). ~~Never
  `--port`: devc picks a free one and prints it.~~ Wrong: devc web defaults to port 48228; see
  the implementation notes.
- The URL comes from stdout's ready line, matched exactly as devc-desktop does
  (`devc-desktop/src/main/launch.ts`):
  `^devc web: (http:\/\/127\.0\.0\.1:\d{1,5}\/#token=[0-9a-f]{64})$`. stdout is otherwise
  discarded; it carries the token and must never reach a log, an output channel, a notification
  or a file. stderr keeps its last 50 lines, shown only when the child exits before its ready
  line or within 10 s fails to print one.
- Stopped on `deactivate` and by **Restart devc web** (`devc-vscode.restartDevcWeb`): SIGTERM,
  then SIGKILL after 5 s. A restart gets a new port and token; the view reloads its iframe, and an
  open tiles tab is left pointing at the dead server (say so in the restart's notification:
  "reopen the tiles with Open devc web Tiles").
- If the child exits on its own, the view shows that it stopped, with a **Restart** link.

### The view id

One per window: `vscode-` plus 12 random hex characters, made at activation and kept in memory
(not in settings or state). It pairs this window's sidebar with this window's tiles. It matches
devc web's `^[A-Za-z0-9_-]{1,64}$`.

### URLs

`pageUrl(ready: string, page: 'sidebar' | 'main', view: string): string`: from the ready line's
`http://127.0.0.1:<port>/#token=<t>`, the URL `http://127.0.0.1:<port>/<page>#token=<t>&view=<view>`.
Each is passed through `vscode.env.asExternalUri` before use (a no-op locally; it maps the port
in a remote window).

### The view

- `package.json`: `viewsContainers.activitybar` entry `devc-web` (title "devc web", an icon in
  the repo's style), and in it the webview view `devc-vscode.devcWeb` (name "devc web",
  `type: "webview"`).
- `WebviewViewProvider` with `retainContextWhenHidden: true` (the page holds a WebSocket and its
  state; recreating it on every hide would reconnect and re-render).
- The webview's HTML: one full-size `<iframe>` of the `/sidebar` URL, no border, and a webview
  CSP of `default-src 'none'; frame-src http://127.0.0.1:<port> <asExternalUri origin>;
  style-src 'unsafe-inline'`. No scripts in the webview itself (`enableScripts: false`); the
  iframe's page runs its own.
- Before the URL is known, and when devc isn't found or the child stopped, the HTML is a short
  message instead (text only, no script; the Restart link is a `command:` URI with
  `enableCommandUris` set to `['devc-vscode.restartDevcWeb']`).

### Opening the tiles

- `devc-vscode.openDevcWebTiles`, title "Open devc web Tiles", in the view's title bar
  (`view/title`, `navigation`) and the Command Palette.
- Opens the `/main` URL in VS Code's **integrated browser**. Its command id isn't settled API:
  find it at run time from `vscode.commands.getCommands(true)` (on VS Code ≥ 1.138 check what the
  integrated browser registers for opening a URL, and record it in `docs/how-it-works.md`), and
  fall back to `simpleBrowser.show` when it is absent. Simple Browser is itself an iframe in a
  webview, so it also needs devc-tools' embedding plan.
- A second run while a tiles tab is open just opens another (two tiles pages on one view is
  allowed; both follow the sidebar).

### Setting

`devc-vscode.devcWebArgs`: `string[]`, default `[]`, `scope: "application"`: extra arguments after
`devc web --no-open` (for example `["--live", "--source", "/path/to/devc-tools/devc"]`). A change
applies on the next start or restart.

## Concept boundaries

- **This `devc web` is the extension's own**, separate from one the user runs in a terminal or
  devc-desktop's: its own port, token and views. They share devc's files on disk (pinned files,
  tasks, projects), which devc web already keeps in step across servers.
- **The view id is not a herdr session, a workspace or a window id.** It only pairs the two pages.
- **`devc-vscode.windowTitle`** (the existing window-title feature) is unrelated: it follows
  herdr's focus, which the tiles page moves through `active_pane` as devc web always has.
- **Storage**: the iframe's page is third-party inside the webview, so Chromium partitions its
  `localStorage`; its layout and sidebar state are separate from the same page's in a browser tab.
  That is expected; don't try to share them.

## Validation

1. `npm run compile`, `npm run lint`, and the new pure tests under plain mocha (the repo runs
   `features.test.js` that way; `devcWeb.test.ts` must not import `vscode`): the ready line
   (match, near-misses, trailing whitespace), `pageUrl` for both pages, the webview HTML's CSP and
   iframe `src`, the message HTML's escaping.
2. The child: with a stub `devc` script on PATH that prints a ready line and sleeps, start, read
   the URL, stop (SIGTERM honoured; a stub ignoring SIGTERM is killed after 5 s); a stub that
   exits early reports its stderr tail; stdout never appears in any output.
3. In VS Code (the user, after devc-tools' embedding plan is on their `devc`): the view shows the
   sidebar; **Open devc web Tiles** opens the tiles in the integrated browser; a pane clicked in the
   view opens in the tiles; zen from the view reaches the tiles; **Restart devc web** reloads the
   view. Say plainly in the report which of these could not be run from the agent's environment.

Commit in this repo's style, with the `Co-Authored-By` line.

## Implementation notes

- **`enableScripts: true`, not `false`.** VS Code builds a webview's content frame with `allow-scripts`
  only when scripts are enabled, and a nested iframe inherits the sandbox, so with `false` the
  framed `/sidebar` could not run. The webview's own document still runs nothing: its CSP has no
  `script-src`.
- **The integrated browser's command** is `workbench.action.browser.open` (read from VS Code
  1.141.1's workbench): it takes a URL string or `{ url, openToSide, reuseUrlFilter }`.
- **Stop** sends SIGTERM to devc, then SIGKILL to its process group (devc web runs `detached`), so
  the kill also reaches the deno server devc's supervisor spawned.
- Validation 3 (in VS Code, against a devc with the embedding plan) was not run: this container
  has no devc and no display for a manual check.
- **`--port` is passed.** devc web listens on a fixed default port (48228, devc-tools'
  `DEVC_WEB_DEFAULT_PORT`) rather than picking a free one, so the extension's server collided
  with a devc web run elsewhere ("port 48228 is already in use"). The extension asks the OS for
  a free 127.0.0.1 port and passes `--port`, retrying up to three times on "already in use"; a
  `--port` in `devcWebArgs` is used as given.
- **`devc-vscode.devcWebDevc`** (added after the plan, at the user's request): `installed` |
  `devc2` | an absolute path, as devc-desktop's `desktopDevc`. `devc2` runs `$DEVC_BIN` (the
  from-source invocation `scripts/bash_aliases.sh` exports, since `devc2` itself is a shell
  function `spawn` cannot run), from the extension host's environment, else `$SHELL -ilc`'s.
- **Both settings are `window`-scoped**, not `application` as planned, so a workspace can set them (user's request). Safe because the extension declares no `untrustedWorkspaces` support, so VS Code doesn't run it in Restricted Mode.
