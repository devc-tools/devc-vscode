import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Environment } from '../environments';
import { focusedPaneStatus } from '../focus';
import { LocalShell } from '../remoteShell';
import { EnvState, SessionConnection } from '../sessions';
import { agentIcon, countsDescription, statusIcon, statusIconSpec, statusRank, worstStatus } from '../status';
import { activeTabOf, eventTouchesTab, stripTabs, tileMetas } from '../tilesPanel';
import { makePaneKey, splitPaneKey } from '../tilesProtocol';
import { sessionStatusText } from '../status';
import { agentRows, agentsViewDescription, AgentSource, blockedCount, filterPickItems, scopeSources, sortAndFilterAgents, toFilter, toScope } from '../views/agentsView';
import {
	effectiveSelection,
	groupOf,
	newSessionPlaces,
	SessionRowNode,
	sessionPickAction,
	sessionPickButtons,
	sessionPickEntries,
	sessionRows,
	sessionRowStatus,
	sessionTreeContextValue,
	sessionTreeDescription,
	validateSessionName,
} from '../views/sessionsView';
import { SessionSpaceNode, sessionRowOf, sessionsRoots, sessionsRootTreeItem, sessionSpaceTreeItem, sessionTreeIcon, sessionTreeItem } from '../views/sessionsTree';
import { agentTooltip, buildSpaces, paneDescription, paneClickCommand, spaceHome, paneTreeItem, SpaceNode, spacesTreeItem, tabSummary } from '../views/spacesView';
import { Snapshot, SnapshotPane } from '../sessions';
import { RAW_SNAPSHOT, snapshot } from './fixtures';

const shell = new LocalShell();
const hostEnv: Environment = { key: 'host', kind: 'host', label: 'this machine', shell };
const containerEnv: Environment = {
	key: 'container:3f2a9c1b04de',
	kind: 'container',
	label: 'my-app',
	containerId: '3f2a9c1b04de',
	user: 'vscode',
	shell,
};

function conn(state: SessionConnection['state'], withSnapshot = state === 'connected'): SessionConnection {
	return { state, snapshot: withSnapshot ? snapshot() : undefined } as SessionConnection;
}

suite('status presentation', () => {
	test('icons and ranks', () => {
		assert.deepStrictEqual(statusIconSpec('blocked'), { id: 'circle-filled', color: 'charts.orange' });
		assert.deepStrictEqual(statusIconSpec('working'), { id: 'circle-filled', color: 'charts.blue' });
		assert.deepStrictEqual(statusIconSpec('done'), { id: 'circle-filled', color: 'charts.green' });
		assert.deepStrictEqual(statusIconSpec('idle'), { id: 'circle-filled', color: 'disabledForeground' });
		assert.deepStrictEqual(statusIconSpec('unknown'), { id: 'circle-filled', color: 'disabledForeground' });
		assert.deepStrictEqual(
			(['blocked', 'working', 'done', 'idle', 'unknown'] as const).map(statusRank),
			[0, 1, 2, 3, 4],
		);
	});

	test('counts description', () => {
		assert.strictEqual(countsDescription({ blocked: 2, working: 1, done: 0 }), '2 blocked · 1 working');
		assert.strictEqual(countsDescription({ blocked: 0, working: 0, done: 3 }), '3 done');
		assert.strictEqual(countsDescription({ blocked: 1, working: 1, done: 1 }), '1 blocked · 1 working · 1 done');
		assert.strictEqual(countsDescription({ blocked: 0, working: 0, done: 0 }), 'idle');
	});

	test('worst-status rollup', () => {
		assert.strictEqual(worstStatus(['idle', 'done', 'working']), 'working');
		assert.strictEqual(worstStatus(['unknown', 'blocked', 'idle']), 'blocked');
		assert.strictEqual(worstStatus(['unknown', 'idle']), 'idle');
		assert.strictEqual(worstStatus([]), undefined);
	});
});

suite('pane identity', () => {
	const base = (extra: Partial<SnapshotPane>): SnapshotPane => ({
		pane_id: 'p',
		tab_id: 't',
		workspace_id: 'w',
		agent_status: 'unknown',
		raw_status: 'unknown',
		focused: false,
		...extra,
	});

	test('paneDescription: an agent its folder, omitted when it is the name; a shell its full path', () => {
		const agent = base({ agent: 'claude', foreground_cwd: '/src/api/', cwd: '/src', terminal_title_stripped: 'Task' });
		assert.strictEqual(paneDescription(agent, 'Task'), 'api');
		assert.strictEqual(paneDescription(agent, 'api'), undefined);
		assert.strictEqual(paneDescription(base({ agent: 'claude' }), 'claude'), undefined, 'no directory');
		assert.strictEqual(paneDescription(base({ foreground_cwd: '/src/api/test', cwd: '/src/api' }), 'test'), '/src/api/test');
		assert.strictEqual(paneDescription(base({ cwd: '/src/api' }), 'api'), '/src/api');
		// The space's own directory, by full path.
		assert.strictEqual(paneDescription(agent, 'Task', '/src/api'), undefined, 'in the space\'s directory');
		assert.strictEqual(paneDescription(agent, 'Task', '/work/api'), 'api', 'same folder name, elsewhere');
		assert.strictEqual(paneDescription(base({ cwd: '/src/api' }), 'x', '/src/api'), '/src/api', 'shells keep their path');
	});

	test('spaceHome: the checkout, else the first pane\'s starting cwd (not the focused one\'s)', () => {
		const snap = (checkoutPath?: string) =>
			({
				workspaces: [{ workspace_id: 'w', checkoutPath }],
				panes: [
					base({ pane_id: 'p1', cwd: '/src/api', foreground_cwd: '/src/api/web' }),
					base({ pane_id: 'p2', cwd: '/tmp', focused: true }),
				],
			}) as unknown as Snapshot;
		assert.strictEqual(spaceHome(snap(), 'w'), '/src/api');
		assert.strictEqual(spaceHome(snap('/wt/api'), 'w'), '/wt/api');
		assert.strictEqual(spaceHome(snap(), 'other'), undefined);
	});

	test('agentIcon: the mark coloured by status, the dot for other agents, nothing for a shell', () => {
		const claude = agentIcon(base({ agent: 'claude', agent_status: 'blocked' }))!;
		assert.strictEqual(claude.id, 'herdr-agent-claude');
		assert.strictEqual((claude.color as vscode.ThemeColor).id, 'charts.orange');
		for (const [agent, status, color] of [
			['copilot', 'working', 'charts.blue'],
			['pi', 'done', 'charts.green'],
			['opencode', 'idle', 'disabledForeground'],
		] as const) {
			const icon = agentIcon(base({ agent, agent_status: status }))!;
			assert.strictEqual(icon.id, `herdr-agent-${agent}`);
			assert.strictEqual((icon.color as vscode.ThemeColor).id, color);
		}
		const codex = agentIcon(base({ agent: 'codex', agent_status: 'blocked' }))!;
		assert.strictEqual(codex.id, 'circle-filled');
		assert.strictEqual((codex.color as vscode.ThemeColor).id, 'charts.orange');
		const shell = agentIcon(base({}));
		assert.strictEqual(shell.id, 'terminal');
		assert.strictEqual(shell.color, undefined, 'a shell: the terminal icon, uncoloured');
	});

	test('contributes.icons: exactly the four marks, from the bundled font', () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const font = { fontPath: 'resources/agent-icons.woff' };
		assert.deepStrictEqual(ext.packageJSON.contributes.icons, {
			'herdr-agent-claude': { description: 'Claude Code', default: { ...font, fontCharacter: '\\E001' } },
			'herdr-agent-copilot': { description: 'GitHub Copilot', default: { ...font, fontCharacter: '\\E002' } },
			'herdr-agent-pi': { description: 'pi', default: { ...font, fontCharacter: '\\E003' } },
			'herdr-agent-opencode': { description: 'OpenCode', default: { ...font, fontCharacter: '\\E004' } },
		});
		assert.ok(fs.statSync(path.join(ext.extensionPath, 'resources', 'agent-icons.woff')).size > 0);
	});
});

suite('Spaces items', () => {
	const spaces = buildSpaces(snapshot(), 'host/code-wksp');

	test('spaces ordered by number, tabs by number, panes in snapshot order', () => {
		assert.deepStrictEqual(
			spaces.map((s) => s.label),
			['web', 'api'],
		);
		assert.deepStrictEqual(
			spaces[0].children.map((t) => t.label),
			['1', 'logs'],
		);
		assert.deepStrictEqual(
			spaces[1].children[0].children.map((p) => p.label),
			['api-fixer', 'zsh'],
		);
	});

	test('labels, descriptions and contextValues', () => {
		const web = spacesTreeItem(spaces[0]);
		assert.strictEqual(web.description, 'frontend');
		assert.strictEqual(web.contextValue, 'herdr.space');
		assert.strictEqual(spacesTreeItem(spaces[1]).description, undefined, 'repo name equal to the label is hidden');
		assert.strictEqual(spacesTreeItem(spaces[0].children[0]).contextValue, 'herdr.tab');

		const [agentPane, shellPane] = spaces[1].children[0].children;
		const agentItem = spacesTreeItem(agentPane);
		assert.strictEqual(agentItem.description, undefined, 'in the space\'s own directory');
		assert.strictEqual(agentItem.contextValue, 'herdr.pane.agent');
		assert.strictEqual((agentItem.iconPath as vscode.ThemeIcon).id, 'herdr-agent-claude');
		assert.strictEqual(((agentItem.iconPath as vscode.ThemeIcon).color as vscode.ThemeColor).id, 'charts.blue');
		assert.deepStrictEqual(agentItem.command?.arguments, ['host/code-wksp', 'w2:p1']);
		assert.strictEqual(agentItem.command?.command, 'herdr.openPaneTab');

		const shellItem = spacesTreeItem(shellPane);
		assert.strictEqual(shellItem.description, '/src/api/test', 'foreground_cwd before cwd');
		assert.strictEqual(shellItem.contextValue, 'herdr.pane.shell');
		assert.strictEqual((shellItem.iconPath as vscode.ThemeIcon).id, 'terminal', 'a shell: the terminal icon');

		const codex = spaces[0].children[0].children[0];
		assert.strictEqual(codex.label, 'web', 'the folder before the agent kind');
		assert.strictEqual(codex.description, undefined, 'the folder is the name: no description');
		assert.strictEqual((spacesTreeItem(codex).iconPath as vscode.ThemeIcon).id, 'circle-filled', 'codex has no mark');
	});

	test('focused spaces and tabs are expanded, others collapsed', () => {
		const E = vscode.TreeItemCollapsibleState.Expanded;
		const C = vscode.TreeItemCollapsibleState.Collapsed;
		assert.strictEqual(spacesTreeItem(spaces[0]).collapsibleState, C);
		assert.strictEqual(spacesTreeItem(spaces[1]).collapsibleState, E);
		assert.strictEqual(spacesTreeItem(spaces[0].children[0]).collapsibleState, E);
		assert.strictEqual(spacesTreeItem(spaces[0].children[1]).collapsibleState, C);
	});

	test('space icon is its worst agent status', () => {
		assert.strictEqual(spaces[0].status, 'blocked');
		assert.strictEqual(spaces[1].status, 'working');
	});
});

suite('pane row clicks', () => {
	const ref = { sessionKey: 'host/s', paneId: 'w1:p1' };

	test('pane and agent rows open the pane in its space', () => {
		assert.deepStrictEqual(paneClickCommand(ref), { command: 'herdr.openPaneTab', title: 'Open in herdr Space', arguments: ['host/s', 'w1:p1'] });
		const pane = snapshot().panes[0];
		assert.strictEqual(paneTreeItem('i', 'l', undefined, pane, ref).command?.command, 'herdr.openPaneTab');
	});

	test('tab rows open their space on that tab; space rows open the space', () => {
		const space = buildSpaces(snapshot(), 'host/s')[0];
		assert.strictEqual(spacesTreeItem(space.children[0]).command?.command, 'herdr.openTab');
		assert.deepStrictEqual(spacesTreeItem(space).command, { command: 'herdr.openSpace', title: 'Open herdr Space', arguments: ['host/s', space.workspaceId] });
	});
});

suite('Agents', () => {
	const sources = [
		{ sessionKey: 'host/b', rowLabel: 'b', snapshot: snapshot() },
		{ sessionKey: 'host/a', rowLabel: 'a', snapshot: snapshot() },
	];
	const rows = agentRows(sources);

	test('every agent pane, with session › workspace description', () => {
		assert.strictEqual(rows.length, 6);
		const fixer = rows.find((r) => r.ref.paneId === 'w2:p1' && r.rowLabel === 'a');
		assert.ok(fixer);
		assert.strictEqual(fixer.label, 'api-fixer');
		assert.strictEqual(fixer.description, 'a › api · working · Refactoring');
		const codex = rows.find((r) => r.ref.paneId === 'w1:p1' && r.rowLabel === 'a');
		assert.strictEqual(codex?.description, 'a › web · blocked');
	});

	test('sorted by status, then session row label, then workspace number', () => {
		assert.deepStrictEqual(
			sortAndFilterAgents(rows, 'all').map((r) => `${r.pane.agent_status} ${r.rowLabel} ${r.workspaceNumber}`),
			['blocked a 1', 'blocked b 1', 'working a 2', 'working b 2', 'done a 1', 'done b 1'],
		);
	});

	test('filters', () => {
		assert.deepStrictEqual(
			sortAndFilterAgents(rows, 'blocked').map((r) => r.pane.agent_status),
			['blocked', 'blocked'],
		);
		assert.deepStrictEqual(
			sortAndFilterAgents(rows, 'working').map((r) => r.rowLabel),
			['a', 'b'],
		);
		assert.strictEqual(sortAndFilterAgents(rows, 'all').length, 6);
		assert.strictEqual(blockedCount(rows), 2);
		assert.deepStrictEqual(
			sortAndFilterAgents(rows, 'done').map((r) => [r.pane.agent_status, r.rowLabel]),
			[
				['done', 'a'],
				['done', 'b'],
			],
		);
		assert.deepStrictEqual(['all', 'blocked', 'working', 'done', 'idle', undefined].map(toFilter), ['all', 'blocked', 'working', 'done', 'all', 'all']);
		assert.deepStrictEqual(['all', 'session', 'x', undefined].map(toScope), ['all', 'session', 'all', 'all']);
	});

	/** One agent pane with a displayed status, state start and title. */
	const one = (status: SnapshotPane['agent_status'], since?: number, title?: string, ws = { label: 'v3_auth', id: 'w1' }, tab = 'agents'): Snapshot =>
		({
			workspaces: [{ workspace_id: ws.id, label: ws.label, number: 1, focused: true }],
			tabs: [{ tab_id: 't1', workspace_id: ws.id, label: tab, number: 1, focused: true }],
			panes: [
				{
					pane_id: 'p1',
					tab_id: 't1',
					workspace_id: ws.id,
					agent: 'claude',
					agent_status: status,
					raw_status: status === 'done' ? 'idle' : status,
					state_since: since,
					terminal_title_stripped: title,
					focused: false,
				},
			],
			agentNames: new Map(),
		}) as Snapshot;
	const NOW = 10_000_000;

	test('row descriptions in both scopes: state, elapsed only when observed, unknown omitted', () => {
		const desc = (snap: Snapshot, scope: 'all' | 'session', rowLabel = 'deephaven-mcp') =>
			agentRows([{ sessionKey: 'host/s', rowLabel, snapshot: snap }], scope, NOW)[0].description;
		assert.strictEqual(desc(one('blocked', NOW - 125_000), 'all'), 'deephaven-mcp › v3_auth · blocked 2m');
		// The title is the row's name: not repeated in the description.
		assert.strictEqual(desc(one('working', NOW - 180_000, 'Refactoring auth middleware'), 'session'), 'v3_auth › agents · working 3m');
		assert.strictEqual(desc(one('idle', undefined, undefined, { label: 'api', id: 'w1' }), 'all', 'code-wksp'), 'code-wksp › api · idle');
		assert.strictEqual(desc(one('done', NOW - 10_000, undefined, { label: 'web', id: 'w1' }), 'all', 'my-app'), 'my-app › web · done <1m');
		assert.strictEqual(desc(one('unknown', NOW - 10_000, 'zsh'), 'all', 'x'), 'x › v3_auth');
		const pane = one('blocked', NOW - 125_000).panes[0];
		assert.strictEqual(agentTooltip(pane, NOW), 'claude · blocked for 2m\np1');
		assert.strictEqual(agentTooltip({ ...pane, state_since: undefined }, NOW), 'claude · blocked\np1');
	});

	test('scope: all sessions, the selected session, or none without one', () => {
		const srcs: AgentSource[] = [
			{ sessionKey: 'host/a', rowLabel: 'a', snapshot: snapshot() },
			{ sessionKey: 'host/b', rowLabel: 'b', snapshot: snapshot() },
		];
		assert.strictEqual(scopeSources(srcs, 'all', undefined).length, 2);
		assert.deepStrictEqual(scopeSources(srcs, 'session', 'host/b').map((s) => s.sessionKey), ['host/b']);
		assert.deepStrictEqual(scopeSources(srcs, 'session', undefined), []);
		const scoped = agentRows(scopeSources(srcs, 'session', 'host/b'), 'session');
		assert.deepStrictEqual(
			scoped.map((r) => r.description),
			['api › main · working · Refactoring', 'web › 1 · blocked', 'web › logs · done'],
		);
	});

	test('view description: counts with filter all, `<filter> n of m` filtered', () => {
		const inScope = agentRows([{ sessionKey: 'host/a', rowLabel: 'a', snapshot: snapshot() }]);
		assert.strictEqual(agentsViewDescription('all', 'all', inScope), 'all sessions · 1 blocked · 1 working · 1 done');
		assert.strictEqual(agentsViewDescription('session', 'all', []), 'this session');
		assert.strictEqual(agentsViewDescription('all', 'blocked', [...inScope, ...rows]), 'all sessions · blocked 3 of 9');
		assert.strictEqual(agentsViewDescription('session', 'done', inScope), 'this session · done 1 of 3');
		const idle = agentRows([{ sessionKey: 'host/a', rowLabel: 'a', snapshot: one('idle') }]);
		assert.strictEqual(agentsViewDescription('all', 'all', idle), 'all sessions · idle');
	});

	test('Filter Agents… items: order, counts in scope, a check on the current one', () => {
		const items = filterPickItems(rows, 'done');
		assert.deepStrictEqual(
			items.map((i) => [i.label, i.description, i.filter]),
			[
				['All', '6', 'all'],
				['Blocked', '2', 'blocked'],
				['Working', '2', 'working'],
				['Done', '2', 'done'],
			],
		);
		assert.deepStrictEqual(
			items.map((i) => (i.iconPath as vscode.ThemeIcon | undefined)?.id),
			[undefined, undefined, undefined, 'check'],
		);
	});
});

suite('Spaces summaries', () => {
	const p = (agent?: string, display_agent?: string) => ({ pane_id: 'x', agent, display_agent }) as SnapshotPane;

	test('tab summary: agents, shells, mixed, repeated kinds, empty', () => {
		assert.strictEqual(tabSummary([p('claude'), p('copilot')]), 'claude, copilot');
		assert.strictEqual(tabSummary([p()]), 'shell');
		assert.strictEqual(tabSummary([p(), p()]), 'shell \u00D72');
		assert.strictEqual(tabSummary([p('claude'), p(), p('codex'), p('claude')]), 'claude \u00D72, codex + shell');
		assert.strictEqual(tabSummary([p('codex', 'Codex')]), 'Codex');
		assert.strictEqual(tabSummary([]), undefined);
	});

	test('tab rows and space rows: descriptions and tooltips', () => {
		const spaces = buildSpaces(snapshot(), 'host/s', (id, dir) => (id === 'w2' && dir === '/src/api' ? '\u2387 main · clean' : undefined));
		assert.deepStrictEqual(
			spaces.flatMap((s) => s.children.map((t) => spacesTreeItem(t).description)),
			['Codex', 'claude', 'claude + shell'],
		);
		const [web, api] = spaces.map(spacesTreeItem);
		assert.strictEqual(api.description, '\u2387 main · clean', 'git when known');
		assert.strictEqual(web.description, 'frontend', 'repo name fallback');
		assert.strictEqual(api.tooltip, 'api\napi\n/src/api\n1 working');
		assert.strictEqual(web.tooltip, 'web\nfrontend\n/src/web\n1 blocked · 1 done');
	});
});

suite('Sessions rows', () => {
	const okHost = (sessions: EnvState['sessions']): EnvState => ({ env: hostEnv, status: 'ok', sessions });

	test('groups', () => {
		assert.strictEqual(groupOf(hostEnv).label, 'This machine');
		assert.strictEqual(groupOf({ kind: 'ssh', key: 'ssh:box', alias: 'box' }).label, 'SSH · box');
		assert.strictEqual(groupOf(containerEnv).label, 'Dev containers');
	});

	test('running sessions by connection state; this machine lists stopped ones too', () => {
		const state = okHost([
			{ name: 'a', default: true, running: true },
			{ name: 'b', default: false, running: true },
			{ name: 'c', default: false, running: true },
			{ name: 'old', default: false, running: false },
		]);
		const conns: Record<string, SessionConnection> = {
			'host/a': conn('connected'),
			'host/b': conn('unsupported'),
			'host/c': conn('disconnected'),
		};
		const rows = sessionRows(state, (k) => conns[k], false);
		assert.deepStrictEqual(
			rows.map((r) => [r.label, r.description, r.contextValue]),
			[
				['a', '1 blocked · 1 working · 1 done', 'herdr.session.running'],
				['b', 'needs herdr 0.9.5 or later', 'herdr.session.running'],
				['c', 'disconnected', 'herdr.session.running'],
				['old', 'stopped', 'herdr.session.stopped'],
			],
		);
		assert.strictEqual(rows[0].tooltip, 'host/a\nherdr 0.9.5');
	});

	test('environment rows', () => {
		assert.deepStrictEqual(
			sessionRows({ env: hostEnv, status: 'notInstalled', sessions: [] }, () => undefined, false).map((r) => [
				r.description,
				r.contextValue,
			]),
			[['herdr not installed', 'herdr.session.absent']],
		);
		assert.strictEqual(
			sessionRows({ env: { ...hostEnv, kind: 'ssh' }, status: 'unreachable', sessions: [] }, () => undefined, false)[0]
				.description,
			'unreachable',
		);
		const none = sessionRows({ env: containerEnv, status: 'ok', sessions: [] }, () => undefined, false);
		assert.deepStrictEqual(
			none.map((r) => [r.label, r.description]),
			[['my-app', 'herdr not running']],
		);
	});

	test('container rows: folder name, session name first unless devc', () => {
		const rows = sessionRows(
			{
				env: containerEnv,
				status: 'ok',
				sessions: [
					{ name: 'devc', default: false, running: true },
					{ name: 'other', default: false, running: true },
				],
			},
			() => conn('connected'),
			false,
		);
		assert.deepStrictEqual(
			rows.map((r) => [r.key, r.label, r.description]),
			[
				['container:3f2a9c1b04de/devc', 'my-app', '1 blocked · 1 working · 1 done'],
				['container:3f2a9c1b04de/other', 'my-app', 'other · 1 blocked · 1 working · 1 done'],
			],
		);
	});

	test('Start in dev containers: the herdr not running row starts devc', () => {
		const [row] = sessionRows({ env: containerEnv, status: 'ok', sessions: [] }, () => undefined, false);
		assert.deepStrictEqual([row.key, row.label, row.description, row.session, row.contextValue], [
			'container:3f2a9c1b04de/',
			'my-app',
			'herdr not running',
			'devc',
			'herdr.session.stopped',
		]);
		assert.strictEqual(sessionPickAction(row, 'container'), 'start');
		assert.deepStrictEqual(sessionPickButtons(row), [], 'not deletable');
		const notInstalled = sessionRows({ env: containerEnv, status: 'notInstalled', sessions: [] }, () => undefined, false)[0];
		assert.strictEqual(sessionPickAction(notInstalled, 'container'), 'none');
		assert.strictEqual(notInstalled.session, undefined);
		const hostNone = sessionRows({ env: hostEnv, status: 'ok', sessions: [] }, () => undefined, false)[0];
		assert.strictEqual(hostNone.contextValue, 'herdr.session.absent', "this machine's empty row is unchanged");
		assert.strictEqual(sessionPickAction(hostNone, 'host'), 'none');
	});

	test('picker actions: running selects, stopped starts (not on SSH), absent does nothing', () => {
		const running = { contextValue: 'herdr.session.running' as const, session: 'a' };
		const stopped = { contextValue: 'herdr.session.stopped' as const, session: 'a' };
		assert.strictEqual(sessionPickAction(running, 'host'), 'select');
		assert.strictEqual(sessionPickAction(running, 'ssh'), 'select');
		assert.strictEqual(sessionPickAction(stopped, 'host'), 'start');
		assert.strictEqual(sessionPickAction(stopped, 'container'), 'start');
		assert.strictEqual(sessionPickAction(stopped, 'ssh'), 'unsupported');
		assert.strictEqual(sessionPickAction({ contextValue: 'herdr.session.absent', session: undefined }, 'host'), 'none');
	});

	test('picker buttons: Stop on this machine\'s running sessions, Delete on all but the default one', () => {
		const rows = sessionRows(
			okHost([
				{ name: 'default', default: true, running: true },
				{ name: 'work', default: false, running: true },
				{ name: 'old', default: false, running: false },
			]),
			() => conn('connected'),
			false,
		);
		assert.deepStrictEqual(rows.map(sessionPickButtons), [['stop'], ['stop', 'delete'], ['delete']]);
		const container = sessionRows(
			{ env: containerEnv, status: 'ok', sessions: [{ name: 'devc', default: false, running: true }, { name: 'x', default: true, running: true }] },
			() => conn('connected'),
			false,
		);
		assert.deepStrictEqual(container.map(sessionPickButtons), [['delete'], []], 'no Stop in containers');
		const unreachable = sessionRows({ env: { ...hostEnv, kind: 'ssh', key: 'ssh:box', alias: 'box' }, status: 'unreachable', sessions: [] }, () => undefined, false);
		assert.deepStrictEqual(unreachable.map(sessionPickButtons), [[]]);
	});

	test('session status bar item: host, container, SSH', () => {
		const snap = snapshot();
		assert.deepStrictEqual(
			sessionStatusText({ sessionKey: 'host/code-wksp', rowLabel: 'code-wksp', envKind: 'host', session: 'code-wksp', snapshot: snap }),
			{ text: 'herdr: code-wksp', tooltip: 'host/code-wksp\nherdr 0.9.5\n1 blocked · 1 working · 1 done' },
		);
		assert.deepStrictEqual(
			sessionStatusText({ sessionKey: 'container:3f2a9c1b04de/devc', rowLabel: 'deephaven-mcp', envKind: 'container', session: 'devc' }),
			{ text: 'herdr: deephaven-mcp (devc)', tooltip: 'container:3f2a9c1b04de/devc' },
		);
		assert.deepStrictEqual(
			sessionStatusText({ sessionKey: 'ssh:buildbox/default', rowLabel: 'default', envKind: 'ssh', alias: 'buildbox', session: 'default', snapshot: { panes: [] } }),
			{ text: 'herdr: default (buildbox)', tooltip: 'ssh:buildbox/default\nidle' },
		);
	});

	test('selection falls back to the host default session, then the first running one', () => {
		const states: EnvState[] = [
			okHost([
				{ name: 'a', default: false, running: true },
				{ name: 'default', default: true, running: true },
			]),
			{ env: containerEnv, status: 'ok', sessions: [{ name: 'devc', default: false, running: true }] },
		];
		const all = (_k: string): SessionConnection | undefined => conn('connected');
		assert.strictEqual(effectiveSelection('container:3f2a9c1b04de/devc', states, all), 'container:3f2a9c1b04de/devc');
		assert.strictEqual(
			effectiveSelection('host/gone', states, (k) => (k === 'host/gone' ? undefined : all(k))),
			'host/default',
		);
		assert.strictEqual(
			effectiveSelection('host/gone', states, (k) => (k === 'host/gone' || k === 'host/default' ? undefined : all(k))),
			'host/a',
		);
		assert.strictEqual(effectiveSelection(undefined, states, () => undefined), undefined);
	});

	test('tab rows open the mirrored tab', () => {
		const tab = buildSpaces(snapshot(), 'host/s')[0].children[0];
		const item = spacesTreeItem(tab);
		assert.strictEqual(item.command?.command, 'herdr.openTab');
		assert.deepStrictEqual(item.command?.arguments, ['host/s', tab.tabId]);
	});

	test('re-layout events: by tab, by pane, others ignored', () => {
		const tabOf = (id: string) => (id === 'mine' ? 't1' : id === 'other' ? 't2' : undefined);
		const on = (event: string, data: Record<string, unknown>) => eventTouchesTab({ event, data }, 't1', tabOf);
		assert.strictEqual(on('layout.updated', { layout: { tab_id: 't1' } }), true);
		assert.strictEqual(on('layout.updated', { layout: { tab_id: 't2' } }), false);
		assert.strictEqual(on('pane.created', { pane: { pane_id: 'new', tab_id: 't1' } }), true);
		assert.strictEqual(on('pane.created', { pane: { pane_id: 'new', tab_id: 't2' } }), false);
		assert.strictEqual(on('tab.renamed', { tab_id: 't1', label: 'x' }), true);
		assert.strictEqual(on('pane.closed', { pane_id: 'mine' }), true);
		assert.strictEqual(on('pane.exited', { pane_id: 'other' }), false);
		assert.strictEqual(on('pane.closed', { pane_id: 'unknown' }), true, 'it might have been here');
		assert.strictEqual(on('pane.moved', { pane_id: 'other' }), true, 'it may have moved out of or into this tab');
		assert.strictEqual(on('pane.updated', { pane_id: 'mine' }), false);
	});

	test('a space\'s active tab: active_tab_id, else the first tab', () => {
		const s = snapshot();
		assert.strictEqual(s.workspaces.find((w) => w.workspace_id === 'w1')?.activeTabId, 'w1:t1');
		assert.strictEqual(activeTabOf(s, 'w1'), 'w1:t1');
		const raw = JSON.parse(JSON.stringify(RAW_SNAPSHOT));
		delete raw.workspaces[1].active_tab_id;
		assert.strictEqual(activeTabOf(snapshot(raw), 'w1'), 'w1:t2', 'missing: first in snapshot order');
		raw.workspaces[1].active_tab_id = 'w9:t9';
		assert.strictEqual(activeTabOf(snapshot(raw), 'w1'), 'w1:t2', 'unknown: first in snapshot order');
		raw.workspaces[1].active_tab_id = 'w2:t1';
		assert.strictEqual(activeTabOf(snapshot(raw), 'w1'), 'w1:t2', 'another space\'s tab: first');
		assert.strictEqual(activeTabOf(s, 'gone'), undefined);
	});

	test('tab strip: this space\'s tabs in snapshot order, worst status, the shown tab active', () => {
		const s = snapshot();
		assert.deepStrictEqual(stripTabs(s, 'w1', 'w1:t1'), [
			{ tabId: 'w1:t2', label: 'logs', status: 'done', active: false },
			{ tabId: 'w1:t1', label: '1', status: 'blocked', active: true },
		]);
		assert.deepStrictEqual(stripTabs(s, 'w2', 'w2:t1'), [{ tabId: 'w2:t1', label: 'main', status: 'working', active: true }]);
		const raw = JSON.parse(JSON.stringify(RAW_SNAPSHOT));
		raw.panes = raw.panes.filter((p: { agent?: string }) => !p.agent);
		assert.strictEqual(stripTabs(snapshot(raw), 'w2', undefined)[0].status, 'shell');
	});

	test('icons: off is an empty circle; idle (and a connected session or space without agents) is filled gray', () => {
		assert.strictEqual(statusIcon(undefined).id, 'circle-outline');
		const idle = statusIcon('idle');
		assert.strictEqual(idle.id, 'circle-filled');
		assert.strictEqual((idle.color as vscode.ThemeColor).id, 'disabledForeground');
		const raw = JSON.parse(JSON.stringify(RAW_SNAPSHOT));
		raw.panes = raw.panes.filter((p: { agent?: string }) => !p.agent);
		const noAgents = snapshot(raw);
		assert.strictEqual(sessionRowStatus(undefined), undefined, 'not connected: off');
		assert.strictEqual(sessionRowStatus(noAgents), 'idle');
		assert.strictEqual(sessionRowStatus(snapshot()), 'blocked');
		const space = buildSpaces(noAgents, 'host/s')[0];
		const icon = spacesTreeItem(space).iconPath as vscode.ThemeIcon;
		assert.strictEqual(icon.id, 'circle-filled');
		assert.strictEqual((icon.color as vscode.ThemeColor).id, 'disabledForeground');
	});

	test('tile headers', () => {
		const s = snapshot();
		assert.deepStrictEqual(tileMetas(s, 'host/s', 'w2:t1'), [
			{ paneKey: 'host/s|w2:p1', label: 'api-fixer', detail: 'api', status: 'working', agent: 'claude' },
			{ paneKey: 'host/s|w2:p2', label: 'zsh', detail: undefined, status: 'shell' },
		]);
		// The folder is not repeated when it is the name; strip entries keep their status dots.
		const t = snapshot();
		t.agentNames.clear();
		t.panes[0].terminal_title_stripped = undefined;
		assert.deepStrictEqual(tileMetas(t, 'host/s', 'w2:t1')[0], { paneKey: 'host/s|w2:p1', label: 'api', detail: undefined, status: 'working', agent: 'claude' });
		assert.deepStrictEqual(stripTabs(s, 'w2', 'w2:t1'), [{ tabId: 'w2:t1', label: 'main', status: 'working', active: true }]);
	});

	test('focused pane status bar text', () => {
		const s = snapshot();
		assert.deepStrictEqual(focusedPaneStatus(s, 'w2:p1', 'my-session'), {
			text: '$(herdr-agent-claude) api-fixer · working',
			tooltip: 'my-session › api › main',
		});
		assert.strictEqual(focusedPaneStatus(s, 'w2:p2', 'r')?.text, '$(terminal) zsh · shell', 'a shell: the terminal icon');
		assert.strictEqual(focusedPaneStatus(s, 'w1:p1', 'r')?.text, '$(circle-filled) web · blocked', 'an agent without a mark: the dot');
		assert.strictEqual(focusedPaneStatus(s, 'gone', 'r'), undefined);
	});

	test('pane keys round-trip', () => {
		assert.strictEqual(makePaneKey('container:abc/devc', 'w1:p2'), 'container:abc/devc|w1:p2');
		assert.deepStrictEqual(splitPaneKey('container:abc/devc|w1:p2'), { sessionKey: 'container:abc/devc', paneId: 'w1:p2' });
	});
});

suite('Switch Session picker', () => {
	const ssh: Environment = { ...hostEnv, kind: 'ssh', key: 'ssh:box', alias: 'box', label: 'box' };

	test('entries: a separator per place in order, its rows, icons, buttons and actions', () => {
		const states: EnvState[] = [
			{ env: hostEnv, status: 'ok', sessions: [{ name: 'default', default: true, running: true }, { name: 'old', default: false, running: false }] },
			{ env: ssh, status: 'unreachable', sessions: [] },
			{ env: containerEnv, status: 'ok', sessions: [] },
		];
		const groups = states.map((st) => groupOf(st.env));
		const rows = new Map(states.map((st) => [groupOf(st.env).id, sessionRows(st, () => conn('connected'), false)]));
		const kinds: Record<string, Environment['kind']> = { [hostEnv.key]: 'host', [ssh.key]: 'ssh', [containerEnv.key]: 'container' };
		const entries = sessionPickEntries(groups, rows, (k) => kinds[k]);
		assert.deepStrictEqual(
			entries.map((e) => (e.kind === 'separator' ? `-- ${e.label}` : [e.label, e.description, e.status ?? 'off', e.buttons.join('+'), e.action].join(' | '))),
			[
				'-- This machine',
				'default | 1 blocked · 1 working · 1 done | blocked | stop | select',
				'old | stopped | off | delete | start',
				'-- SSH · box',
				'box | unreachable | off |  | none',
				'-- Dev containers',
				'my-app | herdr not running | off |  | start',
			],
		);
	});

	test('showStoppedSessions hides stopped container and SSH rows, never this machine\'s', () => {
		const stopped = [{ name: 'old', default: false, running: false }];
		assert.deepStrictEqual(sessionRows({ env: hostEnv, status: 'ok', sessions: stopped }, () => undefined, false).map((r) => r.label), ['old']);
		assert.deepStrictEqual(sessionRows({ env: ssh, status: 'ok', sessions: stopped }, () => undefined, false).map((r) => r.contextValue), ['herdr.session.absent']);
		assert.deepStrictEqual(sessionRows({ env: ssh, status: 'ok', sessions: stopped }, () => undefined, true).map((r) => r.contextValue), ['herdr.session.stopped']);
	});

	test('New Session: places and name checks', () => {
		const other: Environment = { ...containerEnv, key: 'container:other', label: 'other' };
		assert.deepStrictEqual(
			newSessionPlaces([
				{ env: hostEnv, status: 'ok' },
				{ env: ssh, status: 'ok' },
				{ env: containerEnv, status: 'ok' },
				{ env: other, status: 'notInstalled' },
			]),
			[
				{ label: 'This machine', envKey: 'host' },
				{ label: 'my-app', description: 'Dev container', envKey: containerEnv.key },
			],
		);
		assert.deepStrictEqual(newSessionPlaces([]), [{ label: 'This machine', envKey: 'host' }], 'this machine always');
		assert.strictEqual(validateSessionName('  ', []), 'Enter a name.');
		assert.strictEqual(validateSessionName('my session', []), 'Use letters, digits, ".", "_" or "-".');
		assert.strictEqual(validateSessionName('-x', []), 'Use letters, digits, ".", "_" or "-".');
		assert.strictEqual(validateSessionName('work', ['default', 'work']), 'A session named "work" already exists there.');
		assert.strictEqual(validateSessionName('work-2.b_c', ['work']), undefined);
	});

	test('contributions: Sessions view first, old session commands gone; Select Session welcome; status bar click', () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'herdr-vscode')!;
		const c = ext.packageJSON.contributes;
		assert.strictEqual(c.views.herdr[0].id, 'herdr.sessions');
		assert.strictEqual(
			(c.viewsWelcome as { view: string; contents: string }[]).find((w) => w.view === 'herdr.sessions')?.contents,
			'No herdr sessions.\n[New Session](command:herdr.sessions.new)',
		);
		const all = JSON.stringify(ext.packageJSON);
		for (const gone of ['herdr.sessionsShown', 'herdr.sessionsManaging', 'herdr.sessions.manage', 'herdr.sessions.doneManaging', 'herdr.openSession', 'herdr.startSession', 'herdr.stopSession', 'herdr.deleteSession']) {
			assert.ok(!all.includes(gone), gone);
		}
		const cmd = c.commands.find((x: { command: string }) => x.command === 'herdr.sessions.switch');
		assert.deepStrictEqual([cmd.title, cmd.icon], ['Switch Session', '$(arrow-swap)']);
		const title = (c.menus['view/title'] as { command: string; when: string; group: string }[]).find((m) => m.command === 'herdr.sessions.switch')!;
		assert.deepStrictEqual([title.when, title.group], ['view == herdr.spaces', 'navigation@0']);
		const welcome = c.viewsWelcome as { view: string; contents: string; when: string }[];
		const select = 'No session selected.\n[Select Session](command:herdr.sessions.switch)';
		assert.strictEqual(welcome.find((w) => w.view === 'herdr.spaces' && w.when === '!herdr.sessionSelected')?.contents, select);
		assert.strictEqual(welcome.find((w) => w.view === 'herdr.agents' && w.when === 'herdr.agentsScope == session && !herdr.sessionSelected')?.contents, select);
		const status = fs.readFileSync(path.join(ext.extensionPath, 'src', 'status.ts'), 'utf8');
		assert.ok(status.includes("this.item.command = 'herdr.sessions.switch'"));
	});
});

suite('Sessions tree', () => {
	const sshEnv: Environment = { key: 'ssh:devbox', kind: 'ssh', label: 'devbox', alias: 'devbox', shell };
	const rowsOf = (state: EnvState, conns: Record<string, SessionConnection> = {}, showStopped = true) =>
		sessionRows(state, (k) => conns[k], showStopped);
	const noAgents = (): SessionConnection => {
		const s = snapshot();
		return { state: 'connected', snapshot: { ...s, panes: s.panes.map((p) => ({ ...p, agent: undefined })) } } as unknown as SessionConnection;
	};

	test('descriptions: environment · container session · status', () => {
		const host = rowsOf(
			{
				env: hostEnv,
				status: 'ok',
				sessions: [
					{ name: 'a', default: true, running: true },
					{ name: 'b', default: false, running: true },
					{ name: 'c', default: false, running: true },
					{ name: 'old', default: false, running: false },
				],
			},
			{ 'host/a': conn('connected'), 'host/b': noAgents() },
		);
		assert.deepStrictEqual(host.map(sessionTreeDescription), ['1 blocked · 1 working · 1 done', 'idle', 'connecting…', '']);
		const ssh = rowsOf(
			{
				env: sshEnv,
				status: 'ok',
				sessions: [
					{ name: 'api', default: true, running: true },
					{ name: 'nightly', default: false, running: false },
				],
			},
			{ 'ssh:devbox/api': conn('connected') },
		);
		assert.deepStrictEqual(ssh.map(sessionTreeDescription), ['ssh devbox · 1 blocked · 1 working · 1 done', 'ssh devbox · start not supported']);
		const container = rowsOf(
			{
				env: containerEnv,
				status: 'ok',
				sessions: [
					{ name: 'devc', default: false, running: true },
					{ name: 'web', default: false, running: true },
				],
			},
			{ [`${containerEnv.key}/devc`]: noAgents(), [`${containerEnv.key}/web`]: noAgents() },
		);
		assert.deepStrictEqual(container.map(sessionTreeDescription), ['idle', 'web · idle']);
		assert.deepStrictEqual(rowsOf({ env: containerEnv, status: 'ok', sessions: [] }).map(sessionTreeDescription), ['herdr not running']);
		assert.deepStrictEqual(rowsOf({ env: sshEnv, status: 'unreachable', sessions: [] }).map(sessionTreeDescription), ['ssh · unreachable']);
		assert.deepStrictEqual(rowsOf({ env: hostEnv, status: 'notInstalled', sessions: [] }).map(sessionTreeDescription), ['herdr not installed']);
	});

	test('context values', () => {
		const [running, stopped] = rowsOf({
			env: hostEnv,
			status: 'ok',
			sessions: [
				{ name: 'a', default: false, running: true },
				{ name: 'b', default: false, running: false },
			],
		});
		assert.strictEqual(sessionTreeContextValue(running), 'herdr.session.running host deletable');
		assert.strictEqual(sessionTreeContextValue(stopped), 'herdr.session.stopped host deletable');
		const [devc] = rowsOf({ env: containerEnv, status: 'ok', sessions: [{ name: 'devc', default: true, running: true }] });
		assert.strictEqual(sessionTreeContextValue(devc), 'herdr.session.running container');
		const [none] = rowsOf({ env: containerEnv, status: 'ok', sessions: [] });
		assert.strictEqual(sessionTreeContextValue(none), 'herdr.session.stopped container', 'herdr not running: Start starts devc');
		const [absent] = rowsOf({ env: sshEnv, status: 'unreachable', sessions: [] });
		assert.strictEqual(sessionTreeContextValue(absent), 'herdr.session.absent ssh');
	});

	test('roots: Running then Stopped, each omitted when empty', () => {
		assert.deepStrictEqual(sessionsRoots([]), []);
		const running = rowsOf({ env: hostEnv, status: 'ok', sessions: [{ name: 'a', default: true, running: true }] }, { 'host/a': conn('connected') });
		assert.deepStrictEqual(sessionsRoots(running).map((r) => [r.section, r.rows.length]), [['running', 1]]);
		const mixed = [
			...running,
			...rowsOf({ env: hostEnv, status: 'ok', sessions: [{ name: 'old', default: false, running: false }] }),
			...rowsOf({ env: sshEnv, status: 'unreachable', sessions: [] }),
		];
		assert.deepStrictEqual(sessionsRoots(mixed).map((r) => [r.section, r.rows.map((x) => x.label)]), [
			['running', ['a']],
			['stopped', ['old', 'devbox']],
		]);
		const [runningRoot, stoppedRoot] = sessionsRoots(mixed).map(sessionsRootTreeItem);
		assert.deepStrictEqual([runningRoot.label, runningRoot.collapsibleState, runningRoot.description], ['Running', vscode.TreeItemCollapsibleState.Expanded, '1']);
		assert.deepStrictEqual([stoppedRoot.label, stoppedRoot.collapsibleState, stoppedRoot.description], ['Stopped', vscode.TreeItemCollapsibleState.Collapsed, '2']);
	});

	test('session rows: highlighted when selected, icons, click selects running only', () => {
		const [a, old] = rowsOf(
			{
				env: hostEnv,
				status: 'ok',
				sessions: [
					{ name: 'a', default: true, running: true },
					{ name: 'old', default: false, running: false },
				],
			},
			{ 'host/a': conn('connected') },
		);
		const selected = sessionTreeItem(a, true);
		assert.strictEqual(selected.collapsibleState, vscode.TreeItemCollapsibleState.None, 'a running session with no spaces');
		assert.deepStrictEqual(selected.label, { label: 'a', highlights: [[0, 1]] });
		assert.strictEqual(selected.id, 'session|host/a');
		assert.ok(String(selected.tooltip).endsWith('\nSelected session'));
		assert.deepStrictEqual(selected.command?.arguments, ['host/a']);
		assert.strictEqual(selected.command?.command, 'herdr.sessions.select');
		const stopped = sessionTreeItem(old, false);
		assert.strictEqual(stopped.command, undefined);
		const icon = (i: vscode.TreeItem) => {
			const t = i.iconPath as vscode.ThemeIcon;
			return [t.id, t.color?.id];
		};
		assert.deepStrictEqual(icon(stopped), ['device-desktop', 'disabledForeground'], 'stopped: dimmed');
		assert.deepStrictEqual(icon(selected), ['device-desktop', 'charts.orange'], 'worst status: blocked');
		const [idle] = rowsOf({ env: containerEnv, status: 'ok', sessions: [{ name: 'devc', default: true, running: true }] }, { [`${containerEnv.key}/devc`]: noAgents() });
		assert.deepStrictEqual([sessionTreeIcon(idle).id, sessionTreeIcon(idle).color], ['package', undefined], 'idle: uncoloured');
		const [api] = rowsOf({ env: sshEnv, status: 'ok', sessions: [{ name: 'api', default: true, running: true }] }, { 'ssh:devbox/api': conn('disconnected') });
		assert.deepStrictEqual([sessionTreeIcon(api).id, sessionTreeIcon(api).color?.id], ['remote', 'disabledForeground'], 'not connected: dimmed');
		const [unreachable] = rowsOf({ env: sshEnv, status: 'unreachable', sessions: [] });
		assert.strictEqual(sessionTreeIcon(unreachable).id, 'warning');
		const [pending] = rowsOf({ env: sshEnv, status: 'pending', sessions: [] });
		assert.strictEqual(sessionTreeIcon(pending).id, 'loading~spin');
	});

	test('space rows: space name, then session · where · git · counts; the space\'s status icon; click opens it', () => {
		const [api] = rowsOf({ env: sshEnv, status: 'ok', sessions: [{ name: 'api', default: true, running: true }] }, { 'ssh:devbox/api': conn('connected') });
		const space = (over: Partial<SpaceNode>): SpaceNode => ({
			type: 'space',
			id: 'ssh:devbox/api|space|w1',
			sessionKey: 'ssh:devbox/api',
			workspaceId: 'w1',
			label: 'billing',
			description: '\u2387 main',
			tooltip: 'billing',
			focused: true,
			children: [{ type: 'tab', id: 't', label: '1', focused: true, sessionKey: 'ssh:devbox/api', tabId: 't1', children: [] }],
			status: 'done',
			counts: '1 done',
			...over,
		});
		const node = (s: SpaceNode): SessionSpaceNode => ({ type: 'sessionSpace', id: `session|${s.id}`, row: api, space: s });
		const selected = sessionSpaceTreeItem(node(space({})), true);
		assert.deepStrictEqual(selected.label, { label: 'billing', highlights: [[0, 7]] });
		assert.strictEqual(selected.description, 'api · ssh devbox · \u2387 main · 1 done');
		assert.strictEqual(selected.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'the selected session\'s focused space');
		assert.deepStrictEqual((selected.iconPath as vscode.ThemeIcon).id, 'remote');
		assert.deepStrictEqual((selected.iconPath as vscode.ThemeIcon).color?.id, 'charts.green', 'the space\'s status, not the session\'s');
		assert.strictEqual(selected.contextValue, 'herdr.session.running ssh space');
		assert.strictEqual(
			sessionSpaceTreeItem({ ...node(space({})), only: true }, true).contextValue,
			'herdr.session.running ssh onlySpace',
			'the only space: Close closes the session',
		);
		assert.deepStrictEqual(selected.command?.arguments, ['ssh:devbox/api', 'w1']);
		const other = sessionSpaceTreeItem(node(space({ description: undefined, status: undefined, counts: 'idle', focused: false })), false);
		assert.strictEqual(other.label, 'billing');
		assert.strictEqual(other.description, 'api · ssh devbox · idle');
		assert.strictEqual(other.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.strictEqual((other.iconPath as vscode.ThemeIcon).color, undefined, 'idle: uncoloured');
		assert.strictEqual(sessionSpaceTreeItem(node(space({ children: [] })), true).collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(sessionRowOf(node(space({}))), api);
		assert.strictEqual(sessionRowOf(api), api);
	});
});
