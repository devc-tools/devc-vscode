import { parseSnapshot, Snapshot } from '../sessions';

/** A `session.snapshot` result shaped as herdr 0.9.5 sends it (measured against hv-test). */
export const RAW_SNAPSHOT = {
	version: '0.9.5',
	protocol: 22,
	focused_workspace_id: 'w2',
	focused_tab_id: 'w2:t1',
	focused_pane_id: 'w2:p1',
	workspaces: [
		{ workspace_id: 'w2', number: 2, label: 'api', focused: true, worktree: { repo_name: 'api' } },
		{ workspace_id: 'w1', number: 1, label: 'web', focused: false, worktree: { repo_name: 'frontend' } },
	],
	tabs: [
		{ tab_id: 'w1:t2', workspace_id: 'w1', number: 2, label: 'logs', focused: false },
		{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: true },
		{ tab_id: 'w2:t1', workspace_id: 'w2', number: 1, label: 'main', focused: true },
	],
	panes: [
		{
			pane_id: 'w2:p1',
			tab_id: 'w2:t1',
			workspace_id: 'w2',
			agent: 'claude',
			agent_status: 'working',
			cwd: '/src/api',
			foreground_cwd: '/src/api',
			terminal_title_stripped: 'Refactoring',
			focused: true,
		},
		{
			pane_id: 'w2:p2',
			tab_id: 'w2:t1',
			workspace_id: 'w2',
			agent_status: 'unknown',
			cwd: '/src/api',
			foreground_cwd: '/src/api/test',
			terminal_title_stripped: 'zsh',
			focused: false,
		},
		{
			pane_id: 'w1:p1',
			tab_id: 'w1:t1',
			workspace_id: 'w1',
			agent: 'codex',
			display_agent: 'Codex',
			agent_status: 'blocked',
			cwd: '/src/web',
			focused: false,
		},
		{
			pane_id: 'w1:p2',
			tab_id: 'w1:t2',
			workspace_id: 'w1',
			agent: 'claude',
			agent_status: 'done',
			cwd: '/src/web',
			focused: false,
		},
	],
	agents: [
		{ pane_id: 'w2:p1', name: 'api-fixer', agent: 'claude', agent_status: 'working' },
		{ pane_id: 'w1:p1', name: null, agent: 'codex', agent_status: 'blocked' },
	],
};

export function snapshot(raw: unknown = RAW_SNAPSHOT): Snapshot {
	const s = parseSnapshot(raw);
	if (!s) {
		throw new Error('fixture did not parse');
	}
	return s;
}
