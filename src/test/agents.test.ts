import * as vscode from 'vscode';
import * as assert from 'assert';
import {
  AgentTreeDataProvider,
  OTHER_WORKSPACES,
  SSH_HOSTS,
  SshAgentSource,
  WORKSPACE,
  WatchAgents,
  summarize,
  taskLabel,
} from '../agentTree';
import { SshHostInfo } from '../sshFs';
import { ContainerInfo, ContainerSource } from '../containerTree';
import { SNAPSHOT_VERSION } from '../windowRegistry';
import {
  AgentInfo,
  HerdrRunner,
  parseCreatedPane,
  parseSnapshot,
  remoteUserFromMetadata,
  startAgent,
} from '../herdr';

/** Trimmed from real `herdr api snapshot` output (herdr 0.9.1). */
const SNAPSHOT = JSON.stringify({
  id: 'cli:api:snapshot',
  result: {
    type: 'session_snapshot',
    snapshot: {
      panes: [
        {
          agent: 'claude',
          agent_status: 'working',
          cwd: '/workspaces/app',
          foreground_cwd: '/workspaces/app/sub',
          pane_id: 'w1:p1',
          tab_id: 'w1:t1',
          terminal_title_stripped: 'Fixing tests',
          workspace_id: 'w1',
        },
        // A plain shell: herdr has detected no agent in it.
        {
          agent_status: 'unknown',
          cwd: '/workspaces/app',
          pane_id: 'w1:p2',
          workspace_id: 'w1',
        },
        {
          agent: 'codex',
          agent_status: 'something-new',
          pane_id: 'w2:p1',
          workspace_id: 'w2',
        },
      ],
      workspaces: [
        { workspace_id: 'w1', label: 'app' },
        { workspace_id: 'w2', label: 'docs' },
      ],
    },
  },
});

suite('parseSnapshot', () => {
  test('lists panes with a detected agent', () => {
    assert.deepStrictEqual(parseSnapshot(SNAPSHOT), [
      {
        paneId: 'w1:p1',
        tabId: 'w1:t1',
        agent: 'claude',
        status: 'working',
        workspace: 'app',
        title: 'Fixing tests',
        cwd: '/workspaces/app/sub',
      },
      {
        paneId: 'w2:p1',
        tabId: undefined,
        agent: 'codex',
        status: 'unknown',
        workspace: 'docs',
        title: undefined,
        cwd: undefined,
      },
    ]);
  });

  test('a herdr error means no agents', () => {
    const line = JSON.stringify({
      id: 'cli:api:snapshot',
      error: { code: 'server_not_running', message: 'no herdr server' },
    });
    assert.deepStrictEqual(parseSnapshot(line), []);
  });

  test('rejects output that is not a herdr response', () => {
    assert.strictEqual(parseSnapshot('sh: herdr: not found'), undefined);
    assert.strictEqual(parseSnapshot('[]'), undefined);
    assert.strictEqual(parseSnapshot('{"result":{}}'), undefined);
  });
});

suite('remoteUserFromMetadata', () => {
  test('later entries override earlier ones', () => {
    const label = JSON.stringify([
      { remoteUser: 'root' },
      { id: 'feature' },
      { remoteUser: 'vscode' },
    ]);
    assert.strictEqual(remoteUserFromMetadata(label), 'vscode');
  });

  test('falls back to containerUser', () => {
    assert.strictEqual(
      remoteUserFromMetadata(JSON.stringify([{ containerUser: 'node' }])),
      'node'
    );
  });

  test('undefined when absent or unreadable', () => {
    assert.strictEqual(remoteUserFromMetadata('[{}]'), undefined);
    assert.strictEqual(remoteUserFromMetadata(''), undefined);
    assert.strictEqual(remoteUserFromMetadata('<no value>'), undefined);
  });
});

suite('summarize', () => {
  test('counts statuses, attention first, zeros omitted', () => {
    const agents = ['idle', 'working', 'blocked', 'working'].map(
      (status, i) => ({ paneId: `p${i}`, agent: 'claude', status }) as AgentInfo
    );
    assert.strictEqual(summarize(agents), '1 blocked, 2 working, 1 idle');
    assert.strictEqual(summarize([]), '');
  });
});

suite('AgentTreeDataProvider', () => {
  class FakeSource implements ContainerSource {
    containers: ContainerInfo[] = [];
    async listRunning(): Promise<ContainerInfo[]> {
      return this.containers;
    }
  }

  function container(id: string): ContainerInfo {
    return {
      id,
      name: id,
      containerName: `devc-${id}`,
      localFolder: `/work/${id}`,
    };
  }

  function agent(paneId: string, status: AgentInfo['status']): AgentInfo {
    return { paneId, agent: 'claude', status };
  }

  /** Records each watcher so tests can push agents and end streams. */
  function fakeWatch() {
    const watchers = new Map<
      string,
      {
        push: (agents: AgentInfo[], running?: boolean) => void;
        exit: () => void;
        disposed: boolean;
      }
    >();
    const watch: WatchAgents = (id, onAgents, onExit) => {
      const w = { push: onAgents, exit: onExit, disposed: false };
      watchers.set(id, w);
      return {
        dispose() {
          w.disposed = true;
        },
      };
    };
    return { watch, watchers };
  }

  test('always shows Workspace, and Other Workspaces only with agents', async () => {
    const tree = new AgentTreeDataProvider(new FakeSource(), fakeWatch().watch);
    await tree.sync();
    assert.deepStrictEqual(tree.getChildren(), [WORKSPACE]);
    assert.deepStrictEqual(tree.getChildren(WORKSPACE), []);
    const own = tree.getTreeItem(WORKSPACE);
    assert.strictEqual(own.label, 'Workspace');
    assert.strictEqual(own.contextValue, 'agentWorkspace');
    assert.strictEqual(
      own.collapsibleState,
      vscode.TreeItemCollapsibleState.Expanded
    );
    tree.setOtherWindows([
      {
        version: SNAPSHOT_VERSION,
        pid: 2,
        name: 'beta',
        groups: [{ kind: 'host', name: 'beta', agents: [] }],
      },
    ]);
    assert.deepStrictEqual(tree.getChildren(), [WORKSPACE]);
    tree.setOtherWindows([
      {
        version: SNAPSHOT_VERSION,
        pid: 2,
        name: 'beta',
        groups: [
          {
            kind: 'host',
            name: 'beta',
            agents: [{ key: 'k', agent: agent('p', 'idle'), herdr: true }],
          },
        ],
      },
    ]);
    assert.deepStrictEqual(tree.getChildren(), [WORKSPACE, OTHER_WORKSPACES]);
    const others = tree.getTreeItem(OTHER_WORKSPACES);
    assert.strictEqual(others.label, 'Other Workspaces');
    assert.strictEqual(
      others.collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    tree.dispose();
  });

  test('shows every running container, with its agents flat', async () => {
    const source = new FakeSource();
    source.containers = [container('b'), container('a')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();

    const ids = () =>
      tree
        .getChildren(WORKSPACE)
        .map(n => n.kind === 'container' && n.container.id);
    assert.deepStrictEqual(ids(), ['a', 'b']);
    watchers.get('b')!.push([agent('w1:p1', 'blocked')]);
    const terminal = {} as vscode.Terminal;
    tree.setTerminalAgent('b', terminal, agent('t', 'working'));

    const envs = tree.getChildren(WORKSPACE);
    assert.deepStrictEqual(ids(), ['a', 'b']);
    const agents = tree.getChildren(envs[1]);
    assert.deepStrictEqual(
      agents.map(n => n.kind === 'agent' && n.agent.paneId),
      ['w1:p1', 't']
    );
    const item = tree.getTreeItem(envs[1]);
    assert.strictEqual(item.description, '1 blocked, 1 working');
    assert.strictEqual(
      tree.getTreeItem(WORKSPACE).description,
      '1 blocked, 1 working'
    );
    assert.strictEqual(tree.attentionCount(), 1);
    tree.dispose();
  });

  test('labels an agent by its task', async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();
    watchers
      .get('a')!
      .push([{ ...agent('w1:p1', 'working'), title: 'Fixing tests' }]);

    const [env] = tree.getChildren(WORKSPACE);
    const item = tree.getTreeItem(tree.getChildren(env)[0]);
    assert.strictEqual(item.label, 'Fixing tests');
    assert.strictEqual(item.description, 'claude');
    tree.dispose();
  });

  test("says when a container's herdr is not running", async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();

    watchers.get('a')!.push([], false);
    const [env] = tree.getChildren(WORKSPACE);
    const item = tree.getTreeItem(env);
    assert.strictEqual(item.description, 'herdr not running');
    assert.strictEqual(item.contextValue, 'agentContainer');
    assert.strictEqual(
      item.collapsibleState,
      vscode.TreeItemCollapsibleState.None
    );

    watchers.get('a')!.push([], true);
    assert.strictEqual(tree.getTreeItem(env).description, '');
    tree.setAttachedContainers(new Set(['a']));
    assert.strictEqual(
      tree.getTreeItem(env).contextValue,
      'agentContainer.attached'
    );
    assert.deepStrictEqual(tree.containerFor('/work/a/'), {
      container: container('a'),
      herdrRunning: true,
    });
    assert.strictEqual(tree.containerFor('/work/b'), undefined);
    tree.dispose();
  });

  test('drops a container once it stops', async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    const { watch } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();
    source.containers = [];
    await tree.sync();
    assert.deepStrictEqual(tree.getChildren(WORKSPACE), []);
    assert.deepStrictEqual(tree.snapshotGroups(), []);
    tree.dispose();
  });

  test('fires only when agents actually change', async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();

    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    watchers.get('a')!.push([agent('w1:p1', 'working')]);
    watchers.get('a')!.push([agent('w1:p1', 'working')]);
    watchers.get('a')!.push([agent('w1:p1', 'idle')]);
    assert.strictEqual(fired, 2);
    tree.dispose();
  });

  test('stops watching containers that went away', async () => {
    const source = new FakeSource();
    source.containers = [container('a'), container('b')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();
    const first = watchers.get('a')!;

    source.containers = [container('b')];
    await tree.sync();
    assert.strictEqual(first.disposed, true);
    assert.strictEqual(watchers.get('b')!.disposed, false);
    tree.dispose();
    assert.strictEqual(watchers.get('b')!.disposed, true);
  });

  test('restarts a watcher that ended on the next sync', async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();
    const first = watchers.get('a')!;
    first.push([agent('w1:p1', 'idle')]);

    first.exit();
    assert.deepStrictEqual(tree.allAgents(), []);
    await tree.sync();
    assert.notStrictEqual(watchers.get('a'), first);
    tree.dispose();
  });
});

suite('taskLabel', () => {
  test('title, then folder, then the agent', () => {
    const base: AgentInfo = { paneId: 'p', agent: 'claude', status: 'idle' };
    assert.strictEqual(
      taskLabel({ ...base, title: ' Fix it ', cwd: '/w/app' }),
      'Fix it'
    );
    assert.strictEqual(
      taskLabel({ ...base, title: ' ', cwd: '/w/app' }),
      'app'
    );
    assert.strictEqual(taskLabel(base), 'claude');
  });
});

suite('startAgent', () => {
  /** Trimmed from real herdr 0.8.2 `tab create` output. */
  const TAB_CREATED = JSON.stringify({
    id: 'cli:tab:create',
    result: {
      root_pane: { pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1' },
      tab: { tab_id: 'w1:t2', workspace_id: 'w1' },
      type: 'tab_created',
    },
  });
  const error = (code: string, message = code) =>
    JSON.stringify({ error: { code, message }, id: 'cli' });

  /** Answers each command by its first two words, recording the calls. */
  function fakeRun(answers: Record<string, [number, string][]>) {
    const calls: string[][] = [];
    const run: HerdrRunner = async args => {
      calls.push(args);
      const next = answers[args.slice(0, 2).join(' ')]?.shift();
      return next && { exitCode: next[0], stdout: next[1] };
    };
    return { run, calls };
  }

  test('parses the new pane', () => {
    assert.deepStrictEqual(parseCreatedPane(TAB_CREATED), {
      paneId: 'w1:p2',
      tabId: 'w1:t2',
    });
    assert.strictEqual(parseCreatedPane(error('x')), undefined);
    assert.strictEqual(parseCreatedPane('nope'), undefined);
  });

  test('opens a tab and starts the agent in it', async () => {
    const { run, calls } = fakeRun({
      'tab create': [[0, TAB_CREATED]],
      'agent start': [[0, '{}']],
    });
    const result = await startAgent(run, '/w/app', 'claude');
    assert.deepStrictEqual(result, {
      pane: { paneId: 'w1:p2', tabId: 'w1:t2' },
    });
    assert.deepStrictEqual(calls, [
      ['tab', 'create', '--cwd', '/w/app', '--focus'],
      ['agent', 'start', 'claude', '--kind', 'claude', '--pane', 'w1:p2'],
    ]);
  });

  test('creates a workspace when there is none', async () => {
    const { run, calls } = fakeRun({
      'tab create': [[1, error('workspace_not_found')]],
      'workspace create': [[0, TAB_CREATED]],
      'agent start': [[0, '{}']],
    });
    const result = await startAgent(run, undefined, 'pi');
    assert.ok('pane' in result);
    assert.deepStrictEqual(calls[1], ['workspace', 'create', '--focus']);
  });

  test('an agent waiting at startup still started', async () => {
    const { run } = fakeRun({
      'tab create': [[0, TAB_CREATED]],
      'agent start': [[1, error('agent_not_ready')]],
    });
    assert.ok('pane' in (await startAgent(run, undefined, 'claude')));
  });

  test("reports herdr's error", async () => {
    const { run } = fakeRun({
      'tab create': [[0, TAB_CREATED]],
      'agent start': [[1, error('agent_pane_busy', 'pane is busy')]],
    });
    assert.deepStrictEqual(await startAgent(run, undefined, 'claude'), {
      error: 'pane is busy',
    });
    const missing = fakeRun({});
    assert.deepStrictEqual(await startAgent(missing.run, undefined, 'claude'), {
      error: 'herdr could not be run',
    });
  });
});

suite('AgentTreeDataProvider with SSH hosts', () => {
  const noContainers: ContainerSource = { listRunning: async () => [] };
  const noWatch: WatchAgents = () => ({ dispose() {} });

  function fakeSsh(hosts: SshHostInfo[]) {
    const watchers = new Map<
      string,
      {
        session: string;
        push: (agents: AgentInfo[], running: boolean) => void;
        exit: () => void;
        disposed: boolean;
      }
    >();
    let session = 'code.app';
    const source: SshAgentSource = {
      list: () => hosts,
      session: () => session,
      watch(host, s, onAgents, onExit) {
        const w = { session: s, push: onAgents, exit: onExit, disposed: false };
        watchers.set(host, w);
        return {
          dispose() {
            w.disposed = true;
          },
        };
      },
    };
    return {
      source,
      watchers,
      setSession: (s: string) => (session = s),
    };
  }

  const vm: SshHostInfo = { host: 'agent-vm', label: 'Sandbox' };
  const other: SshHostInfo = { host: 'another', label: 'Another' };

  test('shows a host once its watcher reports, running or not', () => {
    const ssh = fakeSsh([vm]);
    const tree = new AgentTreeDataProvider(
      noContainers,
      noWatch,
      undefined,
      ssh.source
    );
    tree.syncSsh();
    assert.strictEqual(ssh.watchers.get('agent-vm')?.session, 'code.app');
    // Not reached yet: no SSH Hosts root.
    assert.deepStrictEqual(tree.getChildren(), [WORKSPACE]);
    assert.deepStrictEqual(tree.getChildren(SSH_HOSTS), []);
    // Reachable, herdr session not running: still shown, empty.
    ssh.watchers.get('agent-vm')!.push([], false);
    assert.deepStrictEqual(tree.getChildren(), [WORKSPACE, SSH_HOSTS]);
    const root = tree.getTreeItem(SSH_HOSTS);
    assert.strictEqual(root.label, 'SSH Hosts');
    assert.strictEqual(root.contextValue, 'agentSshHosts');
    const [env] = tree.getChildren(SSH_HOSTS);
    assert.deepStrictEqual(env, {
      kind: 'ssh',
      host: 'agent-vm',
      label: 'Sandbox',
    });
    let item = tree.getTreeItem(env);
    assert.strictEqual(item.label, 'Sandbox');
    assert.strictEqual(item.id, 'ssh:agent-vm');
    assert.strictEqual(item.contextValue, 'agentSsh');
    assert.strictEqual(
      item.collapsibleState,
      vscode.TreeItemCollapsibleState.None
    );
    assert.ok(String(item.tooltip).includes('"code.app", not running'));
    // Running, with an agent, and a terminal to it open here.
    ssh.watchers
      .get('agent-vm')!
      .push([{ paneId: 'w1:p1', agent: 'claude', status: 'working' }], true);
    tree.setAttachedContainers(new Set(['ssh:agent-vm']));
    item = tree.getTreeItem(env);
    assert.strictEqual(item.contextValue, 'agentSsh.running.attached');
    assert.strictEqual(item.description, '1 working');
    assert.strictEqual(tree.getTreeItem(SSH_HOSTS).description, '1 working');
    const [agentNode] = tree.getChildren(env);
    assert.strictEqual(
      agentNode.kind === 'agent' && agentNode.ssh?.host,
      'agent-vm'
    );
    assert.strictEqual(tree.getTreeItem(agentNode).id, 'ssh-herdr:agent-vm:w1:p1');
    // The connection drops: gone until it reports again.
    ssh.watchers.get('agent-vm')!.exit();
    assert.deepStrictEqual(tree.getChildren(), [WORKSPACE]);
    tree.dispose();
  });

  test('sit under SSH Hosts by label, apart from containers, with terminal agents', async () => {
    const ssh = fakeSsh([vm, other]);
    const source: ContainerSource = {
      listRunning: async () => [
        { id: 'c1', name: 'app', containerName: 'devc-app', localFolder: '/w/app' },
      ],
    };
    const tree = new AgentTreeDataProvider(
      source,
      noWatch,
      undefined,
      ssh.source
    );
    await tree.sync();
    tree.syncSsh();
    ssh.watchers.get('agent-vm')!.push([], true);
    ssh.watchers.get('another')!.push([], true);
    assert.deepStrictEqual(
      tree.getChildren(WORKSPACE).map(n => n.kind),
      ['container']
    );
    assert.deepStrictEqual(
      tree
        .getChildren(SSH_HOSTS)
        .map(n => (n.kind === 'ssh' ? n.label : n.kind)),
      ['Another', 'Sandbox']
    );
    const terminal = { name: 'ssh Sandbox' } as vscode.Terminal;
    tree.setTerminalAgent('ssh:agent-vm', terminal, {
      paneId: 'terminal:pts/3',
      agent: 'claude',
      status: 'idle',
    });
    const sandbox = tree.getChildren(SSH_HOSTS)[1];
    const [detected] = tree.getChildren(sandbox);
    assert.ok(detected.kind === 'agent' && detected.terminal === terminal);
    // Published for other windows, and found again by key.
    const group = tree.snapshotGroups().find(g => g.kind === 'ssh' && g.host === 'agent-vm');
    assert.ok(group && group.kind === 'ssh');
    assert.strictEqual(group.label, 'Sandbox');
    assert.strictEqual(group.agents.length, 1);
    assert.strictEqual(group.agents[0].herdr, false);
    assert.deepStrictEqual(tree.findLocal(group.agents[0].key), detected);
    tree.dispose();
  });

  test('removed hosts and a new session restart watchers', () => {
    const hosts = [vm];
    const ssh = fakeSsh(hosts);
    const tree = new AgentTreeDataProvider(
      noContainers,
      noWatch,
      undefined,
      ssh.source
    );
    tree.syncSsh();
    const first = ssh.watchers.get('agent-vm')!;
    ssh.setSession('code.other');
    tree.syncSsh();
    assert.ok(first.disposed);
    const second = ssh.watchers.get('agent-vm')!;
    assert.strictEqual(second.session, 'code.other');
    hosts.length = 0;
    tree.syncSsh();
    assert.ok(second.disposed);
    tree.dispose();
  });

  test("other windows' SSH hosts are read-only", () => {
    const tree = new AgentTreeDataProvider(noContainers, noWatch);
    tree.setOtherWindows([
      {
        version: SNAPSHOT_VERSION,
        pid: 7,
        name: 'beta',
        groups: [
          {
            kind: 'ssh',
            host: 'agent-vm',
            label: 'Sandbox',
            agents: [
              {
                key: 'ssh-herdr:agent-vm:w1:p1',
                agent: { paneId: 'w1:p1', agent: 'claude', status: 'blocked' },
                herdr: true,
              },
            ],
          },
        ],
      },
    ]);
    const [env] = tree.getChildren(OTHER_WORKSPACES);
    const item = tree.getTreeItem(env);
    assert.strictEqual(item.id, 'w7:ssh:agent-vm');
    assert.strictEqual(item.contextValue, 'agentSshRemote');
    const [remoteAgent] = tree.getChildren(env);
    assert.strictEqual(tree.getTreeItem(remoteAgent).contextValue, 'agentRemote');
    assert.strictEqual(tree.attentionCount(), 1);
    tree.dispose();
  });
});
