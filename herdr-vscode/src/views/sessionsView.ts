import * as vscode from 'vscode';
import { Environment, HOST_KEY } from '../environments';
import { EnvState, SessionConnection, SessionModel, sessionKey, Snapshot, hasAgent } from '../sessions';
import { countsDescription, countStatuses, statusIcon, worstStatus } from '../status';

/** The session the Spaces view shows, by session key. */
export const SELECTED_SESSION_STATE = 'herdr.selectedSession';

/** The session name devc gives a container's session; not repeated in its row. */
const DEVC_SESSION = 'devc';

export interface GroupNode {
	type: 'group';
	id: string;
	label: string;
}

export interface SessionRowNode {
	type: 'session';
	/** Session key, or `<env key>/` for an environment-level row (no session). */
	key: string;
	envKey: string;
	/** Undefined on an environment-level row. */
	session?: string;
	label: string;
	description: string;
	contextValue: 'herdr.session.running' | 'herdr.session.stopped' | 'herdr.session.absent';
	tooltip: string;
	snapshot?: Snapshot;
	groupId: string;
}

export type SessionsNode = GroupNode | SessionRowNode;

/** A session's row label: its name on this machine and SSH hosts, the folder name in a container. */
export function sessionRowLabel(env: Pick<Environment, 'kind' | 'label'>, session: string): string {
	return env.kind === 'container' ? env.label : session;
}

/** The group an environment's rows go under. */
export function groupOf(env: Pick<Environment, 'kind' | 'key' | 'alias'>): GroupNode {
	switch (env.kind) {
		case 'host':
			return { type: 'group', id: 'group:host', label: 'This machine' };
		case 'ssh':
			return { type: 'group', id: `group:${env.key}`, label: `SSH · ${env.alias}` };
		default:
			return { type: 'group', id: 'group:containers', label: 'Dev containers' };
	}
}

/** A connected session's agent status counts, as the row description. */
export function snapshotDescription(snapshot: Snapshot): string {
	return countsDescription(countStatuses(snapshot.panes.filter(hasAgent).map((p) => p.agent_status)));
}

const ENV_DESCRIPTION: Record<Exclude<EnvState['status'], 'ok'>, string> = {
	pending: 'checking…',
	notInstalled: 'herdr not installed',
	unreachable: 'unreachable',
	error: 'error',
};

/** The rows for one environment. */
export function sessionRows(
	state: EnvState,
	connection: (key: string) => SessionConnection | undefined,
	showStopped: boolean,
): SessionRowNode[] {
	const env = state.env;
	const groupId = groupOf(env).id;
	const absent = (description: string, tooltip?: string): SessionRowNode => ({
		type: 'session',
		key: `${env.key}/`,
		envKey: env.key,
		label: env.label,
		description,
		contextValue: 'herdr.session.absent',
		tooltip: tooltip ?? env.key,
		groupId,
	});
	if (state.status !== 'ok') {
		return [absent(ENV_DESCRIPTION[state.status], state.message ? `${env.key}\n${state.message}` : undefined)];
	}
	const rows: SessionRowNode[] = [];
	for (const s of state.sessions) {
		if (!s.running && !showStopped) {
			continue;
		}
		const key = sessionKey(env.key, s.name);
		const conn = s.running ? connection(key) : undefined;
		let description: string;
		if (!s.running) {
			description = 'stopped';
		} else if (conn?.state === 'connected' && conn.snapshot) {
			description = snapshotDescription(conn.snapshot);
		} else if (conn?.state === 'unsupported') {
			description = 'needs herdr 0.9.5 or later';
		} else if (conn?.state === 'disconnected') {
			description = 'disconnected';
		} else {
			description = 'connecting…';
		}
		if (env.kind === 'container' && s.name !== DEVC_SESSION) {
			description = `${s.name} · ${description}`;
		}
		const version = conn?.snapshot?.version;
		rows.push({
			type: 'session',
			key,
			envKey: env.key,
			session: s.name,
			label: sessionRowLabel(env, s.name),
			description,
			contextValue: s.running ? 'herdr.session.running' : 'herdr.session.stopped',
			tooltip: version ? `${key}\nherdr ${version}` : key,
			snapshot: conn?.state === 'connected' ? conn.snapshot : undefined,
			groupId,
		});
	}
	return rows.length > 0 ? rows : [absent('herdr not running')];
}

/**
 * The selected session: the stored one while it runs and is connected or
 * connecting, else this machine's default session, else the first running one.
 */
export function effectiveSelection(
	preferred: string | undefined,
	states: EnvState[],
	connection: (key: string) => SessionConnection | undefined,
): string | undefined {
	if (preferred && connection(preferred)) {
		return preferred;
	}
	const host = states.find((s) => s.env.key === HOST_KEY);
	const hostDefault = host?.sessions.find((s) => s.default && s.running);
	if (hostDefault && connection(sessionKey(HOST_KEY, hostDefault.name))) {
		return sessionKey(HOST_KEY, hostDefault.name);
	}
	for (const state of states) {
		for (const s of state.sessions) {
			if (s.running && connection(sessionKey(state.env.key, s.name))) {
				return sessionKey(state.env.key, s.name);
			}
		}
	}
	return undefined;
}

export class SessionsView implements vscode.TreeDataProvider<SessionsNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<SessionsNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly selectionEmitter = new vscode.EventEmitter<void>();
	/** Fires when {@link selected} may have changed. */
	readonly onDidChangeSelected = this.selectionEmitter.event;
	readonly treeView: vscode.TreeView<SessionsNode>;
	private readonly disposables: vscode.Disposable[] = [];
	private groups: GroupNode[] = [];
	private rows = new Map<string, SessionRowNode[]>();
	private lastSelected: string | undefined;
	private revealed = false;
	/** Set while the view selects a row itself, so that is not stored as the user's choice. */
	private revealing = false;

	constructor(
		private readonly model: SessionModel,
		private readonly state: vscode.Memento,
	) {
		this.treeView = vscode.window.createTreeView('herdr.sessions', { treeDataProvider: this, showCollapseAll: false });
		this.disposables.push(
			this.treeView,
			this.emitter,
			this.selectionEmitter,
			this.treeView.onDidChangeSelection((e) => {
				const node = e.selection[0];
				if (!this.revealing && node?.type === 'session' && node.contextValue === 'herdr.session.running') {
					void this.state.update(SELECTED_SESSION_STATE, node.key);
					this.update();
				}
			}),
			this.treeView.onDidChangeVisibility(() => this.revealSelected()),
			model.onDidChange(() => this.update()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('herdr.showStoppedSessions')) {
					this.update();
				}
			}),
		);
		this.rebuild();
	}

	/** The selected session's key, if any. */
	get selected(): string | undefined {
		return effectiveSelection(this.state.get<string>(SELECTED_SESSION_STATE), this.model.states(), (k) =>
			this.model.connection(k),
		);
	}

	/** The row for a session key. */
	row(key: string): SessionRowNode | undefined {
		for (const rows of this.rows.values()) {
			const row = rows.find((r) => r.key === key);
			if (row) {
				return row;
			}
		}
		return undefined;
	}

	private rebuild(): void {
		const showStopped = vscode.workspace.getConfiguration('herdr').get<boolean>('showStoppedSessions') === true;
		const groups = new Map<string, GroupNode>();
		const rows = new Map<string, SessionRowNode[]>();
		for (const state of this.model.states()) {
			const group = groupOf(state.env);
			groups.set(group.id, group);
			const list = rows.get(group.id) ?? [];
			list.push(...sessionRows(state, (k) => this.model.connection(k), showStopped));
			rows.set(group.id, list);
		}
		this.groups = [...groups.values()];
		this.rows = rows;
	}

	private update(): void {
		this.rebuild();
		this.emitter.fire();
		const selected = this.selected;
		if (selected !== this.lastSelected) {
			this.lastSelected = selected;
			this.revealed = false;
			this.selectionEmitter.fire();
		}
		this.revealSelected();
	}

	/** Shows the selected row as selected (on restore, or after a fallback). */
	private revealSelected(): void {
		const key = this.lastSelected;
		if (!key || this.revealed || !this.treeView.visible) {
			return;
		}
		const row = this.row(key);
		if (row && this.treeView.selection[0] !== row) {
			this.revealed = true;
			this.revealing = true;
			void Promise.resolve(this.treeView.reveal(row, { select: true, focus: false })).then(
				() => {
					this.revealing = false;
				},
				() => {
					this.revealing = false;
					this.revealed = false;
				},
			);
		}
	}

	getTreeItem(node: SessionsNode): vscode.TreeItem {
		if (node.type === 'group') {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.id = node.id;
			item.contextValue = 'herdr.group';
			return item;
		}
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.id = `row:${node.key}`;
		item.description = node.description;
		item.contextValue = node.contextValue;
		item.tooltip = node.tooltip;
		item.iconPath = statusIcon(
			node.snapshot ? worstStatus(node.snapshot.panes.filter(hasAgent).map((p) => p.agent_status)) : undefined,
		);
		return item;
	}

	getChildren(node?: SessionsNode): SessionsNode[] {
		if (!node) {
			return this.groups;
		}
		return node.type === 'group' ? (this.rows.get(node.id) ?? []) : [];
	}

	getParent(node: SessionsNode): SessionsNode | undefined {
		return node.type === 'session' ? this.groups.find((g) => g.id === node.groupId) : undefined;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
