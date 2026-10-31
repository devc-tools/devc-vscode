import * as vscode from 'vscode';
import { formatElapsed } from '../agentState';
import { hasAgent, paneLabel, Snapshot, SnapshotPane } from '../sessions';
import { SpaceGit, spaceDirectory } from '../spaceGit';
import { countsDescription, countStatuses, SHELL_ICON, statusIcon, worstStatus } from '../status';
import { SessionsView } from './sessionsView';

/** A pane across every session. */
export interface PaneRef {
	sessionKey: string;
	paneId: string;
}

export const FOCUS_PANE_COMMAND = 'herdr.focusPane';
export const OPEN_TAB_COMMAND = 'herdr.openTab';
export const OPEN_PANE_TAB_COMMAND = 'herdr.openPaneTab';
export const ADD_TO_LAYOUT_COMMAND = 'herdr.addToLayout';

export type OpenPaneIn = 'layout' | 'herdr';

/** `herdr.openPaneIn`, where anything but `herdr` is the default. */
export function openPaneIn(): OpenPaneIn {
	return vscode.workspace.getConfiguration('herdr').get('openPaneIn') === 'herdr' ? 'herdr' : 'layout';
}

/** What clicking a pane or agent row runs. */
export function paneClickCommand(target: OpenPaneIn, ref: PaneRef): vscode.Command {
	return target === 'herdr'
		? { command: OPEN_PANE_TAB_COMMAND, title: 'Open in herdr Tab', arguments: [ref.sessionKey, ref.paneId] }
		: { command: ADD_TO_LAYOUT_COMMAND, title: 'Add to Layout', arguments: [ref.sessionKey, ref.paneId] };
}

export interface SpaceNode {
	type: 'space';
	id: string;
	sessionKey: string;
	workspaceId: string;
	label: string;
	description?: string;
	tooltip: string;
	/** Where the space's git status is read, when known. */
	directory?: string;
	focused: boolean;
	children: TabNode[];
	/** The worst agent status in the space, undefined with no agents. */
	status: ReturnType<typeof worstStatus>;
}

export interface TabNode {
	type: 'tab';
	id: string;
	label: string;
	description?: string;
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

/**
 * A tab row's description: its agent kinds (`<kind> ×<n>` when repeated) and
 * its shell count, e.g. `claude ×2, codex + 1 shell`; undefined with no panes.
 */
export function tabSummary(panes: readonly SnapshotPane[]): string | undefined {
	const kinds = new Map<string, number>();
	let shells = 0;
	for (const p of panes) {
		const kind = hasAgent(p) ? (p.display_agent ?? p.agent!) : undefined;
		if (kind === undefined) {
			shells++;
		} else {
			kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
		}
	}
	const agents = [...kinds].map(([kind, n]) => (n > 1 ? `${kind} \u00D7${n}` : kind)).join(', ');
	const shellText = shells > 0 ? `${shells} ${shells === 1 ? 'shell' : 'shells'}` : '';
	return agents && shellText ? `${agents} + ${shellText}` : agents || shellText || undefined;
}

/** An agent row's tooltip, in Spaces and Agents: `<agent> · <status>[ for <elapsed>]\n<pane id>`. */
export function agentTooltip(pane: SnapshotPane, now = Date.now()): string {
	const elapsed = pane.state_since !== undefined ? ` for ${formatElapsed(now - pane.state_since)}` : '';
	return `${pane.agent} · ${pane.agent_status}${elapsed}\n${pane.pane_id}`;
}

/** A space's git description by directory, as {@link SpaceGit.description} gives it. */
export type SpaceGitLookup = (workspaceId: string, directory: string | undefined) => string | undefined;

/** A snapshot as Spaces nodes: spaces by number, tabs by number, panes in snapshot order. */
export function buildSpaces(snapshot: Snapshot, sessionKey: string, git?: SpaceGitLookup): SpaceNode[] {
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
					description: tabSummary(snapshot.panes.filter((p) => p.tab_id === t.tab_id)),
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
		const agents = snapshot.panes.filter((p) => p.workspace_id === w.workspace_id && hasAgent(p)).map((p) => p.agent_status);
		const directory = spaceDirectory(snapshot, w.workspace_id);
		const tooltip = [w.label, w.repoName, directory, countsDescription(countStatuses(agents))].filter((x): x is string => !!x);
		return {
			type: 'space',
			id: `${sessionKey}|space|${w.workspace_id}`,
			sessionKey,
			workspaceId: w.workspace_id,
			label: w.label,
			description: git?.(w.workspace_id, directory) ?? (w.repoName && w.repoName !== w.label ? w.repoName : undefined),
			tooltip: tooltip.join('\n'),
			directory,
			focused: w.focused,
			children: tabs,
			status: worstStatus(agents),
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
			item.tooltip = node.tooltip;
			item.iconPath = statusIcon(node.status);
			item.contextValue = 'herdr.space';
			return item;
		}
		case 'tab': {
			const item = new vscode.TreeItem(node.label, expand(node.focused));
			item.id = node.id;
			item.description = node.description;
			item.contextValue = 'herdr.tab';
			item.command = { command: OPEN_TAB_COMMAND, title: 'Open herdr Tab', arguments: [node.sessionKey, node.tabId] };
			return item;
		}
		case 'pane':
			return paneTreeItem(node.id, node.label, node.description, node.pane, node.ref);
	}
}

/** A pane or agent row: status icon (or `terminal`), and a click per `herdr.openPaneIn`. */
export function paneTreeItem(
	id: string,
	label: string,
	description: string | undefined,
	pane: SnapshotPane,
	ref: PaneRef,
	target: OpenPaneIn = openPaneIn(),
): vscode.TreeItem {
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	item.id = id;
	item.description = description;
	const agent = hasAgent(pane);
	item.iconPath = agent ? statusIcon(pane.agent_status) : SHELL_ICON;
	item.contextValue = agent ? 'herdr.pane.agent' : 'herdr.pane.shell';
	item.tooltip = agent ? agentTooltip(pane) : pane.pane_id;
	item.command = paneClickCommand(target, ref);
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
		/** Branch and git status of space rows; none without it. */
		private readonly git?: SpaceGit,
		dragAndDropController?: vscode.TreeDragAndDropController<SpacesNode>,
	) {
		this.treeView = vscode.window.createTreeView('herdr.spaces', { treeDataProvider: this, dragAndDropController });
		this.disposables.push(
			this.treeView,
			this.emitter,
			onModelChange(() => this.update()),
			this.treeView.onDidChangeVisibility(() => this.update()),
			sessions.onDidChangeSelected(() => this.update()),
			...(git ? [git.onDidChange(() => this.update())] : []),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('herdr.openPaneIn')) {
					this.emitter.fire();
				}
			}),
		);
		this.update();
	}

	private update(): void {
		const key = this.sessions.selected;
		const snapshot = key ? this.snapshotOf(key) : undefined;
		const git = this.git;
		this.git?.update(key, snapshot, this.treeView.visible);
		this.roots =
			key && snapshot ? buildSpaces(snapshot, key, git && ((id, dir) => git.description(key, id, dir))) : [];
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
