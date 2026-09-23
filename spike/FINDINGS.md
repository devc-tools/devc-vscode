# Agent status without herdr — spike findings

Goal: detect agent state for agents run directly in a `devcontainer` terminal (no
herdr), with nothing configured in the container and nothing agent-specific in the
extension.

## What stable VS Code API can see

Measured in the real test host (`SPIKE=1 SPIKE_CONTAINER=<id> npx vscode-test --grep spike`):

| Signal | Works? | Notes |
| --- | --- | --- |
| `TerminalShellExecution.read()` | **Yes** | Raw bytes incl. OSC titles and alt-screen, live (chunks arrive as written), through `docker exec -it`. Works for commands sent with `sendText`/typed by the user, via `onDidStartTerminalShellExecution`. Requires shell integration active in the *host* shell. |
| `Terminal.name` | No | Never reflects OSC titles, named or unnamed terminal. |
| `Terminal.dimensions`, `onDidChangeTerminalDimensions`, `onDidWriteTerminalData` | Proposed only | Not usable in a published extension. |

## Prototype pipeline (`src/terminalAgents.ts`, `src/terminalScreen.ts`)

1. `read()` the command the `devcontainer` terminal runs (`devc ...`); everything inside
   that container session, including an agent the user starts, flows through it.
2. `@xterm/headless` (MIT, pure JS, zero deps — xterm.js core, as VS Code uses) rebuilds
   the screen.
3. Which pty: one `docker exec` lists herdr's cached manifest ids
   (`~/.local/state/herdr/agent-detection/remote/*.toml`, 20 agents), every process with
   its tty, process group, foreground group and age (`ps etimes`), and each pty's
   `stty size`. The terminal adopts the pty whose oldest process is no older than its
   command and that no other terminal has claimed. Ages are relative, so host and
   container clocks never need to agree.
4. Which agent: that pty's foreground process whose program name matches a manifest id.
   herdr's own panes have their own ptys, so they never collide with a VS Code terminal.
   Size is that pty's (docker forwards resizes), since VS Code won't give dimensions.
5. What state: `herdr agent explain --file - --agent <id> --format json` in the
   container classifies the screen with herdr's own rules. With the agent known from the
   pty itself, herdr's fallback (no rule matched → idle) is used as-is, as herdr does.

Each step logs to the **Dev Container Agents** output channel; when herdr falls back,
the rebuilt screen is logged too, which is what to look at if a state looks wrong.

End-to-end result (fake `claude` using real Claude UI strings, drawing full-width rules
like Claude's prompt box, with a decoy `claude` already running on another pty at another
size): adopted its own pty, `working → blocked → idle → none after exit`, each via a
matched rule, ~0.3–0.7s behind the frame.

First real-Claude try failed: the idle screen after a reply showed "no agents". The
first version picked the agent (and so the screen size) per container; `devc-dev` had
five `claude` processes, the first at 114 cols vs. the user's 110, so Claude's
full-width prompt box wrapped in the rebuilt screen and no idle rule matched. Per-pty
adoption fixes identity and size together.

Second real-Claude issue: with two terminals, one stopped updating. The pty size is only
learned on the next probe (up to 3s), so Claude's redraw after a resize was rendered at
the old width and the screen stayed garbled. `TerminalScreen` now keeps output since the
last full clear and replays it on resize. Verified against real Claude Code 2.1.280
output captured from a pty (`devc-dev`): it runs on the alt screen and emits `ESC[2J` on
every resize. Replaying that capture with sizes learned late: the stale screen right after
a 90→100 resize matched no rule (the symptom), and the replayed one matched
`live_prompt_box`.

## Trade-offs vs. Claude hooks

| | Terminal + herdr explain | Claude hooks |
| --- | --- | --- |
| Container config | None beyond herdr being installed (manifests are cached once herdr has run) | Hook settings per container/image |
| Other agents | Any of herdr's 20 manifests, updated by herdr | Per-agent hook systems, where they exist |
| Accuracy | Screen heuristics — herdr's, maintained upstream | Exact lifecycle events |
| Cost | Per settled output: 1 `docker exec` (+ probe every 5s while active) | Near zero |

## Known gaps

- Needs shell integration in the host terminal; without it no execution events fire,
  so nothing is detected (fails quiet, not wrong).
- pty adoption is by timing: two terminals opened into one container within the same
  second could swap ptys. Container-side tools needed: `ps` (procps) and `stty`.
- Depends on herdr in the container as the rule engine. Porting the manifest evaluator to
  TS would remove that, but means a TOML parser and translating Rust regex syntax
  (`\x{...}`, inline `(?i)`, `(?m)`) — and herdr's license would need checking before
  shipping its manifests.
- The OSC title rules (e.g. Claude's spinner title) can't be fed to `explain --file`;
  the title is captured (`TerminalScreen.title`) but unused.
