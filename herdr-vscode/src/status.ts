import * as vscode from 'vscode';

export type AgentStatus = 'blocked' | 'working' | 'done' | 'idle' | 'unknown';

const RANK: Record<AgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/** herdr's `agent_status`, with anything unexpected as `unknown`. */
export function toStatus(value: unknown): AgentStatus {
	return typeof value === 'string' && value in RANK ? (value as AgentStatus) : 'unknown';
}

/** Sort rank: blocked first, unknown last. */
export function statusRank(status: AgentStatus): number {
	return RANK[status];
}

/** The worst (lowest-rank) status, or undefined for none. */
export function worstStatus(statuses: Iterable<AgentStatus>): AgentStatus | undefined {
	let worst: AgentStatus | undefined;
	for (const s of statuses) {
		if (worst === undefined || RANK[s] < RANK[worst]) {
			worst = s;
		}
	}
	return worst;
}

const COLOR: Partial<Record<AgentStatus, string>> = {
	blocked: 'charts.orange',
	working: 'charts.blue',
	done: 'charts.green',
};

/** The codicon id and theme color id for a status. */
export function statusIconSpec(status: AgentStatus): { id: string; color?: string } {
	const color = COLOR[status];
	return color ? { id: 'circle-filled', color } : { id: 'circle-outline' };
}

/** The icon for a status; `circle-outline` for none (a session or space without agents). */
export function statusIcon(status: AgentStatus | undefined): vscode.ThemeIcon {
	if (status === undefined) {
		return new vscode.ThemeIcon('circle-outline');
	}
	const spec = statusIconSpec(status);
	return new vscode.ThemeIcon(spec.id, spec.color ? new vscode.ThemeColor(spec.color) : undefined);
}

/** The icon for a pane with no agent. */
export const SHELL_ICON = new vscode.ThemeIcon('terminal');

export interface StatusCounts {
	blocked: number;
	working: number;
	done: number;
}

export function countStatuses(statuses: Iterable<AgentStatus>): StatusCounts {
	const counts: StatusCounts = { blocked: 0, working: 0, done: 0 };
	for (const s of statuses) {
		if (s === 'blocked' || s === 'working' || s === 'done') {
			counts[s]++;
		}
	}
	return counts;
}

/** `"<n> blocked · <n> working · <n> done"` without the zero parts; `"idle"` when all are zero. */
export function countsDescription(counts: StatusCounts): string {
	const parts = (['blocked', 'working', 'done'] as const)
		.filter((k) => counts[k] > 0)
		.map((k) => `${counts[k]} ${k}`);
	return parts.length > 0 ? parts.join(' · ') : 'idle';
}

/** Command the status bar item runs: show blocked agents, then open the herdr container. */
export const REVEAL_BLOCKED_COMMAND = 'herdr.revealBlockedAgents';

/** `$(warning) <n> blocked` on the right while any agent is blocked. */
export class BlockedStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('herdr.blocked', vscode.StatusBarAlignment.Right, 100);

	constructor() {
		this.item.name = 'herdr blocked agents';
		this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		this.item.command = REVEAL_BLOCKED_COMMAND;
	}

	update(blocked: number): void {
		if (blocked > 0) {
			this.item.text = `$(warning) ${blocked} blocked`;
			this.item.tooltip = `${blocked} herdr ${blocked === 1 ? 'agent' : 'agents'} blocked`;
			this.item.show();
		} else {
			this.item.hide();
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
