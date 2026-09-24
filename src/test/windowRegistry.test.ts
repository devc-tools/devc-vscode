import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentTreeDataProvider, THIS_WINDOW, WatchAgents } from '../agentTree';
import { ContainerInfo, ContainerSource } from '../containerTree';
import {
  SNAPSHOT_VERSION,
  WindowRegistry,
  WindowSnapshot,
} from '../windowRegistry';

function snapshot(pid: number, name: string, agents = 1): WindowSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    pid,
    name,
    workspaceUri: `file:///work/${name}`,
    groups: [
      {
        kind: 'container',
        container: {
          id: `c${pid}`,
          name,
          containerName: `devc-${name}`,
          localFolder: `/work/${name}`,
        },
        agents: Array.from({ length: agents }, (_, i) => ({
          key: `herdr:c${pid}:w1:p${i}`,
          agent: { paneId: `w1:p${i}`, agent: 'claude', status: 'blocked' },
          herdr: true,
        })),
      },
    ],
  };
}

suite('WindowRegistry', () => {
  let dir: string;
  const alive = new Set<number>();
  const isAlive = (pid: number) => alive.has(pid);

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-windows-'));
    alive.clear();
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  function registry(pid: number) {
    const seen: { others: WindowSnapshot[][]; focus: string[] } = {
      others: [],
      focus: [],
    };
    alive.add(pid);
    const r = new WindowRegistry(
      dir,
      pid,
      {
        onOthers: w => seen.others.push(w),
        onFocusRequest: k => seen.focus.push(k),
      },
      isAlive
    );
    r.start();
    return { r, seen };
  }

  test('each window sees the others, not itself', () => {
    const a = registry(1);
    const b = registry(2);
    a.r.publish(snapshot(1, 'alpha'));
    b.r.publish(snapshot(2, 'beta'));
    a.r.scan();
    b.r.scan();
    assert.deepStrictEqual(
      a.seen.others.at(-1)?.map(w => w.name),
      ['beta']
    );
    assert.deepStrictEqual(
      b.seen.others.at(-1)?.map(w => w.name),
      ['alpha']
    );
    a.r.dispose();
    b.r.dispose();
  });

  test('a clean shutdown removes the window', () => {
    const a = registry(1);
    const b = registry(2);
    b.r.publish(snapshot(2, 'beta'));
    a.r.scan();
    b.r.dispose();
    a.r.scan();
    assert.deepStrictEqual(a.seen.others.at(-1), []);
    a.r.dispose();
  });

  test("a crashed window's file is ignored and removed", () => {
    const a = registry(1);
    fs.writeFileSync(
      path.join(dir, 'window-99.json'),
      JSON.stringify(snapshot(99, 'ghost'))
    );
    a.r.scan();
    assert.deepStrictEqual(a.seen.others, []);
    assert.strictEqual(fs.existsSync(path.join(dir, 'window-99.json')), false);
    a.r.dispose();
  });

  test('unchanged views are not re-announced', () => {
    const a = registry(1);
    const b = registry(2);
    b.r.publish(snapshot(2, 'beta'));
    a.r.scan();
    a.r.scan();
    b.r.publish(snapshot(2, 'beta'));
    a.r.scan();
    assert.strictEqual(a.seen.others.length, 1);
    a.r.dispose();
    b.r.dispose();
  });

  test('focus requests reach only the addressed window, once', () => {
    const a = registry(1);
    const b = registry(2);
    a.r.requestFocus(2, 'terminal:c2:1');
    a.r.scan();
    b.r.scan();
    b.r.scan();
    assert.deepStrictEqual(a.seen.focus, []);
    assert.deepStrictEqual(b.seen.focus, ['terminal:c2:1']);
    a.r.dispose();
    b.r.dispose();
  });

  test('a stale focus request is dropped, not acted on', () => {
    const b = registry(2);
    const file = path.join(dir, 'focus-2-1-x.json');
    fs.writeFileSync(file, JSON.stringify({ key: 'old' }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    b.r.scan();
    assert.deepStrictEqual(b.seen.focus, []);
    assert.strictEqual(fs.existsSync(file), false);
    b.r.dispose();
  });

  test('container, session and local groups round-trip', () => {
    const a = registry(1);
    const b = registry(2);
    const published: WindowSnapshot = {
      ...snapshot(2, 'beta'),
      groups: [
        ...snapshot(2, 'beta').groups,
        {
          kind: 'session',
          session: 'devc-vscode',
          agents: [
            {
              key: 'host-herdr:devc-vscode:w1:p1',
              agent: { paneId: 'w1:p1', agent: 'pi', status: 'idle' },
              herdr: true,
            },
          ],
        },
        {
          kind: 'local',
          agents: [
            {
              key: 'local-terminal:3',
              agent: {
                paneId: 'terminal:ttys004',
                agent: 'claude',
                status: 'working',
              },
              herdr: false,
            },
          ],
        },
      ],
    };
    b.r.publish(published);
    a.r.scan();
    assert.deepStrictEqual(a.seen.others.at(-1), [published]);
    a.r.dispose();
    b.r.dispose();
  });

  test('changes arrive through the directory watch', async () => {
    const a = registry(1);
    const b = registry(2);
    b.r.publish(snapshot(2, 'beta'));
    await new Promise(r => setTimeout(r, 500));
    assert.deepStrictEqual(
      a.seen.others.at(-1)?.map(w => w.name),
      ['beta']
    );
    a.r.dispose();
    b.r.dispose();
  });
});

suite('AgentTreeDataProvider across windows', () => {
  const noContainers: ContainerSource = { listRunning: async () => [] };
  const noWatch: WatchAgents = () => ({ dispose() {} });

  function localTree(container?: ContainerInfo) {
    const source: ContainerSource = {
      listRunning: async () => (container ? [container] : []),
    };
    let push: (agents: never[]) => void = () => {};
    const tree = new AgentTreeDataProvider(
      container ? source : noContainers,
      container
        ? (_id, onAgents) => {
            push = onAgents as never;
            return { dispose() {} };
          }
        : noWatch
    );
    return { tree, push: (a: unknown[]) => push(a as never[]) };
  }

  test('flat while no other window has agents', async () => {
    const { tree, push } = localTree({
      id: 'c0',
      name: 'here',
      containerName: 'devc-here',
      localFolder: '/work/here',
    });
    await tree.sync();
    push([{ paneId: 'w1:p1', agent: 'claude', status: 'idle' }]);
    tree.setOtherWindows([snapshot(2, 'beta', 0)]);
    assert.deepStrictEqual(
      tree.getChildren().map(n => n.kind),
      ['thisWindow']
    );
    tree.dispose();
  });

  test("this window's groups, then other windows under one node", async () => {
    const { tree, push } = localTree({
      id: 'c0',
      name: 'here',
      containerName: 'devc-here',
      localFolder: '/work/here',
    });
    await tree.sync();
    push([{ paneId: 'w1:p1', agent: 'claude', status: 'working' }]);
    tree.setOtherWindows([snapshot(2, 'beta'), snapshot(3, 'alpha')]);
    const roots = tree.getChildren();
    assert.deepStrictEqual(
      roots.map(n => n.kind),
      ['thisWindow', 'otherWindows']
    );
    assert.deepStrictEqual(
      tree.getChildren(roots[0]).map(n => n.kind),
      ['container']
    );
    assert.strictEqual(
      tree.getTreeItem(roots[0]).description,
      'this window · 1 working'
    );
    const windows = tree.getChildren(roots[1]);
    assert.deepStrictEqual(
      windows.map(n => n.kind === 'window' && n.remote.name),
      ['beta', 'alpha']
    );
    assert.strictEqual(tree.getTreeItem(roots[1]).id, 'otherWindows');
    assert.strictEqual(
      tree.getTreeItem(roots[1]).collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    // Expand All and Collapse All set every group, under fresh ids.
    tree.setExpansion('expanded');
    assert.strictEqual(tree.getTreeItem(roots[1]).id, 'otherWindows#1');
    assert.deepStrictEqual(
      roots.map(n => tree.getTreeItem(n).collapsibleState),
      [
        vscode.TreeItemCollapsibleState.Expanded,
        vscode.TreeItemCollapsibleState.Expanded,
      ]
    );
    tree.setExpansion('collapsed');
    assert.strictEqual(tree.getTreeItem(roots[1]).id, 'otherWindows#2');
    assert.deepStrictEqual(
      roots.map(n => tree.getTreeItem(n).collapsibleState),
      [
        vscode.TreeItemCollapsibleState.Collapsed,
        vscode.TreeItemCollapsibleState.Collapsed,
      ]
    );
    // A container's herdr agents sit under its herdr node.
    const [remoteHerdr] = tree.getChildren(tree.getChildren(windows[0])[0]);
    assert.strictEqual(remoteHerdr.kind, 'containerHerdr');
    const remoteAgent = tree.getChildren(remoteHerdr)[0];
    assert.strictEqual(remoteAgent.kind, 'agent');
    assert.strictEqual(
      remoteAgent.kind === 'agent' && remoteAgent.remote?.published.key,
      'herdr:c2:w1:p0'
    );
    // Badge counts blocked agents in every window.
    assert.strictEqual(tree.attentionCount(), 2);
    tree.dispose();
  });

  test('published keys find the local agent again', async () => {
    const { tree, push } = localTree({
      id: 'c0',
      name: 'here',
      containerName: 'devc-here',
      localFolder: '/work/here',
    });
    await tree.sync();
    push([{ paneId: 'w1:p1', agent: 'claude', status: 'idle' }]);
    const [published] = tree.snapshotGroups();
    const key = published.agents[0].key;
    const node = tree.findLocal(key);
    assert.strictEqual(node?.kind === 'agent' && node.agent.paneId, 'w1:p1');
    assert.strictEqual(tree.findLocal('herdr:nope'), undefined);
    tree.dispose();
  });
});
