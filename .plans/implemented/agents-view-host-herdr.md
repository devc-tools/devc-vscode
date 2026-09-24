# Agents View: Host herdr Sessions

Rename the "Dev Container Agents" view to "Agents" and add agents from herdr sessions
running on the host (not in a container), alongside the existing container agents.

## Checklist

- [x] Rename the view and output channel to "Agents"
- [x] `src/hostHerdr.ts`: list host sessions, watch one session, focus an agent in one
- [x] `src/hostProcesses.ts`: a VS Code terminal's tty and foreground process on the host
- [x] Session ownership: attached in this window's terminals, or matched by folder
- [x] Tree: session groups under the window, beside container groups
- [x] Window registry snapshot reshaped to `groups`, published and read
- [x] Focus: host herdr agents in this window and from another window
- [x] Tests (see Validation)

## Scope decisions

These were settled with the user; do not re-open them.

- **VS Code terminals only.** Agents are only discovered through VS Code terminals or
  herdr sessions tied to this window. No external terminals (iTerm, Terminal.app, tmux
  outside herdr), no Claude hooks, no host-wide process scans for agents.
- **Host herdr is session-aware.** A host usually has several named herdr sessions, one
  per project folder. A window shows the sessions it owns (see Ownership).
- **Container herdr stays default-session only.** Do not add session support to
  `watchHerdr` / `focusHerdrAgent` in `src/herdr.ts`.
- **Shared sessions are fine.** If two windows own the same session, both show it. Focus
  switching the tab in every client of that session is expected; it is how herdr's own UI
  behaves. No dedupe across windows.
- **macOS and Linux hosts.** On Windows, host herdr support is simply off (no sessions
  listed, no errors shown).
- Plain host terminals (no herdr) are the follow-up plan,
  [agents-view-host-terminals.md](agents-view-host-terminals.md).

## Existing touchpoints

- `package.json` — view `devc-vscode.agents` (Explorer), currently named "Dev Container
  Agents". Keep the **id**, change the **name** to `Agents`. Setting descriptions that say
  "Dev Container Agents" / "Agents view" should read consistently.
- `src/herdr.ts` — `AgentInfo`, `parseSnapshot`, `WATCH_SCRIPT`, `watchHerdr`,
  `focusHerdrAgent`. `parseSnapshot` is reused unchanged for host snapshots. The watch loop
  shape (print on change, stop when stdin closes) is reusable locally; the docker-specific
  parts are not.
- `src/agentTree.ts` — `AgentNode`, `AgentTreeDataProvider`. Currently window → container →
  agent. Gains a session group kind; `snapshotContainers` becomes a snapshot of all groups.
- `src/windowRegistry.ts` — `WindowSnapshot`, `PublishedContainer`, `SNAPSHOT_VERSION`.
  Changes to the shape below.
- `src/extension.ts` — wiring: output channel `'Dev Container Agents'`, `publishWindow`,
  `focusAgent`, `isContainerTerminal`, `openContainerTerminal`, `waitForForeground`.
- `src/terminalAgents.ts` — `TerminalAgentTracker.foregroundFor` covers **container**
  terminals only (via the container pty probe). Host terminals need `hostProcesses.ts`.

## Contracts

### Host herdr CLI (verified against herdr 0.8.2 on macOS)

- Resolve `herdr` with `$HOME/.local/bin` prepended to `PATH`; VS Code launched from the
  Dock may not have it on `PATH`.
- **Sessions:** `herdr session list --json` →
  `{"sessions":[{"name":string,"default":boolean,"running":boolean,"session_dir":string,"socket_path":string}]}`.
  Only `running: true` sessions are considered.
- **Targeting a session:** every herdr command for a session runs with
  `HERDR_SOCKET_PATH=<socket_path>` and with `HERDR_SESSION`, `HERDR_ENV`,
  `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID` removed from the environment. The
  extension host inherits these when VS Code is launched from inside a herdr pane, and
  they must never leak into a command.
- **Snapshot:** `herdr api snapshot` — same JSON as in containers; parse with
  `parseSnapshot`.
- **Focus:** `herdr tab focus <tabId>` then `herdr agent focus <paneId>`, as
  `focusHerdrAgent` does in containers.
- **Attached clients:** a client attached to a session is a foreground process whose
  command line is `herdr --session <name>` or `herdr session attach <name>`. A bare `herdr`
  (no session argument) is the **default** session. `herdr server` processes are servers,
  never clients.
- **Attach command** for opening a terminal on a session: `herdr --session <name>`, or
  `herdr` for the default session. No new setting.

### `src/hostProcesses.ts`

```ts
/** A host terminal's pty and the program in its foreground, or undefined off macOS/Linux or when unknown. */
export async function hostTerminalForeground(
  terminal: vscode.Terminal
): Promise<{ tty: string; pid: number; args: string } | undefined>;
```

- The tty comes from `terminal.processId` (`ps -o tty= -p <pid>`), and the foreground
  process from the process whose pgid equals the tty's tpgid (`ps -t <tty> -o pid=,pgid=,tpgid=,command=`).
  This is exact; there is no timing-based pty adoption, unlike `adoptTty`.
- Only called for terminals that are **not** container terminals (`isContainerTerminal`).

### `src/hostHerdr.ts`

```ts
export interface HostSession {
  name: string;
  default: boolean;
  socketPath: string;
}

/** Running host sessions; [] when herdr is missing or the host is Windows. */
export async function listHostSessions(): Promise<HostSession[]>;

/** Stream one session's agents, like watchHerdr, until disposed or the session stops. */
export function watchHostSession(
  session: HostSession,
  onAgents: (agents: AgentInfo[]) => void,
  onExit: () => void
): { dispose(): void };

export async function focusHostHerdrAgent(
  session: HostSession,
  agent: Pick<AgentInfo, 'paneId' | 'tabId'>
): Promise<boolean>;

/** Session name from a foreground command line, or undefined if it is not a herdr client. */
export function sessionFromClientArgs(args: string): string | undefined;
```

`sessionFromClientArgs` returns the default session's name (from `listHostSessions`, the
entry with `default: true`) for a bare `herdr`. The caller supplies that; the function
itself may return a sentinel or take the default name as a parameter, either is fine.

### Ownership (which sessions a window shows)

A window owns a running session when either:

1. **Attached:** one of its host terminals has a herdr client for that session in the
   foreground. It shows **all** of the session's agents.
2. **By folder:** some agent pane's `cwd` in that session is one of the window's
   `file://` workspace folders or under one. It shows **only** those agents. (The default
   session commonly spans many projects; it must not pull unrelated agents in.)

Attached wins when both apply. Sessions owned neither way are not shown.

Cost: only owned sessions stream at the 1s cadence. Checking not-yet-owned sessions for a
folder match may poll more slowly (≥5s). Re-check ownership when terminals open, close,
or change foreground, and when workspace folders change.

### Tree

- Top level is unchanged: the current window's groups directly, or window nodes once
  another window has agents.
- Under a window: container groups (unchanged) and **session** groups, sorted by label.
- Session group label: the session name; `default` when it is the default session.
  Icon `terminal-tmux`. `description` is `summarize(...)` as for containers. Tooltip names
  the socket path. `contextValue` `agentSession`.
- Host herdr agents render like container herdr agents: `"<agent> (herdr)"`, the same
  status icons, and a tooltip with the herdr workspace and pane.
- Agent keys (used for `id` and cross-window focus):
  - container herdr: `herdr:<containerId>:<paneId>` (unchanged)
  - container terminal: `terminal:<containerId>:<n>` (unchanged)
  - host herdr: `host-herdr:<sessionName>:<paneId>` (pane ids collide across sessions)
- `attentionCount` includes host herdr agents.

### Window registry snapshot

```ts
export const SNAPSHOT_VERSION = 2;

export type PublishedGroup =
  | { kind: 'container'; container: ContainerInfo; agents: PublishedAgent[] }
  | { kind: 'session'; session: string; agents: PublishedAgent[] };

export interface WindowSnapshot {
  version: number;
  pid: number;
  name: string;
  workspaceUri?: string;
  groups: PublishedGroup[];
}
```

`PublishedAgent` is unchanged. `containers` is removed outright. No backward compatibility:
all windows are updated and reloaded together, so there is no handling for older snapshot
shapes or unknown group kinds beyond the existing version check.

### Focus

- **Local host herdr agent:** find a host terminal in this window whose foreground is a
  client for the agent's session. If one exists, `show()` it. Otherwise open a terminal
  running the attach command, with `cwd` set to the workspace folder that matched (or the
  first workspace folder) and the same editor-location options `openContainerTerminal`
  uses. Wait for the client to be in the foreground (≤20s, as for containers), then
  `focusHostHerdrAgent`. Show an error message on failure, as for containers.
- **Remote host herdr agent:** unchanged flow: `requestFocus` + `vscode.openFolder`.
  `findLocal` must resolve `host-herdr:` keys.

## Concept boundaries

- **"session" (host herdr session)** vs. **herdr "workspace"** (`AgentInfo.workspace`, a
  herdr workspace label inside a session) vs. **VS Code workspace** (`vscode.workspace`,
  `WindowSnapshot.workspaceUri`). All three appear near each other; keep names distinct
  (`HostSession`, `session`, not `workspace`).
- **Host terminal** vs. **container terminal**. `isContainerTerminal` (name
  `devcontainer`) identifies container terminals. Everything in this plan concerns the
  other terminals. Do not route host terminals through `TerminalAgentTracker`,
  `probeContainer`, or `adoptTty`.
- **`foregroundFor`** (container ptys, from `TerminalAgentTracker`) vs.
  **`hostTerminalForeground`** (host ptys). `focusAgent`'s existing container path keeps
  using `foregroundFor`.
- **`herdr` in `PublishedAgent`** means "managed by herdr", true for container and host
  herdr agents alike. Whether it is a host or container agent comes from the group kind.

## Validation

- Unit tests, no herdr or Docker needed:
  - `sessionFromClientArgs`: `herdr --session x` → `x`; `herdr session attach x` → `x`;
    bare `herdr` → default; `herdr server`, `herdr api snapshot`, and non-herdr → undefined.
  - Parsing `herdr session list --json` (fixture from the shape above), with stopped
    sessions filtered out.
  - Ownership: attached takes the whole session; by-folder keeps only agents under a
    workspace folder; an unowned session is left out.
  - Tree: session groups appear beside container groups; keys follow the contract; two
    sessions with the same pane id give distinct ids.
  - Registry: a snapshot with container and session groups round-trips.
- `npm test` and `npm run lint` pass.
- Manual (macOS, host herdr running): a window with an attached `herdr --session <name>`
  terminal lists that session's agents; clicking one switches herdr's tab; with the
  terminal closed, clicking opens a new one attached to the session and focuses the agent;
  a second window sees the agents under the first window's group and can focus them.
