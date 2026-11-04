import * as vscode from 'vscode';
import { Snapshot } from '../sessions';
import { SidebarRowsSource } from '../sidebarConfig';
import { SpaceGit } from '../spaceGit';
import { statusIconSpec } from '../status';
import {
	SessionList,
	SessionRowNode,
	sessionRowStatus,
	sessionTreeContextValue,
	sessionTreeDescription,
	sessionTreeSection,
	sessionTreeWhere,
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

/** One space of a running session, standing for both: a session with spaces has one row per space. */
export interface SessionSpaceNode {
	type: 'sessionSpace';
	id: string;
	row: SessionRowNode;
	space: SpaceNode;
}

export type SessionsTreeNode = SessionsRootNode | SessionRowNode | SessionSpaceNode | SpacesNode;

/** The session a Sessions row's command acts on. */
export function sessionRowOf(arg: SessionRowNode | SessionSpaceNode | undefined): SessionRowNode | undefined {
	return arg?.type === 'sessionSpace' ? arg.row : arg?.type === 'session' ? arg : undefined;
}

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

/** The codicon for each environment kind: there is no container codicon, so a package (box). */
export const ENV_ICON: Record<SessionRowNode['envKind'], string> = {
	host: 'device-desktop',
	ssh: 'remote',
	container: 'package',
};

/**
 * A session row's icon: its environment's codicon, coloured by the worst agent
 * status of a connected running session (uncoloured when idle), dimmed when
 * stopped or not connected; a warning or spinner for an environment that is not usable.
 */
export function sessionTreeIcon(
	row: Pick<SessionRowNode, 'contextValue' | 'snapshot' | 'envStatus' | 'envKind'>,
	/** A space row's: its own worst status, rather than the session's. */
	space?: Pick<SpaceNode, 'status'>,
): vscode.ThemeIcon {
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
	const id = ENV_ICON[row.envKind];
	if (row.contextValue !== 'herdr.session.running' || !row.snapshot) {
		return new vscode.ThemeIcon(id, new vscode.ThemeColor('disabledForeground'));
	}
	const status = (space ? space.status : sessionRowStatus(row.snapshot)) ?? 'idle';
	// Idle stays the plain foreground: gray would look like stopped.
	const color = status === 'idle' || status === 'unknown' ? undefined : statusIconSpec(status).color;
	return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

/** A label highlighted for the selected session: a tree item has no other way to look distinct, and the tree's own selection moves on clicks. */
function rowLabel(label: string, selected: boolean): string | vscode.TreeItemLabel {
	return selected ? { label, highlights: [[0, label.length]] } : label;
}

/** A session row's tree item: a stopped session, a place that can't be used, or a running session with no spaces. */
export function sessionTreeItem(row: SessionRowNode, selected: boolean): vscode.TreeItem {
	const item = new vscode.TreeItem(rowLabel(row.label, selected), vscode.TreeItemCollapsibleState.None);
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

/**
 * A running session's space row: the space name, then the session name, where
 * it runs, the space's git (or repo) text and its agent counts. Expanded at
 * first when it is the selected session's focused space.
 */
export function sessionSpaceTreeItem(node: SessionSpaceNode, selected: boolean): vscode.TreeItem {
	const { row, space } = node;
	const collapsible =
		space.children.length === 0
			? vscode.TreeItemCollapsibleState.None
			: selected && space.focused
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
	const item = new vscode.TreeItem(rowLabel(space.label, selected), collapsible);
	item.id = node.id;
	item.description = [row.label, ...sessionTreeWhere(row), space.description, space.counts]
		.filter((x): x is string => !!x)
		.join(' · ');
	item.tooltip = [row.tooltip, space.tooltip, selected ? 'Selected session' : undefined].filter((x) => !!x).join('\n');
	item.iconPath = sessionTreeIcon(row, space);
	item.contextValue = `${sessionTreeContextValue(row)} space`;
	item.command = { command: SELECT_SESSION_COMMAND, title: 'Open herdr Space', arguments: [row.key, space.workspaceId] };
	return item;
}

/** A running session's rows: one per space, or the session row with none. */
function rowsOfSession(row: SessionRowNode, spaces: Map<string, SessionSpaceNode[]>): (SessionRowNode | SessionSpaceNode)[] {
	const list = spaces.get(row.key);
	return list && list.length > 0 ? list : [row];
}

function nodeId(node: SessionsTreeNode): string {
	return node.type === 'session' ? `session|${node.key}` : node.id;
}

/** Running sessions' spaces above stopped sessions; a space row expands to its tabs and panes. */
export class SessionsTreeView implements vscode.TreeDataProvider<SessionsTreeNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<SessionsTreeNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly treeView: vscode.TreeView<SessionsTreeNode>;
	private readonly disposables: vscode.Disposable[] = [];
	private roots: SessionsRootNode[] = [];
	private spaces = new Map<string, SessionSpaceNode[]>();
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
				const spaces = buildSpaces(row.snapshot, key, lookup, rows).map(
					(space): SessionSpaceNode => ({ type: 'sessionSpace', id: `session|${space.id}`, row, space }),
				);
				this.spaces.set(key, spaces);
				for (const node of spaces) {
					this.parents.set(node.id, root);
					for (const tab of node.space.children) {
						this.parents.set(tab.id, node);
						for (const pane of tab.children) {
							this.parents.set(pane.id, tab);
						}
					}
				}
			}
		}
		this.emitter.fire();
	}

	/** Expands the selected session's focused space row. `reveal` on a hidden view would open it. */
	private revealSelected(): void {
		if (!this.treeView.visible || !this.selected) {
			return;
		}
		const spaces = this.spaces.get(this.selected) ?? [];
		const node = spaces.find((n) => n.space.focused) ?? spaces[0];
		if (node && node.space.children.length > 0) {
			void Promise.resolve(this.treeView.reveal(node, { expand: true, select: false, focus: false })).catch(() => undefined);
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
				return sessionTreeItem(node, node.key === this.selected);
			case 'sessionSpace':
				return sessionSpaceTreeItem(node, node.row.key === this.selected);
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
				return node.rows.flatMap((row) => rowsOfSession(row, this.spaces));
			case 'session':
				return [];
			case 'sessionSpace':
				return node.space.children;
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
