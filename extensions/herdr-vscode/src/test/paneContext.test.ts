import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HerdrEvent } from '../bridge';
import { RepoDecorations } from '../decorations';
import { Environment } from '../environments';
import { FocusTracker } from '../focus';
import {
	applyPaneFilesOnly,
	canAddToWorkspace,
	ChangeNode,
	CommitFileNode,
	CommitNode,
	commitDescription,
	EntryNode,
	followedPaneKey,
	GroupNode,
	NO_CHANGES,
	NO_PANE_MESSAGE,
	paneContextItem,
	PaneContextHost,
	paneHeaderDescription,
	PaneContextNode,
	PaneContextView,
	markedDescription,
	RootNode,
	rootContextValue,
	sortEntries,
	storedPaneFilesOnly,
	touchedChange,
} from '../paneContext';
import { LocalShell, RemoteShell } from '../remoteShell';
import { gitDescription } from '../spaceGit';
import { SessionConnection, SessionModel, Snapshot } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TilesPanels } from '../tilesPanel';
import { makePaneKey } from '../tilesProtocol';
import { memoryMemento, TouchedMemento, TouchedStore } from '../touched';
import { paneClickCommand } from '../views/spacesView';
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

	test('nothing to follow', () => {
		assert.strictEqual(followedPaneKey({}), undefined);
		assert.strictEqual(followedPaneKey({ selectedSession: S }), undefined);
		assert.strictEqual(followedPaneKey({ herdrFocused: 'w1:p1' }), undefined);
	});

	test('the header description', () => {
		const h = { name: 'Fixing the API', space: 'api', tab: 'main', shown: true };
		assert.strictEqual(paneHeaderDescription(h), 'Fixing the API · api › main');
		assert.strictEqual(paneHeaderDescription({ ...h, shown: false }), 'Fixing the API · api › main · not open in a tile');
	});

	test('Show Pane is a title action while a pane is followed; no pane-row menu entries', () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const menus = ext.packageJSON.contributes.menus as Record<string, { command: string; when: string; group?: string }[]>;
		const title = menus['view/title'].find((m) => m.command === 'herdr.paneContext.showPane')!;
		assert.strictEqual(title.when, 'view == herdr.paneContext && herdr.paneContext.following');
		assert.strictEqual(title.group, 'navigation@0');
		assert.ok(!menus['view/item/context'].some((m) => m.command === 'herdr.paneContext.showPane'));
		assert.ok(!/viewItem == 'herdr\.paneContext\.pane'/.test(JSON.stringify(menus)) && !JSON.stringify(menus).includes("herdr.paneContext.pane hidden"), 'no pane-row context values');
	});

	test('the Repo row description is the Spaces git format', () => {
		const git = (changed: number, ahead: number, behind: number) => ({ head: 'main', changes: Array.from({ length: changed }, () => ({ xy: ' M', path: 'x' })), ahead, behind });
		assert.strictEqual(gitDescription(git(0, 0, 0)), '⎇ main · clean');
		assert.strictEqual(gitDescription(git(3, 0, 0)), '⎇ main ● 3');
		assert.strictEqual(gitDescription(git(3, 1, 2)), '⎇ main ● 3 ↑1 ↓2');
		assert.strictEqual(gitDescription(git(0, 0, 2)), '⎇ main · clean ↓2');
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
		assert.strictEqual(rootContextValue({ canAdd: false }), 'herdr.paneContext.root');
		assert.strictEqual(rootContextValue({ canAdd: true }), 'herdr.paneContext.root addable');
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const whens = new Map((ext.packageJSON.contributes.menus['view/item/context'] as { command: string; when: string }[]).map((m) => [m.command, m.when]));
		const applies = (command: string, value: string) => new RegExp(/viewItem =~ \/(.*)\//.exec(whens.get(command)!)![1]).test(value);
		assert.ok(applies('herdr.paneContext.addToWorkspace', 'herdr.paneContext.root addable'));
		assert.ok(applies('herdr.paneContext.addToWorkspace', 'herdr.paneContext.root addable scm'));
		assert.ok(!applies('herdr.paneContext.addToWorkspace', 'herdr.paneContext.root scm'));

		// Open in Source Control on a file: repo.
		assert.strictEqual(rootContextValue({ canAdd: true, scm: true }), 'herdr.paneContext.root addable scm');
		assert.ok(applies('herdr.paneContext.openSourceControl', 'herdr.paneContext.root addable scm'));
		assert.ok(applies('herdr.paneContext.openSourceControl', 'herdr.paneContext.root scm'));
		assert.ok(!applies('herdr.paneContext.openSourceControl', 'herdr.paneContext.root addable'));
		// A click on a change row opens its diff; the inline action opens the file.
		assert.ok(!whens.has('herdr.paneContext.openChanges'));
		assert.ok(applies('herdr.paneContext.openFile', 'herdr.paneContext.change'));
		assert.ok(applies('herdr.paneContext.openFile', 'herdr.paneContext.commitFile'));
		assert.ok(!applies('herdr.paneContext.openFile', 'herdr.paneContext.commit'));
		assert.ok(!applies('herdr.paneContext.openFile', 'herdr.paneContext.changes'));
		assert.ok(!whens.has('herdr.paneContext.resetBaseline'));

		// Inline order on the Repo row, and none of these in the Command Palette.
		const menus = ext.packageJSON.contributes.menus as Record<string, { command: string; when: string; group?: string }[]>;
		const groups = new Map(menus['view/item/context'].filter((m) => m.group?.startsWith('inline')).map((m) => [m.command, m.group]));
		assert.deepStrictEqual(
			['addToWorkspace', 'openSourceControl'].map((c) => groups.get(`herdr.paneContext.${c}`)),
			['inline@1', 'inline@2'],
		);
		for (const c of ['showPaneFiles', 'showAllFiles', 'openSourceControl']) {
			assert.strictEqual(menus.commandPalette.find((m) => m.command === `herdr.paneContext.${c}`)?.when, 'false', c);
		}
	});

	test('the this-pane toggle: title bar, icons, palette; Reset Baseline is gone', async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const contributed = ext.packageJSON.contributes;
		const commands = contributed.commands as { command: string; title: string; icon?: string }[];
		const cmd = (c: string) => commands.find((x) => x.command === c);
		assert.deepStrictEqual([cmd('herdr.paneContext.showPaneFiles')?.title, cmd('herdr.paneContext.showPaneFiles')?.icon], ["Show Only This Pane's Changes", '$(filter)']);
		assert.deepStrictEqual([cmd('herdr.paneContext.showAllFiles')?.title, cmd('herdr.paneContext.showAllFiles')?.icon], ['Show All Changes', '$(filter-filled)']);
		const title = contributed.menus['view/title'] as { command: string; when: string; group: string }[];
		const at = (c: string) => title.find((m) => m.command === c)!;
		assert.strictEqual(at('herdr.paneContext.showPaneFiles').when, 'view == herdr.paneContext && !herdr.paneContext.paneFilesOnly');
		assert.strictEqual(at('herdr.paneContext.showAllFiles').when, 'view == herdr.paneContext && herdr.paneContext.paneFilesOnly');
		assert.match(at('herdr.paneContext.showPaneFiles').group, /^navigation/);
		assert.match(at('herdr.paneContext.showAllFiles').group, /^navigation/);
		assert.strictEqual(cmd('herdr.paneContext.resetBaseline'), undefined, 'not contributed');
		const everywhere = JSON.stringify(contributed.menus);
		assert.ok(!everywhere.includes('resetBaseline'));
		await ext.activate();
		const registered = new Set(await vscode.commands.getCommands(true));
		assert.ok(!registered.has('herdr.paneContext.resetBaseline'), 'not registered');
		assert.ok(registered.has('herdr.paneContext.showPaneFiles') && registered.has('herdr.paneContext.showAllFiles'));
		// The real commands run (nothing followed in the test host); off again afterwards.
		await vscode.commands.executeCommand('herdr.paneContext.showPaneFiles');
		await vscode.commands.executeCommand('herdr.paneContext.showAllFiles');
	});

	test('the toggle flips the view, the workspaceState value and the context key', async () => {
		const memento = memoryMemento();
		const contexts: [string, boolean][] = [];
		const modes: boolean[] = [];
		const view = { setPaneFilesOnly: (on: boolean) => modes.push(on) };
		assert.strictEqual(storedPaneFilesOnly(memento), false, 'default off');
		await applyPaneFilesOnly(true, view, memento, async (k, v) => contexts.push([k, v]));
		assert.strictEqual(memento.get('herdr.paneContext.paneFilesOnly'), true);
		assert.strictEqual(storedPaneFilesOnly(memento), true);
		await applyPaneFilesOnly(false, view, memento, async (k, v) => contexts.push([k, v]));
		assert.strictEqual(memento.get('herdr.paneContext.paneFilesOnly'), false);
		assert.deepStrictEqual(modes, [true, false]);
		assert.deepStrictEqual(contexts, [
			['herdr.paneContext.paneFilesOnly', true],
			['herdr.paneContext.paneFilesOnly', false],
		]);
	});

	test('an untracked directory row counts as touched when a touched path is under it', () => {
		const t = new Set(['fresh/x', 'src/a.ts']);
		assert.ok(touchedChange('src/a.ts', t));
		assert.ok(!touchedChange('src/b.ts', t));
		assert.ok(touchedChange('fresh/', t));
		assert.ok(!touchedChange('fre/', t));
		assert.ok(!touchedChange('src', t), 'a file named like a directory is not one');
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
		if (method === 'tab.focus') {
			return Promise.resolve({ type: 'ok' });
		}
		if (method === 'layout.export') {
			// The tab's panes side by side.
			const tabId = (params as { tab_id: string }).tab_id;
			const panes = this.snapshots.get(key)?.panes.filter((p) => p.tab_id === tabId) ?? [];
			if (panes.length === 0) {
				return Promise.reject(new Error('layout_not_found'));
			}
			const leaf = (id: string): unknown => ({ type: 'pane', pane_id: id });
			const root = panes
				.slice(1)
				.reduce((first, p) => ({ type: 'split', direction: 'right', ratio: 0.5, first, second: leaf(p.pane_id) }), leaf(panes[0].pane_id));
			return Promise.resolve({ type: 'layout_export', layout: { tab_id: tabId, workspace_id: panes[0].workspace_id, zoomed: false, root } });
		}
		return Promise.reject(new Error(`unexpected ${method}`));
	}
}

class FakeHost {
	message: string | undefined;
	/** Every value the view set as the description. */
	readonly descriptions: (string | undefined)[] = [];
	private descriptionNow: string | undefined;

	get description(): string | undefined {
		return this.descriptionNow;
	}

	set description(value: string | undefined) {
		this.descriptionNow = value;
		this.descriptions.push(value);
	}
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
	let memento: TouchedMemento;
	let touched: TouchedStore;
	let paneFilesOnly: boolean;
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
			touched,
			paneFilesOnly,
			decorations: { set: (repo) => decorated.push(repo) },
			now: () => now,
		});
	}

	const roots = () => view.getChildren();
	const rootRow = async () => (await roots()).find((n) => n.type === 'root') as RootNode;
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
		touched = new TouchedStore(memento);
		paneFilesOnly = false;
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
		assert.strictEqual(host.message, undefined, 'no header while a pane is followed');
		await rootIs(path.basename(dir));
		const root = await rootRow();
		assert.strictEqual(root.description, '⎇ main ● 4');
		assert.strictEqual(paneContextItem(root).contextValue, 'herdr.paneContext.root addable scm');
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
		assert.strictEqual(aItem.command?.command, 'herdr.paneContext.openChanges');
		assert.strictEqual(aItem.command?.arguments?.[0], a);
		assert.strictEqual(aItem.contextValue, 'herdr.paneContext.change');
		assert.strictEqual(a.headUri.toString(), a.headUri.with({ query: 'HEAD' }).toString());
		assert.strictEqual(a.headUri.authority, 'host');
		assert.strictEqual(a.headUri.path, path.join(dir, 'src', 'a.ts'));
		// A wholly untracked directory is one path: nothing to open as a file.
		const fresh = changes.find((c) => c.label === 'fresh')!;
		assert.strictEqual(paneContextItem(fresh).command, undefined);
		// A deleted file opens as HEAD has it.
		const gone = changes.find((c) => c.label === 'gone.txt')!;
		assert.ok(gone.deleted);
		assert.strictEqual(gone.headUri.scheme, 'herdr-git');

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

		assert.strictEqual((await roots())[0].type, 'root', 'the repo row first');
		const top = (await view.getChildren()).filter((n): n is GroupNode => n.type === 'group');
		assert.deepStrictEqual(top.map((g) => g.label), ['Changes', 'Commits', 'Files'], 'no Other Panes');
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

	test('follows herdr focus until a tile is focused, then only tiles', async () => {
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

		// Another tile moves it.
		focus.set(S, 'w2:p2');
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

	test('a focused pane follows a move to another workspace', async () => {
		view = makeView();
		focus.set(S, 'w2:p1');
		const moved = { event: 'pane.moved', data: { previous_pane_id: 'w2:p1', pane: { pane_id: 'w9:p1' } } } as HerdrEvent;
		model.events.fire({ sessionKey: S, event: moved });
		assert.strictEqual(view.followed, makePaneKey(S, 'w9:p1'));
		assert.strictEqual(focus.lastFocused, makePaneKey(S, 'w9:p1'));
	});

	test('the pane going away: the message comes back', async () => {
		view = makeView();
		focus.set(S, 'w2:p1');
		await rootIs(path.basename(dir));
		const without = twoPanes(dir, other);
		without.panes.splice(0, 1);
		model.snapshots.set(S, without);
		model.changed.fire();
		assert.deepStrictEqual(await roots(), []);
		assert.strictEqual(host.message, NO_PANE_MESSAGE);
	});

	test('the header: name and place; a tile showing it drops the note; set only on a change', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		assert.strictEqual(host.description, 'api-fixer · api › main · not open in a tile');
		assert.strictEqual(host.message, undefined);
		assert.strictEqual((await roots())[0].type, 'root', 'the repo row is first');

		shown.add(makePaneKey(S, 'w2:p1'));
		tiles.fire();
		assert.strictEqual(host.description, 'api-fixer · api › main');
		const sets = host.descriptions.length;
		model.changed.fire();
		model.changed.fire();
		assert.strictEqual(host.descriptions.length, sets, 'an unchanged header is not set again');

		const renamed = twoPanes(dir, other);
		renamed.agentNames.clear();
		renamed.panes[0].terminal_title_stripped = 'Fixing the API';
		model.snapshots.set(S, renamed);
		model.changed.fire();
		assert.strictEqual(host.description, 'Fixing the API · api › main');
	});

	test('no pane followed: no header description, the message instead', async () => {
		model.snapshots.set(S, twoPanes(dir, other, 'w9:p9'));
		view = makeView();
		await sleep(50);
		assert.strictEqual(host.description, undefined);
		assert.strictEqual(host.message, NO_PANE_MESSAGE);
		assert.deepStrictEqual(await roots(), []);
	});

	test('poll: new status updates the row; a directory herdr reports no event for is followed', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		fs.writeFileSync(path.join(dir, 'another.txt'), 'x');
		await view.poll();
		assert.strictEqual((await rootRow()).description, '⎇ main ● 5');
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
		assert.deepStrictEqual(await roots(), [], 'nothing loads while hidden');
		assert.strictEqual(host.description, 'api-fixer · api › main · not open in a tile', 'the header does not wait');
		assert.deepStrictEqual(model.requests, []);
		assert.strictEqual(host.message, undefined);
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
		await waitFor('the new file in the status', async () => (await rootRow()).description === '⎇ main ● 5');
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

		// With the diff still open and active (a row click), Open File still opens the file.
		await view.openFile(a);
		const file = await waitFor('the file tab', () => {
			const t = vscode.window.tabGroups.activeTabGroup.activeTab;
			return t?.input instanceof vscode.TabInputText ? t : undefined;
		});
		assert.strictEqual((file.input as vscode.TabInputText).uri.fsPath, path.join(dir, 'src', 'a.ts'), 'Open File: the working tree file');
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

	// ── Changes, Commits, this pane's files ─────────────────────────────────

	const P1 = makePaneKey(S, 'w2:p1');
	const commitRows = async () => view.getChildren(await group('commits'));
	const rowLabels = (nodes: PaneContextNode[]) => nodes.map((n) => (n as { label: string }).label);
	const commitAll = (message: string) => {
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', message);
		return git(dir, 'rev-parse', 'HEAD').trim();
	};
	const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

	test('sections in order: Changes expanded, Commits, Files; no Changed in This Pane', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		const top = await roots();
		assert.deepStrictEqual(
			top.map((n) => (n.type === 'group' ? n.label : n.type)),
			['root', 'Changes', 'Commits', 'Files'],
		);
		const uncommitted = (await group('changes'))!;
		assert.strictEqual(uncommitted.description, '4');
		assert.strictEqual(paneContextItem(uncommitted).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		assert.strictEqual(paneContextItem(uncommitted).contextValue, 'herdr.paneContext.changes');
		assert.strictEqual(uncommitted.id, `${vscode.Uri.file(dir).toString()}|changes`);
		const commits = (await group('commits'))!;
		assert.strictEqual(commits.description, 'recent', 'on main itself');
		assert.strictEqual(paneContextItem(commits).contextValue, 'herdr.paneContext.commits');
		assert.strictEqual(paneContextItem(commits).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.ok(!top.some((n) => n.type === 'group' && n.label === 'Changed in This Pane'));
		const last = decorated[decorated.length - 1]!;
		assert.deepStrictEqual(Object.keys(last).sort(), ['status', 'untrackedDirs'], 'no since-markers');

		// A clean tree: Changes 0 with a note; outside a repo: no change sections.
		commitAll('two');
		view.dispose();
		view = makeView();
		await rootIs(path.basename(dir));
		await waitFor('the clean status', async () => (await rootRow()).description === '⎇ main · clean');
		assert.deepStrictEqual((await roots()).map((n) => (n.type === 'group' ? n.label : n.type)), ['root', 'Changes', 'Commits', 'Files']);
		const clean = (await group('changes'))!;
		assert.strictEqual(clean.description, '0');
		assert.deepStrictEqual((await view.getChildren(clean)).map((n) => (n as { label: string }).label), [NO_CHANGES]);
		view.dispose();
		model.snapshots.set(S, twoPanes(other, dir));
		view = makeView();
		await rootIs(path.basename(other));
		assert.deepStrictEqual((await roots()).map((n) => (n.type === 'group' ? n.label : n.type)), ['root', 'Files']);
		assert.strictEqual(decorated[decorated.length - 1], undefined, 'no markers outside a repo');
	});

	test('commit rows: subject, sha and time, tooltip, icon; files load on expand', async () => {
		const one = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', 'Two things\n\nThe body,\nover two lines.');
		const two = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'commit', '-q', '--allow-empty', '--allow-empty-message', '-m', '');
		view = makeView();
		await rootIs(path.basename(dir));
		const rows = (await commitRows()) as CommitNode[];
		assert.deepStrictEqual(rowLabels(rows), ['(no message)', 'Two things', 'one']);
		const c = rows[1];
		assert.strictEqual(c.id, `${vscode.Uri.file(dir).toString()}|commit|${two}`);
		assert.strictEqual(c.description, commitDescription(c.commit, now));
		assert.match(c.description, new RegExp(`^${two.slice(0, 7)} · `));
		const item = paneContextItem(c);
		assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'git-commit');
		assert.strictEqual(item.contextValue, 'herdr.paneContext.commit');
		assert.match(String(item.tooltip), new RegExp(`^${two}\\nT · \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d\\n\\nTwo things\\n\\nThe body,\\nover two lines\\.$`));

		const files = (await view.getChildren(c)) as CommitFileNode[];
		assert.deepStrictEqual(
			files.map((f) => [f.label, f.description]),
			[
				['x', 'fresh · A'],
				['gone.txt', 'D'],
				['new.txt', 'A'],
				['a.ts', 'src · M'],
			],
		);
		const a = files[3];
		const aItem = paneContextItem(a);
		assert.strictEqual(aItem.resourceUri, undefined, 'no working tree decoration');
		assert.strictEqual((aItem.iconPath as vscode.ThemeIcon).id, vscode.ThemeIcon.File.id);
		assert.strictEqual(aItem.contextValue, 'herdr.paneContext.commitFile');
		assert.strictEqual(aItem.command?.command, 'herdr.paneContext.openChanges');
		assert.strictEqual(aItem.command?.arguments?.[0], a);
		assert.deepStrictEqual([a.leftUri.scheme, a.leftUri.query, a.rightUri.scheme, a.rightUri.query], ['herdr-git', one, 'herdr-git', two]);

		// The root commit: everything added, against the empty tree.
		const root = (await view.getChildren(rows[2])) as CommitFileNode[];
		assert.deepStrictEqual(rowLabels(root), ['README.md', 'gone.txt', 'a.ts'], 'by path, as git sorts');
		assert.ok(root.every((f) => f.status === 'A' && f.leftUri.query === '4b825dc642cb6eb9a060e54bf8d69288fbee4904'));
	});

	test('a commit file: click diffs parent ↔ commit, D opens the parent; Open File: working tree, else the revision', async () => {
		const one = git(dir, 'rev-parse', 'HEAD').trim();
		const two = commitAll('two');
		view = makeView();
		await rootIs(path.basename(dir));
		const c = ((await commitRows()) as CommitNode[])[0];
		const files = (await view.getChildren(c)) as CommitFileNode[];
		const byName = (n: string) => files.find((f) => f.label === n)!;

		await view.openChanges(byName('a.ts'));
		const diff = await waitFor('the diff tab', () => (activeTab()?.input instanceof vscode.TabInputTextDiff ? activeTab() : undefined));
		assert.strictEqual(diff.label, `a.ts (${two.slice(0, 7)})`);
		const input = diff.input as vscode.TabInputTextDiff;
		assert.deepStrictEqual([input.original.scheme, input.original.query, input.modified.scheme, input.modified.query], ['herdr-git', one, 'herdr-git', two]);
		assert.strictEqual(input.modified.path, path.join(dir, 'src', 'a.ts'));

		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await view.openChanges(byName('gone.txt'));
		const gone = await waitFor('the parent revision', () => (activeTab()?.input instanceof vscode.TabInputText ? activeTab() : undefined));
		assert.deepStrictEqual([(gone.input as vscode.TabInputText).uri.scheme, (gone.input as vscode.TabInputText).uri.query], ['herdr-git', one]);

		const openedBy = async (node: CommitFileNode) => {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await view.openFile(node);
			const t = await waitFor('the file tab', () => (activeTab()?.input instanceof vscode.TabInputText ? activeTab() : undefined));
			return (t.input as vscode.TabInputText).uri;
		};
		assert.strictEqual((await openedBy(byName('a.ts'))).toString(), vscode.Uri.file(path.join(dir, 'src', 'a.ts')).toString(), 'the working tree file');
		fs.rmSync(path.join(dir, 'new.txt'));
		const added = await openedBy(byName('new.txt'));
		assert.deepStrictEqual([added.scheme, added.query], ['herdr-git', two], 'gone from the working tree: the commit');
		const deleted = await openedBy(byName('gone.txt'));
		assert.deepStrictEqual([deleted.scheme, deleted.query], ['herdr-git', one], 'deleted: the parent');
	});

	test('poll: a new commit reaches Commits', async () => {
		view = makeView();
		await rootIs(path.basename(dir));
		assert.deepStrictEqual(rowLabels(await commitRows()), ['one']);
		commitAll('two');
		await view.poll();
		assert.deepStrictEqual(rowLabels(await commitRows()), ['two', 'one']);
		assert.strictEqual((await group('changes'))?.description, '0', 'nothing uncommitted: Changes 0');
	});

	test("pane mode: Changes and Commits filtered to the agent's touched files", async () => {
		commitAll('two'); // a.ts, fresh/x, gone.txt, new.txt
		fs.writeFileSync(path.join(dir, 'README.md'), 'readme again\n');
		const three = commitAll('three');
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'uncommitted\n');
		fs.writeFileSync(path.join(dir, 'u.txt'), 'u\n');
		fs.mkdirSync(path.join(dir, 'newdir'));
		fs.writeFileSync(path.join(dir, 'newdir', 'n.txt'), 'n\n');
		await touched.add(P1, dir, ['newdir/n.txt', 'src/a.ts', 'README.md']);
		paneFilesOnly = true;
		view = makeView();
		await rootIs(path.basename(dir));
		const uncommitted = (await group('changes'))!;
		assert.strictEqual(uncommitted.description, '2 of 3');
		assert.deepStrictEqual(rowLabels(await view.getChildren(uncommitted)).sort(), ['a.ts', 'newdir'], 'u.txt is not touched; newdir/ holds a touched path');
		const commits = (await group('commits'))!;
		assert.strictEqual(commits.description, 'recent · this pane');
		const rows = (await commitRows()) as CommitNode[];
		assert.deepStrictEqual(rowLabels(rows), ['three', 'two', 'one'], 'every listed commit touches a.ts or README.md');
		assert.deepStrictEqual(rowLabels(await view.getChildren(rows[1])), ['a.ts'], "two's other files are hidden");
		assert.deepStrictEqual(rowLabels(await view.getChildren(rows[0])), ['README.md']);
		assert.strictEqual(rows[0].commit.sha, three);

		// Commits with no touched file are hidden; none left: the note.
		await touched.prune(() => 'closed');
		await touched.add(P1, dir, ['newdir/n.txt']);
		await waitFor('nothing but newdir', async () => (await group('changes'))?.description === '1 of 3');
		assert.deepStrictEqual(rowLabels(await commitRows()), ['Nothing recorded for this pane']);
		const note = (await commitRows())[0];
		assert.strictEqual(paneContextItem(note).iconPath, undefined, 'a plain note');

		// Off again: everything.
		view.setPaneFilesOnly(false);
		assert.strictEqual((await group('changes'))!.description, '3');
		assert.strictEqual((await group('commits'))!.description, 'recent');
		assert.deepStrictEqual(rowLabels(await commitRows()), ['three', 'two', 'one']);
	});

	test('pane mode with nothing recorded: the note in both sections, Changes shown even when clean', async () => {
		paneFilesOnly = true;
		view = makeView();
		await rootIs(path.basename(dir));
		const uncommitted = (await group('changes'))!;
		assert.strictEqual(uncommitted.description, '0 of 4');
		assert.deepStrictEqual(rowLabels(await view.getChildren(uncommitted)), ['Nothing recorded for this pane']);
		assert.deepStrictEqual(rowLabels(await commitRows()), ['Nothing recorded for this pane']);
		commitAll('two');
		await view.poll();
		assert.strictEqual((await group('changes'))?.description, '0 of 0', 'shown although clean, so the note is visible');

		// A recording reaches the open view.
		const fires: unknown[] = [];
		const listener = view.onDidChangeTreeData((e) => fires.push(e));
		await touched.add(P1, dir, ['new.txt']);
		assert.ok(fires.includes(undefined), 'refreshed');
		listener.dispose();
		assert.deepStrictEqual(rowLabels(await commitRows()), ['two']);
	});

	test('pane mode on a shell pane: unfiltered, with a note first', async () => {
		model.snapshots.set(S, twoPanes(other, dir, 'w2:p2'));
		paneFilesOnly = true;
		view = makeView();
		await rootIs(path.basename(dir));
		const uncommitted = (await group('changes'))!;
		assert.strictEqual(uncommitted.description, '4');
		const rows = await view.getChildren(uncommitted);
		assert.strictEqual(rows.length, 5);
		assert.deepStrictEqual([rows[0].type, (rows[0] as { label: string }).label], ['note', 'No agent in this pane: showing all changes']);
		assert.strictEqual(paneContextItem(rows[0]).iconPath, undefined);
		assert.strictEqual((await group('commits'))!.description, 'recent');
		assert.deepStrictEqual(rowLabels(await commitRows()), ['No agent in this pane: showing all changes', 'one']);
		// Files is never filtered.
		assert.ok(labels(await view.getChildren(await group('files'))).includes('README.md'));
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
		assert.strictEqual(real!.message, undefined);
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
		panels = new TilesPanels({
			extensionUri: ext.extensionUri,
			model: model as unknown as SessionModel,
			streams,
			focus,
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
		assert.ok(!panels.showsPane(S, 'w2:p1'));
		const panel: MirrorPanel = panels.openPaneTab(S, 'w2:p1')!;
		await waitFor('showsPane', () => panels.showsPane(S, 'w2:p1'));
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
