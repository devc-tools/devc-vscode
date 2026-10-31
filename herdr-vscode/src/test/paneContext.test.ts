import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaselineMemento, BaselineStore, memoryMemento } from '../baselines';
import { HerdrEvent } from '../bridge';
import { RepoDecorations } from '../decorations';
import { Environment } from '../environments';
import { FocusTracker } from '../focus';
import { LayoutState, LayoutStore } from '../layouts';
import {
	canAddToWorkspace,
	ChangeNode,
	EntryNode,
	followedPaneKey,
	GroupNode,
	NO_PANE_MESSAGE,
	paneContextItem,
	PaneContextHost,
	paneContextMessage,
	PaneContextNode,
	PaneContextView,
	PaneRowNode,
	markedDescription,
	repoDescription,
	RootNode,
	rootContextValue,
	SinceNode,
	sortEntries,
} from '../paneContext';
import { LocalShell, RemoteShell } from '../remoteShell';
import { SessionConnection, SessionModel, Snapshot } from '../sessions';
import { PaneStreams } from '../streams';
import { LayoutPanel, TilesPanels } from '../tilesPanel';
import { makePaneKey } from '../tilesProtocol';
import { snapshot } from './fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, get: () => T | undefined | false | Promise<T | undefined | false>, ms = 10000): Promise<T> {
	const start = Date.now();
	let last: unknown;
	while (Date.now() - start < ms) {
		last = await get();
		if (last) {
			return last as T;
		}
		await sleep(25);
	}
	throw new Error(`timed out after ${ms} ms waiting for ${what} (last: ${JSON.stringify(last)})`);
}

suite('pane context: rules', () => {
	const S = 'host/a';
	const key = (id: string) => makePaneKey(S, id);

	test('herdr focus is used before any tile has been focused', () => {
		assert.strictEqual(followedPaneKey({ selectedSession: S, herdrFocused: 'w1:p1' }), key('w1:p1'));
		assert.strictEqual(followedPaneKey({ selectedSession: S, herdrFocused: 'w1:p2' }), key('w1:p2'));
	});

	test('and ignored after', () => {
		assert.strictEqual(followedPaneKey({ lastFocused: key('w2:p9'), selectedSession: S, herdrFocused: 'w1:p1' }), key('w2:p9'));
	});

	test('pinned ignores both', () => {
		assert.strictEqual(followedPaneKey({ pinned: key('w3:p3'), lastFocused: key('w2:p9'), selectedSession: S, herdrFocused: 'w1:p1' }), key('w3:p3'));
	});

	test('nothing to follow', () => {
		assert.strictEqual(followedPaneKey({}), undefined);
		assert.strictEqual(followedPaneKey({ selectedSession: S }), undefined);
		assert.strictEqual(followedPaneKey({ herdrFocused: 'w1:p1' }), undefined);
	});

	test('the header', () => {
		const pane = { label: 'api-fixer', space: 'api', tab: 'main', shown: true };
		assert.strictEqual(paneContextMessage(pane, false), 'api-fixer · api › main');
		assert.strictEqual(paneContextMessage(pane, true), 'api-fixer · api › main · pinned');
		assert.strictEqual(paneContextMessage({ ...pane, shown: false }, false), 'api-fixer · api › main · not open in a tile');
		assert.strictEqual(paneContextMessage({ ...pane, shown: false }, true), 'api-fixer · api › main · pinned · not open in a tile');
		assert.strictEqual(paneContextMessage(undefined, false), 'Click into a herdr pane to see its files.');
	});

	test('the Repo row description', () => {
		const git = (changed: number, ahead: number, behind: number) => ({ head: 'main', changes: Array.from({ length: changed }, () => ({ xy: ' M', path: 'x' })), ahead, behind });
		assert.strictEqual(repoDescription(git(0, 0, 0)), '⎇ main');
		assert.strictEqual(repoDescription(git(3, 0, 0)), '⎇ main · ● 3');
		assert.strictEqual(repoDescription(git(0, 2, 0)), '⎇ main ↑2');
		assert.strictEqual(repoDescription(git(0, 0, 4)), '⎇ main ↓4');
		assert.strictEqual(repoDescription(git(3, 2, 4)), '⎇ main · ● 3 ↑2 ↓4');
	});

	test('Add to Workspace: a file root not in the workspace', () => {
		const root = vscode.Uri.file('/a/b');
		assert.ok(canAddToWorkspace(root, undefined));
		assert.ok(canAddToWorkspace(root, [{ uri: vscode.Uri.file('/a') }]));
		assert.ok(!canAddToWorkspace(root, [{ uri: vscode.Uri.file('/a/b') }]));
		assert.ok(!canAddToWorkspace(vscode.Uri.parse('herdr-container://abcdefabcdef/a/b'), undefined));
		assert.ok(!canAddToWorkspace(vscode.Uri.parse('herdr-ssh://host/a/b'), undefined));
	});

	test('directories first, then files, each alphabetical', () => {
		const { Directory: D, File: F, SymbolicLink: L } = vscode.FileType;
		assert.deepStrictEqual(
			sortEntries([
				['b.txt', F],
				['Z', D],
				['a.txt', F],
				['link', D | L],
				['C.txt', F],
				['a', D],
			]).map((e) => e[0]),
			['a', 'link', 'Z', 'a.txt', 'b.txt', 'C.txt'],
		);
	});

	test('the Repo row offers what applies', () => {
		assert.strictEqual(rootContextValue({ canAdd: false, showable: false }), 'herdr.paneContext.root');
		assert.strictEqual(rootContextValue({ canAdd: true, showable: true }), 'herdr.paneContext.root addable showable');
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const whens = new Map((ext.packageJSON.contributes.menus['view/item/context'] as { command: string; when: string }[]).map((m) => [m.command, m.when]));
		const applies = (command: string, value: string) => new RegExp(/viewItem =~ \/(.*)\//.exec(whens.get(command)!)![1]).test(value);
		assert.ok(applies('herdr.paneContext.addToWorkspace', 'herdr.paneContext.root addable'));
		assert.ok(applies('herdr.paneContext.addToWorkspace', 'herdr.paneContext.root addable showable'));
		assert.ok(!applies('herdr.paneContext.addToWorkspace', 'herdr.paneContext.root showable'));
		assert.ok(applies('herdr.paneContext.showPane', 'herdr.paneContext.root addable showable'));
		assert.ok(applies('herdr.paneContext.showPane', 'herdr.paneContext.root showable'));
		assert.ok(!applies('herdr.paneContext.showPane', 'herdr.paneContext.root addable'));
		assert.ok(applies('herdr.paneContext.splitPane', 'herdr.paneContext.root'));

		// Open in Source Control on a file: repo; Terminal Here on this machine.
		assert.strictEqual(rootContextValue({ canAdd: true, showable: false, scm: true, terminal: true }), 'herdr.paneContext.root addable scm terminal');
		assert.strictEqual(rootContextValue({ canAdd: false, showable: true, scm: false, terminal: true }), 'herdr.paneContext.root showable terminal');
		assert.ok(applies('herdr.paneContext.openSourceControl', 'herdr.paneContext.root addable scm terminal'));
		assert.ok(applies('herdr.paneContext.openSourceControl', 'herdr.paneContext.root scm'));
		assert.ok(!applies('herdr.paneContext.openSourceControl', 'herdr.paneContext.root showable terminal'));
		assert.ok(applies('herdr.paneContext.openTerminal', 'herdr.paneContext.root scm terminal'));
		assert.ok(applies('herdr.paneContext.openTerminal', 'herdr.paneContext.root terminal'));
		assert.ok(!applies('herdr.paneContext.openTerminal', 'herdr.paneContext.root addable scm'));
		assert.ok(applies('herdr.paneContext.openChanges', 'herdr.paneContext.change'));
		assert.ok(applies('herdr.paneContext.openChanges', 'herdr.paneContext.sinceChange'));
		assert.ok(!applies('herdr.paneContext.openChanges', 'herdr.paneContext.since'));
		assert.strictEqual(whens.get('herdr.paneContext.resetBaseline'), 'view == herdr.paneContext && viewItem == herdr.paneContext.since');

		// Inline order on the Repo row, and none of these in the Command Palette.
		const menus = ext.packageJSON.contributes.menus as Record<string, { command: string; when: string; group?: string }[]>;
		const groups = new Map(menus['view/item/context'].filter((m) => m.group?.startsWith('inline')).map((m) => [m.command, m.group]));
		assert.deepStrictEqual(
			['addToWorkspace', 'openSourceControl', 'openTerminal', 'splitPane', 'showPane'].map((c) => groups.get(`herdr.paneContext.${c}`)),
			['inline@1', 'inline@2', 'inline@3', 'inline@4', 'inline@5'],
		);
		for (const c of ['resetBaseline', 'openSourceControl', 'openTerminal']) {
			assert.strictEqual(menus.commandPalette.find((m) => m.command === `herdr.paneContext.${c}`)?.when, 'false', c);
		}
	});

	test('other panes: the worktree marker before the description', () => {
		assert.strictEqual(markedDescription('same worktree', '✳ Refactoring auth'), 'same worktree · ✳ Refactoring auth');
		assert.strictEqual(markedDescription('other worktree', undefined), 'other worktree');
		assert.strictEqual(markedDescription('other worktree', ''), 'other worktree');
		assert.strictEqual(markedDescription(undefined, '/x'), '/x');
	});
});

class FakeModel {
	readonly changed = new vscode.EventEmitter<void>();
	readonly events = new vscode.EventEmitter<{ sessionKey: string; event: HerdrEvent }>();
	readonly onDidChange = this.changed.event;
	readonly onDidEvent = this.events.event;
	readonly snapshots = new Map<string, Snapshot>();
	readonly requests: { key: string; method: string; params: unknown }[] = [];
	/** What `pane.get` says the pane's directory is. */
	liveDir: string | undefined;
	refreshes = 0;
	readonly env: Environment = { key: 'host', kind: 'host', label: 'this machine', shell: new LocalShell() };

	connection(key: string): SessionConnection | undefined {
		const snap = this.snapshots.get(key);
		return (
			snap &&
			({
				state: 'connected',
				snapshot: snap,
				name: key.split('/').pop(),
				env: this.env,
				refresh: () => {
					this.refreshes++;
				},
			} as unknown as SessionConnection)
		);
	}

	request(key: string, method: string, params: unknown): Promise<unknown> {
		this.requests.push({ key, method, params });
		if (method === 'pane.get') {
			return Promise.resolve(this.liveDir ? { type: 'pane_info', pane: { foreground_cwd: this.liveDir } } : {});
		}
		if (method === 'pane.split') {
			return Promise.resolve({ type: 'pane_info' });
		}
		return Promise.reject(new Error(`unexpected ${method}`));
	}
}

class FakeHost {
	message: string | undefined;
	visibleNow = true;
	readonly revealed: unknown[] = [];
	private readonly visibility = new vscode.EventEmitter<vscode.TreeViewVisibilityChangeEvent>();
	readonly onDidChangeVisibility = this.visibility.event;

	get visible(): boolean {
		return this.visibleNow;
	}

	reveal(element: unknown): Promise<void> {
		this.revealed.push(element);
		return Promise.resolve();
	}

	fireVisibility(): void {
		this.visibility.fire({ visible: this.visibleNow });
	}

	dispose(): void {
		this.visibility.dispose();
	}
}

/** A snapshot of two spaces with these panes' directories. */
function twoPanes(dir1: string, dir2: string, focused = 'w2:p1'): Snapshot {
	const s = snapshot();
	s.focusedPaneId = focused;
	s.panes[0].foreground_cwd = dir1;
	s.panes[0].cwd = dir1;
	s.panes[1].foreground_cwd = dir2;
	s.panes[1].cwd = dir2;
	return s;
}

suite('pane context: the view over a temp repo', function () {
	this.timeout(30000);
	const S = 'host/a';
	let dir: string;
	let other: string;
	let model: FakeModel;
	let host: FakeHost;
	let focus: FocusTracker;
	let selected: string | undefined;
	let selection: vscode.EventEmitter<void>;
	let shown: Set<string>;
	let tiles: vscode.EventEmitter<void>;
	let links: vscode.EventEmitter<{ paneKey: string; text: string }>;
	let view: PaneContextView;
	let memento: BaselineMemento;
	let decorated: (RepoDecorations | undefined)[];
	let now: number;
	let logged: string[];

	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

	function makeView(): PaneContextView {
		return new PaneContextView({
			model: model as unknown as SessionModel,
			focus,
			sessions: {
				get selected() {
					return selected;
				},
				onDidChangeSelected: selection.event,
			},
			panels: { showsPane: (s, p) => shown.has(makePaneKey(s, p)), onDidChangeTiles: tiles.event, onDidRequestLink: links.event },
			paths: {
				mounts: async () => [],
				uriFor: async (_env, file) => vscode.Uri.file(file),
				home: async () => other,
			},
			createHost: () => host as unknown as PaneContextHost,
			log: (line) => logged.push(line),
			baselines: new BaselineStore(memento),
			decorations: { set: (repo) => decorated.push(repo) },
			now: () => now,
		});
	}

	const roots = () => view.getChildren();
	const rootRow = async () => (await roots())[0] as RootNode;
	const group = async (name: GroupNode['group']) => (await roots()).find((n) => n.type === 'group' && n.group === name) as GroupNode | undefined;
	const labels = (nodes: PaneContextNode[]) => nodes.map((n) => (n.type === 'entry' ? n.name : (n as RootNode).label));
	const rootIs = (name: string) => waitFor(`root ${name}`, async () => (await rootRow())?.label === name);

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ctx-')));
		other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ctx-other-')));
		git(dir, 'init', '-q', '-b', 'main');
		git(dir, 'config', 'user.email', 't@example.invalid');
		git(dir, 'config', 'user.name', 'T');
		fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'head\nline two\nline three\n');
		fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
		fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
		git(dir, 'add', '.');
		git(dir, 'commit', '-q', '-m', 'one');
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'working\nline two\nline three\n');
		fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
		fs.rmSync(path.join(dir, 'gone.txt'));
		fs.mkdirSync(path.join(dir, 'fresh'));
		fs.writeFileSync(path.join(dir, 'fresh', 'x'), 'x');
		fs.writeFileSync(path.join(other, 'plain.txt'), 'p\n');

		model = new FakeModel();
		model.snapshots.set(S, twoPanes(dir, other));
		host = new FakeHost();
		focus = new FocusTracker(model as unknown as SessionModel, () => 'row');
		selected = S;
		selection = new vscode.EventEmitter<void>();
		shown = new Set();
		tiles = new vscode.EventEmitter<void>();
		links = new vscode.EventEmitter<{ paneKey: string; text: string }>();
		memento = memoryMemento();
		decorated = [];
		logged = [];
		now = new Date(2026, 9, 31, 10, 31).getTime();
	});

	teardown(async () => {
		view?.dispose();
		focus.dispose();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(other, { recursive: true, force: true });
	});

	test('no followed pane: the message, and no rows', async () => {
		selected = undefined;
		view = makeView();
		assert.strictEqual(host.message, NO_PANE_MESSAGE);
		assert.deepStrictEqual(await roots(), []);
	});

	test("the repo, branch, changes and tree of herdr's focused pane", async () => {
		view = makeView();
		assert.strictEqual(host.message, 'api-fixer · api › main · not open in a tile');
		await rootIs(path.basename(dir));
		const root = await rootRow();
		assert.strictEqual(root.description, '⎇ main · ● 4');
		assert.strictEqual(paneContextItem(root).contextValue, 'herdr.paneContext.root addable showable scm terminal');
		assert.deepStrictEqual((paneContextItem(root).iconPath as vscode.ThemeIcon).id, 'repo');

		const changes = (await view.getChildren(await group('changes'))) as ChangeNode[];
		assert.deepStrictEqual(
			changes.map((c) => [c.label, c.description]).sort(),
			[
				['a.ts', 'src · M'],
				['fresh', '??'],
				['gone.txt', 'D'],
				['new.txt', '??'],
			].sort(),
		);
		const a = changes.find((c) => c.label === 'a.ts')!;
		assert.strictEqual(a.uri.fsPath, path.join(dir, 'src', 'a.ts'));
		const aItem = paneContextItem(a);
		assert.strictEqual(aItem.command?.command, 'vscode.open');
		assert.strictEqual(aItem.contextValue, 'herdr.paneContext.change');
		assert.strictEqual(a.headUri.toString(), a.headUri.with({ query: 'HEAD' }).toString());
		assert.strictEqual(a.headUri.authority, 'host');
		assert.strictEqual(a.headUri.path, path.join(dir, 'src', 'a.ts'));
		// A wholly untracked directory is one path: nothing to open as a file.
		const fresh = changes.find((c) => c.label === 'fresh')!;
		assert.strictEqual(paneContextItem(fresh).command, undefined);
		// A deleted file opens as HEAD has it.
		const gone = changes.find((c) => c.label === 'gone.txt')!;
		assert.strictEqual((paneContextItem(gone).command!.arguments![0] as vscode.Uri).scheme, 'herdr-git');

		const files = (await view.getChildren(await group('files'))) as EntryNode[];
		assert.deepStrictEqual(labels(files), ['.git', 'fresh', 'src', 'new.txt', 'README.md']);
		const src = files.find((f) => f.name === 'src')!;
		assert.strictEqual(paneContextItem(src).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.strictEqual(paneContextItem(src).command, undefined);
		const nested = (await view.getChildren(src)) as EntryNode[];
		assert.deepStrictEqual(labels(nested), ['deep', 'a.ts']);
		assert.strictEqual(view.getParent(nested[0]), src);
		const readme = paneContextItem(files.find((f) => f.name === 'README.md')!);
		assert.strictEqual((readme.resourceUri as vscode.Uri).fsPath, path.join(dir, 'README.md'));
		assert.strictEqual(readme.command?.command, 'vscode.open');

		const panes = (await view.getChildren(await group('panes'))) as PaneRowNode[];
		assert.deepStrictEqual(panes.map((p) => p.ref.paneId), ['w2:p2'], 'the same space, without the pane itself');
		assert.strictEqual(panes[0].description, other);
		assert.strictEqual(paneContextItem(panes[0]).command?.command, 'herdr.addToLayout');
		assert.strictEqual(paneContextItem((await group('panes'))!).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.strictEqual(paneContextItem((await group('files'))!).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
	});

	test('not a repo: the directory is the root, with no Changes', async () => {
		model.snapshots.set(S, twoPanes(other, dir));
		view = makeView();
		await rootIs(path.basename(other));
		const root = await rootRow();
		assert.strictEqual(root.description, undefined);
		assert.strictEqual((paneContextItem(root).iconPath as vscode.ThemeIcon).id, 'folder');
		assert.strictEqual(await group('changes'), undefined);
		assert.deepStrictEqual(labels(await view.getChildren(await group('files'))), ['plain.txt']);
	});

	test('a directory it cannot read says why, rather than failing', async () => {
		const missing = path.join(other, 'missing');
		model.snapshots.set(S, twoPanes(missing, dir));
		view = makeView();
		await rootIs('missing');
		const rows = await view.getChildren(await group('files'));
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].type, 'note');
	});

	test('follows herdr focus until a tile is focused, then only tiles; a pin holds', async () => {
		view = makeView();
		await rootIs(path.basename(dir));

		// Rule 2: herdr's focus moves, the view follows.
		model.snapshots.set(S, twoPanes(dir, other, 'w2:p2'));
		model.changed.fire();
		await rootIs(path.basename(other));
		assert.strictEqual(view.followed, makePaneKey(S, 'w2:p2'));

		// A tile gets focus: rule 1 from now on.
		focus.set(S, 'w2:p1');
		await rootIs(path.basename(dir));
		model.snapshots.set(S, twoPanes(dir, other, 'w2:p2'));
		model.changed.fire();
		await sleep(50);
		assert.strictEqual(view.followed, makePaneKey(S, 'w2:p1'), 'herdr focus no longer counts');

		// Pinned: another tile does not move it, until Unpin.
		view.pin();
		assert.ok(view.pinned);
		assert.match(String(host.message), / · pinned/);
		focus.set(S, 'w2:p2');
		await sleep(50);
		assert.strictEqual(view.followed, makePaneKey(S, 'w2:p1'));
		assert.strictEqual((await rootRow()).label, path.basename(dir));
		view.unpin();
		assert.ok(!view.pinned);
		assert.strictEqual(view.followed, makePaneKey(S, 'w2:p2'));
		await rootIs(path.basename(other));
	});

	test('a changed selected session changes the followed pane, before any tile', async () => {
		selected = undefined;
		view = makeView();
		assert.strictEqual(view.followed, undefined);
		selected = S;
		selection.fire();
		assert.strictEqual(view.followed, makePaneKey(S, 'w2:p1'));
		await rootIs(path.basename(dir));
	});

	test('a pinned or focused pane follows a move to another workspace', async () => {
		view = makeView();
		focus.set(S, 'w2:p1');
		view.pin();
		const moved = { event: 'pane.moved', data: { previous_pane_id: 'w2:p1', pane: { pane_id: 'w9:p1' } } } as HerdrEvent;
		model.events.fire({ sessionKey: S, event: moved });
		assert.strictEqual(view.followed, makePaneKey(S, 'w9:p1'));
		assert.strictEqual(focus.lastFocused, makePaneKey(S, 'w9:p1'));
		view.unpin();
		assert.strictEqual(view.followed, makePaneKey(S, 'w9:p1'));
	});

	test('the pane going away: the message comes back, a pin stays', async () => {
		view = makeView();
		focus.set(S, 'w2:p1');
		await rootIs(path.basename(dir));
		view.pin();
		const without = twoPanes(dir, other);
		without.panes.splice(0, 1);
		model.snapshots.set(S, without);
		model.changed.fire();
		assert.deepStrictEqual(await roots(), []);
		assert.match(String(host.message), /pinned pane is not available/);
		view.unpin();
		assert.strictEqual(host.message, NO_PANE_MESSAGE);
	});

	test('a tile showing it changes the header and the Show Pane offer', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		assert.ok((await rootRow()).showable);
		shown.add(makePaneKey(S, 'w2:p1'));
		tiles.fire();
		assert.strictEqual(host.message, 'api-fixer · api › main');
		assert.ok(!(await rootRow()).showable);
	});

	test('Other Panes follows the snapshot, without touching the rest of the tree', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const panes = (await group('panes'))!;
		await view.getChildren(panes);
		const fires: unknown[] = [];
		const listener = view.onDidChangeTreeData((e) => fires.push(e));
		const renamed = twoPanes(dir, other);
		renamed.panes[1].label = 'renamed';
		model.snapshots.set(S, renamed);
		model.changed.fire();
		assert.strictEqual(fires[0], panes);
		const count = fires.length;
		model.changed.fire();
		assert.strictEqual(fires.length, count, 'the same rows: nothing');
		listener.dispose();
		assert.strictEqual(((await view.getChildren(panes))[0] as PaneRowNode).label, 'renamed');
	});

	test('Split Pane Here asks herdr for exactly that', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		await view.splitPane();
		assert.deepStrictEqual(model.requests.filter((r) => r.method === 'pane.split'), [
			{ key: S, method: 'pane.split', params: { target_pane_id: 'w2:p1', direction: 'down', cwd: dir, focus: false } },
		]);
	});

	test('poll: new status updates the row; a directory herdr reports no event for is followed', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		fs.writeFileSync(path.join(dir, 'another.txt'), 'x');
		await view.poll();
		assert.strictEqual((await rootRow()).description, '⎇ main · ● 5');
		const fires: unknown[] = [];
		const listener = view.onDidChangeTreeData((e) => fires.push(e));
		await view.poll();
		assert.strictEqual(fires.length, 0, 'nothing new, no tree refresh');
		listener.dispose();

		assert.strictEqual(model.refreshes, 0);
		model.liveDir = other;
		await view.poll();
		assert.strictEqual(model.refreshes, 1, 'pane.get said so: a new snapshot');
		model.snapshots.set(S, twoPanes(other, dir));
		model.changed.fire();
		await rootIs(path.basename(other));
	});

	test('a hidden view does not load or poll, and catches up when shown', async () => {
		host.visibleNow = false;
		view = makeView();
		await sleep(100);
		assert.deepStrictEqual(await roots(), []);
		assert.deepStrictEqual(model.requests, []);
		assert.strictEqual(host.message, 'api-fixer · api › main · not open in a tile', 'the header does not wait');
		host.visibleNow = true;
		host.fireVisibility();
		await rootIs(path.basename(dir));
	});

	test('a host root refreshes from a file watcher', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const fired = new Promise<void>((resolve) => {
			const listener = view.onDidChangeTreeData(() => {
				listener.dispose();
				resolve();
			});
		});
		await sleep(500); // The watcher starts asynchronously.
		fs.writeFileSync(path.join(dir, 'watched.txt'), 'x');
		await Promise.race([fired, sleep(15000).then(() => assert.fail('no refresh from the watcher'))]);
		await waitFor('the new file in the status', async () => (await rootRow()).description === '⎇ main · ● 5');
	});

	test('Open Changes: HEAD against the working tree', async () => {
		const provider = vscode.workspace.registerTextDocumentContentProvider('herdr-ctx-test', { provideTextDocumentContent: () => 'head\n' });
		view = makeView();
		await rootIs(path.basename(dir));
		const changes = (await view.getChildren(await group('changes'))) as ChangeNode[];
		const a = changes.find((c) => c.label === 'a.ts')!;
		await view.openChanges({ ...a, headUri: a.headUri.with({ scheme: 'herdr-ctx-test' }) });
		const tab = await waitFor('the diff tab', () => vscode.window.tabGroups.activeTabGroup.activeTab);
		assert.strictEqual(tab.label, 'a.ts (HEAD ↔ working tree)');
		assert.ok(tab.input instanceof vscode.TabInputTextDiff);
		assert.strictEqual((tab.input as vscode.TabInputTextDiff).modified.fsPath, path.join(dir, 'src', 'a.ts'));
		provider.dispose();
	});

	test('new file and folder, rename and delete, in the temp repo', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const root = vscode.Uri.file(dir);
		const made = await view.createEntry(root, 'made.txt', 'file');
		assert.ok(made);
		assert.strictEqual(fs.readFileSync(path.join(dir, 'made.txt'), 'utf8'), '');
		fs.writeFileSync(path.join(dir, 'made.txt'), 'keep me');
		assert.strictEqual(await view.createEntry(root, 'made.txt', 'file'), undefined, 'an existing name is not overwritten');
		assert.strictEqual(fs.readFileSync(path.join(dir, 'made.txt'), 'utf8'), 'keep me');
		assert.ok(await view.createEntry(root, 'made-dir', 'folder'));
		assert.ok(fs.statSync(path.join(dir, 'made-dir')).isDirectory());
		assert.ok(await view.renameEntry(made, 'renamed.txt'));
		assert.ok(fs.existsSync(path.join(dir, 'renamed.txt')));
		assert.ok(!fs.existsSync(path.join(dir, 'made.txt')));
		assert.ok(await view.deleteEntry(vscode.Uri.file(path.join(dir, 'renamed.txt'))));
		assert.ok(await view.deleteEntry(vscode.Uri.file(path.join(dir, 'made-dir'))));
		assert.ok(!fs.existsSync(path.join(dir, 'renamed.txt')));
		assert.ok(!fs.existsSync(path.join(dir, 'made-dir')));
	});

	// ── Pane changes: since a baseline, markers, repo actions ─────────────────

	const sinceRows = async () => view.getChildren(await group('since'));
	const store = () => new BaselineStore(memento);
	const P1 = makePaneKey(S, 'w2:p1');

	test('sections in order; a baseline on first follow; nothing changed since; All Changes collapsed', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const top = await roots();
		assert.deepStrictEqual(
			top.map((n) => (n.type === 'group' ? n.label : n.type)),
			['root', 'Changed in This Pane', 'All Changes', 'Files', 'Other Panes in This Space'],
		);
		const since = (await group('since'))!;
		assert.strictEqual(since.description, 'since 10:31');
		assert.strictEqual(paneContextItem(since).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		assert.strictEqual(paneContextItem(since).contextValue, 'herdr.paneContext.since');
		const rows = await view.getChildren(since);
		assert.deepStrictEqual(rows.map((r) => [r.type, (r as { label: string }).label]), [['note', 'No changes since 10:31']]);
		assert.strictEqual(paneContextItem(rows[0]).iconPath, undefined);
		assert.strictEqual(paneContextItem(rows[0]).command, undefined);
		const all = (await group('changes'))!;
		assert.strictEqual(all.description, '4');
		assert.strictEqual(paneContextItem(all).description, '4');
		assert.strictEqual(paneContextItem(all).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.strictEqual(paneContextItem(all).contextValue, 'herdr.paneContext.changes');
		const stored = store().get(P1, dir)!;
		assert.strictEqual(stored.at, now);
		assert.strictEqual(stored.head, git(dir, 'rev-parse', 'HEAD').trim());
		assert.match(stored.tree, /^[0-9a-f]{40}$/);

		// Outside a repo: no change sections.
		view.dispose();
		model.snapshots.set(S, twoPanes(other, dir));
		view = makeView();
		await rootIs(path.basename(other));
		assert.deepStrictEqual((await roots()).map((n) => (n.type === 'group' ? n.label : n.type)), ['root', 'Files', 'Other Panes in This Space']);
		assert.strictEqual(decorated[decorated.length - 1], undefined, 'no markers outside a repo');
	});

	test('changes after following are in Changed in This Pane, earlier ones are not; commits; markers', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		fs.writeFileSync(path.join(dir, 'src', 'later.ts'), 'x');
		fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
		fs.rmSync(path.join(dir, 'new.txt')); // untracked at the baseline
		await view.poll();
		const rows = (await sinceRows()) as SinceNode[];
		assert.deepStrictEqual(
			rows.map((r) => [r.label, r.description, r.status]),
			[
				['README.md', undefined, 'M'],
				['new.txt', undefined, 'D'],
				['later.ts', 'src', 'A'],
			],
		);
		assert.ok(!rows.some((r) => r.label === 'a.ts'), 'changed before following: only in All Changes');
		const later = rows[2];
		const item = paneContextItem(later);
		assert.strictEqual((item.resourceUri as vscode.Uri).fragment, 'herdr-since');
		assert.strictEqual((item.resourceUri as vscode.Uri).with({ fragment: '' }).fsPath, path.join(dir, 'src', 'later.ts'));
		assert.strictEqual(item.contextValue, 'herdr.paneContext.sinceChange');
		assert.strictEqual(item.command?.command, 'vscode.open');
		const opened = item.command!.arguments![0] as vscode.Uri;
		assert.strictEqual(opened.toString(), vscode.Uri.file(path.join(dir, 'src', 'later.ts')).toString(), 'the plain URI, no fragment');
		assert.strictEqual(item.tooltip, `${dir}/src/later.ts · Added since 10:31`);
		assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, vscode.ThemeIcon.File.id);
		const gone = paneContextItem(rows[1]).command!.arguments![0] as vscode.Uri;
		assert.strictEqual(gone.scheme, 'herdr-git', 'a deleted row opens the baseline version');
		assert.strictEqual(gone.query, store().get(P1, dir)!.tree);
		assert.strictEqual((await group('since'))!.description, 'since 10:31');

		const last = decorated[decorated.length - 1]!;
		assert.ok(last.status.some((c) => c.uri.fsPath === path.join(dir, 'src', 'a.ts') && c.xy === ' M'));
		assert.deepStrictEqual(last.untrackedDirs.map((u) => u.fsPath), [path.join(dir, 'fresh')]);
		assert.deepStrictEqual(
			last.since.map((c) => [path.basename(c.uri.path), c.status, c.uri.fragment]),
			[
				['README.md', 'M', 'herdr-since'],
				['new.txt', 'D', 'herdr-since'],
				['later.ts', 'A', 'herdr-since'],
			],
		);
		assert.strictEqual(last.sinceTime, '10:31');

		git(dir, 'add', 'src/later.ts');
		git(dir, 'commit', '-q', '-m', 'two');
		await view.poll();
		assert.strictEqual((await group('since'))!.description, 'since 10:31 · 1 commit');
		assert.ok(((await sinceRows()) as SinceNode[]).some((r) => r.label === 'later.ts'), 'committed changes are still changes since');
		git(dir, 'commit', '-q', '--allow-empty', '-m', 'three');
		await view.poll();
		assert.strictEqual((await group('since'))!.description, 'since 10:31 · 2 commits');
	});

	test('the baseline survives a reload (a new view on the same memento); Reset Baseline replaces it', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		fs.writeFileSync(path.join(dir, 'later.txt'), 'x');
		view.dispose();
		now += 60 * 60 * 1000;
		view = makeView();
		await rootIs(path.basename(dir));
		assert.strictEqual((await group('since'))!.description, 'since 10:31');
		assert.deepStrictEqual(((await sinceRows()) as SinceNode[]).map((r) => r.label), ['later.txt']);
		const before = store().get(P1, dir)!;
		await view.resetBaseline();
		assert.strictEqual((await group('since'))!.description, 'since 11:31');
		assert.deepStrictEqual((await sinceRows()).map((r) => (r as { label: string }).label), ['No changes since 11:31']);
		const after = store().get(P1, dir)!;
		assert.strictEqual(after.at, now);
		assert.notStrictEqual(after.tree, before.tree);
		assert.deepStrictEqual(store().keys(), [`${P1}\n${dir}`]);
	});

	test('a baseline git has pruned is replaced by a new one, and says so', async () => {
		await store().set(P1, dir, { tree: 'f'.repeat(40), head: '', at: now - 1000 });
		view = makeView();
		await rootIs(path.basename(dir));
		const stored = store().get(P1, dir)!;
		assert.notStrictEqual(stored.tree, 'f'.repeat(40));
		assert.strictEqual(stored.at, now);
		assert.ok(logged.includes(`pane context: baseline for ${dir} was lost; recorded a new one`), logged.join('\n'));
		assert.deepStrictEqual((await sinceRows()).map((r) => (r as { label: string }).label), ['No changes since 10:31']);
	});

	test('a snapshot that fails: one warning row', async () => {
		const local = new LocalShell();
		const failing: RemoteShell = {
			run: (argv, o) => (argv[0] === 'sh' ? Promise.resolve({ exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('\nfatal: boom\nmore\n') }) : local.run(argv, o)),
			spawn: () => local.spawn([]),
		};
		(model as unknown as { env: Environment }).env = { ...model.env, shell: failing };
		view = makeView();
		await rootIs(path.basename(dir));
		assert.strictEqual((await group('since'))!.description, undefined);
		const rows = await sinceRows();
		assert.deepStrictEqual(rows.map((r) => (r as { label: string }).label), ['Could not record a baseline: fatal: boom']);
		assert.strictEqual((paneContextItem(rows[0]).iconPath as vscode.ThemeIcon).id, 'warning');
		assert.deepStrictEqual(store().keys(), []);
	});

	test('Open Changes on a since row: the baseline against the working tree', async () => {
		const provider = vscode.workspace.registerTextDocumentContentProvider('herdr-ctx-since', { provideTextDocumentContent: () => 'working\n' });
		view = makeView();
		await rootIs(path.basename(dir));
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'again\n');
		await view.poll();
		const a = ((await sinceRows()) as SinceNode[]).find((r) => r.label === 'a.ts')!;
		assert.strictEqual(a.status, 'M');
		assert.strictEqual(a.baseUri.query, store().get(P1, dir)!.tree);
		await view.openChanges({ ...a, baseUri: a.baseUri.with({ scheme: 'herdr-ctx-since' }) });
		const tab = await waitFor('the diff tab', () => vscode.window.tabGroups.activeTabGroup.activeTab);
		assert.strictEqual(tab.label, 'a.ts (since 10:31 ↔ working tree)');
		assert.ok(tab.input instanceof vscode.TabInputTextDiff);
		assert.strictEqual((tab.input as vscode.TabInputTextDiff).modified.toString(), vscode.Uri.file(path.join(dir, 'src', 'a.ts')).toString());
		provider.dispose();
	});

	test('pane.moved moves the baselines; a closed pane loses them while its session is connected', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const baseline = store().get(P1, dir);
		model.events.fire({ sessionKey: S, event: { event: 'pane.moved', data: { previous_pane_id: 'w2:p1', pane: { pane_id: 'w9:p1' } } } as HerdrEvent });
		await sleep(10);
		assert.deepStrictEqual(store().get(makePaneKey(S, 'w9:p1'), dir), baseline);
		const without = twoPanes(dir, other);
		without.panes.splice(0, 1);
		model.snapshots.set(S, without);
		model.changed.fire();
		await sleep(10);
		assert.deepStrictEqual(store().keys(), [], 'neither w2:p1 nor w9:p1 is in the snapshot');
	});

	test('Terminal Here: a terminal editor in the root, named after it', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const terminal = view.openTerminal()!;
		try {
			const options = terminal.creationOptions as vscode.TerminalOptions;
			assert.strictEqual(options.name, path.basename(dir));
			assert.strictEqual(options.cwd, dir);
			assert.strictEqual(options.location, vscode.TerminalLocation.Editor);
		} finally {
			terminal.dispose();
		}
	});

	test("Open in Source Control: VS Code's Git has the temp repo afterwards", async () => {
		const ext = vscode.extensions.getExtension<{ getAPI(v: 1): { getRepository(uri: vscode.Uri): unknown } }>('vscode.git');
		assert.ok(ext, 'the test host has vscode.git');
		view = makeView();
		await rootIs(path.basename(dir));
		await view.openSourceControl();
		const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
		assert.ok(api.getRepository(vscode.Uri.file(dir)));
		assert.ok(api.getRepository(vscode.Uri.file(path.join(dir, 'src', 'a.ts'))));
	});

	test('Other Panes: same worktree, other worktree, none', async () => {
		model.snapshots.set(S, twoPanes(dir, path.join(dir, 'src')));
		view = makeView();
		await rootIs(path.basename(dir));
		let panes = (await view.getChildren(await group('panes'))) as PaneRowNode[];
		assert.strictEqual(panes[0].description, `same worktree · ${path.join(dir, 'src')}`);
		view.dispose();

		const linked = path.join(other, 'linked');
		git(dir, 'worktree', 'add', '-q', linked);
		model.snapshots.set(S, twoPanes(dir, linked));
		view = makeView();
		await rootIs(path.basename(dir));
		panes = (await view.getChildren(await group('panes'))) as PaneRowNode[];
		assert.strictEqual(panes[0].description, `other worktree · ${linked}`);
		view.dispose();

		const plain = path.join(other, 'plain');
		fs.mkdirSync(plain);
		model.snapshots.set(S, twoPanes(dir, plain));
		view = makeView();
		await rootIs(path.basename(dir));
		panes = (await view.getChildren(await group('panes'))) as PaneRowNode[];
		assert.strictEqual(panes[0].description, plain, 'not comparable: unchanged');
	});

	suite('links', () => {
		const pk = makePaneKey(S, 'w2:p1');
		const activeFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

		test('relative, with line and column: opens beside at that position', async () => {
			view = makeView();
			const before = vscode.window.activeTextEditor?.viewColumn ?? 1;
			links.fire({ paneKey: pk, text: 'src/a.ts:2:3' });
			await waitFor('the file', () => activeFile() === path.join(dir, 'src', 'a.ts'));
			const editor = vscode.window.activeTextEditor!;
			await waitFor('the selection', () => editor.selection.active.line === 1);
			assert.ok(editor.selection.isEmpty);
			assert.strictEqual(editor.selection.active.line, 1);
			assert.strictEqual(editor.selection.active.character, 2);
			assert.ok((editor.viewColumn ?? 1) >= before, 'beside');
			assert.strictEqual(editor.document.isDirty, false);
		});

		test('line only, ./relative, bare, and ~/', async () => {
			view = makeView();
			await view.openLink(pk, './src/a.ts:3');
			assert.strictEqual(activeFile(), path.join(dir, 'src', 'a.ts'));
			assert.strictEqual(vscode.window.activeTextEditor!.selection.active.line, 2);
			assert.strictEqual(vscode.window.activeTextEditor!.selection.active.character, 0);
			await view.openLink(pk, 'README.md');
			assert.strictEqual(activeFile(), path.join(dir, 'README.md'));
			await view.openLink(pk, '~/plain.txt'); // `paths.home` here is the other temp directory.
			assert.strictEqual(activeFile(), path.join(other, 'plain.txt'));
			await view.openLink(pk, path.join(dir, 'new.txt'));
			assert.strictEqual(activeFile(), path.join(dir, 'new.txt'));
		});

		test('a missing path does nothing', async () => {
			view = makeView();
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await view.openLink(pk, 'src/missing.ts:19');
			assert.strictEqual(vscode.window.activeTextEditor, undefined);
		});

		test('a directory under the root is revealed in Files; elsewhere nothing', async () => {
			view = makeView();
			await rootIs(path.basename(dir));
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await view.openLink(pk, 'src/deep');
			assert.strictEqual(vscode.window.activeTextEditor, undefined, 'no editor');
			const node = host.revealed[0] as EntryNode;
			assert.strictEqual(node.uri.fsPath, path.join(dir, 'src', 'deep'));
			assert.strictEqual((view.getParent(node) as EntryNode).name, 'src');
			assert.strictEqual((view.getParent(view.getParent(node)!) as GroupNode).label, 'Files');
			await view.openLink(pk, other);
			assert.strictEqual(host.revealed.length, 1);
		});
	});

	test('the real tree view takes the nodes: reveal walks through parents', async () => {
		let real: vscode.TreeView<PaneContextNode> | undefined;
		view = new PaneContextView({
			model: model as unknown as SessionModel,
			focus,
			sessions: {
				get selected() {
					return selected;
				},
				onDidChangeSelected: selection.event,
			},
			panels: { showsPane: () => true, onDidChangeTiles: tiles.event, onDidRequestLink: links.event },
			paths: { mounts: async () => [], uriFor: async (_e, f) => vscode.Uri.file(f), home: async () => undefined },
			createHost: (treeDataProvider) => {
				real = vscode.window.createTreeView('herdr.paneContext', { treeDataProvider });
				return real;
			},
			log: () => undefined,
		});
		await vscode.commands.executeCommand('herdr.paneContext.focus');
		await waitFor('visible', () => real?.visible);
		await rootIs(path.basename(dir));
		assert.strictEqual(real!.message, 'api-fixer · api › main');
		await view.revealDirectory(path.join(dir, 'src', 'deep'));
		await waitFor('selected', () => (real!.selection[0] as EntryNode | undefined)?.name === 'deep');
	});
});

suite('pane context: links from a real webview', function () {
	this.timeout(30000);
	const S = 'host/a';
	let panels: TilesPanels;
	let model: FakeModel;
	let focus: FocusTracker;
	let streams: PaneStreams;

	setup(() => {
		model = new FakeModel();
		model.snapshots.set(S, twoPanes('/nonexistent', '/nonexistent'));
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		streams = new PaneStreams(() => undefined, () => undefined);
		focus = new FocusTracker(model as unknown as SessionModel, () => 'row');
		const values = new Map<string, unknown>();
		const state: LayoutState = {
			get: (k) => values.get(k),
			update: (k, v) => {
				values.set(k, v);
				return Promise.resolve();
			},
		};
		panels = new TilesPanels({
			extensionUri: ext.extensionUri,
			model: model as unknown as SessionModel,
			streams,
			focus,
			layouts: new LayoutStore(state),
			rowLabel: () => 'row',
			log: () => undefined,
		});
	});

	teardown(() => {
		panels.dispose();
		focus.dispose();
		streams.dispose();
	});

	test('a printed path is a link on hover, and a click asks to open it; showsPane follows the tile', async () => {
		const seen: { paneKey: string; text: string }[] = [];
		panels.onDidRequestLink((l) => seen.push(l));
		let tileChanges = 0;
		panels.onDidChangeTiles(() => tileChanges++);
		const panel: LayoutPanel = panels.newLayout('links');
		assert.ok(!panels.showsPane(S, 'w2:p1'));
		panels.addToLayout(S, 'w2:p1');
		assert.ok(panels.showsPane(S, 'w2:p1'));
		assert.ok(tileChanges > 0);
		const paneKey = makePaneKey(S, 'w2:p1');
		await waitFor('the tile', async () => (await panel.probe()).tiles.find((t) => t.paneKey === paneKey && t.width > 0 && t.cols > 0));
		// Frames are how anything gets on screen; the stream is not running here, so this one comes from the test.
		const printed = '  see src/auth/middleware.ts:19 then http://x.y/z';
		panel.frame(paneKey, { full: true, cols: 80, rows: 10, bytes: Buffer.from(`\x1b[1;1H${printed}`).toString('base64') });
		await waitFor('the text', async () => (await panel.probe()).tiles[0].text.includes('middleware'));

		// Into the URL: no link.
		await panel.probe({ kind: 'hoverCell', paneKey, col: 42, row: 0 });
		await sleep(150);
		assert.strictEqual((await panel.probe()).tiles[0].overLink, false);

		// Over the path.
		await panel.probe({ kind: 'hoverCell', paneKey, col: 10, row: 0 });
		await waitFor('the pointer over the link', async () => (await panel.probe()).tiles[0].overLink);
		await panel.probe({ kind: 'clickCell', paneKey, col: 10, row: 0 });
		await waitFor('openLink', () => seen.length > 0);
		assert.deepStrictEqual(seen, [{ paneKey, text: 'src/auth/middleware.ts:19' }]);

		const disposed = tileChanges;
		panel.panel.dispose();
		assert.ok(!panels.showsPane(S, 'w2:p1'));
		assert.ok(tileChanges > disposed);
	});
});
