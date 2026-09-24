import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  AgentNode,
  AgentTreeDataProvider,
  HostSessionSource,
  WatchAgents,
  ownedAgents,
} from '../agentTree';
import { ContainerInfo, ContainerSource } from '../containerTree';
import { AgentInfo } from '../herdr';
import {
  HostSession,
  attachCommand,
  errorMessage,
  herdrEnv,
  parseSessionList,
  sessionFromClientArgs,
  sessionNameForDir,
} from '../hostHerdr';
import { foregroundFromPs } from '../hostProcesses';
import { SNAPSHOT_VERSION, WindowSnapshot } from '../windowRegistry';

suite('sessionFromClientArgs', () => {
  test('names the session a client attaches to', () => {
    assert.strictEqual(sessionFromClientArgs('herdr --session x', 'd'), 'x');
    assert.strictEqual(
      sessionFromClientArgs('/Users/me/.local/bin/herdr --session x', 'd'),
      'x'
    );
    assert.strictEqual(
      sessionFromClientArgs('herdr session attach x', 'd'),
      'x'
    );
  });

  test('a bare herdr is the default session', () => {
    assert.strictEqual(sessionFromClientArgs('herdr', 'default'), 'default');
    assert.strictEqual(sessionFromClientArgs('herdr', undefined), undefined);
  });

  test('servers, other subcommands, and other programs are not clients', () => {
    for (const args of [
      'herdr server',
      'herdr api snapshot',
      'herdr session list --json',
      'bash',
      'vim herdr',
      'herdr-mirror daemon',
    ]) {
      assert.strictEqual(sessionFromClientArgs(args, 'default'), undefined);
    }
  });
});

suite('parseSessionList', () => {
  /** Shape from herdr 0.8.2's `herdr session list --json`. */
  const LIST = JSON.stringify({
    sessions: [
      {
        default: true,
        name: 'default',
        running: true,
        session_dir: '/home/me/.config/herdr',
        socket_path: '/home/me/.config/herdr/herdr.sock',
      },
      {
        default: false,
        name: 'stopped',
        running: false,
        session_dir: '/home/me/.config/herdr/sessions/stopped',
        socket_path: '/home/me/.config/herdr/sessions/stopped/herdr.sock',
      },
      {
        default: false,
        name: 'app',
        running: true,
        session_dir: '/home/me/.config/herdr/sessions/app',
        socket_path: '/home/me/.config/herdr/sessions/app/herdr.sock',
      },
    ],
  });

  test('lists running sessions only', () => {
    assert.deepStrictEqual(parseSessionList(LIST), [
      {
        name: 'default',
        default: true,
        socketPath: '/home/me/.config/herdr/herdr.sock',
      },
      {
        name: 'app',
        default: false,
        socketPath: '/home/me/.config/herdr/sessions/app/herdr.sock',
      },
    ]);
  });

  test('nothing from output that is not a session list', () => {
    assert.deepStrictEqual(parseSessionList(''), []);
    assert.deepStrictEqual(parseSessionList('{"error":{}}'), []);
  });
});

suite('host herdr commands', () => {
  test('inherited HERDR_* variables never reach a command', () => {
    const env = herdrEnv('/s/herdr.sock', {
      HOME: '/home/me',
      PATH: '/usr/bin',
      HERDR_SESSION: 'other',
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p3',
      HERDR_TAB_ID: 'w1:t3',
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_SOCKET_PATH: '/other/herdr.sock',
      KEEP: 'yes',
    });
    assert.deepStrictEqual(env, {
      HOME: '/home/me',
      PATH: '/home/me/.local/bin:/usr/bin',
      KEEP: 'yes',
      HERDR_SOCKET_PATH: '/s/herdr.sock',
    });
  });

  test('error message from a herdr error response', () => {
    assert.strictEqual(
      errorMessage(
        '{"error":{"code":"session_delete_failed","message":"deleting the default session is not supported"}}'
      ),
      'deleting the default session is not supported'
    );
    assert.strictEqual(errorMessage('{"deleted":true}'), undefined);
    assert.strictEqual(errorMessage('not json'), undefined);
  });

  test('attach command', () => {
    assert.strictEqual(
      attachCommand({ name: 'default', default: true, socketPath: '' }),
      'herdr'
    );
    assert.strictEqual(
      attachCommand({ name: 'app', default: false, socketPath: '' }),
      'herdr --session app'
    );
    assert.strictEqual(
      attachCommand({ name: "it's", default: false, socketPath: '' }),
      `herdr --session 'it'\\''s'`
    );
  });
});

suite('foregroundFromPs', () => {
  test('finds the foreground group leader', () => {
    const output = [
      '85000 85000 85948 -bash',
      '85948 85948 85948 herdr --session devc-vscode',
      '85950 85948 85948 some-helper',
    ].join('\n');
    assert.deepStrictEqual(foregroundFromPs(output), {
      pid: 85948,
      args: 'herdr --session devc-vscode',
    });
  });

  test('the shell when nothing else is running', () => {
    assert.deepStrictEqual(foregroundFromPs(' 12 12 12 /bin/zsh -l\n'), {
      pid: 12,
      args: '/bin/zsh -l',
    });
    assert.strictEqual(foregroundFromPs(''), undefined);
  });
});

function agent(paneId: string, cwd?: string): AgentInfo {
  return { paneId, tabId: 't1', agent: 'claude', status: 'blocked', cwd };
}

suite('ownedAgents', () => {
  const agents = [
    agent('w1:p1', '/work/app'),
    agent('w1:p2', '/work/app/sub'),
    agent('w1:p3', '/work/application'),
    agent('w1:p4'),
  ];

  test('an attached session shows all its agents', () => {
    assert.strictEqual(ownedAgents(agents, true, []).length, 4);
  });

  test('otherwise only agents under a workspace folder', () => {
    assert.deepStrictEqual(
      ownedAgents(agents, false, ['/work/app']).map(a => a.paneId),
      ['w1:p1', 'w1:p2']
    );
  });

  test('a session with nothing in the folders is not owned', () => {
    assert.deepStrictEqual(ownedAgents(agents, false, ['/elsewhere']), []);
  });
});

suite('sessionNameForDir', () => {
  test('is the basename, normalized as herdrs does', () => {
    assert.strictEqual(sessionNameForDir('/work/devc-vscode'), 'devc-vscode');
    assert.strictEqual(sessionNameForDir('/work/My Project!'), 'my-project');
    assert.strictEqual(sessionNameForDir('/work/a  b__c.d'), 'a-b__c.d');
    assert.strictEqual(sessionNameForDir('/work/---'), undefined);
  });
});

suite('AgentTreeDataProvider with host sessions', () => {
  const session = (name: string, isDefault = false): HostSession => ({
    name,
    default: isDefault,
    socketPath: `/sock/${name}`,
  });

  /** A host with sessions, terminals, and folders the test controls. */
  function fakeHost() {
    const host = {
      sessions: [] as HostSession[],
      foregrounds: [] as string[],
      folders: [] as string[],
      workspaceSession: undefined as string | undefined,
      agents: new Map<string, AgentInfo[]>(),
      watchers: new Map<
        string,
        { push(a: AgentInfo[]): void; exit(): void; disposed: boolean }
      >(),
    };
    const source: HostSessionSource = {
      list: async () => host.sessions,
      foregrounds: async () => host.foregrounds,
      folders: () => host.folders,
      workspaceSession: () => host.workspaceSession,
      read: async s => host.agents.get(s.name),
      watch(s, onAgents, onExit) {
        const w = { push: onAgents, exit: onExit, disposed: false };
        host.watchers.set(s.name, w);
        const initial = host.agents.get(s.name);
        if (initial) {
          onAgents(initial);
        }
        return {
          dispose() {
            w.disposed = true;
          },
        };
      },
    };
    return { host, source };
  }

  function treeWith(
    source: HostSessionSource,
    containers: ContainerInfo[] = [],
    containerAgents: AgentInfo[] = []
  ) {
    const containerSource: ContainerSource = {
      listRunning: async () => containers,
    };
    const watch: WatchAgents = (_id, onAgents) => {
      onAgents(containerAgents);
      return { dispose() {} };
    };
    return new AgentTreeDataProvider(containerSource, watch, source);
  }

  function labels(tree: AgentTreeDataProvider, nodes: AgentNode[]) {
    return nodes.map(n => tree.getTreeItem(n).label);
  }

  test('an attached session shows all its agents', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('default', true), session('app')];
    host.foregrounds = ['/bin/zsh', 'herdr --session app'];
    host.agents.set('app', [agent('w1:p1', '/x'), agent('w1:p2', '/y')]);
    host.agents.set('default', [agent('w1:p1', '/z')]);
    const tree = treeWith(source);
    await tree.syncSessions();

    const roots = tree.getChildren();
    assert.deepStrictEqual(labels(tree, roots), ['app']);
    assert.strictEqual(tree.getChildren(roots[0]).length, 2);
    assert.strictEqual(host.watchers.has('default'), false);
    assert.strictEqual(tree.attentionCount(), 2);
    tree.dispose();
  });

  test('a bare herdr attaches the default session', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('main', true)];
    host.foregrounds = ['herdr'];
    host.agents.set('main', [agent('w1:p1')]);
    const tree = treeWith(source);
    await tree.syncSessions();
    assert.deepStrictEqual(labels(tree, tree.getChildren()), ['default']);
    // Stoppable but not deletable: herdr refuses to delete it.
    assert.strictEqual(
      tree.getTreeItem(tree.getChildren()[0]).contextValue,
      'agentSession.default.attached'
    );
    tree.dispose();
  });

  test('by folder, only agents in this window are shown', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('default', true), session('other')];
    host.folders = ['/work/app'];
    host.agents.set('default', [
      agent('w1:p1', '/work/app/src'),
      agent('w2:p1', '/work/unrelated'),
    ]);
    host.agents.set('other', [agent('w1:p1', '/work/unrelated')]);
    const tree = treeWith(source);
    await tree.syncSessions();

    const roots = tree.getChildren();
    assert.deepStrictEqual(labels(tree, roots), ['default']);
    assert.deepStrictEqual(
      tree.getChildren(roots[0]).map(n => n.kind === 'agent' && n.agent.paneId),
      ['w1:p1']
    );
    // Not owned, so not streamed.
    assert.strictEqual(host.watchers.has('other'), false);
    tree.dispose();
  });

  test('stops streaming a session no longer owned', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('app')];
    host.foregrounds = ['herdr --session app'];
    host.agents.set('app', [agent('w1:p1', '/elsewhere')]);
    const tree = treeWith(source);
    await tree.syncSessions();
    assert.strictEqual(tree.getChildren().length, 1);

    host.foregrounds = [];
    await tree.syncSessions();
    assert.strictEqual(host.watchers.get('app')!.disposed, true);
    assert.deepStrictEqual(tree.getChildren(), []);
    tree.dispose();
  });

  test('a stopped session is dropped', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('app')];
    host.foregrounds = ['herdr --session app'];
    host.agents.set('app', [agent('w1:p1')]);
    const tree = treeWith(source);
    await tree.syncSessions();
    host.watchers.get('app')!.exit();
    assert.deepStrictEqual(tree.getChildren(), []);
    tree.dispose();
  });

  test('session groups sit beside container groups, by label', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('beta'), session('delta')];
    host.foregrounds = ['herdr --session beta', 'herdr --session delta'];
    host.agents.set('beta', [agent('w1:p1')]);
    host.agents.set('delta', [agent('w1:p1')]);
    const containers = ['alpha', 'gamma'].map(id => ({
      id,
      name: id,
      containerName: `devc-${id}`,
      localFolder: `/work/${id}`,
    }));
    const tree = treeWith(source, containers, [agent('w1:p1')]);
    await tree.sync();
    await tree.syncSessions();

    const roots = tree.getChildren();
    assert.deepStrictEqual(
      roots.map(n => `${n.kind}:${tree.getTreeItem(n).label}`),
      [
        'container:alpha',
        'session:beta',
        'session:delta',
        'container:gamma',
      ]
    );
    const sessionItem = tree.getTreeItem(roots[1]);
    assert.strictEqual(sessionItem.contextValue, 'agentSession.attached');
    assert.strictEqual(
      (sessionItem.iconPath as vscode.ThemeIcon).id,
      'terminal-tmux'
    );

    // Keys follow the contract, and the same pane id in two sessions (and a
    // container) still gives distinct ids.
    const ids = roots.flatMap(group =>
      tree.getChildren(group).map(n => tree.getTreeItem(n).id)
    );
    assert.deepStrictEqual(ids, [
      'herdr:alpha:w1:p1',
      'host-herdr:beta:w1:p1',
      'host-herdr:delta:w1:p1',
      'herdr:gamma:w1:p1',
    ]);
    const item = tree.getTreeItem(tree.getChildren(roots[1])[0]);
    assert.strictEqual(item.label, 'claude (herdr)');

    // Published and found again by key.
    const groups = tree.snapshotGroups();
    assert.deepStrictEqual(
      groups.map(g => g.kind),
      ['container', 'session', 'session', 'container']
    );
    const node = tree.findLocal('host-herdr:delta:w1:p1');
    assert.strictEqual(node?.kind === 'agent' && node.session, 'delta');
    tree.dispose();
  });

  test("the window's workspace session shows without agents", async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('default', true), session('app'), session('x')];
    host.folders = ['/work/app'];
    host.workspaceSession = 'app';
    host.agents.set('app', []);
    host.agents.set('default', []);
    const tree = treeWith(source);
    await tree.syncSessions();

    const roots = tree.getChildren();
    assert.deepStrictEqual(labels(tree, roots), ['app']);
    assert.deepStrictEqual(tree.getChildren(roots[0]), []);
    // No terminal here is a client, so it offers to attach.
    assert.strictEqual(tree.getTreeItem(roots[0]).contextValue, 'agentSession');

    host.foregrounds = ['herdr --session app'];
    await tree.syncSessions();
    assert.strictEqual(
      tree.getTreeItem(tree.getChildren()[0]).contextValue,
      'agentSession.attached'
    );

    // Still streamed once detached: the name keeps it owned.
    host.foregrounds = [];
    await tree.syncSessions();
    assert.strictEqual(host.watchers.get('app')!.disposed, false);
    assert.deepStrictEqual(labels(tree, tree.getChildren()), ['app']);

    host.workspaceSession = undefined;
    await tree.syncSessions();
    assert.strictEqual(host.watchers.get('app')!.disposed, true);
    assert.deepStrictEqual(tree.getChildren(), []);
    tree.dispose();
  });

  test('an attached session shows without agents', async () => {
    const { host, source } = fakeHost();
    host.sessions = [session('app')];
    host.foregrounds = ['herdr --session app'];
    const tree = treeWith(source);
    await tree.syncSessions();
    assert.deepStrictEqual(labels(tree, tree.getChildren()), ['app']);
    tree.dispose();
  });

  test("another window's session group", async () => {
    const { source } = fakeHost();
    const tree = treeWith(source);
    const remote: WindowSnapshot = {
      version: SNAPSHOT_VERSION,
      pid: 7,
      name: 'beta',
      workspaceUri: 'file:///work/beta',
      groups: [
        {
          kind: 'session',
          session: 'beta',
          agents: [
            {
              key: 'host-herdr:beta:w1:p1',
              agent: agent('w1:p1'),
              herdr: true,
            },
          ],
        },
      ],
    };
    tree.setOtherWindows([remote]);
    const [others] = tree.getChildren();
    const [window] = tree.getChildren(others);
    const [group] = tree.getChildren(window);
    assert.strictEqual(group.kind, 'session');
    assert.strictEqual(tree.getTreeItem(group).id, 'w7:session:beta');
    assert.strictEqual(
      tree.getTreeItem(group).contextValue,
      'agentSessionRemote'
    );
    const [remoteAgent] = tree.getChildren(group);
    assert.strictEqual(
      tree.getTreeItem(remoteAgent).id,
      'w7:host-herdr:beta:w1:p1'
    );
    assert.strictEqual(tree.attentionCount(), 1);
    tree.dispose();
  });
});
