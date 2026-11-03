import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HerdrEvent } from '../bridge';
import { RemoteShell, LocalShell } from '../remoteShell';
import { SessionConnection, Snapshot, SnapshotPane } from '../sessions';
import { makePaneKey } from '../tilesProtocol';
import { memoryMemento, paneStateIn, realSpanGit, SpanGit, TOUCHED_KEY, TOUCHED_MAX_AGE_MS, TouchedRecorder, TouchedStore } from '../touched';
import { snapshot } from './fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, get: () => T | undefined | false | Promise<T | undefined | false>, ms = 10000): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const v = await get();
		if (v) {
			return v as T;
		}
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${what}`);
}

const S = 'host/a';
const P1 = makePaneKey(S, 'w2:p1');
const P2 = makePaneKey(S, 'w1:p2');

suite('touched files: the store', () => {
	test('add merges sorted and unique; a memento round trip keeps it; malformed entries are ignored', async () => {
		const memento = memoryMemento();
		const store = new TouchedStore(memento);
		let fired = 0;
		store.onDidChange(() => fired++);
		await store.add(P1, '/r', ['src/b.ts', 'a.txt'], 1000);
		await store.add(P1, '/r', ['a.txt', 'src/a.ts'], 2000);
		assert.deepStrictEqual(store.get(P1, '/r'), { paths: ['a.txt', 'src/a.ts', 'src/b.ts'], at: 2000 });
		assert.strictEqual(fired, 2);
		const reloaded = new TouchedStore(memento);
		assert.deepStrictEqual(reloaded.get(P1, '/r'), { paths: ['a.txt', 'src/a.ts', 'src/b.ts'], at: 2000 });
		assert.deepStrictEqual(memento.get(TOUCHED_KEY), { [`${P1}\n/r`]: { paths: ['a.txt', 'src/a.ts', 'src/b.ts'], at: 2000 } });
		await memento.update(TOUCHED_KEY, { [`${P1}\n/r`]: { paths: 'x', at: 1 }, [`${P2}\n/r`]: { paths: ['ok'], at: 3 } });
		assert.deepStrictEqual(reloaded.keys(), [`${P2}\n/r`]);
		assert.strictEqual(reloaded.get(P1, '/other'), undefined);
		store.dispose();
		reloaded.dispose();
	});

	test('pruned at 7 days and for closed panes; a pane of a disconnected session keeps its entries', async () => {
		const store = new TouchedStore(memoryMemento());
		const now = 100 * TOUCHED_MAX_AGE_MS;
		await store.add(P1, '/old', ['a'], now - TOUCHED_MAX_AGE_MS - 1);
		await store.add(P1, '/new', ['a'], now - TOUCHED_MAX_AGE_MS + 1000);
		await store.add(P2, '/new', ['a'], now);
		await store.add(makePaneKey('host/gone', 'w1:p1'), '/r', ['a'], now);
		const snap = snapshot();
		snap.panes = snap.panes.filter((p) => p.pane_id !== 'w1:p2');
		await store.prune(
			paneStateIn((key) => (key === S ? { state: 'connected', snapshot: snap } : undefined)),
			now,
		);
		assert.deepStrictEqual(store.keys().sort(), [`${P1}\n/new`, `${makePaneKey('host/gone', 'w1:p1')}\n/r`].sort());
		assert.strictEqual(store.prune(() => 'present', now), undefined, 'nothing to drop: no write');
		store.dispose();
	});

	test('move: every entry of the pane goes to the new key', async () => {
		const store = new TouchedStore(memoryMemento());
		await store.add(P1, '/r', ['a'], 1);
		await store.add(P1, '/s', ['b'], 2);
		await store.add(P2, '/r', ['c'], 3);
		await store.move(P1, makePaneKey(S, 'w9:p1'));
		assert.deepStrictEqual(store.keys().sort(), [`${P2}\n/r`, `${makePaneKey(S, 'w9:p1')}\n/r`, `${makePaneKey(S, 'w9:p1')}\n/s`].sort());
		assert.deepStrictEqual(store.get(makePaneKey(S, 'w9:p1'), '/s'), { paths: ['b'], at: 2 });
		assert.strictEqual(store.move('nope', 'x'), undefined);
		store.dispose();
	});
});

class FakeModel {
	readonly changed = new vscode.EventEmitter<void>();
	readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	readonly onDidChange = this.changed.event;
	readonly onDidEvent = this.events.event;
	snap: Snapshot;
	shell: RemoteShell = new LocalShell();

	constructor(dir: string) {
		this.snap = snapshot();
		for (const p of this.snap.panes) {
			p.cwd = dir;
			p.foreground_cwd = dir;
			p.raw_status = 'idle';
			p.agent_status = 'idle';
		}
	}

	connections(): SessionConnection[] {
		return [{ key: S, state: 'connected', snapshot: this.snap, env: { key: 'host', kind: 'host', label: 'this machine', shell: this.shell } } as unknown as SessionConnection];
	}

	set(paneId: string, status: SnapshotPane['raw_status']): void {
		const pane = this.snap.panes.find((p) => p.pane_id === paneId)!;
		pane.raw_status = status;
		pane.agent_status = status;
		this.changed.fire();
	}

	remove(paneId: string): void {
		this.snap.panes = this.snap.panes.filter((p) => p.pane_id !== paneId);
		this.changed.fire();
	}
}

suite('touched files: the recorder over a temp repo', function () {
	this.timeout(30000);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
	let dir: string;
	let tmp: string;
	let savedTmp: string | undefined;
	let model: FakeModel;
	let store: TouchedStore;
	let recorder: TouchedRecorder | undefined;
	let logged: string[];

	const spanDirs = () => fs.readdirSync(tmp).filter((n) => n.startsWith('herdr-vscode-span.'));
	const make = (git?: SpanGit) => {
		recorder = new TouchedRecorder({ model, store, log: (l) => logged.push(l), git });
		return recorder;
	};

	setup(() => {
		savedTmp = process.env.TMPDIR;
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-touched-tmp-')));
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-touched-')));
		process.env.TMPDIR = tmp;
		git(dir, 'init', '-q', '-b', 'main');
		git(dir, 'config', 'user.email', 't@example.invalid');
		git(dir, 'config', 'user.name', 'T');
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
		git(dir, 'add', '.');
		git(dir, 'commit', '-q', '-m', 'one');
		model = new FakeModel(dir);
		store = new TouchedStore(memoryMemento());
		logged = [];
	});

	teardown(() => {
		recorder?.dispose();
		recorder = undefined;
		store.dispose();
		if (savedTmp === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = savedTmp;
		}
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('idle → working → idle around a write records that path; a write while idle does not; no span directory is left', async () => {
		const r = make();
		fs.writeFileSync(path.join(dir, 'before.txt'), 'idle write\n');
		model.set('w2:p1', 'working');
		assert.deepStrictEqual(r.openSpans(), [P1]);
		await r.settled();
		assert.strictEqual(spanDirs().length, 1, 'the open span has its directory');
		fs.writeFileSync(path.join(dir, 'a.txt'), 'changed while working\n');
		fs.writeFileSync(path.join(dir, 'made.txt'), 'm\n');
		model.set('w2:p1', 'idle');
		assert.deepStrictEqual(r.openSpans(), []);
		await r.settled();
		assert.deepStrictEqual(store.get(P1, dir)?.paths, ['a.txt', 'made.txt']);
		assert.deepStrictEqual(spanDirs(), []);
		fs.writeFileSync(path.join(dir, 'after.txt'), 'idle again\n');
		model.changed.fire();
		await r.settled();
		assert.deepStrictEqual(store.get(P1, dir)?.paths, ['a.txt', 'made.txt'], 'idle writes are not recorded');
		assert.deepStrictEqual(store.keys(), [`${P1}\n${dir}`], 'nothing for other panes');
		assert.deepStrictEqual(logged, []);
	});

	test('first sight while working starts a span (as after a reload); a blocked pane ends it', async () => {
		model.snap.panes.find((p) => p.pane_id === 'w2:p1')!.raw_status = 'working';
		const r = make();
		assert.deepStrictEqual(r.openSpans(), [P1]);
		await r.settled();
		fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
		model.set('w2:p1', 'blocked');
		await r.settled();
		assert.deepStrictEqual(store.get(P1, dir)?.paths, ['x.txt']);
	});

	test('a pane that disappears mid-span ends it, and its files are recorded', async () => {
		const r = make();
		model.set('w2:p1', 'working');
		await r.settled();
		fs.rmSync(path.join(dir, 'a.txt'));
		model.remove('w2:p1');
		assert.deepStrictEqual(r.openSpans(), []);
		await r.settled();
		// Pruning drops a closed pane's entries; the recording happened, then went with the pane.
		assert.deepStrictEqual(spanDirs(), []);
		model.changed.fire();
		await r.settled();
		assert.strictEqual(store.get(P1, dir), undefined, 'the pane is closed: pruned');
	});

	test('a pane that disappears mid-span: recorded before pruning sees it closed', async () => {
		const added: string[][] = [];
		const orig = store.add.bind(store);
		store.add = (pane, top, paths, now) => (added.push([pane, top, ...paths]), orig(pane, top, paths, now));
		const r = make();
		model.set('w2:p1', 'working');
		await r.settled();
		fs.rmSync(path.join(dir, 'a.txt'));
		model.remove('w2:p1');
		await r.settled();
		assert.deepStrictEqual(added, [[P1, dir, 'a.txt']]);
	});

	test('a shell pane and a pane outside a repo record nothing', async () => {
		const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-touched-plain-')));
		try {
			model.snap.panes.find((p) => p.pane_id === 'w1:p1')!.foreground_cwd = plain;
			const r = make();
			model.set('w2:p2', 'working'); // no agent
			model.set('w1:p1', 'working'); // not a repo
			assert.deepStrictEqual(r.openSpans(), [makePaneKey(S, 'w1:p1')]);
			await r.settled();
			assert.deepStrictEqual(spanDirs(), [], 'not a repo: no span directory');
			model.set('w1:p1', 'idle');
			await r.settled();
			assert.deepStrictEqual(store.keys(), []);
		} finally {
			fs.rmSync(plain, { recursive: true, force: true });
		}
	});

	test('pane.moved moves the stored entries and the open span', async () => {
		const r = make();
		await store.add(P1, dir, ['old.txt']);
		model.set('w2:p1', 'working');
		await r.settled();
		fs.writeFileSync(path.join(dir, 'moved.txt'), 'm\n');
		model.snap.panes.find((p) => p.pane_id === 'w2:p1')!.pane_id = 'w9:p1';
		model.events.fire({ sessionKey: S, event: { event: 'pane.moved', data: { previous_pane_id: 'w2:p1', pane: { pane_id: 'w9:p1' } } } as HerdrEvent });
		assert.deepStrictEqual(r.openSpans(), [makePaneKey(S, 'w9:p1')]);
		model.set('w9:p1', 'idle');
		await r.settled();
		assert.deepStrictEqual(store.get(makePaneKey(S, 'w9:p1'), dir)?.paths, ['moved.txt', 'old.txt']);
		assert.strictEqual(store.get(P1, dir), undefined);
	});

	test('two panes on one toplevel never run two snapshots at once; an end waits for its start', async () => {
		let running = 0;
		let most = 0;
		const order: string[] = [];
		const slow: SpanGit = {
			...realSpanGit,
			snapshot: async (shell, top, d) => {
				running++;
				most = Math.max(most, running);
				order.push(`snapshot ${path.basename(d)}`);
				await sleep(60);
				try {
					return await realSpanGit.snapshot(shell, top, d);
				} finally {
					running--;
				}
			},
		};
		const r = make(slow);
		model.set('w2:p1', 'working');
		model.set('w1:p2', 'working');
		// Ended before either start has finished.
		fs.writeFileSync(path.join(dir, 'both.txt'), 'b\n');
		model.set('w2:p1', 'idle');
		model.set('w1:p2', 'idle');
		await r.settled();
		assert.strictEqual(most, 1, 'one snapshot at a time per toplevel');
		assert.strictEqual(order.length, 4, order.join(', '));
		// Each span's directory is snapshotted twice, start before end.
		const dirs = order.map((o) => o.split(' ')[1]);
		assert.strictEqual(new Set(dirs).size, 2);
		assert.deepStrictEqual(spanDirs(), []);
		assert.deepStrictEqual(logged, []);
	});

	test('a failed snapshot drops the span with one log line; its directory still goes', async () => {
		let made: string | undefined;
		const failing: SpanGit = {
			...realSpanGit,
			makeDir: async (shell) => (made = await realSpanGit.makeDir(shell)),
			snapshot: async () => {
				throw new Error('fatal: boom');
			},
		};
		const r = make(failing);
		model.set('w2:p1', 'working');
		await r.settled();
		model.set('w2:p1', 'idle');
		await r.settled();
		assert.deepStrictEqual(logged, [`touched files: start snapshot in ${dir}: fatal: boom`]);
		assert.ok(made && !fs.existsSync(made));
		assert.deepStrictEqual(store.keys(), []);

		// A failing end: also one line, and the directory goes.
		let calls = 0;
		const endFails: SpanGit = {
			...realSpanGit,
			makeDir: async (shell) => (made = await realSpanGit.makeDir(shell)),
			snapshot: async (shell, top, d) => {
				if (++calls === 2) {
					throw new Error('fatal: end');
				}
				return realSpanGit.snapshot(shell, top, d);
			},
		};
		r.dispose();
		logged.length = 0;
		const r2 = make(endFails);
		model.set('w2:p1', 'working');
		await r2.settled();
		model.set('w2:p1', 'idle');
		await r2.settled();
		assert.deepStrictEqual(logged, [`touched files: end snapshot in ${dir}: fatal: end`]);
		assert.ok(!fs.existsSync(made!));
	});

	test('leftover span directories older than a day are removed on the first command in an environment', async () => {
		const old = path.join(tmp, 'herdr-vscode-span.OLD123');
		const fresh = path.join(tmp, 'herdr-vscode-span.NEW123');
		fs.mkdirSync(old);
		fs.mkdirSync(fresh);
		const t = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		fs.utimesSync(old, t, t);
		const r = make();
		model.set('w2:p1', 'working');
		await r.settled();
		assert.ok(!fs.existsSync(old), 'two days old: removed');
		assert.ok(fs.existsSync(fresh), 'recent (another window may be using it): kept');
		model.set('w2:p1', 'idle');
		await r.settled();
	});
});
