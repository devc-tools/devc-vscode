import * as vscode from 'vscode';
import { hasAgent, paneLabel, Snapshot, SnapshotPane } from '../sessions';
import { SHELL_ICON, statusIcon, worstStatus } from '../status';
import { SessionsView } from './sessionsView';

/** What `herdr.focusPane` takes. */
export interface PaneRef {
	sessionKey: string;
	paneId: string;
}

export const FOCUS_PANE_COMMAND = 'herdr.focusPane';
export const OPEN_TAB_COMMAND = 'herdr.openTab';

export interface SpaceNode {
	type: 'space';
	id: string;
	label: string;
	description?: string;
	focused: boolean;
	children: TabNode[];
	/** The worst agent status in the space, undefined with no agents. */
	status: ReturnType<typeof worstStatus>;
}

export interface TabNode {
	type: 'tab';
	id: string;
	label: string;
	focused: boolean;
	sessionKey: string;
	tabId: string;
	children: PaneNode[];
}

export interface PaneNode {
	type: 'pane';
	id: string;
	label: string;
	description?: string;
	pane: SnapshotPane;
	ref: PaneRef;
}

export type SpacesNode = SpaceNode | TabNode | PaneNode;

/** A pane row's description: the terminal title when an agent runs, else the cwd. */
export function paneDescription(pane: SnapshotPane): string | undefined {
	return hasAgent(pane) ? pane.terminal_title_stripped : (pane.foreground_cwd ?? pane.cwd);
}

/** A snapshot as Spaces nodes: spaces by number, tabs by number, panes in snapshot order. */
export function buildSpaces(snapshot: Snapshot, sessionKey: string): SpaceNode[] {
	const byNumber = <T extends { number: number }>(a: T, b: T) => a.number - b.number;
	return [...snapshot.workspaces].sort(byNumber).map((w) => {
		const tabs = snapshot.tabs
			.filter((t) => t.workspace_id === w.workspace_id)
			.sort(byNumber)
			.map(
				(t): TabNode => ({
					type: 'tab',
					id: `${sessionKey}|tab|${t.tab_id}`,
					label: `tab · ${t.label}`,
					focused: t.focused,
					sessionKey,
					tabId: t.tab_id,
					children: snapshot.panes
						.filter((p) => p.tab_id === t.tab_id)
						.map(
							(p): PaneNode => ({
								type: 'pane',
								id: `${sessionKey}|pane|${p.pane_id}`,
								label: paneLabel(p, snapshot),
								description: paneDescription(p),
								pane: p,
								ref: { sessionKey, paneId: p.pane_id },
							}),
						),
				}),
			);
		return {
			type: 'space',
			id: `${sessionKey}|space|${w.workspace_id}`,
			label: w.label,
			description: w.repoName && w.repoName !== w.label ? w.repoName : undefined,
			focused: w.focused,
			children: tabs,
			status: worstStatus(
				snapshot.panes.filter((p) => p.workspace_id === w.workspace_id && hasAgent(p)).map((p) => p.agent_status),
			),
		};
	});
}

/** The tree item for a Spaces node. */
export function spacesTreeItem(node: SpacesNode): vscode.TreeItem {
	const expand = (focused: boolean) =>
		focused ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
	switch (node.type) {
		case 'space': {
			const item = new vscode.TreeItem(node.label, expand(node.focused));
			item.id = node.id;
			item.description = node.description;
			item.iconPath = statusIcon(node.status);
			item.contextValue = 'herdr.space';
			return item;
		}
		case 'tab': {
			const item = new vscode.TreeItem(node.label, expand(node.focused));
			item.id = node.id;
			item.contextValue = 'herdr.tab';
			item.command = { command: OPEN_TAB_COMMAND, title: 'Open herdr Tab', arguments: [node.sessionKey, node.tabId] };
			return item;
		}
		case 'pane':
			return paneTreeItem(node.id, node.label, node.description, node.pane, node.ref);
	}
}

/** A pane or agent row: status icon (or `terminal`), and a click that focuses it in herdr. */
export function paneTreeItem(
	id: string,
	label: string,
	description: string | undefined,
	pane: SnapshotPane,
	ref: PaneRef,
): vscode.TreeItem {
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	item.id = id;
	item.description = description;
	const agent = hasAgent(pane);
	item.iconPath = agent ? statusIcon(pane.agent_status) : SHELL_ICON;
	item.contextValue = agent ? 'herdr.pane.agent' : 'herdr.pane.shell';
	item.tooltip = agent ? `${pane.agent} · ${pane.agent_status}\n${pane.pane_id}` : pane.pane_id;
	item.command = { command: FOCUS_PANE_COMMAND, title: 'Focus Pane in herdr', arguments: [ref] };
	return item;
}

export class SpacesView implements vscode.TreeDataProvider<SpacesNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<SpacesNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly treeView: vscode.TreeView<SpacesNode>;
	private readonly disposables: vscode.Disposable[] = [];
	private roots: SpaceNode[] = [];
	private contextSelected: boolean | undefined;

	constructor(
		private readonly sessions: SessionsView,
		private readonly snapshotOf: (key: string) => Snapshot | undefined,
		onModelChange: vscode.Event<void>,
	) {
		this.treeView = vscode.window.createTreeView('herdr.spaces', { treeDataProvider: this });
		this.disposables.push(
			this.treeView,
			this.emitter,
			onModelChange(() => this.update()),
			sessions.onDidChangeSelected(() => this.update()),
		);
		this.update();
	}

	private update(): void {
		const key = this.sessions.selected;
		const snapshot = key ? this.snapshotOf(key) : undefined;
		this.roots = key && snapshot ? buildSpaces(snapshot, key) : [];
		this.treeView.description = key ? this.sessions.row(key)?.label : undefined;
		if (this.contextSelected !== (key !== undefined)) {
			this.contextSelected = key !== undefined;
			void vscode.commands.executeCommand('setContext', 'herdr.sessionSelected', this.contextSelected);
		}
		this.emitter.fire();
	}

	getTreeItem(node: SpacesNode): vscode.TreeItem {
		return spacesTreeItem(node);
	}

	getChildren(node?: SpacesNode): SpacesNode[] {
		if (!node) {
			return this.roots;
		}
		return node.type === 'pane' ? [] : node.children;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
