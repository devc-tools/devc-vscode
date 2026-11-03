import * as vscode from 'vscode';
import { Snapshot } from '../sessions';
import { SidebarRowsSource } from '../sidebarConfig';
import { SpaceGit } from '../spaceGit';
import { statusIcon } from '../status';
import {
	SessionList,
	SessionRowNode,
	sessionRowStatus,
	sessionTreeContextValue,
	sessionTreeDescription,
	sessionTreeSection,
} from './sessionsView';
import { buildSpaces, SpaceNode, SpacesNode, spacesTreeItem } from './spacesView';

export const SESSIONS_VIEW = 'herdr.sessions';
export const SELECT_SESSION_COMMAND = 'herdr.sessions.select';

/** `Running` or `Stopped`, holding its session rows. */
export interface SessionsRootNode {
	type: 'root';
	id: string;
	section: 'running' | 'stopped';
	rows: SessionRowNode[];
}

export type SessionsTreeNode = SessionsRootNode | SessionRowNode | SpacesNode;

const ROOT_LABEL = { running: 'Running', stopped: 'Stopped' } as const;

/** The roots for these rows: `Running` then `Stopped`, each omitted with no rows. */
export function sessionsRoots(rows: readonly SessionRowNode[]): SessionsRootNode[] {
	const roots: SessionsRootNode[] = [];
	for (const section of ['running', 'stopped'] as const) {
		const list = rows.filter((r) => sessionTreeSection(r) === section);
		if (list.length > 0) {
			roots.push({ type: 'root', id: `root|${section}`, section, rows: list });
		}
	}
	return roots;
}

/** A session row's icon: its worst agent status when connected, a warning or spinner for an environment that is not usable, else the empty circle. */
export function sessionTreeIcon(row: Pick<SessionRowNode, 'contextValue' | 'snapshot' | 'envStatus'>): vscode.ThemeIcon {
	if (row.contextValue === 'herdr.session.absent') {
		switch (row.envStatus) {
			case 'unreachable':
			case 'notInstalled':
			case 'error':
				return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
			case 'pending':
				return new vscode.ThemeIcon('loading~spin');
		}
	}
	return statusIcon(row.contextValue === 'herdr.session.running' && row.snapshot ? sessionRowStatus(row.snapshot) : undefined);
}

/** A session row's tree item. `hasChildren`: a running, connected session with spaces to show. */
export function sessionTreeItem(row: SessionRowNode, selected: boolean, hasChildren: boolean): vscode.TreeItem {
	const collapsible = !hasChildren
		? vscode.TreeItemCollapsibleState.None
		: selected
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.Collapsed;
	// A tree item label has no other way to look distinct, and the tree's own selection moves on clicks.
	const item = new vscode.TreeItem(selected ? { label: row.label, highlights: [[0, row.label.length]] } : row.label, collapsible);
	item.id = `session|${row.key}`;
	item.description = sessionTreeDescription(row);
	item.tooltip = selected ? `${row.tooltip}\nSelected session` : row.tooltip;
	item.iconPath = sessionTreeIcon(row);
	item.contextValue = sessionTreeContextValue(row);
	if (row.contextValue === 'herdr.session.running') {
		item.command = { command: SELECT_SESSION_COMMAND, title: 'Select Session', arguments: [row.key] };
	}
	return item;
}

function nodeId(node: SessionsTreeNode): string {
	return node.type === 'session' ? `session|${node.key}` : node.id;
}

/** Running sessions above stopped ones; running ones expand to their spaces, tabs and panes. */
export class SessionsTreeView implements vscode.TreeDataProvider<SessionsTreeNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<SessionsTreeNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly treeView: vscode.TreeView<SessionsTreeNode>;
	private readonly disposables: vscode.Disposable[] = [];
	private roots: SessionsRootNode[] = [];
	private spaces = new Map<string, SpaceNode[]>();
	private parents = new Map<string, SessionsTreeNode>();
	private selected: string | undefined;

	constructor(
		private readonly sessions: SessionList,
		private readonly snapshotOf: (key: string) => Snapshot | undefined,
		/** Branch and git status of the selected session's space rows. */
		private readonly git?: SpaceGit,
		/** herdr's `[ui.sidebar.*]` rows, as in Spaces. */
		private readonly sidebar?: SidebarRowsSource,
	) {
		this.treeView = vscode.window.createTreeView(SESSIONS_VIEW, { treeDataProvider: this, showCollapseAll: true });
		this.disposables.push(
			this.treeView,
			this.emitter,
			sessions.onDidChange(() => this.update()),
			sessions.onDidChangeSelected(() => {
				this.update();
				this.revealSelected();
			}),
			this.treeView.onDidChangeVisibility(() => this.update()),
			...(git ? [git.onDidChange(() => this.update())] : []),
			...(sidebar ? [sidebar.onDidChange(() => this.update())] : []),
		);
		this.update();
	}

	private update(): void {
		const selected = this.sessions.selected;
		this.selected = selected;
		const selectedSnapshot = selected ? this.snapshotOf(selected) : undefined;
		this.git?.update(selected, selectedSnapshot, this.treeView.visible, 'sessions');
		const git = this.git;
		const rows = this.sidebar?.config?.spaces?.rows;
		this.roots = sessionsRoots(this.sessions.allRows());
		this.spaces = new Map();
		this.parents = new Map();
		for (const root of this.roots) {
			for (const row of root.rows) {
				this.parents.set(nodeId(row), root);
				if (root.section !== 'running' || !row.snapshot) {
					continue;
				}
				const key = row.key;
				const lookup = key === selected && git ? (id: string, dir: string | undefined) => git.description(key, id, dir) : undefined;
				const spaces = buildSpaces(row.snapshot, key, lookup, rows);
				this.spaces.set(key, spaces);
				for (const space of spaces) {
					this.parents.set(space.id, row);
					for (const tab of space.children) {
						this.parents.set(tab.id, space);
						for (const pane of tab.children) {
							this.parents.set(pane.id, tab);
						}
					}
				}
			}
		}
		this.emitter.fire();
	}

	/** Expands the selected session's row. `reveal` on a hidden view would open it. */
	private revealSelected(): void {
		if (!this.treeView.visible || !this.selected) {
			return;
		}
		const row = this.roots.flatMap((r) => r.rows).find((r) => r.key === this.selected);
		if (row && this.spaces.has(row.key)) {
			void Promise.resolve(this.treeView.reveal(row, { expand: true, select: false, focus: false })).catch(() => undefined);
		}
	}

	getTreeItem(node: SessionsTreeNode): vscode.TreeItem {
		switch (node.type) {
			case 'root': {
				const item = new vscode.TreeItem(ROOT_LABEL[node.section], vscode.TreeItemCollapsibleState.Expanded);
				item.id = node.id;
				item.description = String(node.rows.length);
				item.contextValue = 'herdr.sessions.group';
				return item;
			}
			case 'session':
				return sessionTreeItem(node, node.key === this.selected, (this.spaces.get(node.key)?.length ?? 0) > 0);
			default:
				return spacesTreeItem(node);
		}
	}

	getChildren(node?: SessionsTreeNode): SessionsTreeNode[] {
		if (!node) {
			return this.roots;
		}
		switch (node.type) {
			case 'root':
				return node.rows;
			case 'session':
				return this.spaces.get(node.key) ?? [];
			case 'pane':
				return [];
			default:
				return node.children;
		}
	}

	getParent(node: SessionsTreeNode): SessionsTreeNode | undefined {
		return this.parents.get(nodeId(node));
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
