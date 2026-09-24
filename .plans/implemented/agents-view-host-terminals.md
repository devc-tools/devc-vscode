# Agents View: Plain Host Terminals

Detect agents run directly in a host VS Code terminal (no herdr, no container) and show
them in the Agents view, with status from herdr's detection rules on the host.

Depends on [agents-view-host-herdr.md](agents-view-host-herdr.md): the "Scope decisions",
`hostProcesses.ts`, and the `groups` registry snapshot come from there.

## Checklist

- [x] Track host terminals' command output (all non-container terminals)
- [x] Identify the agent from the terminal's foreground process on the host
- [x] Classify the screen with the host's `herdr agent explain`
- [x] Tree: a "Terminals" group under the window
- [x] Registry: `local` group kind
- [x] Focus: show the terminal, locally and from another window
- [x] Presence-only fallback for commands already running when the extension loaded
- [x] Tests (see Validation)

## Scope decisions (in addition to the host herdr plan's)

- Every VS Code terminal that is **not** a container terminal is a candidate. The
  extension does not need to have created it.
- A terminal whose foreground is a herdr client is **not** reported as an agent; its agents
  come from the session (host herdr plan). Same for `docker`/`devc` foregrounds: whatever
  runs inside a container is out of scope here.
- Status needs herdr installed on the host. Without it, nothing is reported for host
  terminals (fail quiet, no error message). Porting herdr's rules to TypeScript is out of
  scope.
- macOS and Linux hosts only, as in the host herdr plan.

## Existing touchpoints

- `src/terminalAgents.ts` — `TrackedExecution` / `TerminalAgentTracker` already stream
  `TerminalShellExecution.read()` into `TerminalScreen`, settle, and classify. The
  pipeline is container-specific in its deps (`resolveContainer`, `probe`, `classify`) and
  in pty adoption (`adoptTty`). The host path reuses the stream/settle/classify pipeline,
  not the container probe or adoption.
- `src/terminalScreen.ts` — headless screen, reused unchanged.
- `src/hostProcesses.ts` (from the host herdr plan) — tty and foreground of a host
  terminal. Extend it as needed for the foreground's agent name and the tty's size.
- `src/agentTree.ts` — `setTerminalAgent(containerId, terminal, agent)` is keyed by
  container. Host terminal agents need their own entry point, not a fake container id.
- `src/extension.ts` — `TerminalAgentTracker` wiring; `isContainerTerminal` gates which
  terminals the tracker reads.

## Contracts

### Detection

- **Which terminals:** `onDidStartTerminalShellExecution` for terminals where
  `isContainerTerminal` is false. Container terminals keep their existing path unchanged.
- **Which agent:** the terminal's foreground process (`hostTerminalForeground`), whose
  program name, looking through script interpreters as `programName` does, matches a
  manifest id in `$HOME/.local/state/herdr/agent-detection/remote/*.toml` on the host.
- **Screen size:** the tty's size on the host: `stty -f /dev/<tty> size` on macOS,
  `stty -F /dev/<tty> size` on Linux. The screen is resized and replayed as it is for
  containers.
- **Status:** `herdr agent explain --file <tmpfile> --agent <id> --format json` run
  locally, with the same environment hygiene as the host herdr plan (inherited `HERDR_*`
  removed). Parse with `parseExplain`. `keepPrevious` is honoured as it is for containers.
- **Presence-only fallback:** a terminal with no execution stream (its command started
  before the extension activated, or no shell integration) but with an agent in its
  foreground is reported with status `unknown`. Re-check it on the same cadence as quiet
  terminals (`RECHECK_MS`).

### Tree

- Host terminal agents go in a group labelled `Terminals` under the window, icon
  `terminal`, `contextValue` `agentTerminals`, `description` `summarize(...)`. It sits
  after the container and session groups.
- Agent label: `<agent>` (no suffix); tooltip includes the terminal's name.
- Key: `local-terminal:<n>`, where `n` is the per-window terminal id `terminalId()`
  already assigns.

### Window registry

Add the group kind below and bump `SNAPSHOT_VERSION` (no backward compatibility needed).

```ts
| { kind: 'local'; agents: PublishedAgent[] }
```

`PublishedAgent.herdr` is `false` for these agents.

### Focus

- Local: `terminal.show()`.
- Remote: the existing `requestFocus` + `vscode.openFolder` flow; `findLocal` resolves
  `local-terminal:` keys.

## Concept boundaries

- **`local` group** (plain host terminals) vs. **`session` group** (host herdr) vs.
  **`container` group**. A host terminal attached to herdr belongs to a session group,
  never to `local`.
- **`terminal:<containerId>:<n>`** keys (container terminals) vs.
  **`local-terminal:<n>`** keys (host terminals). Both use the same `terminalId()` counter.
- **Container pty probe** (`probeContainer`, `parseProbe`, `adoptTty`, `etimes`-based
  ages) is not used for host terminals. macOS `ps` has no `etimes`; host code must not
  depend on it.

## Validation

- Unit tests, no herdr needed:
  - A host terminal with an agent in the foreground is reported in the `Terminals` group
    with the classifier's status; one with a herdr client, `docker`, or a plain shell in
    the foreground is not.
  - Presence-only: no execution stream plus an agent in the foreground → `unknown`.
  - Registry: a `local` group round-trips.
  - Keys `local-terminal:<n>` are distinct from container terminal keys.
- `npm test` and `npm run lint` pass.
- Manual (macOS, herdr installed on host): run `claude` in a plain VS Code terminal; it
  shows under `Terminals` and moves between working, blocked, and idle; a second window
  shows it and clicking there brings the first window forward with the terminal shown;
  reloading the window keeps it listed as `unknown` while it runs.
