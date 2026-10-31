import * as assert from 'assert';
import * as vscode from 'vscode';
import { Environment } from '../environments';
import { focusedPaneStatus } from '../focus';
import { LocalShell } from '../remoteShell';
import { EnvState, SessionConnection } from '../sessions';
import { countsDescription, statusIconSpec, statusRank, worstStatus } from '../status';
import { eventTouchesTab, panelTitle, tileMetas } from '../tilesPanel';
import { makePaneKey, splitPaneKey } from '../tilesProtocol';
import { sessionStatusText } from '../status';
import { agentRows, agentsViewDescription, AgentSource, blockedCount, filterPickItems, scopeSources, sortAndFilterAgents, toFilter, toScope } from '../views/agentsView';
import { effectiveSelection, groupOf, sessionItemContext, sessionRows } from '../views/sessionsView';
import { agentTooltip, buildSpaces, paneClickCommand, paneTreeItem, spacesTreeItem, tabSummary } from '../views/spacesView';
import { Snapshot, SnapshotPane } from '../sessions';
import { snapshot } from './fixtures';

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
		assert.deepStrictEqual(statusIconSpec('idle'), { id: 'circle-outline' });
		assert.deepStrictEqual(statusIconSpec('unknown'), { id: 'circle-outline' });
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

suite('Spaces items', () => {
	const spaces = buildSpaces(snapshot(), 'host/code-wksp');

	test('spaces ordered by number, tabs by number, panes in snapshot order', () => {
		assert.deepStrictEqual(
			spaces.map((s) => s.label),
			['web', 'api'],
		);
		assert.deepStrictEqual(
			spaces[0].children.map((t) => t.label),
			['tab · 1', 'tab · logs'],
		);
		assert.deepStrictEqual(
			spaces[1].children[0].children.map((p) => p.label),
			['api-fixer', 'test'],
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
		assert.strictEqual(agentItem.description, 'Refactoring');
		assert.strictEqual(agentItem.contextValue, 'herdr.pane.agent');
		assert.strictEqual((agentItem.iconPath as vscode.ThemeIcon).id, 'circle-filled');
		assert.deepStrictEqual(agentItem.command?.arguments, ['host/code-wksp', 'w2:p1']);
		assert.strictEqual(agentItem.command?.command, 'herdr.addToLayout', 'the default of herdr.openPaneIn');

		const shellItem = spacesTreeItem(shellPane);
		assert.strictEqual(shellItem.description, '/src/api/test', 'foreground_cwd before cwd');
		assert.strictEqual(shellItem.contextValue, 'herdr.pane.shell');
		assert.strictEqual((shellItem.iconPath as vscode.ThemeIcon).id, 'terminal');

		const codex = spaces[0].children[0].children[0];
		assert.strictEqual(codex.label, 'Codex', 'display_agent when agents[] has no name');
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

	test('per herdr.openPaneIn', () => {
		assert.deepStrictEqual(paneClickCommand('layout', ref), { command: 'herdr.addToLayout', title: 'Add to Layout', arguments: ['host/s', 'w1:p1'] });
		assert.deepStrictEqual(paneClickCommand('herdr', ref), { command: 'herdr.openPaneTab', title: 'Open in herdr Tab', arguments: ['host/s', 'w1:p1'] });
	});

	test('a row takes the setting when it is built', () => {
		const pane = snapshot().panes[0];
		assert.strictEqual(paneTreeItem('i', 'l', undefined, pane, ref, 'herdr').command?.command, 'herdr.openPaneTab');
		assert.strictEqual(paneTreeItem('i', 'l', undefined, pane, ref, 'layout').command?.command, 'herdr.addToLayout');
	});

	test('tab rows open the mirrored tab whatever the setting', () => {
		const tab = buildSpaces(snapshot(), 'host/s')[0].children[0];
		assert.strictEqual(spacesTreeItem(tab).command?.command, 'herdr.openTab');
		assert.strictEqual(spacesTreeItem(buildSpaces(snapshot(), 'host/s')[0]).command, undefined, 'space rows only expand');
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
		assert.strictEqual(desc(one('working', NOW - 180_000, 'Refactoring auth middleware'), 'session'), 'v3_auth › agents · working 3m · Refactoring auth middleware');
		assert.strictEqual(desc(one('idle', undefined, undefined, { label: 'api', id: 'w1' }), 'all', 'code-wksp'), 'code-wksp › api · idle');
		assert.strictEqual(desc(one('done', NOW - 10_000, undefined, { label: 'web', id: 'w1' }), 'all', 'my-app'), 'my-app › web · done <1m');
		assert.strictEqual(desc(one('unknown', NOW - 10_000, 'zsh'), 'all', 'x'), 'x › v3_auth · zsh');
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
		assert.strictEqual(tabSummary([p()]), '1 shell');
		assert.strictEqual(tabSummary([p(), p()]), '2 shells');
		assert.strictEqual(tabSummary([p('claude'), p(), p('codex'), p('claude')]), 'claude \u00D72, codex + 1 shell');
		assert.strictEqual(tabSummary([p('codex', 'Codex')]), 'Codex');
		assert.strictEqual(tabSummary([]), undefined);
	});

	test('tab rows and space rows: descriptions and tooltips', () => {
		const spaces = buildSpaces(snapshot(), 'host/s', (id, dir) => (id === 'w2' && dir === '/src/api' ? '\u2387 main · clean' : undefined));
		assert.deepStrictEqual(
			spaces.flatMap((s) => s.children.map((t) => spacesTreeItem(t).description)),
			['Codex', 'claude', 'claude + 1 shell'],
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

	test('Start in dev containers: the herdr not running row starts devc; suffixes', () => {
		const [row] = sessionRows({ env: containerEnv, status: 'ok', sessions: [] }, () => undefined, false);
		assert.deepStrictEqual([row.key, row.label, row.description, row.session, row.contextValue], [
			'container:3f2a9c1b04de/',
			'my-app',
			'herdr not running',
			'devc',
			'herdr.session.stopped',
		]);
		assert.strictEqual(sessionItemContext(row, 'container'), 'herdr.session.stopped container');
		const notInstalled = sessionRows({ env: containerEnv, status: 'notInstalled', sessions: [] }, () => undefined, false)[0];
		assert.strictEqual(sessionItemContext(notInstalled, 'container'), 'herdr.session.absent');
		assert.strictEqual(notInstalled.session, undefined);
		const running = sessionRows({ env: containerEnv, status: 'ok', sessions: [{ name: 'devc', default: false, running: true }] }, () => conn('connected'), false)[0];
		assert.strictEqual(sessionItemContext(running, 'container'), 'herdr.session.running container');
		const stopped = sessionRows({ env: containerEnv, status: 'ok', sessions: [{ name: 'x', default: false, running: false }] }, () => undefined, true)[0];
		assert.strictEqual(sessionItemContext(stopped, 'container'), 'herdr.session.stopped container');
		assert.strictEqual(sessionItemContext({ envKey: 'host', contextValue: 'herdr.session.stopped' }, 'host'), 'herdr.session.stopped host');
		assert.strictEqual(sessionItemContext({ envKey: 'host', contextValue: 'herdr.session.running' }, 'host'), 'herdr.session.running host');
		assert.strictEqual(sessionItemContext({ envKey: 'ssh:box', contextValue: 'herdr.session.stopped' }, 'ssh'), 'herdr.session.stopped');
		const hostNone = sessionRows({ env: hostEnv, status: 'ok', sessions: [] }, () => undefined, false)[0];
		assert.strictEqual(hostNone.contextValue, 'herdr.session.absent', "this machine's empty row is unchanged");
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

	test('panel title and tile headers', () => {
		const s = snapshot();
		assert.strictEqual(panelTitle(s, 'w2:t1'), 'main · api');
		assert.strictEqual(panelTitle(s, 'gone'), undefined);
		assert.deepStrictEqual(tileMetas(s, 'host/s', 'w2:t1'), [
			{ paneKey: 'host/s|w2:p1', label: 'api-fixer', detail: 'Refactoring', status: 'working' },
			{ paneKey: 'host/s|w2:p2', label: 'test', detail: undefined, status: 'shell' },
		]);
	});

	test('focused pane status bar text', () => {
		const s = snapshot();
		assert.deepStrictEqual(focusedPaneStatus(s, 'w2:p1', 'my-session'), {
			text: '$(circle-filled) api-fixer · working',
			tooltip: 'my-session › api › main',
		});
		assert.strictEqual(focusedPaneStatus(s, 'w2:p2', 'r')?.text, '$(circle-filled) test · shell');
		assert.strictEqual(focusedPaneStatus(s, 'gone', 'r'), undefined);
	});

	test('pane keys round-trip', () => {
		assert.strictEqual(makePaneKey('container:abc/devc', 'w1:p2'), 'container:abc/devc|w1:p2');
		assert.deepStrictEqual(splitPaneKey('container:abc/devc|w1:p2'), { sessionKey: 'container:abc/devc', paneId: 'w1:p2' });
	});
});
