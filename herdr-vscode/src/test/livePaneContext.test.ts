import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { bridgeRequest, herdrArgv } from '../bridge';
import { Environments } from '../environments';
import { FocusTracker } from '../focus';
import { cleanupSpanDirs, GitHeadContentProvider, makeSpanDir, parseGitHeadUri, readToplevel, removeSpanDir, spanDiff, spanSnapshot } from '../git';
import { ChangeNode, CommitNode, EntryNode, GroupNode, PaneContextNode, PaneContextView, PaneRowNode, RootNode } from '../paneContext';
import { EnvironmentPaths } from '../paths';
import { LocalShell } from '../remoteShell';
import { SessionModel } from '../sessions';
import { PaneStreams } from '../streams';
import { MirrorPanel, TilesPanels } from '../tilesPanel';
import { makePaneKey, TileProbe } from '../tilesProtocol';
import { memoryMemento, TouchedRecorder, TouchedStore } from '../touched';

/**
 * The Pane Context view in a real tree view, over a real herdr session and a real
 * webview, in a herdr home that holds only the throwaway session `hv-test`.
 * Skipped unless HERDR_VSCODE_LIVE_HOME names that home. Everything it writes is
 * in temp directories.
 */
const LIVE_HOME = process.env.HERDR_VSCODE_LIVE_HOME;
const SESSION = 'hv-test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, get: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
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

(LIVE_HOME ? suite : suite.skip)('live pane context in an isolated herdr home', function () {
	this.timeout(90000);
	const key = `host/${SESSION}`;
	const shell = new LocalShell();
	const req = (method: string, params: unknown) => bridgeRequest(shell, SESSION, method, params);
	const pk = (id: string) => makePaneKey(key, id);
	let realHome: string | undefined;
	let model: SessionModel;
	let streams: PaneStreams;
	let focus: FocusTracker;
	let panels: TilesPanels;
	let paths: EnvironmentPaths;
	let view: PaneContextView;
	let touched: TouchedStore;
	let tree: vscode.TreeView<PaneContextNode>;
	let panel: MirrorPanel;
	let repo: string;
	let plain: string;
	let workspaceId: string;
	let tabId: string;
	let p1: string;
	let p2: string;

	const git = (...args: string[]) => cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
	const roots = () => view.getChildren();
	const rootRow = async () => (await roots()).find((n) => n.type === 'root') as RootNode | undefined;
	const paneRow = async () => (await roots()).find((n) => n.type === 'pane') as PaneRowNode | undefined;
	const group = async (name: GroupNode['group']) => (await roots()).find((n) => n.type === 'group' && n.group === name) as GroupNode | undefined;
	const rootIs = (name: string, ms = 8000) => waitFor(`root ${name}`, ms, async () => (await rootRow())?.label === name);
	const tileOf = async (id: string): Promise<TileProbe | undefined> => (await panel.probe()).tiles.find((t) => t.paneKey === pk(id));
	const say = (id: string, text: string) => panel.onMessage({ type: 'input', paneKey: pk(id), text: `${text}\r` });

	suiteSetup(async () => {
		realHome = process.env.HOME;
		process.env.HOME = LIVE_HOME;
		repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-live-repo-')));
		plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hv-live-plain-')));
		git('init', '-q', '-b', 'main');
		git('config', 'user.email', 't@example.invalid');
		git('config', 'user.name', 'T');
		fs.mkdirSync(path.join(repo, 'src', 'auth'), { recursive: true });
		fs.writeFileSync(path.join(repo, 'src', 'auth', 'middleware.ts'), 'head one\nhead two\nhead three\n');
		git('add', '.');
		git('commit', '-q', '-m', 'one');
		fs.writeFileSync(path.join(repo, 'src', 'auth', 'middleware.ts'), 'edit one\nhead two\nhead three\n');
		fs.writeFileSync(path.join(plain, 'plain.txt'), 'p\n');
		fs.writeFileSync(path.join(LIVE_HOME!, 'hv-link.txt'), 'in home\n');

		const log = (l: string) => console.log(`[live-pane-context] ${l}`);
		const environments = new Environments(() => undefined);
		model = new SessionModel(environments, log);
		model.start();
		await waitFor('connected', 15000, () => model.connection(key)?.state === 'connected' && model.connection(key)?.snapshot);
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		streams = new PaneStreams((k) => {
			const c = model.connection(k);
			return c && { shell: c.env.shell, name: c.name };
		}, log);
		focus = new FocusTracker(model, () => 'hv-row');
		panels = new TilesPanels({ extensionUri: ext.extensionUri, model, streams, focus, rowLabel: () => 'hv-row', log });
		paths = new EnvironmentPaths(environments);

		const created = (await req('workspace.create', { cwd: repo, label: 'ctx', focus: true })) as { workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } };
		workspaceId = created.workspace.workspace_id;
		tabId = created.tab.tab_id;
		p1 = created.root_pane.pane_id;
		p2 = ((await req('pane.split', { target_pane_id: p1, direction: 'right', cwd: plain, focus: false })) as { pane: { pane_id: string } }).pane.pane_id;
		await waitFor('panes in snapshot', 5000, () => model.connection(key)?.snapshot?.panes.filter((p) => p.tab_id === tabId).length === 2);

		const noSelectionChange = new vscode.EventEmitter<void>();
		touched = new TouchedStore(memoryMemento());
		view = new PaneContextView({
			touched,
			model,
			focus,
			sessions: { selected: key, onDidChangeSelected: noSelectionChange.event },
			panels,
			paths,
			createHost: (treeDataProvider) => {
				tree = vscode.window.createTreeView('herdr.paneContext', { treeDataProvider });
				return tree;
			},
			log,
		});
		await vscode.commands.executeCommand('herdr.paneContext.focus');
		await waitFor('the view visible', 5000, () => tree.visible);
	});

	suiteTeardown(async () => {
		view?.dispose();
		panels?.dispose();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		if (workspaceId) {
			await req('workspace.close', { workspace_id: workspaceId }).catch(() => undefined);
		}
		streams?.dispose();
		focus?.dispose();
		paths?.dispose();
		model?.dispose();
		process.env.HOME = realHome;
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(plain, { recursive: true, force: true });
		fs.rmSync(path.join(LIVE_HOME!, 'hv-link.txt'), { force: true });
	});

	test("before any tile: follows herdr's focus (pane.focused), with the pane row saying no tile", async () => {
		await waitFor('p1 followed', 5000, () => view.followed === pk(p1));
		await rootIs(path.basename(repo));
		assert.strictEqual(tree.message, undefined);
		assert.match(String((await paneRow())?.description), /^ctx › .* · not open in a tile$/);

		const start = Date.now();
		await req('pane.focus', { pane_id: p2 });
		await rootIs(path.basename(plain));
		console.log(`[live-pane-context] herdr focus to view: ${Date.now() - start} ms`);
		assert.strictEqual(view.followed, pk(p2));
		await req('pane.focus', { pane_id: p1 });
		await rootIs(path.basename(repo));
	});

	test('the repo row and the changes, as herdr and git really report them', async () => {
		const root = (await rootRow())!;
		assert.strictEqual(root.description, '⎇ main · ● 1');
		assert.strictEqual(root.isRepo, true);
		const changes = (await view.getChildren(await group('changes'))) as ChangeNode[];
		assert.deepStrictEqual(changes.map((c) => [c.label, c.description]), [['middleware.ts', 'src/auth · M']]);
		assert.strictEqual(changes[0].uri.fsPath, path.join(repo, 'src', 'auth', 'middleware.ts'));
	});

	test('Uncommitted holds the change, Commits the one commit (recent, on main)', async () => {
		const uncommitted = (await group('changes'))!;
		assert.strictEqual(uncommitted.label, 'Uncommitted');
		const all = (await view.getChildren(uncommitted)) as ChangeNode[];
		assert.deepStrictEqual(all.map((c) => c.label), ['middleware.ts']);
		const commits = (await group('commits'))!;
		assert.strictEqual(commits.description, 'recent');
		const rows = (await view.getChildren(commits)) as CommitNode[];
		assert.deepStrictEqual(rows.map((r) => r.label), ['one']);
		assert.strictEqual(rows[0].commit.sha, git('rev-parse', 'HEAD').trim());
	});

	// `Show Pane` runs the extension's own command, whose model discovers nothing here: so what it runs.
	test('a tile opening ends rule 2 and the pane row note', async () => {
		panel = panels.openPaneTab(key, p1)!;
		await waitFor('p1 painted', 15000, async () => (await tileOf(p1))?.text.length);
		await waitFor('the pane row note gone', 5000, async () => !String((await paneRow())?.description).includes('not open in a tile'));
		await waitFor('p1 is the last focused', 5000, () => focus.lastFocused === pk(p1));

		await req('pane.focus', { pane_id: p2 });
		await waitFor("herdr's focus moved", 5000, () => model.connection(key)?.snapshot?.focusedPaneId === p2);
		await sleep(300);
		assert.strictEqual(view.followed, pk(p1), 'herdr focus no longer counts');
		await req('pane.focus', { pane_id: p1 });
	});

	test('focusing another tile switches it; Pin holds until Unpin', async () => {
		panels.openPaneTab(key, p2);
		await waitFor('p2 last focused', 15000, () => focus.lastFocused === pk(p2));
		await rootIs(path.basename(plain));
		view.pin();
		assert.strictEqual(tree.message, undefined, 'pinned shows in the title bar only');
		panels.openPaneTab(key, p1);
		await waitFor('p1 last focused', 15000, () => focus.lastFocused === pk(p1));
		await sleep(300);
		assert.strictEqual((await rootRow())?.label, path.basename(plain));
		view.unpin();
		await rootIs(path.basename(repo));
	});

	test('a cd, which herdr reports with no event, is followed by the 5 s poll', async () => {
		await waitFor('p1 painted', 15000, async () => (await tileOf(p1))?.text.length);
		const start = Date.now();
		say(p1, `cd ${plain}`);
		await rootIs(path.basename(plain), 8000);
		console.log(`[live-pane-context] cd to view: ${Date.now() - start} ms`);
		say(p1, `cd ${repo}/src`);
		await rootIs(path.basename(repo), 8000);
	});

	test('a change by something else shows in the repo row within the poll', async () => {
		const start = Date.now();
		fs.writeFileSync(path.join(repo, 'added by agent.txt'), 'x\n');
		await waitFor('the count', 8000, async () => (await rootRow())?.description === '⎇ main · ● 2');
		console.log(`[live-pane-context] file to count: ${Date.now() - start} ms`);
	});

	test('a real click in the tree opens a file, editable; saving reaches the disk', async () => {
		const files = (await view.getChildren(await group('files'))) as EntryNode[];
		const row = files.find((f) => f.name === 'added by agent.txt')!;
		const item = await view.getTreeItem(row);
		await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
		const editor = await waitFor('the editor', 5000, () => vscode.window.activeTextEditor?.document.uri.fsPath === row.uri.fsPath && vscode.window.activeTextEditor);
		await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'saved\n'));
		assert.ok(await editor.document.save());
		assert.strictEqual(fs.readFileSync(row.uri.fsPath, 'utf8'), 'saved\nx\n');
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		panel.panel.reveal();
	});

	test('Open Changes: the left side is really HEAD', async () => {
		// The extension under test registers the real provider for `herdr-git`, over environments it has
		// not discovered here; so through a provider of our own over the same class.
		const provider = new GitHeadContentProvider((k) => (model.connection(key)?.env.key === k ? model.connection(key)?.env : undefined));
		const changes = (await view.getChildren(await group('changes'))) as ChangeNode[];
		const change = changes.find((c) => c.label === 'middleware.ts')!;
		assert.deepStrictEqual(parseGitHeadUri(change.headUri), { envKey: 'host', toplevel: repo, file: 'src/auth/middleware.ts' });
		assert.strictEqual(await provider.provideTextDocumentContent(change.headUri), 'head one\nhead two\nhead three\n');
	});

	test('Split Pane Here: a new pane below the followed one, in the repo root', async () => {
		const before = new Set(model.connection(key)!.snapshot!.panes.map((p) => p.pane_id));
		await view.splitPane();
		const fresh = await waitFor('the new pane', 5000, () => model.connection(key)?.snapshot?.panes.find((p) => !before.has(p.pane_id)));
		assert.strictEqual(fresh.tab_id, tabId);
		assert.strictEqual(fresh.foreground_cwd ?? fresh.cwd, repo);
		const exported = (await req('layout.export', { tab_id: tabId })) as { layout: { root: unknown } };
		const find = (n: { type: string; direction?: string; first?: unknown; second?: { pane_id?: string } }): boolean =>
			n.type === 'split' && ((n.direction === 'down' && n.second?.pane_id === fresh.pane_id) || find(n.first as never) || find(n.second as never));
		assert.ok(find(exported.layout.root as never), JSON.stringify(exported.layout.root));
		assert.strictEqual(model.connection(key)?.snapshot?.focusedPaneId !== fresh.pane_id, true, 'focus: false');
		await req('pane.close', { pane_id: fresh.pane_id });
	});

	test('a file written from the pane is in Uncommitted within a poll', async () => {
		await waitFor('p1 painted', 15000, async () => (await tileOf(p1))?.text.length);
		const start = Date.now();
		say(p1, `printf 'from pane\\n' > ${repo}/from-pane.txt`);
		await waitFor('the change row', 8000, async () => ((await view.getChildren(await group('changes'))) as ChangeNode[]).some((n) => n.label === 'from-pane.txt'));
		console.log(`[live-pane-context] file from pane to Uncommitted: ${Date.now() - start} ms`);
		assert.strictEqual(fs.readFileSync(path.join(repo, 'from-pane.txt'), 'utf8'), 'from pane\n');
	});

	test("an agent pane going working → idle while a file is written records it; nothing in the repo's .git changes", async () => {
		const objects = () => cp.execFileSync('find', [path.join(repo, '.git', 'objects'), '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
		const indexMtime = () => fs.statSync(path.join(repo, '.git', 'index')).mtimeMs;
		const before = { objects: objects(), index: indexMtime() };
		const store = new TouchedStore(memoryMemento());
		const timings: string[] = [];
		const timed = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
			const t = Date.now();
			try {
				return await run();
			} finally {
				timings.push(`${what} ${Date.now() - t} ms`);
			}
		};
		const recorder = new TouchedRecorder({
			model,
			store,
			log: (l) => console.log(`[live-pane-context] ${l}`),
			git: {
				toplevel: readToplevel,
				makeDir: makeSpanDir,
				snapshot: (sh, top, d) => timed('snapshot', () => spanSnapshot(sh, top, d)),
				diff: (sh, top, d, a, b) => timed('diff', () => spanDiff(sh, top, d, a, b)),
				removeDir: removeSpanDir,
				cleanup: cleanupSpanDirs,
			},
		});
		const report = (state: string) => req('pane.report_agent', { pane_id: p1, source: 'herdr-vscode-test', agent: 'claude', state });
		try {
			await report('working');
			await waitFor('the span', 5000, () => recorder.openSpans().includes(pk(p1)));
			await recorder.settled();
			fs.writeFileSync(path.join(repo, 'by-agent.txt'), 'agent\n');
			const start = Date.now();
			await report('idle');
			await waitFor('recorded', 8000, () => store.get(pk(p1), repo)?.paths.includes('by-agent.txt'));
			console.log(`[live-pane-context] idle to recorded: ${Date.now() - start} ms; ${timings.join(', ')}`);
			assert.deepStrictEqual(store.get(pk(p1), repo)?.paths, ['by-agent.txt'], 'from-pane.txt and middleware.ts changed before the span');
			assert.strictEqual(objects(), before.objects, '.git/objects file count');
			assert.strictEqual(indexMtime(), before.index, '.git/index mtime');
		} finally {
			recorder.dispose();
			store.dispose();
		}
	});

	suite('links printed in a real tile', () => {
		/** Prints a line in the tile, finds it, and hovers and clicks on `needle`. */
		async function click(text: string, needle: string): Promise<void> {
			const marker = `m${Math.random().toString(36).slice(2, 8)}`;
			say(p1, `clear; printf '%s\\n' '${marker} ${text}'`);
			const tile = await waitFor('printed', 10000, async () => {
				const t = await tileOf(p1);
				return t?.text.split('\n').some((l) => l.startsWith(`${marker} `)) && t;
			});
			const lines = tile.text.split('\n');
			const row = lines.findIndex((l) => l.startsWith(`${marker} `));
			const col = lines[row].indexOf(needle) + 2;
			await panel.probe({ kind: 'hoverCell', paneKey: pk(p1), col, row });
			await waitFor('the pointer', 5000, async () => (await tileOf(p1))?.overLink);
			await panel.probe({ kind: 'clickCell', paneKey: pk(p1), col, row });
		}
		const activeFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

		test('relative to a pane in a subdirectory, with line and column', async () => {
			await click('see ./auth/middleware.ts:2:6 now', 'middleware');
			const editor = await waitFor('the file beside', 8000, () => activeFile() === path.join(repo, 'src', 'auth', 'middleware.ts') && vscode.window.activeTextEditor);
			await waitFor('the selection', 3000, () => editor.selection.active.line === 1);
			assert.strictEqual(editor.selection.active.character, 5);
			assert.notStrictEqual(editor.viewColumn, panel.panel.viewColumn, 'beside the tiles');
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		});

		test('~/ resolves against the home of the environment', async () => {
			await click('~/hv-link.txt', 'hv-link');
			await waitFor('the file', 8000, () => activeFile() === path.join(LIVE_HOME!, 'hv-link.txt'));
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		});

		test('a missing path opens nothing', async () => {
			const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
			await click('src/no/such/file.ts:19', 'file.ts');
			await sleep(1000);
			assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, before);
		});

		test('a directory is revealed in Files', async () => {
			say(p1, `cd ${repo}`);
			await waitFor('the snapshot', 8000, async () => (await rootRow())?.label === path.basename(repo));
			await waitFor('the directory', 8000, async () => {
				const conn = model.connection(key);
				conn?.refresh();
				const pane = conn?.snapshot?.panes.find((p) => p.pane_id === p1);
				return pane?.foreground_cwd === repo;
			});
			await click('src/auth', 'src/auth');
			await waitFor('selected', 8000, () => (tree.selection[0] as EntryNode | undefined)?.name === 'auth');
		});
	});

	// Mocha runs a suite's nested suites after its own tests, and this one takes the pane away.
	suite('last', () => {
		test('a pinned pane follows a real move to another workspace', async () => {
			view.pin();
			const move = await shell.run(herdrArgv(['--session', SESSION, 'pane', 'move', p1, '--new-workspace', '--label', 'moved-ctx', '--no-focus']), { timeoutMs: 10000 });
			assert.strictEqual(move.exitCode, 0, move.stderr.toString());
			const r = JSON.parse(move.stdout.toString()) as { result: { move_result: { pane: { pane_id: string; workspace_id: string } } } };
			const moved = r.result.move_result.pane;
			assert.notStrictEqual(moved.pane_id, p1);
			await waitFor('the new key', 5000, () => view.followed === pk(moved.pane_id));
			assert.strictEqual(focus.lastFocused, pk(moved.pane_id));
			await waitFor('the pane row', 5000, async () => String((await paneRow())?.description).includes('moved-ctx'));
			await rootIs(path.basename(repo));
			view.unpin();
			await req('workspace.close', { workspace_id: moved.workspace_id });
			await waitFor('the pane gone: the message', 5000, () => tree.message === 'Click into a herdr pane to see its files.');
		});
	});
});
