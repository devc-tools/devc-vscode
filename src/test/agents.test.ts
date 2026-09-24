import * as vscode from 'vscode';
import * as assert from 'assert';
import {
  AgentTreeDataProvider,
  THIS_WINDOW,
  WatchAgents,
  summarize,
} from '../agentTree';
import { ContainerInfo, ContainerSource } from '../containerTree';
import { AgentInfo, parseSnapshot, remoteUserFromMetadata } from '../herdr';

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
    stopped: ContainerInfo[] = [];
    async listRunning(): Promise<ContainerInfo[]> {
      return this.containers;
    }
    async listStopped(): Promise<ContainerInfo[]> {
      return this.stopped;
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

  test('shows every running container, with its agents', async () => {
    const source = new FakeSource();
    source.containers = [container('a'), container('b')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();

    const ids = () =>
      tree.getChildren(THIS_WINDOW).map(n => n.kind === 'container' && n.container.id);
    assert.deepStrictEqual(ids(), ['a', 'b']);
    watchers.get('b')!.push([agent('w1:p1', 'blocked')]);

    const roots = tree.getChildren(THIS_WINDOW);
    assert.deepStrictEqual(ids(), ['a', 'b']);
    const [herdrNode] = tree.getChildren(roots[1]);
    assert.strictEqual(herdrNode.kind, 'containerHerdr');
    assert.deepStrictEqual(
      tree.getChildren(herdrNode).map(n => n.kind === 'agent' && n.agent.paneId),
      ['w1:p1']
    );
    assert.strictEqual(tree.attentionCount(), 1);
    tree.dispose();
  });

  test("says when a container's herdr is not running", async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();

    watchers.get('a')!.push([], false);
    const [root] = tree.getChildren(THIS_WINDOW);
    const item = tree.getTreeItem(root);
    assert.strictEqual(item.description, 'container · herdr not running');
    assert.strictEqual(item.contextValue, 'agentContainer');
    assert.strictEqual(
      item.collapsibleState,
      vscode.TreeItemCollapsibleState.None
    );

    watchers.get('a')!.push([], true);
    assert.strictEqual(tree.getTreeItem(root).description, 'container');
    tree.setAttachedContainers(new Set(['a']));
    assert.strictEqual(
      tree.getTreeItem(root).contextValue,
      'agentContainer.attached'
    );
    tree.dispose();
  });

  test('shows stopped containers, not watched', async () => {
    const source = new FakeSource();
    source.containers = [container('a')];
    source.stopped = [container('b')];
    const { watch, watchers } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    await tree.sync();

    assert.strictEqual(watchers.has('b'), false);
    const [, stopped] = tree.getChildren(THIS_WINDOW);
    assert.strictEqual(
      stopped.kind === 'container' && stopped.state,
      'stopped'
    );
    const item = tree.getTreeItem(stopped);
    assert.strictEqual(item.description, 'container · stopped');
    assert.strictEqual(item.contextValue, 'agentContainer.stopped');
    // Not published: other windows only show groups with agents.
    assert.deepStrictEqual(
      tree.snapshotGroups().map(g => g.kind === 'container' && g.container.id),
      ['a']
    );

    // Down removes it, leaving nothing for a folder that is not primary.
    source.stopped = [];
    await tree.sync();
    assert.strictEqual(tree.getChildren(THIS_WINDOW).length, 1);
    tree.dispose();
  });

  test("the primary folder's container, real or placeholder", async () => {
    const source = new FakeSource();
    const { watch } = fakeWatch();
    const tree = new AgentTreeDataProvider(source, watch);
    tree.setPrimaryFolder('/work/a');
    await tree.sync();

    const [placeholder] = tree.getChildren(THIS_WINDOW);
    assert.strictEqual(
      placeholder.kind === 'container' && placeholder.state,
      'absent'
    );
    const item = tree.getTreeItem(placeholder);
    assert.strictEqual(item.label, 'a');
    assert.strictEqual(item.description, 'container · not created');
    assert.strictEqual(item.contextValue, 'agentContainer.absent');
    assert.deepStrictEqual(tree.snapshotGroups(), []);

    source.stopped = [container('a')];
    await tree.sync();
    const [stopped] = tree.getChildren(THIS_WINDOW);
    assert.strictEqual(
      stopped.kind === 'container' && stopped.state,
      'stopped'
    );

    source.stopped = [];
    source.containers = [container('a')];
    await tree.sync();
    const roots = tree.getChildren(THIS_WINDOW);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(
      roots[0].kind === 'container' && roots[0].state,
      undefined
    );
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
