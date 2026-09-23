import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTreeDataProvider, WatchAgents } from '../agentTree';
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
    containers: [
      {
        container: { id: `c${pid}`, name, containerName: `devc-${name}` },
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
    });
    await tree.sync();
    push([{ paneId: 'w1:p1', agent: 'claude', status: 'idle' }]);
    tree.setOtherWindows([snapshot(2, 'beta', 0)]);
    assert.deepStrictEqual(
      tree.getChildren().map(n => n.kind),
      ['container']
    );
    tree.dispose();
  });

  test('grouped by window, this window first', async () => {
    const { tree, push } = localTree({
      id: 'c0',
      name: 'here',
      containerName: 'devc-here',
    });
    await tree.sync();
    push([{ paneId: 'w1:p1', agent: 'claude', status: 'working' }]);
    tree.setOtherWindows([snapshot(2, 'beta'), snapshot(3, 'alpha')]);
    const roots = tree.getChildren();
    assert.deepStrictEqual(
      roots.map(n => (n.kind === 'window' ? (n.remote?.name ?? 'this') : '')),
      ['this', 'beta', 'alpha']
    );
    const remoteAgent = tree.getChildren(tree.getChildren(roots[1])[0])[0];
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
    });
    await tree.sync();
    push([{ paneId: 'w1:p1', agent: 'claude', status: 'idle' }]);
    const [published] = tree.snapshotContainers();
    const key = published.agents[0].key;
    const node = tree.findLocal(key);
    assert.strictEqual(node?.kind === 'agent' && node.agent.paneId, 'w1:p1');
    assert.strictEqual(tree.findLocal('herdr:nope'), undefined);
    tree.dispose();
  });
});
