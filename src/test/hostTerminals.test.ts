import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  AgentNode,
  AgentTreeDataProvider,
  HostSessionSource,
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

async function waitFor(
  check: () => boolean,
  timeoutMs = 3000
): Promise<void> {
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

  test('a Terminals group after container and session groups', async () => {
    const t = tree();
    await t.sync();
    await t.syncSessions();
    const inContainer = fakeTerminal('devcontainer');
    const onHost = fakeTerminal('zsh');
    t.setTerminalAgent('c1', inContainer, agent('terminal:pts/3'));
    t.setLocalTerminalAgent(onHost, agent('terminal:ttys004', 'blocked'));

    const roots = t.getChildren();
    assert.deepStrictEqual(
      roots.map(n => n.kind),
      ['session', 'container', 'local']
    );
    const group = t.getTreeItem(roots[2]);
    assert.strictEqual(group.label, 'Terminals');
    assert.strictEqual(group.contextValue, 'agentTerminals');
    assert.strictEqual((group.iconPath as vscode.ThemeIcon).id, 'terminal');
    assert.strictEqual(group.description, '1 blocked');

    // Container and host terminal keys share one counter but never collide.
    // A container's herdr agents sit under its herdr node, before its
    // terminals' agents.
    const all = roots.flatMap(g =>
      ids(
        t,
        t.getChildren(g).flatMap(n =>
          n.kind === 'containerHerdr' ? t.getChildren(n) : [n]
        )
      )
    );
    assert.deepStrictEqual(all, [
      'host-herdr:app:w1:p1',
      'herdr:c1:w1:p1',
      'terminal:c1:1',
      'local-terminal:2',
    ]);

    const [local] = t.getChildren(roots[2]);
    const item = t.getTreeItem(local);
    assert.strictEqual(item.label, 'claude');
    assert.strictEqual(item.contextValue, 'agent');
    assert.ok(String(item.tooltip).includes('"zsh"'));
    assert.strictEqual(t.getTreeItem(roots[1]).contextValue, 'agentContainer');

    // Published as a `local` group and found again by key.
    const published = t.snapshotGroups().find(g => g.kind === 'local');
    assert.deepStrictEqual(published, {
      kind: 'local',
      agents: [
        {
          key: 'local-terminal:2',
          agent: agent('terminal:ttys004', 'blocked'),
          herdr: false,
        },
      ],
    });
    const found = t.findLocal('local-terminal:2');
    assert.strictEqual(found?.kind === 'agent' && found.terminal, onHost);

    t.setLocalTerminalAgent(onHost, undefined);
    assert.deepStrictEqual(
      t.getChildren().map(n => n.kind),
      ['session', 'container']
    );
    t.dispose();
  });

  test("another window's Terminals group", () => {
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
          kind: 'local',
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
    const [others] = t.getChildren();
    const [window] = t.getChildren(others);
    const [group] = t.getChildren(window);
    assert.strictEqual(group.kind, 'local');
    assert.strictEqual(t.getTreeItem(group).id, 'w9:local');
    const [remoteAgent] = t.getChildren(group);
    const item = t.getTreeItem(remoteAgent);
    assert.strictEqual(item.id, 'w9:local-terminal:4');
    assert.strictEqual(item.label, 'claude');
    // Another window's agents cannot be closed from here.
    assert.strictEqual(item.contextValue, 'agentRemote');
    assert.strictEqual(t.attentionCount(), 1);
    t.dispose();
  });
});
