# devc web: one shared server for every window, shut down when no window uses it

Asked for on 2026-10-23, after [devc-web-panels](implemented/devc-web-panels.md): the view showed
an empty panel, each window started its own `devc web` on a random port, and those children
outlived reloads and crashes (they run `detached`, so nothing reaped them).

The empty panel was devc-tools': every page sent `frame-ancestors 'none'`. Fixed there by
devc-tools' `devc-web-vscode-embedding` (`/sidebar` and `/main` send `frame-ancestors
vscode-webview: vscode-file:`), which arrives with the user's next devc / devc web restart.

## Checklist

- [x] 1. `src/devcWebWatchdog.ts`: a Node script that runs `devc web` and stops it when no client
      window is alive
- [x] 2. `src/devcWeb.ts`: `DevcWebServer` finds and adopts the shared server, or starts it under
      the watchdog, on the fixed port; registers this window as a client; follows the shared
      server's restarts and exits
- [x] 3. `src/extension.ts`: the store (SecretStorage), the shared directory, the port setting;
      deactivate unregisters instead of stopping
- [x] 4. `package.json`: `devc-vscode.devcWebPort`; settings descriptions
- [x] 5. Tests in `src/test/devcWeb.test.ts`
- [x] 6. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

- **Port**: `devc-vscode.devcWebPort`, integer, default `48229`, `scope: "application"` (every
  window must agree). `devc web --no-open --port <port> <devcWebArgs>`; a `--port` in
  `devcWebArgs` is used as given instead. No free-port retry. A port held by something else fails
  the start with "port <port> is in use: free it or set devc-vscode.devcWebPort" plus the stderr tail.
- **Shared directory**: `<globalStorage>/devc-web/`. `clients/<pid>`: one empty file per window
  using devc web, named by its extension host pid. `start.lock`: created with `wx` by the window
  starting the server, holding its pid; a lock whose pid is dead is removed and retaken.
- **Discovery**: the ready URL (it holds the token) and the watchdog's pid are kept in VS Code's
  SecretStorage, key `devcWeb.server`, JSON `{"pid": <watchdog pid>, "url": "<ready URL>"}`;
  never in a file. A record is live when the pid is alive and the URL's port accepts a TCP
  connection on 127.0.0.1; a dead record is deleted.
- **Starting**: register the client file, adopt a live record, else take the lock, check again,
  then spawn the watchdog `detached` (its own process group) with `ELECTRON_RUN_AS_NODE=1`
  `process.execPath out/devcWebWatchdog.js <JSON options>`; it forwards devc's stdout and stderr
  only until the ready line. A window that finds the lock taken polls the record every 200 ms
  until the ready timeout plus the stop timeout.
- **Watchdog**: runs devc in its own process group. Every 2 s it lists `clients/`, deletes files
  of dead pids, and once no client has been alive for 10 s (so a window reload keeps the server)
  SIGTERMs devc, SIGKILLs the group after 5 s, and exits. SIGTERM/SIGINT/SIGHUP to the watchdog
  do the same at once. When devc exits, the watchdog exits with its code.
- **Each window** polls the record every 2 s: a different live record means another window
  restarted it (the view reloads onto the new URL); none means stopped (the view shows the
  Restart link).
- **Restart devc web**: SIGTERM the watchdog, wait for it to exit (SIGKILL its group after the
  stop timeout + 2 s), delete the record, start again. Other windows follow by their poll.
- **Deactivate**: removes this window's client file; does not stop the server.

## Validation

- [x] `npm run compile`, `npm run lint`, `npx mocha --ui tdd out/test/devcWeb.test.js`
- [x] Tests: two clients share one server (one spawn); the server stops once every client is
      gone (dead pid) after the grace; restart from one client is followed by the other; a stale
      record is replaced; a lock held by a live pid makes the second client wait and adopt
- [x] No `devc web` or watchdog process left after the test run (`pgrep -f devcWebWatchdog`)
- [ ] In VS Code (the user): two windows show the sidebar against one port; closing both stops
      `devc web` within ~15 s

## Relevant Files

- `src/devcWebWatchdog.ts` (new), `src/devcWeb.ts`, `src/extension.ts`, `src/test/devcWeb.test.ts`
- `package.json`, `README.md`, `CHANGELOG.md`, `docs/how-it-works.md`
- `.plans/PLAN.md`

## Implementation notes

- Validated: compile, lint, `devcWeb.test.js` under plain mocha (37 passing, three runs), no
  watchdog left afterwards. The in-VS Code check (two windows, closing both) was not run: no
  display or devc here.
- A window's own `stop()` sets a flag so the watchdog exit it causes doesn't flash "stopped".
- Windows started by the old per-window code before this change are not tracked; any still
  running are found with `pgrep -af 'devc.* web --no-open'`.
