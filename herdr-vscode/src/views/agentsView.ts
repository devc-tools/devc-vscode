import * as vscode from 'vscode';
import { formatElapsed } from '../agentState';
import type { EnvironmentKind } from '../environments';
import { hasAgent, paneLabel, Snapshot, SnapshotPane } from '../sessions';
import { customToken, renderRow, SidebarConfig, SidebarRows, SidebarRowsSource } from '../sidebarConfig';
import { countsDescription, countStatuses, statusRank } from '../status';
import { PaneRef, paneTreeItem } from './spacesView';

export type AgentsFilter = 'all' | 'blocked' | 'working' | 'done';
export type AgentsScope = 'all' | 'session';

/** Context key and workspace state key for the filter. */
export const AGENTS_FILTER_KEY = 'herdr.agentsFilter';
/** Context key and workspace state key for the scope. */
export const AGENTS_SCOPE_KEY = 'herdr.agentsScope';

/** Re-render period while the view is visible, for the elapsed times. */
const TICK_MS = 30000;

export function toFilter(value: unknown): AgentsFilter {
	return value === 'blocked' || value === 'working' || value === 'done' ? value : 'all';
}

export function toScope(value: unknown): AgentsScope {
	return value === 'session' ? 'session' : 'all';
}

/** A connected session, as the Agents view reads it. */
export interface AgentSource {
	sessionKey: string;
	/** The session's row label in Sessions. */
	rowLabel: string;
	snapshot: Snapshot;
	/** The session's environment, for the `machine` token. */
	envKind?: EnvironmentKind;
	/** The environment's row label (ssh alias, container folder name). */
	envLabel?: string;
}

/** herdr's `[ui.sidebar.agents]` rows. */
export type AgentRowsConfig = NonNullable<SidebarConfig['agents']>;

export interface AgentRow {
	id: string;
	label: string;
	description: string;
	pane: SnapshotPane;
	ref: PaneRef;
	rowLabel: string;
	workspaceNumber: number;
	/** Configured rows without `state_icon`: no icon. */
	noIcon?: boolean;
}

/** `<status>[ <elapsed>]`; undefined for `unknown`. Elapsed only when the state's start was observed. */
export function stateText(pane: SnapshotPane, now: number): string | undefined {
	if (pane.agent_status === 'unknown') {
		return undefined;
	}
	return pane.state_since !== undefined ? `${pane.agent_status} ${formatElapsed(now - pane.state_since)}` : pane.agent_status;
}

/** The configured rows for an agent pane: `rows_by_agent[agent]`, else `rows`; undefined for phase 19's row. */
export function agentRowsFor(config: AgentRowsConfig | undefined, pane: SnapshotPane): SidebarRows | undefined {
	return (pane.agent !== undefined ? config?.rowsByAgent?.[pane.agent] : undefined) ?? config?.rows;
}

/** An agent row from herdr's configured rows; phase 19's time in state is appended last. */
export function renderAgentRow(
	rows: SidebarRows,
	input: {
		label: string;
		pane: SnapshotPane;
		workspace: string;
		tab: string;
		machine?: string;
	},
	now: number,
): { label: string; description?: string; icon: boolean } {
	const { pane } = input;
	const value = (token: string): string | undefined => {
		switch (token) {
			case 'agent':
				return input.label;
			case 'workspace':
				return input.workspace;
			case 'tab':
				return input.tab;
			case 'pane':
				return pane.label;
			case 'machine':
				return input.machine;
			case 'state_text':
				return pane.agent_status === 'unknown' ? undefined : pane.state_labels?.[pane.agent_status]?.trim() || pane.agent_status;
			case 'terminal_title':
				return pane.terminal_title;
			case 'terminal_title_stripped':
				return pane.terminal_title_stripped;
			default:
				return customToken(token, pane.tokens);
		}
	};
	const row = renderRow(rows, 'agent', value);
	if (pane.state_since !== undefined && pane.agent_status !== 'unknown') {
		const elapsed = formatElapsed(now - pane.state_since);
		row.description = row.description ? `${row.description} · ${elapsed}` : elapsed;
	}
	return row;
}

/**
 * Every agent pane across `sources`. With `config` (herdr's
 * `[ui.sidebar.agents]`), rows it covers are laid out from it.
 */
export function agentRows(sources: AgentSource[], scope: AgentsScope = 'all', now = Date.now(), config?: AgentRowsConfig): AgentRow[] {
	const rows: AgentRow[] = [];
	for (const src of sources) {
		const workspaces = new Map(src.snapshot.workspaces.map((w) => [w.workspace_id, w]));
		const tabs = new Map(src.snapshot.tabs.map((t) => [t.tab_id, t]));
		for (const pane of src.snapshot.panes) {
			if (!hasAgent(pane)) {
				continue;
			}
			const ws = workspaces.get(pane.workspace_id);
			const space = ws?.label ?? pane.workspace_id;
			const tab = tabs.get(pane.tab_id)?.label ?? pane.tab_id;
			const label = paneLabel(pane, src.snapshot);
			const row: AgentRow = {
				id: `${src.sessionKey}|agent|${pane.pane_id}`,
				label,
				description: '',
				pane,
				ref: { sessionKey: src.sessionKey, paneId: pane.pane_id },
				rowLabel: src.rowLabel,
				workspaceNumber: ws?.number ?? Number.MAX_SAFE_INTEGER,
			};
			const configured = agentRowsFor(config, pane);
			if (configured) {
				const machine = src.envKind && src.envKind !== 'host' ? src.envLabel : undefined;
				const r = renderAgentRow(configured, { label, pane, workspace: space, tab, machine }, now);
				row.label = r.label;
				row.description = r.description ?? '';
				if (!r.icon) {
					row.noIcon = true;
				}
			} else {
				const breadcrumb = scope === 'session' ? `${space} › ${tab}` : `${src.rowLabel} › ${space}`;
				row.description = [breadcrumb, stateText(pane, now), pane.terminal_title_stripped].filter((p): p is string => !!p).join(' · ');
			}
			rows.push(row);
		}
	}
	return rows;
}

/** The sources the scope shows: all, or the selected session's only (none without one). */
export function scopeSources(sources: AgentSource[], scope: AgentsScope, selected: string | undefined): AgentSource[] {
	return scope === 'all' ? sources : sources.filter((s) => s.sessionKey === selected);
}

/** Sorted by status rank, then session row label, then workspace number; then filtered. */
export function sortAndFilterAgents(rows: AgentRow[], filter: AgentsFilter): AgentRow[] {
	return rows
		.filter((r) => filter === 'all' || r.pane.agent_status === filter)
		.sort(
			(a, b) =>
				statusRank(a.pane.agent_status) - statusRank(b.pane.agent_status) ||
				a.rowLabel.localeCompare(b.rowLabel) ||
				a.workspaceNumber - b.workspaceNumber,
		);
}

export function blockedCount(rows: AgentRow[]): number {
	return rows.filter((r) => r.pane.agent_status === 'blocked').length;
}

const SCOPE_LABEL: Record<AgentsScope, string> = { all: 'all sessions', session: 'this session' };

/** `<scope label>[ · <summary>]`, over the agents in scope (before the filter). */
export function agentsViewDescription(scope: AgentsScope, filter: AgentsFilter, inScope: AgentRow[]): string {
	let summary: string | undefined;
	if (filter === 'all') {
		summary = inScope.length > 0 ? countsDescription(countStatuses(inScope.map((r) => r.pane.agent_status))) : undefined;
	} else {
		summary = `${filter} ${inScope.filter((r) => r.pane.agent_status === filter).length} of ${inScope.length}`;
	}
	return summary ? `${SCOPE_LABEL[scope]} · ${summary}` : SCOPE_LABEL[scope];
}

export interface FilterPickItem extends vscode.QuickPickItem {
	filter: AgentsFilter;
}

const FILTER_LABELS: [AgentsFilter, string][] = [
	['all', 'All'],
	['blocked', 'Blocked'],
	['working', 'Working'],
	['done', 'Done'],
];

/** **Filter Agents…** items: All, Blocked, Working, Done with their counts in scope; a check on the current one. */
export function filterPickItems(inScope: AgentRow[], current: AgentsFilter): FilterPickItem[] {
	return FILTER_LABELS.map(([filter, label]) => {
		const count = filter === 'all' ? inScope.length : inScope.filter((r) => r.pane.agent_status === filter).length;
		const item: FilterPickItem = { label, description: String(count), filter };
		if (filter === current) {
			item.iconPath = new vscode.ThemeIcon('check');
		}
		return item;
	});
}

/** The selected session, as Spaces uses it. */
export interface SelectedSession {
	readonly selected: string | undefined;
	readonly onDidChangeSelected: vscode.Event<void>;
}

export class AgentsView implements vscode.TreeDataProvider<AgentRow>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<AgentRow | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly blockedEmitter = new vscode.EventEmitter<number>();
	/** The number of blocked agents, whenever the list is rebuilt. */
	readonly onDidChangeBlocked = this.blockedEmitter.event;
	readonly treeView: vscode.TreeView<AgentRow>;
	private readonly disposables: vscode.Disposable[] = [];
	private rows: AgentRow[] = [];
	private inScope: AgentRow[] = [];
	private filterValue: AgentsFilter;
	private scopeValue: AgentsScope;
	private ticker: NodeJS.Timeout | undefined;

	constructor(
		private readonly sources: () => AgentSource[],
		onModelChange: vscode.Event<void>,
		private readonly state: vscode.Memento,
		private readonly selection: SelectedSession,
		/** herdr's `[ui.sidebar.*]` rows; phase 19's rows without it. */
		private readonly sidebar?: SidebarRowsSource,
		dragAndDropController?: vscode.TreeDragAndDropController<AgentRow>,
	) {
		this.filterValue = toFilter(state.get(AGENTS_FILTER_KEY));
		this.scopeValue = toScope(state.get(AGENTS_SCOPE_KEY));
		this.treeView = vscode.window.createTreeView('herdr.agents', { treeDataProvider: this, dragAndDropController });
		this.disposables.push(
			this.treeView,
			this.emitter,
			this.blockedEmitter,
			onModelChange(() => this.update()),
			selection.onDidChangeSelected(() => {
				if (this.scopeValue === 'session') {
					this.update();
				}
			}),
			this.treeView.onDidChangeVisibility(() => this.tick()),
			...(sidebar ? [sidebar.onDidChange(() => this.update())] : []),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('herdr.openPaneIn')) {
					this.emitter.fire();
				}
			}),
		);
		void vscode.commands.executeCommand('setContext', AGENTS_FILTER_KEY, this.filterValue);
		void vscode.commands.executeCommand('setContext', AGENTS_SCOPE_KEY, this.scopeValue);
		this.update();
		this.tick();
	}

	get filter(): AgentsFilter {
		return this.filterValue;
	}

	get scope(): AgentsScope {
		return this.scopeValue;
	}

	async setFilter(filter: AgentsFilter): Promise<void> {
		this.filterValue = filter;
		await this.state.update(AGENTS_FILTER_KEY, filter);
		await vscode.commands.executeCommand('setContext', AGENTS_FILTER_KEY, filter);
		this.update();
	}

	async setScope(scope: AgentsScope): Promise<void> {
		this.scopeValue = scope;
		await this.state.update(AGENTS_SCOPE_KEY, scope);
		await vscode.commands.executeCommand('setContext', AGENTS_SCOPE_KEY, scope);
		this.update();
	}

	/** **Filter Agents…**: a quick pick with counts; Escape changes nothing. */
	async pickFilter(): Promise<void> {
		const items = filterPickItems(this.inScope, this.filterValue);
		const pick = vscode.window.createQuickPick<FilterPickItem>();
		pick.placeholder = 'Show agents';
		pick.items = items;
		pick.activeItems = items.filter((i) => i.filter === this.filterValue);
		const chosen = await new Promise<FilterPickItem | undefined>((resolve) => {
			pick.onDidAccept(() => resolve(pick.selectedItems[0] ?? pick.activeItems[0]));
			pick.onDidHide(() => resolve(undefined));
			pick.show();
		});
		pick.dispose();
		if (chosen) {
			await this.setFilter(chosen.filter);
		}
	}

	/** The 30 s re-render runs only while the view is visible; one runs when it becomes visible. */
	private tick(): void {
		if (this.treeView.visible) {
			if (this.ticker === undefined) {
				this.ticker = setInterval(() => this.update(), TICK_MS);
				this.update();
			}
		} else if (this.ticker !== undefined) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private update(): void {
		const sources = this.sources();
		const now = Date.now();
		const config = this.sidebar?.config?.agents;
		const all = agentRows(sources, 'all', now, config);
		this.inScope =
			this.scopeValue === 'all'
				? all
				: agentRows(scopeSources(sources, this.scopeValue, this.selection.selected), this.scopeValue, now, config);
		this.rows = sortAndFilterAgents([...this.inScope], this.filterValue);
		const blocked = blockedCount(all);
		this.treeView.badge = blocked > 0 ? { value: blocked, tooltip: `${blocked} agents blocked` } : undefined;
		this.treeView.description = agentsViewDescription(this.scopeValue, this.filterValue, this.inScope);
		this.blockedEmitter.fire(blocked);
		this.emitter.fire();
	}

	getTreeItem(row: AgentRow): vscode.TreeItem {
		const item = paneTreeItem(row.id, row.label, row.description || undefined, row.pane, row.ref);
		if (row.noIcon) {
			item.iconPath = undefined;
		}
		return item;
	}

	getChildren(row?: AgentRow): AgentRow[] {
		return row ? [] : this.rows;
	}

	dispose(): void {
		clearInterval(this.ticker);
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
