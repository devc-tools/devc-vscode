# herdr-vscode: Sidebar rows follow herdr's config

Mockup board E ("herdr's own sidebar vs the VS Code views",
https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): users configure herdr's TUI sidebar with
`[ui.sidebar.spaces]` and `[ui.sidebar.agents]` rows in herdr's `config.toml`. herdr-vscode reads
the same rows and maps each row token onto the **Spaces** view's space rows and the **Agents**
view's rows, so the two sidebars show the same things. With no rows configured (or an invalid
config), every row stays exactly as phase 19 draws it.

Depends on [herdr-sidebar-triage](herdr-sidebar-triage.md) (phase 19: branch and git status on
space rows, Done state, time in state, Agents scope). Phase 19's row formats are the defaults
here and supply the `branch` / `git_status` text (`gitDescription(info)` in `src/spaceGit.ts`, split into
its branch and status parts); this plan only prescribes how configured rows
override them. Paths are under `herdr-vscode/`.

## Checklist

- [x] 1. Add `smol-toml` `1.9.1` (exact) to `dependencies`; lockfile updated
- [x] 2. Config path resolution on this machine (`HERDR_CONFIG_PATH`, `XDG_CONFIG_HOME`, `~/.config`)
- [x] 3. Parse and validate `ui.sidebar.spaces` / `ui.sidebar.agents` (incl. `rows_by_agent`) exactly as
      herdr 0.9.5 accepts them; any sidebar error → whole sidebar config ignored, logged once
- [x] 4. Snapshot carries `tokens` (workspaces and panes), `state_labels` and `terminal_title` (panes)
- [x] 5. Row renderer: tokens → label / description / icon for space rows and agent rows
- [x] 6. Spaces and Agents views use the renderer when their section is configured, phase 19's rows
      otherwise; Agents sources carry the environment (for `machine`)
- [x] 7. `herdr.useHerdrSidebarConfig` setting
- [x] 8. Reload: config file polled every 2 s; setting change; views re-render
- [x] 9. Measure (live, throwaway session) whether `pane.report_metadata` and
      `workspace.report_metadata` emit a subscribed event; add the token re-snapshot fallback only
      if one does not (see Refresh)
- [x] 10. Tests (list under Validation)
- [x] 11. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Decisions

- **Only this machine's config is read**, for every session (host, SSH, container). herdr-vscode is
  one local client showing many sessions, and the Agents view mixes all of them in one sorted
  list, so it needs one row format; this is also how herdr's own `machine` token is meant to be
  used (one client's rows naming the machine). Tradeoff: a container's or SSH host's own
  `config.toml` (devc seeds containers from `~/.config/devc/herdr`, not from the host's
  `~/.config/herdr`) is ignored, so the TUI inside a container may differ from VS Code. No
  RemoteShell reads, no remote watching.
- **TOML parser: `smol-toml` `1.9.1`** (BSD-3-Clause, no dependencies, TOML 1.0, published
  2026-10-09 so it passes `.npmrc`'s `min-release-age=3`). Install with
  `npm install --save-exact smol-toml@1.9.1` in `herdr-vscode/`; esbuild bundles it into
  `dist/extension.js` (no `external` change). Not a hand-written parser: herdr configs use inline
  tables, mixed arrays and multi-line arrays.
- **`$name` tokens** are herdr's display-only metadata: workspace tokens reported with
  `herdr workspace report-metadata --source <id> --token NAME=VALUE <workspace>` and pane tokens
  with `herdr pane report-metadata --source <id> --token NAME=VALUE <pane>`. They arrive in
  `session.snapshot` as `workspaces[].tokens` and `panes[].tokens` (objects of string → string,
  keys without the `$`). A missing or empty value renders nothing.
- Styles (`fg`, `bold`, `dim`) and `row_gap` are validated but have no effect: a tree item's
  description is one plain string.

### Settings

| Key | Type | Default | Scope |
| --- | --- | --- | --- |
| `herdr.useHerdrSidebarConfig` | boolean | `true` | `window` |

Description: "Lay out Spaces and Agents rows from `[ui.sidebar.*]` in this machine's herdr
`config.toml`. Off: the built-in rows." When `false`, the config file is not read or polled.

### Config path (this machine only)

In order, from the extension host's `process.env`:

1. `HERDR_CONFIG_PATH`, when set and non-empty: that path as given.
2. `$XDG_CONFIG_HOME/herdr/config.toml`, when `XDG_CONFIG_HOME` is set and non-empty.
3. `<os.homedir()>/.config/herdr/config.toml`.

Measured with `herdr config check` (0.9.5): `HERDR_CONFIG_PATH` wins over `XDG_CONFIG_HOME`, which
wins over `~/.config`. The path may be a symlink (devc containers link it to a seed file); read it
with `fs.readFile`, which follows links. On Windows (`process.platform === 'win32'`) nothing is
read: defaults.

- File missing (`ENOENT`) → defaults, nothing logged.
- Any other read error → defaults, logged.

### Schema accepted (herdr 0.9.5)

Only `ui.sidebar.spaces` and `ui.sidebar.agents` are read; every other key in the file is
ignored, as are unknown keys inside `ui.sidebar`, `ui.sidebar.spaces` and `ui.sidebar.agents`
(herdr warns and ignores them too).

| Key | Value |
| --- | --- |
| `ui.sidebar.spaces.rows` | rows (below), space tokens |
| `ui.sidebar.spaces.row_gap` | integer ≥ 0 (ignored) |
| `ui.sidebar.agents.rows` | rows, agent tokens |
| `ui.sidebar.agents.row_gap` | integer ≥ 0 (ignored) |
| `ui.sidebar.agents.rows_by_agent` | table: agent id → rows, agent tokens |

*rows* is an array of arrays (`[]` and `[[]]` are valid). Each element is either a token string,
or an inline table `{ token = "<token>", fg = "#RGB" | "#RRGGBB", bold = <bool>, dim = <bool> }`
where `token` is required, the other three optional, and **no other key is allowed**
(`fg` must match `/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/`; `fg = "blue"` is invalid).

Token strings:

- Space tokens: `state_icon`, `state_text`, `workspace`, `branch`, `git_status`.
- Agent tokens: `state_icon`, `state_text`, `machine`, `workspace`, `tab`, `pane`, `agent`,
  `terminal_title`, `terminal_title_stripped`.
- Custom (both sections): `$` followed by `/^[A-Za-z0-9_-]{1,32}$/` (`$a-b_9`, `$ABC` valid; `$`,
  `$x.y`, a 33-character name invalid).
- Any other string is invalid. Measured: `agent` or `tab` in space rows, `branch` or
  `git_status` in agent rows, `bogus` anywhere → herdr rejects.

**Validation is all-or-nothing, like herdr's** (any error makes herdr print `using defaults` and
ignore the whole config): if the TOML does not parse (`smol-toml` throws `TomlError`), or `ui`,
`ui.sidebar`, `ui.sidebar.spaces`, `ui.sidebar.agents` or `rows_by_agent` is present but not a
table, or any rows / token / style / `row_gap` value above is invalid, **both** views use
defaults. Log once per distinct failure (not on every poll) to the `herdr` output channel:

```
sidebar config: <path>: <reason>; using default rows
```

`<reason>` is the `TomlError` message's first line, or e.g. ``unknown space token `agent` `` /
``invalid custom token `$x.y` `` / `ui.sidebar.agents.rows must be an array of arrays`. On a
successful load that changes the result, log `sidebar config: <path>: loaded`.

`rows_by_agent` keys are not validated (herdr rejects ids that are not canonical agent ids, e.g.
`github_copilot`, `open_code`; its list changes between releases). A key applies to an agent row
whose snapshot `agent` equals the key exactly; keys matching no pane do nothing.

Example (the test fixture):

```toml
onboarding = false

[ui.sidebar.spaces]
row_gap = 1
rows = [["state_icon", "workspace", "$jj_status"], ["branch", "git_status"]]

[ui.sidebar.agents]
rows = [["state_icon", { token = "machine", dim = true }, "workspace", "tab"], ["agent"], ["$ticket"]]

[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"], ["agent"]]
```

Parsed result (token names only, rows kept in order; styles dropped after validation):

```json
{
  "spaces": { "rows": [["state_icon", "workspace", "$jj_status"], ["branch", "git_status"]] },
  "agents": {
    "rows": [["state_icon", "machine", "workspace", "tab"], ["agent"], ["$ticket"]],
    "rowsByAgent": { "claude": [["state_icon", "workspace", "tab"], ["terminal_title_stripped"], ["agent"]] }
  }
}
```

A section is *configured* when its `rows` key is present (an agent row is also configured when
`rows_by_agent` has its agent). A file with only `[ui.sidebar.agents.rows_by_agent]` configures
only the agents it names; all other rows keep phase 19's default.

herdr 0.9.5's own defaults, for reference (board E): spaces
`[["state_icon", "workspace"], ["branch", "git_status"]]`, agents
`[["state_icon", "machine", "workspace", "tab"], ["agent"]]`. herdr-vscode does **not** feed these
through the renderer when a section is unconfigured: it keeps phase 19's row.

### Rendering a configured row

Rows are flattened: row 1's tokens, then row 2's, and so on (a tree item has one line). Each
token falls into one of three classes:

| Token | Space row | Agent row |
| --- | --- | --- |
| `state_icon` | icon: phase 19's status icon of the worst agent status in the space (rolls up, `done` included) | icon: phase 19's status icon of `agent_status` |
| `workspace` | **label**: workspace label | description: workspace label |
| `agent` | (invalid) | **label**: today's `paneLabel` (live agent name, `display_agent`, `agent`, …) |
| `state_text` | description: worst status word (`blocked`, `working`, `done`, `idle`); nothing when the space has no agents or the worst is `unknown` | description: `state_labels[agent_status]` when non-empty, else the status word; nothing for `unknown` |
| `branch` | description: phase 19's branch part of `gitDescription` (e.g. `⎇ v3_auth`); nothing when not a repo | (invalid) |
| `git_status` | description: phase 19's git status part of `gitDescription` (e.g. `● 4 ↑1`, `clean`); nothing when unknown | (invalid) |
| `machine` | (invalid) | description: the environment's label (ssh alias, container folder name) when the environment is not `host`; nothing on this machine |
| `tab` | (invalid) | description: the pane's tab label |
| `pane` | (invalid) | description: the pane's `label`; nothing when absent (herdr 0.9.5 snapshots carry none) |
| `terminal_title` | (invalid) | description: `terminal_title` |
| `terminal_title_stripped` | (invalid) | description: `terminal_title_stripped` |
| `$name` | description: `workspaces[].tokens[name]` | description: `panes[].tokens[name]` |

Rules:

- **Label**: the first occurrence of the row's label token (`workspace` / `agent`). When the
  configured rows have none, the label is still that value (a tree item needs one); it is then
  not repeated in the description.
- **Icon**: set when `state_icon` occurs (any number of times); when it does not occur, the row
  has **no icon** (`iconPath` undefined). Shell panes never appear in Agents, so the `terminal`
  icon does not arise here.
- **Description segments**: every other token, in flattened order. A token kind renders at most
  once (first occurrence wins; later duplicates are skipped). A segment whose value is missing,
  empty or whitespace-only is skipped. Values are trimmed.
- **Joining**: consecutive rendered segments are joined with ` · `, except
  - ` › ` when the previous rendered segment is `workspace` or `tab` and the current one is `tab`
    or `pane` (breadcrumb), and
  - when `branch` is immediately followed by `git_status`, the pair is rendered as one segment
    exactly as phase 19 renders branch + git status in its default space description.
- Phase 19 parts with no herdr token are kept: on agent rows, phase 19's time-in-state text
  (`formatElapsed(now - pane.state_since)` from `src/agentState.ts`, only when `state_since` is set) is
  appended last, joined with ` · `, whatever the config. Tab rows, pane rows, Spaces' tab
  summaries, tooltips, `contextValue`, click commands, sorting, filtering, the badge and the
  Agents scope switch are unchanged (`tabSummary`, `agentTooltip`, `sortAndFilterAgents`,
  `agentsViewDescription`, `filterPickItems` in `src/views/`).
- Empty description → `undefined`.

Examples (session on this machine unless stated; phase 19 formats `⎇ v3_auth ● 4 ↑1`):

| Config section | Data | Label | Description | Icon |
| --- | --- | --- | --- | --- |
| spaces fixture above | space `deephaven-mcp / v3_auth`, worst `blocked`, branch `v3_auth`, 4 changed, 1 ahead, token `jj_status=jj:kq` | `deephaven-mcp / v3_auth` | `jj:kq · ⎇ v3_auth ● 4 ↑1` | blocked |
| spaces `[["workspace"], ["state_text"]]` | space with no agents | `docs-review` | (none) | none |
| agents fixture `rows` | `copilot`, workspace `v3_auth`, tab `agents`, host, no `ticket` | `copilot` | `v3_auth › agents` | status |
| agents fixture `rows` | `codex` on SSH `buildbox`, workspace `infra-ci`, tab `main`, `ticket=DH-42` | `codex` | `buildbox · infra-ci › main · DH-42` | status |
| agents fixture `rows_by_agent.claude` | `claude`, `v3_auth` › `agents`, title `Refactoring auth middleware` | `claude` | `v3_auth › agents · Refactoring auth middleware` | status |
| agents `[["agent", "state_text"]]` | `blocked`, `state_labels.blocked = "needs approval"` | `claude` | `needs approval` | none |

(Phase 19's time-in-state text, when it has one for the row, follows each agent description
above after ` · `.)

### Snapshot fields

`parseSnapshot` additionally keeps, per herdr 0.9.5's API schema (`herdr api schema --json`):

- `workspaces[].tokens` and `panes[].tokens`: objects; keep entries whose value is a string; absent
  → empty.
- `panes[].state_labels`: object of status → string; keep string values; absent → empty.
- `panes[].terminal_title`: string or absent.

### Refresh

- The resolved config path is polled with `fs.watchFile(path, { interval: 2000 })` (follows
  symlinks, sees creation and deletion of a missing file). On any change of `mtimeMs`, `size` or
  `ino`, re-read, re-validate and, if the parsed result changed, re-render both views. The poller
  is started on activation when `herdr.useHerdrSidebarConfig` is true, stopped
  (`fs.unwatchFile`) when it turns false or on dispose.
- `herdr.useHerdrSidebarConfig` change → load or drop the config and re-render.
- The path is resolved once at activation (environment variables of a running extension host do
  not change).
- Token values: `workspace.metadata_updated` is already subscribed and re-snapshots. Whether
  `pane.report_metadata` emits `pane.updated` (subscribed) is unknown: measure it (checklist 9).
  If it does not, then while the Spaces or Agents view is visible and the active config contains
  a `$` token, re-take `session.snapshot` for every connected session every 10 s; otherwise add
  nothing. Record the measurement and the outcome under Implementation notes.

### Gotchas

- herdr rejects its **whole** config for errors outside `ui.sidebar` too (measured:
  `[theme] name = 5` → `using defaults`, sidebar rows ignored) and for unknown `rows_by_agent`
  ids. herdr-vscode validates only the sidebar section, so with such an error the TUI shows
  herdr's defaults while VS Code follows the rows. `herdr config check` shows the problem; README
  says so.
- VS Code started from a desktop launcher may not have `HERDR_CONFIG_PATH` / `XDG_CONFIG_HOME`
  that a shell profile sets; it then reads `~/.config/herdr/config.toml`.
- `smol-toml` returns integers as JS `number` (do not enable `integersAsBigInt`); check
  `row_gap` with `Number.isInteger(v) && v >= 0`.
- Duplicate keys and other TOML errors throw `TomlError`; treat any thrown error from `parse` as
  invalid.
- The test host sets `HERDR_VSCODE_NO_DISCOVERY=1`, but the config loader is not discovery: tests
  must pass the env and path explicitly (load function takes `env` and `homedir` as inputs) and
  never read the real `~/.config/herdr/config.toml`. In the test extension host, the activated
  extension must not read the real file either: skip the config poller when
  `HERDR_VSCODE_NO_DISCOVERY=1`.

## Validation

- [x] `npm run build && npm run lint && xvfb-run -a npm test` (in `herdr-vscode/`) passes, with
      unit tests for:
  - [x] path resolution: `HERDR_CONFIG_PATH` wins; `XDG_CONFIG_HOME` next; empty values ignored;
        `~/.config/herdr/config.toml` last
  - [x] the example fixture parses to exactly the JSON above
  - [x] valid: `rows = []`, `rows = [[]]`, styled token with `fg = "#89b4fa"`, `bold`, `dim`;
        `$a-b_9`, `$ABC`, a 32-character custom name; `state_text` in both sections; unknown keys
        `ui.sidebar.foo` and `ui.sidebar.agents.foo` ignored; unrelated `[theme]` keys ignored
  - [x] invalid → both sections default and one log line: `agent` / `tab` in spaces; `branch` /
        `git_status` in agents; `bogus`; `$`; `$x.y`; 33-character custom name;
        `{token="agent", italic=true}`; `{fg="#fff"}` without `token`; `fg = "blue"`; `rows = 5`;
        `[ui] sidebar = 3`; `row_gap = "x"`; `row_gap = -1`; unterminated `x = [`; the same
        invalid file polled twice logs once
  - [x] missing file → defaults, no log; unreadable path (a directory) → defaults, logged
  - [x] `parseSnapshot` keeps workspace/pane `tokens`, pane `state_labels` and `terminal_title`,
        dropping non-string values
  - [x] renderer: every row of the Examples table (label, description, icon present or absent);
        `machine` omitted for `host`, shown for an SSH and a container environment; duplicate
        tokens render once; missing `$` value skipped with no doubled separator; `workspace ›
        tab` and `tab › pane` breadcrumbs; label fallback when the rows lack `workspace` /
        `agent`; `rows_by_agent` picks by exact `agent`, others use `rows`; with only
        `rows_by_agent`, a non-matching agent gets phase 19's default row unchanged
  - [x] views: Spaces and Agents items equal phase 19's defaults with no config and with
        `herdr.useHerdrSidebarConfig` false; switch to configured rows after a load event
  - [x] reload: writing a temp config file (via an explicit path) re-renders the views within
        5 s; deleting it returns to defaults; a symlink retargeted to another file is picked up
- [x] `npx vsce ls` (in `herdr-vscode/`) lists no `node_modules` (smol-toml is bundled);
      `package.json` has `"smol-toml": "1.9.1"` (no range) and `package-lock.json` resolves 1.9.1
- [x] `git diff --stat -- devc-vscode` is empty
- [x] Live (opt-in, `HERDR_VSCODE_LIVE_HOME`, throwaway session `hv-test` in an isolated `HOME`):
      `herdr workspace report-metadata --source hv --token jj_status=x <ws>` and
      `herdr pane report-metadata --source hv --token ticket=DH-1 <pane>` show up in the parsed
      snapshot's `tokens`; which events each emitted is recorded under Implementation notes
- [ ] Manual: with `[ui.sidebar.agents] rows = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"], ["agent"]]`
      in `~/.config/herdr/config.toml`, Agents rows read `claude` / `v3_auth › agents · <title>`
      within 3 s of saving, with no reload
- [ ] Manual: removing `state_icon` from `[ui.sidebar.spaces] rows` removes the space icons; putting
      it back restores them, worst status rolled up
- [ ] Manual: an agent in a dev container session shows the container's folder name first with the
      default-style agents rows; an agent on this machine shows none
- [ ] Manual: `herdr workspace report-metadata <ws> --source me --token jj_status=jj:kq` (id first; herdr 0.9.5 rejects options before it) in a session
      whose spaces rows include `$jj_status` shows `jj:kq` on that space's row
- [ ] Manual: a typo (`"bogus"`) in the rows → both views go back to defaults and the herdr output
      channel shows `sidebar config: …: unknown … token \`bogus\`; using default rows` once; fixing
      it restores the configured rows
- [ ] Manual: `herdr.useHerdrSidebarConfig: false` → defaults immediately; `true` → configured rows

## Relevant Files

- `herdr-vscode/package.json` (`smol-toml` dependency, `herdr.useHerdrSidebarConfig` setting)
- `herdr-vscode/package-lock.json`
- `herdr-vscode/src/sidebarConfig.ts` (new: path resolution, parse and validation, poller, row
  renderer)
- `herdr-vscode/src/sessions.ts` (`parseSnapshot`: `tokens`, `state_labels`, `terminal_title`;
  token re-snapshot fallback only if checklist 9 needs it)
- `herdr-vscode/src/views/spacesView.ts` (`buildSpaces(snapshot, sessionKey, git?)` space rows through the
  renderer when configured; `SpacesView` takes the config source before its drag controller; `tabSummary`,
  `agentTooltip` unchanged)
- `herdr-vscode/src/views/agentsView.ts` (`agentRows(sources, scope, now)` agent rows through the renderer when
  configured; `stateText` stays the default; `AgentSource` gains the environment kind and label; `AgentsView`
  takes the config source before its drag controller)
- `herdr-vscode/src/status.ts` (read only: `statusIcon`, `worstStatus`, as phase 19 leaves them)
- `herdr-vscode/src/spaceGit.ts` (`gitDescription(info)` unchanged; a splitter into branch and status parts)
- `herdr-vscode/src/agentState.ts` (read only: `formatElapsed`)
- `herdr-vscode/src/agentReview.ts` (read only: Ask Agent's picker keeps the default rows)
- `herdr-vscode/src/extension.ts` (load config, poller lifecycle, `NO_DISCOVERY` skip, pass
  environment to agent sources, re-render on reload)
- `herdr-vscode/src/test/sidebarConfig.test.ts` (new)
- `herdr-vscode/src/test/views.test.ts`, `herdr-vscode/src/test/sessions.test.ts`,
  `herdr-vscode/src/test/fixtures.ts`, `herdr-vscode/src/test/spaceGit.test.ts`
- `herdr-vscode/src/test/liveModel.test.ts` (opt-in metadata measurement)
- `herdr-vscode/README.md` (Settings table row; a "Rows from herdr's config" section with the
  token mapping table, this-machine-only note and `herdr config check` advice)
- `herdr-vscode/CHANGELOG.md`
- `herdr-vscode/docs/how-it-works.md` (Views: config path, validation, rendering, refresh)
- `.plans/PLAN.md`

## Implementation notes

### Status (2026-10-31)

Implemented; the six Manual items need a person in VS Code (and a dev container for the `machine` one), so
they stay unticked and the plan stays out of `implemented/`.

### Phase 19 names (plan edited before implementing)

The plan predates phase 19 and named its formatter only by description. Relevant Files and Contracts now
name the real functions: `agentRows(sources, scope, now)` / `stateText` / `sortAndFilterAgents` /
`agentsViewDescription` / `filterPickItems` in `src/views/agentsView.ts`; `formatElapsed` and
`SnapshotPane.state_since` (`src/agentState.ts`); `gitDescription(info)` in `src/spaceGit.ts`;
`buildSpaces(snapshot, sessionKey, git?)`, `tabSummary`, `agentTooltip` in `src/views/spacesView.ts`.
`src/spaceGit.ts`, `src/agentState.ts`, `src/agentReview.ts` and `src/test/spaceGit.test.ts` were added to
Relevant Files (`spaceGit.test.ts` ended up untouched: the splitter is tested in `sidebarConfig.test.ts`).

### Measured

- `smol-toml@1.9.1` (published 2026-10-09) installed with `npm install --save-exact` under
  `min-release-age=3`; `package.json` has `"smol-toml": "1.9.1"`, the lockfile resolves 1.9.1. esbuild
  bundles it (`dist/extension.js` 285 kB); `npx vsce ls` lists only `dist/`, `resources/`, `package.json`,
  `README.md`, `CHANGELOG.md`, `LICENSE` (no `.vscodeignore` change).
- Live (`HERDR_VSCODE_LIVE_HOME=/tmp/hvt`, `hv-test`, herdr 0.9.5; `liveModel` "report-metadata tokens reach
  the snapshot"), two runs: `workspace report-metadata` emitted **`workspace.metadata_updated`** (token in
  the model after 359 / 209 ms); `pane report-metadata` emitted **`pane.updated`** (token in the model after
  176 / 194 ms). Both are subscribed, so **no token re-snapshot fallback was added**. Both tokens appear in
  a parsed `session.snapshot` (`workspaces[].tokens.jj_status`, `panes[].tokens.ticket`); the test clears
  them afterwards.
- herdr 0.9.5's CLI wants the id **before** the options: `herdr workspace report-metadata --source hv --token
  jj_status=x w1` fails with `unknown option: hv` (exit 2), `herdr workspace report-metadata w1 --source hv
  --token jj_status=x` works. The live test and README use the id-first form; the Manual item's command
  needs it too.
- `herdr config check` on temp files (`HERDR_CONFIG_PATH`, isolated `HOME`) agrees with the validator on
  `bogus`, `rows = [[]]`, `$x.y`, `italic`, `fg = "blue"`, the fixture's agents rows, `row_gap = -1`.
- `npm run build && npm run lint && xvfb-run -a npm test`: 322 passing, 60 pending (before: 307 / 59; +15
  unit tests in `src/test/sidebarConfig.test.ts`, +1 opt-in live test). The poll test saw a new file after
  2018 ms.
- Live run (`HERDR_VSCODE_LIVE_HOME=/tmp/hvt`): 377 passing, 4 pending, 1 failing — the pre-existing
  `live model … lists only the isolated session` (the home also lists `default` and `hv-ctl`). `hv-test`
  and `hv-ctl` were stopped and deleted, `/tmp/hvt` removed. The real `~/.config/herdr/config.toml` (a
  symlink to devc's seed) was never written (target mtime 2026-09-24 13:38:36, md5 unchanged); the test
  host does not read it (`HERDR_VSCODE_NO_DISCOVERY=1` → no path).

### Deviations and decisions

- **Ask Agent keeps the default rows.** `agentPickItems` and thread titles (`src/agentReview.ts`) call
  `agentRows` without a config, so they keep phase 19's config-independent strings and threads stay stable
  when the config changes; `agentReview.test.ts` "candidates carry the environment path" is unchanged and
  still pins those strings.
- **Time in state** appended to configured agent rows is `formatElapsed(now - state_since)` alone (`2m`),
  not phase 19's `stateText` (`blocked 2m`): the status word is `state_text`'s job, and appending
  `stateText` would repeat it. Nothing is appended without `state_since` or for `unknown`.
- `branch` / `git_status` come from splitting phase 19's `gitDescription` string (`splitGitDescription` in
  `src/spaceGit.ts`; a ref name has no spaces), so `SpaceGit` and its cache are unchanged; `branch`
  immediately followed by `git_status` renders the whole `gitDescription` string.
- Constructors: `SpacesView(sessions, snapshotOf, onModelChange, spaceGit?, sidebar?, dnd?)` and
  `AgentsView(sources, onModelChange, memento, selectedSession, sidebar?, dnd?)` — the drag controller stays
  last. `sidebar` is a `SidebarRowsSource` (`config` + `onDidChange`), implemented by `SidebarConfigSource`.
- `AgentSource` gained optional `envKind` / `envLabel` (optional so other callers keep compiling; no
  `machine` without them). `SnapshotWorkspace.tokens`, `SnapshotPane.tokens` / `state_labels` are typed
  optional but `parseSnapshot` always sets them (empty when absent).
- smol-toml's types are its ES module's, which TypeScript (module `Node16`) refuses to `import` from a
  CommonJS file (TS1479); `src/sidebarConfig.ts` loads it with `require('smol-toml')` (its CommonJS build)
  typed through `import type … with { 'resolution-mode': 'import' }`.
- An agents section with only `row_gap` (no `rows`, no `rows_by_agent`) is validated and leaves `agents`
  out of the parsed result, as for an absent section.
- `fs.watchFile` is started with `persistent: false`.
- The "views" Validation item is covered at the row-builder level (`buildSpaces` → `spacesTreeItem`,
  `agentRows` driven by a `SidebarConfigSource` that is enabled, disabled and fires its change event), not
  by second `SpacesView` / `AgentsView` instances: the activated extension already owns the
  `herdr.spaces` / `herdr.agents` tree views in the test host. The views' wiring (`sidebar.onDidChange` →
  `update()`) is left to the Manual items.
