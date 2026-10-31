import * as vscode from 'vscode';
import { hasAgent, paneLabel, Snapshot, SnapshotPane } from '../sessions';
import { statusRank } from '../status';
import { PaneRef, paneTreeItem } from './spacesView';

export type AgentsFilter = 'all' | 'blocked' | 'working';

/** Context key and workspace state key for the filter. */
export const AGENTS_FILTER_KEY = 'herdr.agentsFilter';

export function toFilter(value: unknown): AgentsFilter {
	return value === 'blocked' || value === 'working' ? value : 'all';
}

/** A connected session, as the Agents view reads it. */
export interface AgentSource {
	sessionKey: string;
	/** The session's row label in Sessions. */
	rowLabel: string;
	snapshot: Snapshot;
}

export interface AgentRow {
	id: string;
	label: string;
	description: string;
	pane: SnapshotPane;
	ref: PaneRef;
	rowLabel: string;
	workspaceNumber: number;
}

/** Every agent pane across `sources`. */
export function agentRows(sources: AgentSource[]): AgentRow[] {
	const rows: AgentRow[] = [];
	for (const src of sources) {
		const workspaces = new Map(src.snapshot.workspaces.map((w) => [w.workspace_id, w]));
		for (const pane of src.snapshot.panes) {
			if (!hasAgent(pane)) {
				continue;
			}
			const ws = workspaces.get(pane.workspace_id);
			const title = pane.terminal_title_stripped;
			rows.push({
				id: `${src.sessionKey}|agent|${pane.pane_id}`,
				label: paneLabel(pane, src.snapshot),
				description: `${src.rowLabel} › ${ws?.label ?? pane.workspace_id}${title ? ` · ${title}` : ''}`,
				pane,
				ref: { sessionKey: src.sessionKey, paneId: pane.pane_id },
				rowLabel: src.rowLabel,
				workspaceNumber: ws?.number ?? Number.MAX_SAFE_INTEGER,
			});
		}
	}
	return rows;
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

export class AgentsView implements vscode.TreeDataProvider<AgentRow>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<AgentRow | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly blockedEmitter = new vscode.EventEmitter<number>();
	/** The number of blocked agents, whenever the list is rebuilt. */
	readonly onDidChangeBlocked = this.blockedEmitter.event;
	readonly treeView: vscode.TreeView<AgentRow>;
	private readonly disposables: vscode.Disposable[] = [];
	private rows: AgentRow[] = [];
	private filterValue: AgentsFilter;

	constructor(
		private readonly sources: () => AgentSource[],
		onModelChange: vscode.Event<void>,
		private readonly state: vscode.Memento,
	) {
		this.filterValue = toFilter(state.get(AGENTS_FILTER_KEY));
		this.treeView = vscode.window.createTreeView('herdr.agents', { treeDataProvider: this });
		this.disposables.push(this.treeView, this.emitter, this.blockedEmitter, onModelChange(() => this.update()));
		void vscode.commands.executeCommand('setContext', AGENTS_FILTER_KEY, this.filterValue);
		this.update();
	}

	get filter(): AgentsFilter {
		return this.filterValue;
	}

	async setFilter(filter: AgentsFilter): Promise<void> {
		this.filterValue = filter;
		await this.state.update(AGENTS_FILTER_KEY, filter);
		await vscode.commands.executeCommand('setContext', AGENTS_FILTER_KEY, filter);
		this.update();
	}

	private update(): void {
		const all = agentRows(this.sources());
		this.rows = sortAndFilterAgents(all, this.filterValue);
		const blocked = blockedCount(all);
		this.treeView.badge = blocked > 0 ? { value: blocked, tooltip: `${blocked} agents blocked` } : undefined;
		this.treeView.description = this.filterValue === 'all' ? undefined : this.filterValue;
		this.blockedEmitter.fire(blocked);
		this.emitter.fire();
	}

	getTreeItem(row: AgentRow): vscode.TreeItem {
		return paneTreeItem(row.id, row.label, row.description, row.pane, row.ref);
	}

	getChildren(row?: AgentRow): AgentRow[] {
		return row ? [] : this.rows;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
