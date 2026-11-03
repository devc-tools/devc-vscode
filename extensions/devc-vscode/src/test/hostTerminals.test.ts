import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  AgentNode,
  AgentTreeDataProvider,
  HostSessionSource,
  OTHER_WORKSPACES,
  WORKSPACE,
  WatchAgents,
} from '../agentTree';
import { ContainerInfo, ContainerSource } from '../containerTree';
import { AgentInfo } from '../herdr';
import {
  HostForeground,
  HostForegroundCache,
  parseSttySize,
} from '../hostProcesses';
import {
  Classification,
  ExecutionOutput,
  HostTarget,
  HostTerminalDeps,
  TrackedExecution,
  agentName,
  presentHostAgent,
} from '../terminalAgents';
import { SNAPSHOT_VERSION, WindowSnapshot } from '../windowRegistry';

const KNOWN = new Set(['claude', 'codex', 'pi']);

function fakeTerminal(name: string): vscode.Terminal {
  return { name } as vscode.Terminal;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

/** A host with one terminal whose foreground the test sets. */
function fakeHost(args: string) {
  const reports: (AgentInfo | undefined)[] = [];
  const screens: string[] = [];
  const host: HostTerminalDeps = {
    foreground: async (): Promise<HostForeground> => ({
      tty: 'ttys004',
      pid: 100,
      args,
    }),
    agentIds: async () => KNOWN,
    size: async () => ({ rows: 5, cols: 30 }),
    classify: async (agent, screen): Promise<Classification> => {
      screens.push(screen);
      return {
        agent,
        status: screen.includes('Do you want to proceed?')
          ? 'blocked'
          : 'working',
        rule: 'test_rule',
        keepPrevious: false,
      };
    },
    report: (_terminal, agent) => reports.push(agent),
  };
  return { host, reports, screens };
}

/** A shell execution whose output the test writes, ended by `end()`. */
function fakeExecution(command: string) {
  const chunks: string[] = [];
  let wake: () => void = () => {};
  let ended = false;
  const execution: ExecutionOutput = {
    commandLine: {
      value: command,
      isTrusted: true,
      confidence: vscode.TerminalShellExecutionCommandLineConfidence.High,
    },
    async *read() {
      while (!ended) {
        const chunk = chunks.shift();
        if (chunk !== undefined) {
          yield chunk;
        } else {
          await new Promise<void>(r => (wake = r));
        }
      }
    },
  };
  return {
    execution,
    write(chunk: string) {
      chunks.push(chunk);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
  };
}

suite('host terminal detection', () => {
  test('agentName matches manifest ids only', () => {
    assert.strictEqual(agentName('claude', KNOWN), 'claude');
    assert.strictEqual(
      agentName('/usr/local/bin/codex --yolo', KNOWN),
      'codex'
    );
    assert.strictEqual(agentName('node /opt/bin/pi.js', KNOWN), 'pi');
    for (const args of [
      'herdr',
      'herdr --session app',
      'docker exec -it abc bash',
      'devc herdr',
      '-zsh',
      '/bin/bash',
    ]) {
      assert.strictEqual(agentName(args, KNOWN), undefined, args);
    }
  });

  test('parseSttySize', () => {
    assert.deepStrictEqual(parseSttySize('43 181\n'), {
      rows: 43,
      cols: 181,
    });
    assert.strictEqual(parseSttySize('0 0\n'), undefined);
    assert.strictEqual(parseSttySize('stty: not a tty'), undefined);
  });

  test('an agent in the foreground is classified', async () => {
    const { host, reports, screens } = fakeHost('claude');
    const terminal = fakeTerminal('zsh');
    const run = fakeExecution('claude');
    const tracked = new TrackedExecution(
      terminal,
      run.execution,
      new HostTarget(terminal, host),
      () => {}
    );
    run.write('\x1b[2J\x1b[HDo you want to proceed?\r\n');
    await waitFor(() => reports.at(-1)?.status === 'blocked');
    assert.deepStrictEqual(reports.at(-1), {
      paneId: 'terminal:ttys004',
      agent: 'claude',
      status: 'blocked',
      title: undefined,
    });
    // Classified at the tty's size.
    assert.ok(screens.at(-1)?.startsWith('Do you want to proceed?'));

    run.end();
    await waitFor(() => reports.at(-1) === undefined);
    tracked.dispose();
  });

  for (const args of [
    'herdr --session app',
    'docker exec -it c1 zsh',
    '-zsh',
  ]) {
    test(`nothing is reported for ${args.split(' ')[0]}`, async () => {
      const { host, reports, screens } = fakeHost(args);
      const terminal = fakeTerminal('zsh');
      const run = fakeExecution(args);
      const tracked = new TrackedExecution(
        terminal,
        run.execution,
        new HostTarget(terminal, host),
        () => {}
      );
      run.write('some output\r\n');
      await waitFor(() => reports.length > 0);
      assert.deepStrictEqual(reports, [undefined]);
      assert.deepStrictEqual(screens, []);
      tracked.dispose();
    });
  }

  test('presence-only: no output stream means unknown', async () => {
    const terminal = fakeTerminal('zsh');
    assert.deepStrictEqual(
      await presentHostAgent(terminal, fakeHost('claude').host),
      { paneId: 'terminal:ttys004', agent: 'claude', status: 'unknown' }
    );
    assert.strictEqual(
      await presentHostAgent(terminal, fakeHost('-zsh').host),
      undefined
    );
    assert.strictEqual(
      await presentHostAgent(terminal, fakeHost('herdr').host),
      undefined
    );
  });

  test('foreground readings are shared for a moment', async () => {
    let reads = 0;
    const cache = new HostForegroundCache(async () => {
      reads++;
      return { tty: 'ttys004', pid: 1, args: 'claude' };
    }, 50);
    const terminal = fakeTerminal('zsh');
    await Promise.all([cache.get(terminal), cache.get(terminal)]);
    assert.strictEqual(reads, 1);
    await new Promise(r => setTimeout(r, 60));
    await cache.get(terminal);
    assert.strictEqual(reads, 2);
  });
});

suite('AgentTreeDataProvider with host terminals', () => {
  const container: ContainerInfo = {
    id: 'c1',
    name: 'zeta',
    containerName: 'devc-zeta',
    localFolder: '/work/zeta',
  };
  const agent = (paneId: string, status: AgentInfo['status'] = 'idle') => ({
    paneId,
    agent: 'claude',
    status,
  });

  function tree() {
    const source: ContainerSource = { listRunning: async () => [container] };
    const watch: WatchAgents = (_id, onAgents) => {
      onAgents([agent('w1:p1')]);
      return { dispose() {} };
    };
    const hosts: HostSessionSource = {
      list: async () => [{ name: 'app', default: false, socketPath: '/s' }],
      foregrounds: async () => ['herdr --session app'],
      folders: () => [],
      workspaceSession: () => undefined,
      read: async () => [agent('w1:p1')],
      watch(_s, onAgents) {
        onAgents([agent('w1:p1')]);
        return { dispose() {} };
      },
    };
    return new AgentTreeDataProvider(source, watch, hosts);
  }

  function ids(t: AgentTreeDataProvider, nodes: AgentNode[]) {
    return nodes.map(n => t.getTreeItem(n).id);
  }

  test('host terminals join the host, after its sessions', async () => {
    const t = tree();
    await t.sync();
    await t.syncSessions();
    const inContainer = fakeTerminal('devcontainer');
    const onHost = fakeTerminal('zsh');
    t.setTerminalAgent('c1', inContainer, agent('terminal:pts/3'));
    t.setLocalTerminalAgent(onHost, agent('terminal:ttys004', 'blocked'));

    const envs = t.getChildren(WORKSPACE);
    assert.deepStrictEqual(
      envs.map(n => n.kind),
      ['host', 'container']
    );
    assert.strictEqual(t.getTreeItem(envs[0]).description, '1 blocked, 1 idle');

    // Container and host terminal keys share one counter, numbered as the
    // tree first shows them, but never collide. A container's herdr agents
    // come before its terminals' agents.
    const all = envs.flatMap(env => ids(t, t.getChildren(env)));
    assert.deepStrictEqual(all, [
      'host-herdr:app:w1:p1',
      'local-terminal:1',
      'herdr:c1:w1:p1',
      'terminal:c1:2',
    ]);

    const local = t.getChildren(envs[0])[1];
    const item = t.getTreeItem(local);
    assert.strictEqual(item.label, 'claude');
    assert.strictEqual(item.contextValue, 'agent');
    assert.ok(String(item.tooltip).includes('"zsh"'));

    // Published with the host and found again by key.
    const published = t.snapshotGroups().find(g => g.kind === 'host');
    assert.deepStrictEqual(published?.agents[1], {
      key: 'local-terminal:1',
      agent: agent('terminal:ttys004', 'blocked'),
      herdr: false,
    });
    const found = t.findLocal('local-terminal:1');
    assert.strictEqual(found?.kind === 'agent' && found.terminal, onHost);

    t.setLocalTerminalAgent(onHost, undefined);
    assert.deepStrictEqual(ids(t, t.getChildren(envs[0])), [
      'host-herdr:app:w1:p1',
    ]);
    t.dispose();
  });

  test("another window's host terminal agent", () => {
    const t = new AgentTreeDataProvider(
      { listRunning: async () => [] },
      () => ({ dispose() {} })
    );
    const remote: WindowSnapshot = {
      version: SNAPSHOT_VERSION,
      pid: 9,
      name: 'beta',
      workspaceUri: 'file:///work/beta',
      groups: [
        {
          kind: 'host',
          name: 'beta',
          agents: [
            {
              key: 'local-terminal:4',
              agent: agent('terminal:ttys001', 'blocked'),
              herdr: false,
            },
          ],
        },
      ],
    };
    t.setOtherWindows([remote]);
    const [env] = t.getChildren(OTHER_WORKSPACES);
    assert.strictEqual(env.kind, 'host');
    const [remoteAgent] = t.getChildren(env);
    const item = t.getTreeItem(remoteAgent);
    assert.strictEqual(item.id, 'w9:local-terminal:4');
    assert.strictEqual(item.label, 'claude');
    // Another window's agents cannot be closed from here.
    assert.strictEqual(item.contextValue, 'agentRemote');
    assert.strictEqual(t.attentionCount(), 1);
    t.dispose();
  });
});
