import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { gitHeadUri, readRepo, RepoInfo } from '../git';
import { CONTAINER_SCHEME, SSH_SCHEME } from '../paths';
import { LocalShell, RemoteShell, ShellResult } from '../remoteShell';
import { SnapshotPane } from '../sessions';
import { memoryMemento } from '../touched';
import {
	applyTitle,
	expandTitle,
	fileSource,
	paneTitle,
	tabUri,
	TITLE_ORIGINAL_KEY,
	TITLE_WRITTEN_KEY,
	TitleSource,
	WindowTitleController,
	WindowTitleDeps,
} from '../windowTitle';
import { snapshot } from './fixtures';

const result = (exitCode: number, stdout = ''): ShellResult => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

/** A shell answering git's two questions from a table keyed by the `-C` dir. */
function gitShell(repos: Record<string, { toplevel: string; common: string; branch?: string } | 'throw'>): RemoteShell & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (argv: string[]) => {
			calls.push(argv);
			const dir = argv[2];
			if (argv.includes('rev-parse')) {
				const repo = repos[dir];
				if (repo === 'throw') {
					throw new Error('container gone');
				}
				return repo ? result(0, `${repo.toplevel}\n${repo.common}\n`) : result(128);
			}
			const repo = Object.values(repos).find((r) => r !== 'throw' && r.toplevel === dir);
			return repo && repo !== 'throw' && repo.branch ? result(0, `${repo.branch}\n`) : result(1);
		},
		spawn: () => {
			throw new Error('not used');
		},
	};
}

const repo = (over: Partial<RepoInfo> = {}): RepoInfo => ({ toplevel: '/src/wt-a', main: '/src/proj', branch: 'feature-a', ...over });

suite('window title', () => {
	suite('expandTitle', () => {
		test('fills each variable', () => {
			assert.strictEqual(expandTitle('${project}|${branch}|${folder}|${space}|${title}', repo(), 'api', 'Fixing'), 'proj|feature-a|wt-a|api|Fixing');
		});
		test('leaves VS Code variables as written', () => {
			assert.strictEqual(expandTitle('${branch} (${rootNameShort})${separator}${title}', repo()), 'feature-a (${rootNameShort})${separator}');
		});
		test('a $ in a value becomes ＄', () => {
			assert.strictEqual(expandTitle('${branch}', repo({ branch: 'a$b' })), 'a＄b');
		});
		test('detached HEAD: the folder name', () => {
			assert.strictEqual(expandTitle('${branch}', repo({ branch: undefined })), 'wt-a');
		});
		test('space and title default to empty; result trimmed', () => {
			assert.strictEqual(expandTitle('  ${branch} ${space}${title} ', repo()), 'feature-a');
			assert.strictEqual(expandTitle('   ', repo()), '');
		});
	});

	suite('paneTitle', () => {
		const pane = (over: Partial<SnapshotPane>): SnapshotPane =>
			({ pane_id: 'p', tab_id: 't', workspace_id: 'w', agent_status: 'unknown', raw_status: 'unknown', cwd: '/src/api', ...over }) as SnapshotPane;
		test('equal to the label: empty', () => {
			assert.strictEqual(paneTitle(pane({ label: 'build', terminal_title_stripped: 'build' })), '');
		});
		test('equal to the folder without an agent: empty', () => {
			assert.strictEqual(paneTitle(pane({ label: 'x', terminal_title_stripped: 'api' })), '');
		});
		test('equal to the folder with an agent: the title', () => {
			assert.strictEqual(paneTitle(pane({ label: 'x', agent: 'claude', terminal_title_stripped: 'api' })), 'api');
		});
		test('a distinct title', () => {
			assert.strictEqual(paneTitle(pane({ terminal_title_stripped: ' Fixing the title ' })), 'Fixing the title');
		});
		test('whitespace only: empty', () => {
			assert.strictEqual(paneTitle(pane({ terminal_title_stripped: '   ' })), '');
		});
	});

	suite('readRepo', () => {
		test('main worktree', async () => {
			const shell = gitShell({ '/src/proj/sub': { toplevel: '/src/proj', common: '/src/proj/.git', branch: 'main' } });
			assert.deepStrictEqual(await readRepo(shell, '/src/proj/sub'), { toplevel: '/src/proj', main: '/src/proj', branch: 'main' });
		});
		test('linked worktree', async () => {
			const shell = gitShell({ '/src/wt-a': { toplevel: '/src/wt-a', common: '/src/proj/.git', branch: 'feature-a' } });
			const info = await readRepo(shell, '/src/wt-a');
			assert.deepStrictEqual(info, { toplevel: '/src/wt-a', main: '/src/proj', branch: 'feature-a' });
			assert.strictEqual(expandTitle('${project}/${folder}', info!), 'proj/wt-a');
		});
		test('detached: no branch', async () => {
			const shell = gitShell({ '/src/proj': { toplevel: '/src/proj', common: '/src/proj/.git' } });
			assert.deepStrictEqual(await readRepo(shell, '/src/proj'), { toplevel: '/src/proj', main: '/src/proj', branch: undefined });
		});
		test('not a repo, and an unreachable environment', async () => {
			assert.strictEqual(await readRepo(gitShell({}), '/tmp'), undefined);
			assert.strictEqual(await readRepo(gitShell({ '/x': 'throw' }), '/x'), undefined);
		});
		test('real git through LocalShell', async () => {
			const here = path.resolve(__dirname, '..', '..');
			const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: here, encoding: 'utf8' }).trim();
			const toplevel = git('rev-parse', '--show-toplevel');
			let branch: string | undefined;
			try {
				branch = git('symbolic-ref', '--short', '-q', 'HEAD') || undefined;
			} catch {
				branch = undefined;
			}
			const info = await readRepo(new LocalShell(), here);
			assert.ok(info);
			assert.strictEqual(fs.realpathSync(info.toplevel), fs.realpathSync(toplevel));
			assert.strictEqual(info.branch, branch);
		});
	});

	suite('tab → source', () => {
		const host = gitShell({});
		const container = gitShell({});
		const ssh = gitShell({});
		const envs: Record<string, { shell: RemoteShell }> = {
			'container:abcdef123456': { shell: container },
			'ssh:devbox': { shell: ssh },
		};
		const find = (key: string) => envs[key.toLowerCase()];
		const dirOf = (s: TitleSource) => (s.kind === 'dir' ? { shell: s.shell, dir: s.dir } : s.kind);

		test('text editor and diff tabs', () => {
			const file = vscode.Uri.file('/src/proj/a.ts');
			assert.strictEqual(tabUri(new vscode.TabInputText(file))?.toString(), file.toString());
			const modified = vscode.Uri.file('/src/proj/b.ts');
			assert.strictEqual(tabUri(new vscode.TabInputTextDiff(file, modified))?.toString(), modified.toString());
			assert.strictEqual(tabUri(new vscode.TabInputWebview('markdown.preview')), undefined);
			assert.strictEqual(tabUri(undefined), undefined);
		});
		test('a host file', () => {
			assert.deepStrictEqual(dirOf(fileSource(vscode.Uri.file('/src/proj/a.ts'), find, host)), { shell: host, dir: '/src/proj' });
		});
		test('container, ssh and herdr-git files pick their environment', () => {
			const c = vscode.Uri.from({ scheme: CONTAINER_SCHEME, authority: 'abcdef123456', path: '/workspaces/p/x.ts' });
			assert.deepStrictEqual(dirOf(fileSource(c, find, host)), { shell: container, dir: '/workspaces/p' });
			const s = vscode.Uri.from({ scheme: SSH_SCHEME, authority: 'devbox', path: '/home/u/r/y.ts' });
			assert.deepStrictEqual(dirOf(fileSource(s, find, host)), { shell: ssh, dir: '/home/u/r' });
			const g = gitHeadUri('ssh:devbox', '/home/u/r', 'src/z.ts');
			assert.deepStrictEqual(dirOf(fileSource(g, find, host)), { shell: ssh, dir: '/home/u/r/src' });
		});
		test('untitled and unknown environments: keep', () => {
			assert.strictEqual(fileSource(vscode.Uri.from({ scheme: 'untitled', path: 'Untitled-1' }), find, host).kind, 'keep');
			const other = vscode.Uri.from({ scheme: CONTAINER_SCHEME, authority: '999999999999', path: '/x/y' });
			assert.strictEqual(fileSource(other, find, host).kind, 'keep');
		});
	});

	suite('applyTitle', () => {
		function store(initial?: string) {
			let value = initial;
			const writes: (string | undefined)[] = [];
			return {
				writes,
				get value() {
					return value;
				},
				set value(v: string | undefined) {
					value = v;
				},
				current: () => value,
				write: async (v: string | undefined) => {
					writes.push(v);
					value = v;
				},
				state: memoryMemento(),
			};
		}

		test('writes, then restores the own title', async () => {
			const s = store('mine');
			await applyTitle('main (x)', s);
			assert.strictEqual(s.value, 'main (x)');
			assert.strictEqual(s.state.get(TITLE_WRITTEN_KEY), 'main (x)');
			assert.deepStrictEqual(s.state.get(TITLE_ORIGINAL_KEY), { value: 'mine' });
			await applyTitle('main (x)', s);
			assert.deepStrictEqual(s.writes, ['main (x)'], 'no rewrite of the same title');
			await applyTitle('', s);
			assert.strictEqual(s.value, 'mine');
			assert.strictEqual(s.state.get(TITLE_WRITTEN_KEY), undefined);
		});
		test('an unset own title is removed again', async () => {
			const s = store(undefined);
			await applyTitle('a', s);
			await applyTitle('', s);
			assert.deepStrictEqual(s.writes, ['a', undefined]);
		});
		test('a hand edit becomes the title to restore', async () => {
			const s = store(undefined);
			await applyTitle('a', s);
			s.value = 'edited';
			await applyTitle('b', s);
			assert.deepStrictEqual(s.state.get(TITLE_ORIGINAL_KEY), { value: 'edited' });
			await applyTitle('', s);
			assert.strictEqual(s.value, 'edited');
		});
		test('nothing written: restore does nothing', async () => {
			const s = store('mine');
			await applyTitle('', s);
			assert.deepStrictEqual(s.writes, []);
		});
	});

	suite('controller', () => {
		const disposables: vscode.Disposable[] = [];
		teardown(() => {
			for (const d of disposables.splice(0)) {
				d.dispose();
			}
		});

		function setup(opts: { template?: string; saved?: boolean; tab?: unknown; panelPane?: string } = {}) {
			const live = { ...opts };
			let value: string | undefined = 'mine';
			const writes: (string | undefined)[] = [];
			const snap = snapshot();
			const paneShell = gitShell({ '/src/api': { toplevel: '/src/api', common: '/src/api/.git', branch: 'api-branch' } });
			const hostShell = gitShell({ '/src/proj': { toplevel: '/src/proj', common: '/src/proj/.git', branch: 'main' } });
			const changed = new vscode.EventEmitter<void>();
			const reports = new vscode.EventEmitter<{ sessionKey: string; paneId: string }>();
			const tiles = new vscode.EventEmitter<void>();
			disposables.push(changed, reports, tiles);
			const panel = opts.panelPane === undefined ? undefined : { sessionKey: 'host/s', activePaneId: opts.panelPane };
			const deps: WindowTitleDeps = {
				model: {
					connection: (key: string) => (key === 'host/s' ? { snapshot: snap, env: { shell: paneShell }, state: 'connected', refresh() {} } : undefined),
					onDidChange: changed.event,
					request: async () => undefined,
				} as unknown as WindowTitleDeps['model'],
				focus: { onDidReportFocus: reports.event },
				panels: { activeSpacePanel: () => panel, onDidChangeTiles: tiles.event } as unknown as WindowTitleDeps['panels'],
				findEnv: () => undefined,
				hostShell,
				state: memoryMemento(),
				log: () => {},
				template: () => live.template ?? '${project}:${branch}${separator}${space}${separator}${title}',
				savedWorkspace: () => live.saved ?? true,
				activeTabInput: () => live.tab,
				store: {
					current: () => value,
					write: async (v) => {
						writes.push(v);
						value = v;
					},
				},
				startupMs: 0,
			};
			const controller = new WindowTitleController(deps);
			disposables.push(controller);
			return { controller, writes, value: () => value, live };
		}

		test('a space tab: its active pane, with space and title', async () => {
			const t = setup({ panelPane: 'w2:p1' });
			await t.controller.update();
			assert.strictEqual(t.value(), 'api:api-branch${separator}api${separator}Refactoring');
		});
		test('a space tab with no pane yet: keep', async () => {
			const t = setup({ panelPane: 'nope' });
			await t.controller.update();
			assert.deepStrictEqual(t.writes, []);
		});
		test('a text editor: the file’s repo, no space or title', async () => {
			const t = setup({ tab: new vscode.TabInputText(vscode.Uri.file('/src/proj/sub')) });
			await t.controller.update();
			assert.strictEqual(t.value(), 'proj:main${separator}${separator}');
		});
		test('a file in no repo restores; Settings-like tabs keep', async () => {
			const t = setup({ tab: new vscode.TabInputText(vscode.Uri.file('/src/proj/sub')) });
			await t.controller.update();
			t.live.tab = new vscode.TabInputWebview('x');
			await t.controller.update();
			assert.strictEqual(t.value(), 'proj:main${separator}${separator}', 'keep');
			t.live.tab = new vscode.TabInputText(vscode.Uri.file('/nowhere/f.txt'));
			await t.controller.update();
			assert.strictEqual(t.value(), 'mine', 'restored');
		});
		test('setting off: the own title comes back', async () => {
			const t = setup({ tab: new vscode.TabInputText(vscode.Uri.file('/src/proj/sub')), template: '${branch}' });
			await t.controller.update();
			assert.strictEqual(t.value(), 'main');
			t.live.template = '';
			await t.controller.update();
			assert.strictEqual(t.value(), 'mine');
		});
		test('not a saved workspace: never writes', async () => {
			const t = setup({ saved: false, panelPane: 'w2:p1' });
			await t.controller.update();
			assert.deepStrictEqual(t.writes, []);
		});
	});

	test('package.json declares herdr.windowTitle', () => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
		const setting = pkg.contributes.configuration.properties['herdr.windowTitle'];
		assert.deepStrictEqual(setting.type, ['string', 'null']);
		assert.strictEqual(setting.default, null);
		assert.strictEqual(setting.scope, 'window');
	});
});
