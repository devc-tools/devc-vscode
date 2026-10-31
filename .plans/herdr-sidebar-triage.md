# herdr-vscode: Sidebar triage (filters with counts, time in state, done, scope, git, Start, status bar)

Closes the gaps between the built sidebar ([herdr-sidebar](implemented/herdr-sidebar.md), phase 14) and
mockup boards A and E (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP; board A is `Main.dc.html`,
"herdr sidebar and pane tiles"; board E is `Herdr.dc.html`, "herdr sidebar comparison"). Board A shows
filter chips with counts (`All 7 · Blocked 2 · Working 3 · Done 1`), agent rows with time in state
(`blocked 2m`), a **Start** action on a dev container without herdr, and a status bar holding
`herdr: deephaven-mcp (devc)` and `herdr 0.9.4`. Board E shows space rows with branch and git status
(`⎇ v3_auth ● 4 ↑1`), tab rows with a summary (`claude, copilot`, `2 shells`) and an Agents scope switch
(`this session · all sessions`).

Depends on [herdr-sidebar](implemented/herdr-sidebar.md) (views, model), [herdr-mirrored-tabs](herdr-mirrored-tabs.md)
(`src/focus.ts`: tile focus reports), [herdr-pane-context](herdr-pane-context.md) (`src/git.ts`) and commit
`c47a952` (**Start Session** / **Stop Session** for this machine, `src/sessionControl.ts`). All paths are
under `herdr-vscode/` unless a path says otherwise. Nothing under `devc-vscode/` changes.

Out of scope, decided:

- **`attached` marker on Sessions rows: dropped.** herdr 0.9.5 does not expose attached clients. The bundled
  API schema (`herdr api schema --json`, read offline) has no client list in `session.snapshot` or any other
  read method; `no_foreground_client` appears only as a result reason of `notification.show` and
  `client.window_title.set`, which both have side effects. `herdr session list --json` has no such field.
- **Window title (`herdr: <session> · <space>`): not done.** VS Code has no window-title API; the only way
  is rewriting the workspace's `window.title` setting as focus moves, which devc-vscode does
  (`devc-vscode.windowTitle`) and which only works for a saved `.code-workspace` file that it then keeps
  rewriting. The status bar session item below carries the same information without touching user files.
- **Stop for dev container sessions, Start on SSH hosts:** not added (not asked; SSH is untested live).
- devc web (devc-tools `devc/web/`) has no done or time-in-state semantics to reuse: its sidebar shows
  herdr's raw `agent_status`. Everything below is defined here.

## Checklist

- [ ] 1. Snapshot parsing: `worktree.checkout_path` on workspaces; `state_change_seq` and
      `completion_seq` from `agents[]`; the raw herdr status kept beside the displayed one
- [ ] 2. Agent state tracker: time in state, derived **done**, seen marks, persistence in workspace state
- [ ] 3. The displayed status (with derived done) applied where snapshots enter the model, so every view,
      rollup, count, tile and status bar item uses it
- [ ] 4. Seen marks from tile focus, herdr focus moving to the pane, and pane clicks
- [ ] 5. Agents view: Done filter, **Filter Agents…** quick pick with counts, view description with counts,
      title bar reorganized
- [ ] 6. Agents view: scope switch (`all sessions` / `this session`), context key and workspace state
- [ ] 7. Agents rows: new description format with status and elapsed time; 30 s re-render while visible
- [ ] 8. Spaces: git description on space rows (poller, visible-only)
- [ ] 9. Spaces: tab row summary description
- [ ] 10. Sessions: **Start Session** on dev container rows
- [ ] 11. Status bar: session item `herdr: <label>` with the herdr version in its tooltip
- [ ] 12. `herdr.revealBlockedAgents` also sets the scope to all sessions
- [ ] 13. Live measurement in throwaway `hv-test`: `state_change_seq` / `completion_seq` behaviour of
      `pane.report_agent`; record the result under Implementation notes
- [ ] 14. Tests (list under Validation)
- [ ] 15. `README.md`, `CHANGELOG.md`, `docs/how-it-works.md`

## Contracts

### Snapshot fields (herdr 0.9.5, from the bundled schema)

- `workspaces[].worktree` is `null` or `{repo_key, repo_name, repo_root, checkout_path, is_linked_worktree}`
  (all required when present). Keep `checkout_path` (string, non-empty) beside `repo_name`. It has **no
  branch** (`WorktreeInfo.branch` exists only on `worktree.list` results); the branch comes from git.
- `agents[]` entries (one per agent pane, matched to panes by `pane_id`) carry:
  - `state_change_seq`: uint64, default 0, increments on each agent state change. Absent → treat as
    undefined.
  - `completion_seq`: uint64 or `null`, "the current idle transition completed work, independently of who
    has viewed it". Only an integer counts; `null`/absent → undefined.
  - **Gotcha:** these are on `agents[]` only, not on `panes[]`.
- No event or snapshot field carries a timestamp. `pane.agent_status_changed` data is
  `{pane_id, workspace_id, agent_status, agent?, display_agent?, title?, state_labels?}`. Time in state is
  measured locally, at the moment the snapshot showing the change is applied.
- `agent_status` enum is `idle | working | blocked | done | unknown`; 0.9.5 was measured to report only
  `idle | working | blocked | unknown`. A raw `done` from a later herdr is displayed as `done` as is, with no
  seen handling.

### Agent state tracker

One record per agent pane, keyed by the pane key (`makePaneKey(sessionKey, paneId)` from
`src/tilesProtocol.ts`). Fields: `status` (raw herdr status), `seq` (`state_change_seq` or undefined),
`since` (epoch ms), `observed` (boolean: `since` is when the state began), `token` (string or undefined:
the last completion), `seen` (boolean).

On every applied snapshot of a session, for each pane with an agent (`now` = `Date.now()`;
`first` = this is the first snapshot since the connection was (re)established):

1. `cseqToken` = `c:<completion_seq>` when `completion_seq` is an integer, else undefined.
2. **No record:** create `{status: raw, seq, since: now, observed: !first, token: raw === 'idle' ? cseqToken : undefined, seen: true}`.
   A completion that existed before the pane was first seen is a baseline, never shown as done.
3. **Changed** (`raw !== record.status`, or both `seq` and `record.seq` defined and different): let
   `prev = record.status`; set `status = raw`, `seq`, `since = now`, `observed = !first`. When `raw === 'idle'`:
   `newToken = cseqToken ?? (prev === 'working' ? 'l:' + (seq ?? now) : undefined)`; when `newToken` is defined
   and differs from `record.token`, set `token = newToken`, `seen = false`.
4. **Unchanged:** when `raw === 'idle'` and `cseqToken` is defined and differs from `record.token`, set
   `token = cseqToken`, `seen = false` (herdr filled it in late).
5. Panes without an agent have no record; a record whose pane is gone from a **connected** session's snapshot
   is deleted. Records of sessions with no connection are kept, and deleted when `since` is older than 7 days.

**Displayed status** = `done` when `raw === 'idle'` and `token` is defined and `seen === false`; else `raw`.
**Elapsed** is shown only when `observed` is true. A state that began while the window was closed or the
session disconnected shows no time until its next change.

**Seen** (`seen = true` on that pane's record; a change event follows so views update) when:

- a tile of the pane reports focus (every xterm focus gain in a mirrored or Layout tab, including a focus of
  the tile that was already the last focused — **gotcha:** `FocusTracker.onDidChangeLastFocused` fires only
  when the key changes, so hook every `set()` call, not that event);
- herdr's `focused_pane_id` in a session's snapshot changes to the pane (a change from a different, known
  value; not on `first` snapshots);
- `herdr.addToLayout`, `herdr.openPaneTab` or `herdr.focusPane` runs for the pane (row click or context
  menu).

The agent leaving `idle` ends done by itself (displayed status is the raw one). Completing while you
watch the tile still shows done until the next focus of the tile or until the agent works again; this is
accepted.

**Persistence:** workspace state key `herdr.agentStates`, value
`{"v":1,"panes":{"<pane key>":{"status":"idle","seq":12,"since":1761900000000,"observed":true,"token":"c:3","seen":false}}}`
(plain JSON: no `Map`, no `undefined` values — omit the key). Loaded on activation before the model starts;
written at most once per second after a change and on dispose. A missing or malformed value (or `v !== 1`)
is ignored. Persisting `since` keeps elapsed time across a window reload when the state did not change
meanwhile (rule 3 does not fire, so `observed` and `since` survive).

**Where it applies:** the displayed status replaces `SnapshotPane.agent_status` when a snapshot enters
the model (`SessionConnection` / `SessionModel` in `src/sessions.ts`), with the raw value kept in a new
field and `since`/`observed` exposed for the Agents view. Every current reader of `agent_status`
(`sessionsView.ts`, `spacesView.ts`, `agentsView.ts`, `focus.ts`, `tilesPanel.ts`, `paneContext.ts`)
then shows done without change. A seen mark re-applies the displayed statuses to the current snapshots
and fires `SessionModel.onDidChange`. The tracker is optional in the `SessionModel` constructor
(in-memory when not given), so the live suites keep constructing `new SessionModel(environments, log)`.

### Elapsed time format

`elapsed = now - since` in ms: `< 60000` → `<1m`; `< 3600000` → `<floor(min)>m`; `< 86400000` →
`<floor(h)>h`; else `<floor(d)>d`. Examples: 59 s → `<1m`, 125 s → `2m`, 61 min → `1h`, 26 h → `1d`.

### Agents view (`herdr.agents`)

**Scope.** Context key and workspace state key `herdr.agentsScope`: `all` (default; anything else stored
reads as `all`) or `session`. `session` lists only agents of the **selected session** (as Spaces uses it,
`SessionsView.selected`); with no selected session it lists none.

**Filter.** Context key and workspace state key `herdr.agentsFilter`: `all` (default) | `blocked` |
`working` | `done`, matched against the **displayed** status. Counts are taken over the agents in scope,
before the filter.

**Rows**, sorted as today (status rank of the displayed status, then session row label, then workspace
number). Label unchanged. Description:

```
<breadcrumb>[ · <state>][ · <terminal_title_stripped>]
```

- `<breadcrumb>`: scope `all` → `<session row label> › <space label>` (as today); scope `session` →
  `<space label> › <tab label>` (board E).
- `<state>`: the displayed status word (`blocked`, `working`, `done`, `idle`), followed by ` <elapsed>`
  when elapsed is shown; omitted for `unknown`.
- Examples: `deephaven-mcp › v3_auth · blocked 2m`,
  `v3_auth › agents · working 3m · Refactoring auth middleware`, `code-wksp › api · idle`,
  `my-app › web · done <1m`.
- Tooltip: `<agent> · <displayed status>[ for <elapsed>]\n<pane id>` (agent rows in Spaces get the same).

**Re-render:** besides model changes, the rows are re-rendered every 30 s while the view is visible
(`TreeView.visible`, `onDidChangeVisibility`); the timer is stopped while hidden and one re-render runs
when it becomes visible. Item ids are unchanged, so selection and scroll stay.

**View description** (`TreeView.description`, plain text): `<scope label>[ · <summary>]`

- `<scope label>`: `all sessions` | `this session`.
- Filter `all`: `<summary>` = `countsDescription` of the agents in scope
  (`2 blocked · 3 working · 1 done`; `idle` when those three are zero); omitted when there are no
  agents in scope.
- Filter `blocked` / `working` / `done`: `<summary>` = `<filter> <shown> of <total>`, e.g.
  `all sessions · blocked 2 of 7`.

**Badge** unchanged: blocked agents across all sessions, whatever the scope and filter.

**Title bar** (`view/title`, `view == herdr.agents`), replacing the three filter buttons:

| Order | Command | Title | Icon | When |
| --- | --- | --- | --- | --- |
| `navigation@1` | `herdr.agents.scopeSession` | Show Only the Selected Session | `$(globe)` | `herdr.agentsScope != session` |
| `navigation@1` | `herdr.agents.scopeAll` | Show All Sessions | `$(target)` | `herdr.agentsScope == session` |
| `navigation@2` | `herdr.agents.filter` | Filter Agents… | `$(filter)` | always |
| `navigation@3` | `herdr.agents.showAll` | Show All | `$(list-flat)` | `herdr.agentsFilter != all` |

`herdr.agents.showBlocked`, `herdr.agents.showWorking` (existing) and new `herdr.agents.showDone` ("Show
Done") stay as commands (Command Palette, category `herdr`) but leave the title bar.

**Filter Agents…** opens a single-select quick pick, placeholder `Show agents`, items in this order:
`All`, `Blocked`, `Working`, `Done`; each item's `description` is its count in scope as a decimal string
(`All` = every agent in scope); the current filter's item has `iconPath` `new ThemeIcon('check')` and is the
active item. Picking sets the filter; Escape changes nothing. (VS Code tree views cannot host chips; a quick
pick with counts plus the counts in the view description is the closest native form.)

**Welcome contents** (`viewsWelcome`, replacing the two Agents entries):

| when | contents |
| --- | --- |
| `herdr.agentsScope == session && !herdr.sessionSelected` | `Select a running session in Sessions.` |
| `(herdr.agentsScope != session \|\| herdr.sessionSelected) && (herdr.agentsFilter == all \|\| !herdr.agentsFilter)` | `No agents.` |
| `(herdr.agentsScope != session \|\| herdr.sessionSelected) && herdr.agentsFilter && herdr.agentsFilter != all` | `No agents match this filter.` |

`herdr.revealBlockedAgents` (status bar click) sets scope `all` and filter `blocked`, then opens the herdr
container.

### Spaces: git on space rows

- **Directory** per space: `worktree.checkout_path` when present; else the space's focused pane's
  `foreground_cwd ?? cwd`, else its first pane's (`spaceCwd` in `src/sessionControl.ts`); else none (no git).
- **Command**, in the session's environment shell: `readStatus(shell, dir)` from `src/git.ts`
  (`git --no-optional-locks -C <dir> status --porcelain=v1 -z --branch`, plus `git rev-parse --short HEAD`
  when detached). `-C` at a subdirectory works; no `rev-parse --show-toplevel` call is needed. Non-zero
  exit (not a repo: 128; no git: 127) or a timeout → no git part. Parsing is `parseStatus` (existing): the
  `## ` record gives branch, `[ahead N, behind M]`; every other record is one change, a rename/copy's second
  record skipped.
- **Description format** (U+2387 `⎇`, U+25CF `●`, U+2191 `↑`, U+2193 `↓`):
  `⎇ <head>` + (`changes > 0` ? ` ● <changes>` : ` · clean`) + (`ahead > 0` ? ` ↑<ahead>` : ``) +
  (`behind > 0` ? ` ↓<behind>` : ``). `<head>` is the branch, or the short SHA when detached.
  Examples: `⎇ v3_auth ● 4 ↑1`, `⎇ main · clean`, `⎇ docs ● 1`, `⎇ main · clean ↓2`, `⎇ 1a2b3c4 ● 2`.
- Space row description = the git part when known; otherwise (no result yet, not a repo) the current rule
  (`worktree.repo_name` when present and different from the label). Space row tooltip:
  `<label>` + (`\n<repo_name>` when present) + (`\n<directory>` when known) + `\n<counts description of the
  space's agents>`.
- **Gotcha:** `TreeItem.description` is plain text; `$(codicon)` syntax is not rendered there, hence the
  Unicode glyphs.
- **Cadence:** only for the selected session's spaces and only while the Spaces view is visible. A pass
  runs every 10 s, plus once (debounced 300 ms) when Spaces becomes visible, when the selected session
  changes, and when a snapshot adds a space or changes a space's directory. At most 4 git runs at a time
  per pass; a space whose previous run is still going is skipped. Results are cached per
  `<session key>|<workspace_id>` with the directory they were taken in; a cached result whose directory no
  longer matches is dropped (the row falls back until the next result). The view re-renders only when a
  description changed.

### Spaces: tab rows

Description summarises the tab's panes in snapshot order:

- agent kinds: `display_agent ?? agent` of each agent pane, distinct in order of first appearance, a kind
  seen `n > 1` times written `<kind> ×<n>` (U+00D7), joined with `, `;
- shells: the number of panes without an agent, `1 shell` / `<n> shells`;
- description = `<agents> + <shells>` when both, else whichever exists; no description for a tab with no
  panes.

Examples: `claude, copilot`; `2 shells`; `claude ×2, codex + 1 shell`.

### Sessions: Start in dev containers

- Rows that offer **Start Session** (`herdr.startSession`, existing title "Start Session", `$(play)`,
  inline): this machine's stopped sessions (as today) and, new, a dev container's:
  - stopped session rows (listed when `herdr.showStoppedSessions` is on): start that session name;
  - the environment row shown when the container's listing succeeded but no session runs (description
    `herdr not running`): it now carries session name `devc` and starts it. Its label, description and id
    are unchanged.
- `contextValue`: container rows get ` container` appended, as host rows get ` host`
  (`herdr.session.running container`, `herdr.session.stopped container`). The `herdr not running` row of
  a container becomes `herdr.session.stopped container`. Container rows that cannot start (herdr not
  installed, error, checking…) stay `herdr.session.absent` with no suffix.
- Menu: `view == herdr.sessions && viewItem =~ /^herdr\.session\.stopped (host|container)$/`, group
  `inline@1`. **Stop Session** stays host-only (`viewItem == 'herdr.session.running host'`). Check every
  `viewItem ==` and `node.contextValue ===` comparison on session rows after the suffix change (the
  selection handler compares the base value, not the item's `contextValue`).
- **Container start argv**, through `execDocker` (`src/docker.ts`) with `readSettings().dockerPath`,
  timeout 15 s — not through `DockerShell`, whose `run` adds `-i` (`-d` and `-i` must not be combined):

  ```
  docker exec -d [-u <remote user>] <container id> /bin/bash -lc 'cd; PATH="$HOME/.local/bin:$PATH"; export SHELL; exec "$0" "$@"' herdr --session <S> server
  ```

  `-u` only when the environment has a user. `cd` starts the server in the user's home; `export SHELL`
  because bash sets `SHELL` without exporting it under `docker exec`, and herdr's panes start `$SHELL`
  (devc web's `SERVER_SCRIPT` in devc-tools `devc/web/herdr_bridge.ts` does the same).
  `docker exec -d` exits 0 as soon as the process is created; a non-zero exit is an error with its stderr.
- Then re-list that environment until the session runs, as this machine's start does (20 tries, 500 ms
  apart); on success select it; on failure warn
  `herdr: session "<S>" did not start in <container folder name>. Its herdr-server.log says why.`
  Progress shows on the Sessions view, as today.

### Status bar

- Existing items stay: blocked (`$(warning) <n> blocked`, right, priority 100) and focused pane (left,
  priority 100). The focused pane item now shows the displayed status (done included) via the model.
- New **session item**: id `herdr.session`, name `herdr session`, left-aligned, priority 101 (left of the
  focused-pane item). Shown while there is a selected session; hidden otherwise.
  - Text: `herdr: <session row label>` + suffix: container → ` (<session name>)`; SSH → ` (<alias>)`;
    this machine → none. Examples: `herdr: deephaven-mcp (devc)`, `herdr: code-wksp`,
    `herdr: default (buildbox)`.
  - Tooltip: `<session key>` + (`\nherdr <snapshot version>` when connected) + (`\n<counts description>`
    when connected).
  - Click: `herdr.sessions.focus` (VS Code's generated focus command of the Sessions view).
  - Updates on `SessionsView.onDidChangeSelected` and `SessionModel.onDidChange`.

### Commands (new or changed)

| Command | Title | Palette | Where |
| --- | --- | --- | --- |
| `herdr.agents.filter` | Filter Agents… | yes | Agents title `navigation@2` |
| `herdr.agents.showDone` | Show Done | yes | — |
| `herdr.agents.scopeSession` | Show Only the Selected Session | yes | Agents title `navigation@1` |
| `herdr.agents.scopeAll` | Show All Sessions | yes | Agents title `navigation@1` |
| `herdr.startSession` | Start Session (unchanged) | no | Sessions rows, now also containers |

All with `"category": "herdr"`. `herdr.agents.showBlocked` / `showWorking` lose their title-bar entries.

## Validation

- [ ] `cd herdr-vscode && npm run build && npm run lint && xvfb-run -a npm test` passes, including new
      unit tests for:
      - snapshot parsing: `checkout_path`; `state_change_seq` / `completion_seq` from `agents[]` (integer,
        `null`, absent)
      - tracker with an injected clock: first sight (baseline completion not done, `observed` false on a
        first snapshot and true on a later one); working → idle with `completion_seq` → done; working →
        idle with no `completion_seq` → done (`l:` token); blocked → idle without `completion_seq` → not
        done; same status with a changed `state_change_seq` resets `since`; late `completion_seq` →
        done; seen clears done; working again after done → working; raw `done` passes through;
        persistence round-trip (restore keeps `since`/`observed` when unchanged, malformed value ignored);
        pruning of gone panes
      - elapsed format: 0 s, 59 s, 60 s, 125 s, 3599 s, 3600 s, 61 min, 26 h
      - Agents: description in both scopes (examples above, `unknown` omitted, elapsed only when observed);
        `done` filter; scope `session` with and without a selected session; view description for filter
        `all` (with and without agents) and filtered (`blocked 2 of 7`); quick pick items and counts
      - tab summary: agents only, shells only (`1 shell`, `2 shells`), mixed, repeated kind (`×2`), empty
      - git description: `parseStatus` results → `⎇ v3_auth ● 4 ↑1`, `⎇ main · clean`, `⎇ main · clean ↓2`,
        detached; and a real temp repo through `LocalShell` (`git init -b main`, commit, modify a file →
        `⎇ main ● 1`; a clone one commit ahead of its bare origin → `⎇ main · clean ↑1`; a non-repo dir →
        no git part)
      - space directory choice: `checkout_path`, else focused pane's `foreground_cwd ?? cwd`, else first pane's
      - Sessions rows: container `herdr not running` row → `herdr.session.stopped container` with session
        `devc`; not-installed container row stays `herdr.session.absent`; host suffix unchanged
      - container start argv exactly as in the contract (with and without user)
      - status bar session text and tooltip for host, container, SSH
      - `extension.test.ts`: the new commands are registered; `herdr.agents.showDone`,
        `herdr.agents.scopeSession`, `herdr.agents.scopeAll` run without error
- [ ] Live, against a throwaway `hv-test` only (`HERDR_VSCODE_LIVE_HOME=<dir>` per README § Development;
      stop and delete `hv-test` afterwards with `herdr session stop hv-test` and
      `herdr session delete hv-test` in that `HOME`; never touch another session): extend
      `src/test/liveModel.test.ts` to report `working` then `idle` with `pane.report_agent` and assert the
      model's displayed status becomes `done` within 2 s, then `idle` after a seen mark; log the raw
      `agents[]` entry (`state_change_seq`, `completion_seq`) before and after, and copy the values into
      Implementation notes
- [ ] `git diff --stat -- devc-vscode` is empty
- [ ] Manual: in an Extension Development Host with an agent working in a session, the Agents row shows
      `… · working <1m`, then `1m` after a minute without any herdr event; reloading the window keeps the
      minutes counting from the same start
- [ ] Manual: an agent finishes (working → idle) while its tile is not focused: its icon turns green, the
      row says `done`, Sessions' row counts `1 done`; clicking into its tile turns it back to `idle`; the
      same when instead the herdr TUI's focus moves to that pane
- [ ] Manual: **Filter Agents…** lists All / Blocked / Working / Done with counts and a check on the current
      one; choosing Done shows only done agents and the description reads `all sessions · done 1 of <n>`;
      **Show All** clears it; the filter and the scope survive a reload
- [ ] Manual: the scope button switches the description between `all sessions` and `this session`, and
      `this session` lists only the selected session's agents with `<space> › <tab>` breadcrumbs; the
      blocked status bar item switches back to all sessions
- [ ] Manual: Spaces shows `⎇ <branch> ● <n>` on a space whose repo has changes, within 10 s of editing a
      file; nothing runs git while Spaces is collapsed (check with `ps -eo args | grep 'git --no-optional-locks'`
      over 30 s); tab rows read like `claude, copilot` / `2 shells`
- [ ] Manual, dev container: a running dev container with herdr installed and no session shows
      `herdr not running` with a **Start Session** button; pressing it starts `devc`, the row becomes the
      running session and is selected; `docker exec <id> ps -eo args | grep 'herdr --session devc server'`
      shows the server
- [ ] Manual: the status bar shows `herdr: <selected session>` (with `(devc)` for a container); its tooltip
      shows the herdr version; clicking it focuses the Sessions view

## Relevant Files

- `herdr-vscode/package.json` (commands, `view/title` and `view/item/context` menus, `commandPalette`,
  `viewsWelcome`)
- `herdr-vscode/src/sessions.ts` (parsing; displayed status applied to snapshots; optional tracker; seen
  re-apply)
- `herdr-vscode/src/agentState.ts` (new: tracker, persistence, elapsed format)
- `herdr-vscode/src/spaceGit.ts` (new: space directory choice, git description, visible-only poller)
- `herdr-vscode/src/status.ts` (session status bar item)
- `herdr-vscode/src/focus.ts` (a hook on every tile focus report for seen marks)
- `herdr-vscode/src/sessionControl.ts` (container start argv and start-and-wait for any environment)
- `herdr-vscode/src/extension.ts` (wiring: tracker from workspace state, seen on click commands, new
  commands, status bar item, container start, reveal-blocked scope)
- `herdr-vscode/src/views/agentsView.ts` (scope, done filter, quick pick, descriptions, timer)
- `herdr-vscode/src/views/spacesView.ts` (space git description and tooltip, tab summary, agent tooltip)
- `herdr-vscode/src/views/sessionsView.ts` (container contextValue suffix, startable `herdr not running` row)
- `herdr-vscode/src/test/fixtures.ts` (snapshot fixture with `agents[]` seq fields and `checkout_path`)
- `herdr-vscode/src/test/agentState.test.ts` (new), `herdr-vscode/src/test/spaceGit.test.ts` (new)
- `herdr-vscode/src/test/views.test.ts`, `herdr-vscode/src/test/sessions.test.ts`,
  `herdr-vscode/src/test/sessionControl.test.ts`, `herdr-vscode/src/test/extension.test.ts`,
  `herdr-vscode/src/test/liveModel.test.ts`
- `herdr-vscode/README.md` (Agents filters, scope, done, time in state; Spaces git and tab summaries;
  container Start; status bar)
- `herdr-vscode/CHANGELOG.md` (Unreleased entries)
- `herdr-vscode/docs/how-it-works.md` (§ Views: tracker rules, seen marks, persistence key, git cadence,
  container start argv; § Sessions)
- `.plans/PLAN.md` (phase 19 row and status, when implementing)
