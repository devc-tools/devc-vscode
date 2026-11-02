# herdr-vscode: pane identity (agent marks, task-title names, Active Pane pane row)

Decided by the user on 2026-11-02:

1. A pane's **name** is what it is working on, not its agent kind: three Claude panes must not all read
   `claude`. The terminal title (Claude Code keeps it set to the current task) comes before `label`, the
   folder and the agent kind.
2. The **agent kind** is shown as an icon: devc web's Lobe Icons marks (claude, copilot, pi, opencode),
   coloured by agent status, in place of the status dot wherever one pane is shown.
3. **Active Pane** gets a real first row for the pane (icon, name, `<space> › <tab>`), replacing the
   header text line, and clicking it opens the pane's tile. Today the header says `not open in a tile` and
   the only fix is an inline action on the repo row that is easy to miss.

Measured on 2026-11-02 in the running `devc` session (herdr 0.9.5): no pane had an `agents[].name` or
`display_agent`; all three had `agent: "claude"`; `label` was missing on one and stale on another (an old
session title); `terminal_title_stripped` was present, distinct and current on all three
(`Herdr-vscode session improvements`, `web_git_history_test.ts CI failure`, …). Tab labels were `1`, `2`, `3`.

Depends on phase 26. Paths are under `herdr-vscode/` unless they start with `.plans/`.
[herdr-commit-changes](herdr-commit-changes.md) (phase 28) builds on the pane row added here.

## Checklist

- [ ] 1. Vendor the four marks: copy `devc-tools/devc/web/static/vendor/agent-icons/{claudecode,githubcopilot,pi,opencode}.svg`,
      `LICENSE` and `VERSIONS` byte-for-byte into `resources/agent-icons/`
- [ ] 2. `scripts/build-agent-icons.sh`: even-odd → non-zero paths, then an icon font; commit its output
      `resources/agent-icons.woff`; the glyph-hole check (Validation) passes
- [ ] 3. `contributes.icons` for the four marks; `agentIcon(pane)` returning the coloured mark, the dot for other agents,
      nothing for shells
- [ ] 4. `paneLabel` order and `paneDescription` changed (Contracts); tile headers follow
- [ ] 5. Spaces pane rows, Agents rows and the focused-pane status bar item use the mark
- [ ] 6. Tiles webview: the tile header's dot becomes the inline-SVG mark for the four agents (`src/agentMarks.ts`)
- [ ] 7. Active Pane: pane row first; header message only for no-pane states; Show Pane moves from the repo row
      to the pane row
- [ ] 8. Tests (Validation)
- [ ] 9. README, CHANGELOG, `docs/how-it-works.md`

## Contracts

### Pane name (`paneLabel`, `src/sessions.ts`)

First non-empty of:

1. `agents[].name` (the snapshot's `agentNames`)
2. `terminal_title_stripped`
3. `label`
4. the basename of `foreground_cwd ?? cwd` (trailing `/` removed)
5. `display_agent ?? agent`
6. `shell`

Whitespace-only values count as empty; values are trimmed. `display_agent` moves from 2nd to 5th place.

### Pane description (`paneDescription`, `src/views/spacesView.ts`)

- Agent pane: the basename of `foreground_cwd ?? cwd` (was `terminal_title_stripped`). Omitted when it equals the
  pane name or there is no directory.
- Shell pane: `foreground_cwd ?? cwd`, unchanged.

The sidebar config path (`renderAgentRow`, `renderSpaceRow`) keeps receiving `paneLabel` as its `label` input; no
token changes. `agentTooltip` stays `<agent> · <status>[ for <elapsed>]\n<pane id>`. `tabSummary` (agent kinds,
`claude ×2`) is unchanged.

### Tile headers (`tileMetas`, `src/tilesPanel.ts`)

`label` = `paneLabel`; `detail` = the folder basename for agent panes (was the terminal title, now the label),
omitted when equal to `label`; shells keep no detail. `TileMeta` gains `agent?: string` (herdr's `agent`, for the
mark). Strip entries (`StripTab`) keep their status dot: a tab can hold several agents.

### Icon font

- `resources/agent-icons/` holds the vendored SVGs, `LICENSE`, `VERSIONS` (unmodified copies), and
  `resources/agent-icons/nonzero/<name>.svg` (the converted outlines the font is built from).
- `scripts/build-agent-icons.sh` (bash, `set -euo pipefail`, run by hand, **not** part of `npm run build`):
  1. `pipx run picosvg resources/agent-icons/<name>.svg > resources/agent-icons/nonzero/<name>.svg` for each of the four.
     picosvg rewrites `fill-rule="evenodd"` shapes as non-zero outlines; font glyphs are filled non-zero, so the raw
     files would lose their holes (the Claude mark's eyes, the pi and opencode counters).
  2. `npx --yes fantasticon@3.0.0 resources/agent-icons/nonzero -o "$tmp" -t woff -g json -n agent-icons --normalize
     --font-height 1000 --descent 0 --codepoints "$tmp/codepoints.json"`, with `codepoints.json`
     `{"claudecode":57345,"githubcopilot":57346,"pi":57347,"opencode":57348}` (U+E001–U+E004), then copy
     `$tmp/agent-icons.woff` to `resources/agent-icons.woff`.
  3. Runs the glyph-hole check below and exits non-zero when it fails.
- `package.json` `contributes.icons`:

  | id | description | fontCharacter |
  | --- | --- | --- |
  | `herdr-agent-claude` | Claude Code | `\E001` |
  | `herdr-agent-copilot` | GitHub Copilot | `\E002` |
  | `herdr-agent-pi` | pi | `\E003` |
  | `herdr-agent-opencode` | OpenCode | `\E004` |

  each `"default": { "fontPath": "resources/agent-icons.woff", "fontCharacter": "<above>" }`. `.vscodeignore`
  already ships `resources/**`.
- Glyph-hole check (`pipx run --spec fonttools python - resources/agent-icons.woff` with an inline script, or a
  `scripts/check-agent-icons.py` the shell script calls): with SVG point `(x, y)` in the 24×24 viewBox mapped to font
  units as `(x * 1000/24, (24 - y) * 1000/24)`, use `fontTools.pens.pointInsidePen.PointInsidePen` on each glyph:

  | glyph | inside | outside (a hole) |
  | --- | --- | --- |
  | U+E001 claude | (12, 6.5) | (6.744, 9.5) left eye, (17.255, 9.5) right eye |
  | U+E003 pi | (3.75, 12) | (9.25, 9.25) |
  | U+E004 opencode | (6, 12) | (12, 12) |

  If `--normalize` scales differently than assumed, compute the mapping from the glyph's bounds against the SVG
  path's bounds rather than skipping the check.

### Agent icon (`src/status.ts`)

`agentIcon(pane)`:

- `hasAgent(pane)` and `pane.agent` ∈ {`claude`, `copilot`, `pi`, `opencode`}:
  `new ThemeIcon('herdr-agent-<agent>', new ThemeColor(<status colour>))`, the colour table `statusIcon` uses
  (`charts.orange` blocked, `charts.blue` working, `charts.green` done, `disabledForeground` idle / unknown).
- Any other agent: `statusIcon(pane.agent_status)` (today's dot).
- Shell: `undefined`.

Used by `paneTreeItem` (Spaces pane rows and Agents rows, so the sidebar config's `noIcon` still clears it) and the
Active Pane pane row. Session, space and tab rows keep their dots (they aggregate several panes).

Status bar focused-pane item (`src/focus.ts`): text `$(herdr-agent-<agent>) <name> · <status>` for the four agents,
`$(circle-filled) …` for others, unchanged for shells.

### Tiles webview mark (`src/agentMarks.ts`, `src/webview/tiles.ts`, `tiles.css`)

`src/agentMarks.ts` exports the path data per agent id, copied from `devc-tools/devc/web/static/lib/agent_icons.js`
`AGENT_MARKS` (24×24, `fill="currentColor"`, `fill-rule="evenodd"`). In a tile header, a pane whose `TileMeta.agent`
is one of the four gets a 12×12 inline `<svg class="tile-mark tile-mark-<status>">` where the dot was; its colour is
the dot's colour for that status (same CSS variables). Other agents keep the dot; shells get nothing.

### Active Pane pane row (`src/paneContext.ts`)

When a pane is followed, the first top-level row (before the repo row) is:

- **type** `pane`; **id** `<pane key>|pane`
- **label**: `paneLabel`
- **description**: `<space label> › <tab label>` (ids when unlabelled), then ` · not open in a tile` when no tile in
  this window shows the pane
- **icon**: `agentIcon(pane)`; for a shell `new ThemeIcon('terminal')`
- **tooltip**: `agentTooltip(pane)` for agents, the pane id for shells
- **click**: `paneClickCommand(ref)` (opens or reveals the pane's space tab and focuses its tile, as Spaces rows do)
- **contextValue**: `herdr.paneContext.pane`, plus ` hidden` when not open in a tile
- **inline action**: `herdr.paneContext.showPane` (`$(window)`), `when`
  `view == herdr.paneContext && viewItem == 'herdr.paneContext.pane hidden'`

`TreeView.message` is set only when no pane is followed (today's `NO_PANE_MESSAGE` and the pinned-pane-unavailable
text); otherwise `undefined`. Pinned state is shown by the title bar's pin / unpin button only.

The repo row loses `showable` (and its ` showable` context value suffix) and the Show Pane inline action. Its other
actions are unchanged. The pane row refreshes on snapshot changes (name and status change constantly) by firing
only that row, not the whole tree.

## Validation

- [ ] `cd herdr-vscode && npm run compile && npm run lint` succeed
- [ ] Bundle on Linux with the esbuild binary in `node_modules` built for macOS:
      `ESBUILD_BINARY_PATH=<linux esbuild> npm run bundle` (install `@esbuild/linux-arm64@<same version>` into a
      scratch directory; do not change `node_modules`)
- [ ] `xvfb-run -a npx vscode-test` passes, including new tests:
  - [ ] `paneLabel`: the order above, one case per step; whitespace-only `terminal_title_stripped` falls through;
        the 2026-11-02 measurement (`agent: claude`, title, stale label) gives the title
  - [ ] `paneDescription`: agent → folder basename, omitted when equal to the name; shell → full path
  - [ ] `agentIcon`: `claude` blocked → id `herdr-agent-claude`, colour `charts.orange`; `codex` → `circle-filled`;
        shell → `undefined`
  - [ ] `package.json` `contributes.icons` has exactly the four ids with the `fontPath` and characters above, and
        `resources/agent-icons.woff` exists
  - [ ] `tileMetas`: `detail` is the folder basename, `agent` is set; strip entries unchanged
  - [ ] Active Pane: top-level rows are pane, repo, …; pane row label, description with and without
        `· not open in a tile`, context value with ` hidden`, click command = `paneClickCommand`; `host.message` is
        `undefined` while following and `NO_PANE_MESSAGE` with none; the repo row's context value has no ` showable`
  - [ ] Show Pane `when` clause matches `herdr.paneContext.pane hidden` only
  - [ ] Tiles webview probe: a `claude` tile header has a `.tile-mark` and no `.tile-dot`; a shell has neither
- [ ] `bash scripts/build-agent-icons.sh` runs clean and the glyph-hole check passes
- [ ] `cmp` of each vendored SVG, `LICENSE` and `VERSIONS` against the devc-tools originals reports no difference
- [ ] Manual (left to the user, record under Implementation notes): Spaces, Agents and Active Pane show the Claude
      mark in orange / blue / green / gray with the eyes visible, in a light and a dark theme

## Relevant Files

- `herdr-vscode/resources/agent-icons/claudecode.svg`, `githubcopilot.svg`, `pi.svg`, `opencode.svg`, `LICENSE`,
  `VERSIONS` (new, vendored)
- `herdr-vscode/resources/agent-icons/nonzero/*.svg` (new, generated)
- `herdr-vscode/resources/agent-icons.woff` (new, generated)
- `herdr-vscode/scripts/build-agent-icons.sh` (new), `herdr-vscode/scripts/check-agent-icons.py` (new, if separate)
- `herdr-vscode/package.json` (`contributes.icons`, Show Pane menu `when`)
- `herdr-vscode/src/sessions.ts` (`paneLabel`)
- `herdr-vscode/src/status.ts` (`agentIcon`)
- `herdr-vscode/src/views/spacesView.ts` (`paneDescription`, `paneTreeItem`)
- `herdr-vscode/src/views/agentsView.ts` (uses `paneTreeItem`; check `noIcon`)
- `herdr-vscode/src/focus.ts` (status bar text)
- `herdr-vscode/src/paneContext.ts` (pane row, message, repo row)
- `herdr-vscode/src/tilesPanel.ts` (`tileMetas`)
- `herdr-vscode/src/tilesProtocol.ts` (`TileMeta.agent`)
- `herdr-vscode/src/agentMarks.ts` (new)
- `herdr-vscode/src/webview/tiles.ts`, `herdr-vscode/src/webview/tiles.css`
- `herdr-vscode/src/test/views.test.ts`, `paneContext.test.ts`, `livePaneContext.test.ts`, `spacePanels.test.ts`,
  `extension.test.ts`, `sessions.test.ts`
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md`
- `.plans/PLAN.md`

## Implementation notes
