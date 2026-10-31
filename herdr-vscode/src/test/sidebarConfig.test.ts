import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSnapshot, Snapshot } from '../sessions';
import { loadSidebarConfig, parseSidebarConfig, SidebarConfig, SidebarConfigSource, sidebarConfigPath, SidebarRows } from '../sidebarConfig';
import { splitGitDescription } from '../spaceGit';
import { agentRows, AgentSource } from '../views/agentsView';
import { buildSpaces, spacesTreeItem } from '../views/spacesView';

const FIXTURE = `onboarding = false

[ui.sidebar.spaces]
row_gap = 1
rows = [["state_icon", "workspace", "$jj_status"], ["branch", "git_status"]]

[ui.sidebar.agents]
rows = [["state_icon", { token = "machine", dim = true }, "workspace", "tab"], ["agent"], ["$ticket"]]

[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"], ["agent"]]
`;

const FIXTURE_JSON: SidebarConfig = {
	spaces: { rows: [['state_icon', 'workspace', '$jj_status'], ['branch', 'git_status']] },
	agents: {
		rows: [['state_icon', 'machine', 'workspace', 'tab'], ['agent'], ['$ticket']],
		rowsByAgent: { claude: [['state_icon', 'workspace', 'tab'], ['terminal_title_stripped'], ['agent']] },
	},
};

function config(text: string): SidebarConfig {
	const r = parseSidebarConfig(text);
	assert.ok('config' in r, `expected valid: ${'error' in r ? r.error : ''}`);
	return r.config;
}

function error(text: string): string {
	const r = parseSidebarConfig(text);
	assert.ok('error' in r, `expected invalid: ${text}`);
	return r.error;
}

suite('sidebar config: path', () => {
	const home = '/home/me';
	test('HERDR_CONFIG_PATH wins, then XDG_CONFIG_HOME, then ~/.config; empty values are ignored', () => {
		assert.strictEqual(sidebarConfigPath({ HERDR_CONFIG_PATH: '/x/c.toml', XDG_CONFIG_HOME: '/xdg' }, home, 'linux'), '/x/c.toml');
		assert.strictEqual(sidebarConfigPath({ HERDR_CONFIG_PATH: '', XDG_CONFIG_HOME: '/xdg' }, home, 'linux'), '/xdg/herdr/config.toml');
		assert.strictEqual(sidebarConfigPath({ XDG_CONFIG_HOME: '' }, home, 'darwin'), '/home/me/.config/herdr/config.toml');
		assert.strictEqual(sidebarConfigPath({}, home, 'linux'), '/home/me/.config/herdr/config.toml');
		assert.strictEqual(sidebarConfigPath({ HERDR_CONFIG_PATH: 'C:\\c.toml' }, home, 'win32'), undefined, 'nothing read on Windows');
	});
});

suite('sidebar config: parse and validate', () => {
	test('the example fixture parses to exactly the contract JSON', () => {
		assert.deepStrictEqual(config(FIXTURE), FIXTURE_JSON);
	});

	test('valid forms', () => {
		assert.deepStrictEqual(config('[ui.sidebar.spaces]\nrows = []'), { spaces: { rows: [] } });
		assert.deepStrictEqual(config('[ui.sidebar.agents]\nrows = [[]]'), { agents: { rows: [[]] } });
		assert.deepStrictEqual(
			config('[ui.sidebar.agents]\nrows = [[{ token = "agent", fg = "#89b4fa", bold = true, dim = false }, { token = "tab", fg = "#fff" }]]'),
			{ agents: { rows: [['agent', 'tab']] } },
		);
		const name32 = 'a'.repeat(32);
		assert.deepStrictEqual(config(`[ui.sidebar.spaces]\nrows = [["$a-b_9", "$ABC", "$${name32}", "state_text"]]`), {
			spaces: { rows: [['$a-b_9', '$ABC', `$${name32}`, 'state_text']] },
		});
		assert.deepStrictEqual(config('[ui.sidebar.agents]\nrows = [["state_text"]]'), { agents: { rows: [['state_text']] } });
		assert.deepStrictEqual(
			config('[ui.sidebar]\nfoo = 1\n[ui.sidebar.agents]\nfoo = "x"\nrows = [["agent"]]\n[theme]\nname = 5'),
			{ agents: { rows: [['agent']] } },
			'unknown sidebar keys and unrelated [theme] keys are ignored',
		);
		assert.deepStrictEqual(config('onboarding = true'), {});
		assert.deepStrictEqual(config('[ui.sidebar.agents.rows_by_agent]\nclaude = [["agent"]]'), { agents: { rowsByAgent: { claude: [['agent']] } } });
	});

	test('invalid forms', () => {
		const cases: [string, RegExp][] = [
			['[ui.sidebar.spaces]\nrows = [["agent"]]', /unknown space token `agent`/],
			['[ui.sidebar.spaces]\nrows = [["tab"]]', /unknown space token `tab`/],
			['[ui.sidebar.agents]\nrows = [["branch"]]', /unknown agent token `branch`/],
			['[ui.sidebar.agents]\nrows = [["git_status"]]', /unknown agent token `git_status`/],
			['[ui.sidebar.agents]\nrows = [["bogus"]]', /unknown agent token `bogus`/],
			['[ui.sidebar.spaces]\nrows = [["$"]]', /invalid custom token `\$`/],
			['[ui.sidebar.spaces]\nrows = [["$x.y"]]', /invalid custom token `\$x\.y`/],
			[`[ui.sidebar.spaces]\nrows = [["$${'a'.repeat(33)}"]]`, /invalid custom token/],
			['[ui.sidebar.agents]\nrows = [[{token="agent", italic=true}]]', /unknown key `italic`/],
			['[ui.sidebar.agents]\nrows = [[{fg="#fff"}]]', /needs `token`/],
			['[ui.sidebar.agents]\nrows = [[{token="agent", fg = "blue"}]]', /invalid fg `blue`/],
			['[ui.sidebar.agents]\nrows = [[{token="agent", bold = 1}]]', /bold must be a boolean/],
			['[ui.sidebar.agents]\nrows = 5', /^ui\.sidebar\.agents\.rows must be an array of arrays$/],
			['[ui.sidebar.agents]\nrows = ["agent"]', /must be an array of arrays/],
			['[ui]\nsidebar = 3', /ui\.sidebar must be a table/],
			['ui = 1', /ui must be a table/],
			['[ui.sidebar.agents]\nrows_by_agent = 1', /rows_by_agent must be a table/],
			['[ui.sidebar.agents.rows_by_agent]\nclaude = [["branch"]]', /unknown agent token `branch`/],
			['[ui.sidebar.spaces]\nrow_gap = "x"', /row_gap must be an integer/],
			['[ui.sidebar.spaces]\nrow_gap = -1', /row_gap must be an integer/],
			['[ui.sidebar.agents]\nrow_gap = 1.5', /row_gap must be an integer/],
			['x = [', /^Invalid TOML document/],
			['a = 1\na = 2', /^Invalid TOML document/],
		];
		for (const [text, re] of cases) {
			const e = error(text);
			assert.match(e, re, text);
			assert.ok(!e.includes('\n'), 'one line');
		}
	});
});

suite('sidebar config: load and poll', () => {
	let dir: string;
	let logs: string[];
	let source: SidebarConfigSource | undefined;
	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sidebar-'));
		logs = [];
	});
	teardown(() => {
		source?.dispose();
		source = undefined;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const waitFor = async (what: string, ms: number, ok: () => boolean): Promise<number> => {
		const start = Date.now();
		while (Date.now() - start < ms) {
			if (ok()) {
				return Date.now() - start;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`timed out after ${ms} ms waiting for ${what}`);
	};

	test('missing file: defaults, nothing logged; a directory: defaults, logged', async () => {
		assert.deepStrictEqual(await loadSidebarConfig(path.join(dir, 'none.toml')), { status: 'missing' });
		source = new SidebarConfigSource(path.join(dir, 'none.toml'), (l) => logs.push(l));
		await source.setEnabled(true);
		assert.strictEqual(source.config, undefined);
		assert.deepStrictEqual(logs, []);
		source.dispose();
		source = new SidebarConfigSource(dir, (l) => logs.push(l));
		await source.setEnabled(true);
		assert.strictEqual(source.config, undefined);
		assert.strictEqual(logs.length, 1);
		assert.match(logs[0], new RegExp(`^sidebar config: ${dir}: .+; using default rows$`));
	});

	test('the same invalid file polled twice logs once; a valid load logs loaded', async () => {
		const file = path.join(dir, 'config.toml');
		fs.writeFileSync(file, '[ui.sidebar.agents]\nrows = [["bogus"]]\n');
		source = new SidebarConfigSource(file, (l) => logs.push(l));
		await source.setEnabled(true);
		await source.reload();
		await source.reload();
		assert.deepStrictEqual(logs, [`sidebar config: ${file}: unknown agent token \`bogus\`; using default rows`]);
		assert.strictEqual(source.config, undefined);
		fs.writeFileSync(file, FIXTURE);
		await source.reload();
		await source.reload();
		assert.deepStrictEqual(logs.slice(1), [`sidebar config: ${file}: loaded`]);
		assert.deepStrictEqual(source.config, FIXTURE_JSON);
	});

	test('disabled: not read; enabling loads, disabling drops (one change event each)', async () => {
		const file = path.join(dir, 'config.toml');
		fs.writeFileSync(file, FIXTURE);
		source = new SidebarConfigSource(file, (l) => logs.push(l));
		let changes = 0;
		source.onDidChange(() => changes++);
		await source.setEnabled(false);
		assert.strictEqual(source.config, undefined);
		assert.strictEqual(changes, 0);
		await source.setEnabled(true);
		assert.deepStrictEqual(source.config, FIXTURE_JSON);
		assert.strictEqual(changes, 1);
		await source.setEnabled(false);
		assert.strictEqual(source.config, undefined);
		assert.strictEqual(changes, 2);
	});

	test('a written file re-renders within 5 s; deleting it returns to defaults; a retargeted symlink is picked up', async function () {
		this.timeout(30000);
		const file = path.join(dir, 'config.toml');
		source = new SidebarConfigSource(file, (l) => logs.push(l));
		await source.setEnabled(true);
		assert.strictEqual(source.config, undefined);
		// What the views do on a change: rebuild their rows from the source.
		const src: AgentSource[] = [{ sessionKey: 'host/s', rowLabel: 's', snapshot: agentSnapshot({ agent: 'copilot' }), envKind: 'host', envLabel: 'this machine' }];
		const description = () => agentRows(src, 'all', NOW, source!.config?.agents)[0].description;
		let rendered = description();
		source.onDidChange(() => (rendered = description()));
		assert.strictEqual(rendered, 's › v3_auth · working');
		fs.writeFileSync(file, '[ui.sidebar.agents]\nrows = [["agent"], ["tab"]]\n');
		const ms = await waitFor('configured rows', 5000, () => rendered === 'agents');
		console.log(`[sidebar-config] new file picked up after ${ms} ms`);
		fs.unlinkSync(file);
		await waitFor('defaults after delete', 5000, () => rendered === 's › v3_auth · working');
		const a = path.join(dir, 'a.toml');
		const b = path.join(dir, 'b.toml');
		fs.writeFileSync(a, '[ui.sidebar.agents]\nrows = [["workspace"]]\n');
		fs.writeFileSync(b, '[ui.sidebar.agents]\nrows = [["agent", "tab"]]\n');
		fs.symlinkSync(a, file);
		await waitFor('symlink target a', 5000, () => rendered === 'v3_auth');
		fs.unlinkSync(file);
		fs.symlinkSync(b, file);
		await waitFor('symlink target b', 5000, () => rendered === 'agents');
	});
});

suite('snapshot: tokens, state_labels, terminal_title', () => {
	test('kept, with non-string values dropped', () => {
		const s = parseSnapshot({
			workspaces: [
				{ workspace_id: 'w1', number: 1, label: 'a', tokens: { jj_status: 'jj:kq', n: 5, x: null } },
				{ workspace_id: 'w2', number: 2, label: 'b' },
			],
			tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: '1' }],
			panes: [
				{
					pane_id: 'p1',
					tab_id: 't1',
					workspace_id: 'w1',
					agent: 'claude',
					agent_status: 'blocked',
					terminal_title: '✳ Refactoring',
					tokens: { ticket: 'DH-42', bad: { a: 1 } },
					state_labels: { blocked: 'needs approval', working: 3 },
				},
				{ pane_id: 'p2', tab_id: 't1', workspace_id: 'w1', terminal_title: 7, tokens: 'x', state_labels: [] },
			],
		})!;
		assert.deepStrictEqual(s.workspaces.map((w) => w.tokens), [{ jj_status: 'jj:kq' }, {}]);
		assert.deepStrictEqual(s.panes.map((p) => [p.terminal_title, p.tokens, p.state_labels]), [
			['✳ Refactoring', { ticket: 'DH-42' }, { blocked: 'needs approval' }],
			[undefined, {}, {}],
		]);
	});
});

const NOW = 10_000_000;

function agentSnapshot(o: {
	agent: string;
	status?: string;
	workspace?: string;
	tab?: string;
	title?: string;
	tokens?: Record<string, string>;
	stateLabels?: Record<string, string>;
	label?: string;
}): Snapshot {
	return parseSnapshot({
		workspaces: [{ workspace_id: 'w1', number: 1, label: o.workspace ?? 'v3_auth' }],
		tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: o.tab ?? 'agents' }],
		panes: [
			{
				pane_id: 'w1:p1',
				tab_id: 'w1:t1',
				workspace_id: 'w1',
				agent: o.agent,
				agent_status: o.status ?? 'working',
				label: o.label,
				terminal_title_stripped: o.title,
				tokens: o.tokens,
				state_labels: o.stateLabels,
			},
		],
	})!;
}

function agentRow(snap: Snapshot, agents: SidebarConfig['agents'], env: Pick<AgentSource, 'envKind' | 'envLabel'> = { envKind: 'host', envLabel: 'this machine' }) {
	const row = agentRows([{ sessionKey: 'host/s', rowLabel: 's', snapshot: snap, ...env }], 'all', NOW, agents)[0];
	return { label: row.label, description: row.description || undefined, icon: !row.noIcon };
}

suite('sidebar config: rendering', () => {
	const fixtureAgents = FIXTURE_JSON.agents;

	test('space rows: the examples', () => {
		const snap = parseSnapshot({
			workspaces: [
				{ workspace_id: 'w1', number: 1, label: 'deephaven-mcp / v3_auth', tokens: { jj_status: 'jj:kq' } },
				{ workspace_id: 'w2', number: 2, label: 'docs-review' },
			],
			tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1' }],
			panes: [
				{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'claude', agent_status: 'blocked', cwd: '/src/a' },
				{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'codex', agent_status: 'working', cwd: '/src/a' },
			],
		})!;
		const git = (id: string) => (id === 'w1' ? '⎇ v3_auth ● 4 ↑1' : undefined);
		const [first] = buildSpaces(snap, 'host/s', git, FIXTURE_JSON.spaces!.rows).map(spacesTreeItem);
		assert.strictEqual(first.label, 'deephaven-mcp / v3_auth');
		assert.strictEqual(first.description, 'jj:kq · ⎇ v3_auth ● 4 ↑1');
		assert.strictEqual((first.iconPath as vscode.ThemeIcon).id, 'circle-filled');
		assert.strictEqual(((first.iconPath as vscode.ThemeIcon).color as vscode.ThemeColor).id, 'charts.orange', 'worst status: blocked');
		const docs = spacesTreeItem(buildSpaces(snap, 'host/s', git, [['workspace'], ['state_text']])[1]);
		assert.strictEqual(docs.label, 'docs-review');
		assert.strictEqual(docs.description, undefined);
		assert.strictEqual(docs.iconPath, undefined, 'no state_icon: no icon');
		const st = spacesTreeItem(buildSpaces(snap, 'host/s', git, [['state_text', 'git_status', 'branch']])[0]);
		assert.strictEqual(st.label, 'deephaven-mcp / v3_auth', 'label fallback without `workspace`');
		assert.strictEqual(st.description, 'blocked · ● 4 ↑1 · ⎇ v3_auth', 'not adjacent in branch → git_status order: separate');
		const clean = spacesTreeItem(buildSpaces(snap, 'host/s', () => '⎇ main · clean ↓2', [['branch', 'git_status']])[0]);
		assert.strictEqual(clean.description, '⎇ main · clean ↓2', 'the pair renders as phase 19 does');
	});

	test('the git description splits into branch and status parts', () => {
		assert.deepStrictEqual(splitGitDescription('⎇ v3_auth ● 4 ↑1'), { branch: '⎇ v3_auth', status: '● 4 ↑1' });
		assert.deepStrictEqual(splitGitDescription('⎇ main · clean'), { branch: '⎇ main', status: 'clean' });
		assert.deepStrictEqual(splitGitDescription('⎇ main · clean ↓2'), { branch: '⎇ main', status: 'clean ↓2' });
	});

	test('agent rows: the examples', () => {
		assert.deepStrictEqual(agentRow(agentSnapshot({ agent: 'copilot' }), fixtureAgents), { label: 'copilot', description: 'v3_auth › agents', icon: true });
		assert.deepStrictEqual(
			agentRow(agentSnapshot({ agent: 'codex', workspace: 'infra-ci', tab: 'main', tokens: { ticket: 'DH-42' } }), fixtureAgents, { envKind: 'ssh', envLabel: 'buildbox' }),
			{ label: 'codex', description: 'buildbox · infra-ci › main · DH-42', icon: true },
		);
		assert.deepStrictEqual(agentRow(agentSnapshot({ agent: 'claude', title: 'Refactoring auth middleware' }), fixtureAgents), {
			label: 'claude',
			description: 'v3_auth › agents · Refactoring auth middleware',
			icon: true,
		});
		assert.deepStrictEqual(
			agentRow(agentSnapshot({ agent: 'claude', status: 'blocked', stateLabels: { blocked: 'needs approval' } }), { rows: [['agent', 'state_text']] }),
			{ label: 'claude', description: 'needs approval', icon: false },
		);
	});

	test('machine: none for host, the label for SSH and containers', () => {
		const rows = { rows: [['machine', 'agent']] };
		const snap = agentSnapshot({ agent: 'claude' });
		assert.strictEqual(agentRow(snap, rows).description, undefined);
		assert.strictEqual(agentRow(snap, rows, { envKind: 'ssh', envLabel: 'buildbox' }).description, 'buildbox');
		assert.strictEqual(agentRow(snap, rows, { envKind: 'container', envLabel: 'my-app' }).description, 'my-app');
	});

	test('duplicates once, empty values skipped, breadcrumbs, label fallback, state text, time in state', () => {
		const snap = agentSnapshot({ agent: 'claude', label: 'p-one', tokens: { a: 'A', empty: '  ' } });
		const r = (rows: SidebarRows) => agentRow(snap, { rows });
		assert.strictEqual(r([['tab', 'workspace', 'tab', 'workspace']]).description, 'agents · v3_auth', 'each kind once; label not repeated');
		assert.strictEqual(r([['agent', 'workspace'], ['$missing', '$empty', '$a']]).description, 'v3_auth · A', 'no doubled separator');
		assert.strictEqual(r([['workspace', 'tab', 'pane']]).description, 'v3_auth › agents › p-one');
		assert.strictEqual(r([['tab', '$missing', 'pane']]).description, 'agents › p-one', 'tab › pane across a skipped token');
		const noAgent = r([['workspace']]);
		assert.deepStrictEqual([noAgent.label, noAgent.description], ['claude', 'v3_auth'], 'label fallback without `agent`');
		assert.strictEqual(r([['state_text']]).description, 'working');
		assert.strictEqual(agentRow(agentSnapshot({ agent: 'x', status: 'unknown' }), { rows: [['state_text']] }).description, undefined);
		const since = agentSnapshot({ agent: 'claude', status: 'blocked' });
		since.panes[0].state_since = NOW - 125_000;
		assert.strictEqual(agentRow(since, { rows: [['agent', 'workspace']] }).description, 'v3_auth · 2m', "phase 19's time in state last");
		assert.strictEqual(agentRow(since, { rows: [['agent']] }).description, '2m');
	});

	test('rows_by_agent picks by exact agent; with only rows_by_agent, others keep the default row', () => {
		const byAgent = { rowsByAgent: { claude: [['agent', 'tab']] } };
		assert.strictEqual(agentRow(agentSnapshot({ agent: 'claude' }), byAgent).description, 'agents');
		assert.strictEqual(agentRow(agentSnapshot({ agent: 'claude' }), { ...byAgent, rows: [['workspace']] }).description, 'agents');
		assert.strictEqual(agentRow(agentSnapshot({ agent: 'Claude' }), { ...byAgent, rows: [['workspace']] }).description, 'v3_auth');
		const codex = agentSnapshot({ agent: 'codex', title: 't' });
		codex.panes[0].state_since = NOW - 60_000;
		const src = [{ sessionKey: 'host/s', rowLabel: 's', snapshot: codex }];
		assert.deepStrictEqual(agentRows(src, 'all', NOW, byAgent), agentRows(src, 'all', NOW));
		assert.strictEqual(agentRows(src, 'all', NOW, byAgent)[0].description, 's › v3_auth · working 1m · t');
	});
});

suite('sidebar config: views keep the defaults without a config', () => {
	test('Spaces and Agents rows equal the defaults with no config, and with the setting off', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sidebar-'));
		try {
			const file = path.join(dir, 'config.toml');
			fs.writeFileSync(file, FIXTURE);
			const source = new SidebarConfigSource(file, () => undefined);
			const snap = agentSnapshot({ agent: 'copilot', title: 'T' });
			const src: AgentSource[] = [{ sessionKey: 'host/s', rowLabel: 's', snapshot: snap, envKind: 'host', envLabel: 'this machine' }];
			const git = () => '⎇ main ● 1';
			const spaces = () => buildSpaces(snap, 'host/s', git, source.config?.spaces?.rows).map(spacesTreeItem);
			const agents = () => agentRows(src, 'all', NOW, source.config?.agents);
			const defaults = { spaces: buildSpaces(snap, 'host/s', git).map(spacesTreeItem), agents: agentRows(src, 'all', NOW) };
			await source.setEnabled(false);
			assert.deepStrictEqual(spaces(), defaults.spaces);
			assert.deepStrictEqual(agents(), defaults.agents);
			assert.strictEqual(agents()[0].description, 's › v3_auth · working · T');
			let fired = false;
			source.onDidChange(() => (fired = true));
			await source.setEnabled(true);
			assert.ok(fired, 'a load event');
			assert.strictEqual(spaces()[0].description, '⎇ main ● 1');
			assert.notDeepStrictEqual(agents(), defaults.agents);
			assert.strictEqual(agents()[0].description, 'v3_auth › agents');
			await source.setEnabled(false);
			assert.deepStrictEqual(agents(), defaults.agents);
			source.dispose();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
