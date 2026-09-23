import * as cp from 'child_process';
import { execDocker } from './docker';

/**
 * Agent state as herdr reports it. herdr runs its own detection rules against
 * each pane (OSC titles, spinners, prompt boxes, permission dialogs), so this
 * is the same state herdr's sidebar shows — nothing is re-detected here.
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  /** herdr's pane id, e.g. "w1:p2" — the target for `herdr agent focus`. */
  paneId: string;
  /** herdr's id for the pane's tab, e.g. "w1:t2" — for `herdr tab focus`. */
  tabId?: string;
  /** The detected agent, e.g. "claude". */
  agent: string;
  status: AgentStatus;
  /** Label of the herdr workspace the pane lives in. */
  workspace?: string;
  /** The terminal title the agent set, with styling stripped. */
  title?: string;
  cwd?: string;
}

const STATUSES: ReadonlySet<string> = new Set<AgentStatus>([
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
]);

/**
 * Runs inside the container. Polls herdr's socket API through its own CLI and
 * prints the snapshot only when it changes, so the host sees one line per
 * change rather than one per tick. It needs nothing beyond sh and herdr — no
 * socat or other bridge to the socket.
 *
 * `docker exec` never signals the process it started when the client goes
 * away, so the loop runs in the background while the foreground waits for
 * stdin to close. The host holds stdin open for as long as it wants updates;
 * killing the client (or VS Code exiting) closes it and ends the loop.
 */
export const WATCH_SCRIPT = `
PATH="$HOME/.local/bin:$PATH"
command -v herdr >/dev/null 2>&1 || exit 127
(
  prev=
  while :; do
    cur=$(herdr api snapshot 2>&1 | tr -d '\\n')
    if [ "$cur" != "$prev" ]; then
      printf '%s\\n' "$cur"
      prev=$cur
    fi
    sleep 1
  done
) &
loop=$!
cat >/dev/null
kill $loop
`;

/**
 * The agents in one `herdr api snapshot` response. A herdr error — typically
 * `server_not_running` before herdr is started — means no agents. Undefined
 * only for output that is not a herdr response at all.
 */
export function parseSnapshot(line: string): AgentInfo[] | undefined {
  let response: unknown;
  try {
    response = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(response)) {
    return undefined;
  }
  if (isObject(response.error)) {
    return [];
  }
  const snapshot = isObject(response.result)
    ? response.result.snapshot
    : undefined;
  if (!isObject(snapshot)) {
    return undefined;
  }

  const workspaces = new Map<string, string>();
  for (const ws of arrayOf(snapshot.workspaces)) {
    if (typeof ws.workspace_id === 'string' && typeof ws.label === 'string') {
      workspaces.set(ws.workspace_id, ws.label);
    }
  }

  // Panes rather than the top-level `agents` list, which older herdr
  // versions omit. A pane carries `agent` only once herdr has detected one.
  const agents: AgentInfo[] = [];
  for (const pane of arrayOf(snapshot.panes)) {
    if (typeof pane.pane_id !== 'string' || typeof pane.agent !== 'string') {
      continue;
    }
    const status =
      typeof pane.agent_status === 'string' && STATUSES.has(pane.agent_status)
        ? (pane.agent_status as AgentStatus)
        : 'unknown';
    agents.push({
      paneId: pane.pane_id,
      tabId: stringOr(pane.tab_id),
      agent: pane.agent,
      status,
      workspace:
        typeof pane.workspace_id === 'string'
          ? workspaces.get(pane.workspace_id)
          : undefined,
      title: stringOr(pane.terminal_title_stripped),
      cwd: stringOr(pane.foreground_cwd) ?? stringOr(pane.cwd),
    });
  }
  return agents;
}

/**
 * The user the devcontainer CLI execs as, from the devcontainer.metadata label.
 * herdr's socket lives under that user's home, so the watcher must run as them
 * rather than as whatever user the image defaults to. Later entries override
 * earlier ones, as they do for the CLI.
 */
export function remoteUserFromMetadata(label: string): string | undefined {
  let entries: unknown;
  try {
    entries = JSON.parse(label);
  } catch {
    return undefined;
  }
  let user: string | undefined;
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (!isObject(entry)) {
      continue;
    }
    user = stringOr(entry.remoteUser) ?? stringOr(entry.containerUser) ?? user;
  }
  return user;
}

export async function getRemoteUser(
  containerId: string,
  dockerCommand: string
): Promise<string | undefined> {
  let res;
  try {
    res = await execDocker(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "devcontainer.metadata"}}',
        containerId,
      ],
      undefined,
      dockerCommand
    );
  } catch {
    return undefined;
  }
  if (res.exitCode !== 0) {
    return undefined;
  }
  return remoteUserFromMetadata(res.stdout.toString('utf8').trim());
}

function userArgs(user: string | undefined): string[] {
  return user ? ['-u', user] : [];
}

/**
 * Stream a container's agents to `onAgents` until disposed or the container
 * goes away. `onAgents` fires once per change in herdr's snapshot; `onExit`
 * fires when the stream ends on its own (container stopped, herdr not
 * installed).
 */
export function watchHerdr(
  containerId: string,
  user: string | undefined,
  dockerCommand: string,
  onAgents: (agents: AgentInfo[]) => void,
  onExit: () => void
): { dispose(): void } {
  const child = cp.spawn(
    dockerCommand,
    ['exec', '-i', ...userArgs(user), containerId, 'sh', '-c', WATCH_SCRIPT],
    // stdin stays open: closing it is what stops the loop in the container.
    { stdio: ['pipe', 'pipe', 'ignore'] }
  );
  let disposed = false;
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const agents = line ? parseSnapshot(line) : undefined;
      if (agents && !disposed) {
        onAgents(agents);
      }
    }
  });
  child.stdin?.on('error', () => {
    /* the exec already ended */
  });
  child.on('error', err => {
    console.error('devc-vscode: herdr watcher error', err.message);
  });
  child.on('close', () => {
    if (!disposed) {
      disposed = true;
      onExit();
    }
  });
  return {
    dispose() {
      disposed = true;
      child.stdin?.end();
      child.kill();
    },
  };
}

/**
 * Switch herdr's focus to an agent's pane. As of herdr 0.9, `agent focus`
 * moves the server's focus to the pane's tab but attached clients keep
 * showing whatever they were showing; `tab focus` is what switches their
 * view. So the tab is focused first, then the agent's pane within it.
 */
export async function focusHerdrAgent(
  containerId: string,
  user: string | undefined,
  agent: Pick<AgentInfo, 'paneId' | 'tabId'>,
  dockerCommand: string
): Promise<boolean> {
  const res = await execDocker(
    [
      'exec',
      ...userArgs(user),
      containerId,
      'sh',
      '-c',
      `PATH="$HOME/.local/bin:$PATH"
      if [ -n "$2" ]; then herdr tab focus "$2" >/dev/null || exit; fi
      exec herdr agent focus "$1"`,
      'sh',
      agent.paneId,
      agent.tabId ?? '',
    ],
    undefined,
    dockerCommand
  );
  return res.exitCode === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
