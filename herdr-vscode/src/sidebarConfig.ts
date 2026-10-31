import * as fs from 'fs';
import * as path from 'path';
import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' };
import * as vscode from 'vscode';

// smol-toml is an ES module with a CommonJS build (`index.cjs`), which `require`
// loads; its types are the ES module's. esbuild bundles it.
const { parse } = require('smol-toml') as typeof SmolToml;

/**
 * Spaces and Agents rows from `[ui.sidebar.spaces]` / `[ui.sidebar.agents]` in
 * this machine's herdr `config.toml`, validated as herdr 0.9.5 validates them.
 */

/** Rows of token names (`$name` for custom tokens); styles are dropped after validation. */
export type SidebarRows = string[][];

export interface SidebarConfig {
	spaces?: { rows: SidebarRows };
	agents?: { rows?: SidebarRows; rowsByAgent?: Record<string, SidebarRows> };
}

export const SPACE_TOKENS = ['state_icon', 'state_text', 'workspace', 'branch', 'git_status'] as const;
export const AGENT_TOKENS = [
	'state_icon',
	'state_text',
	'machine',
	'workspace',
	'tab',
	'pane',
	'agent',
	'terminal_title',
	'terminal_title_stripped',
] as const;

const CUSTOM_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const FG = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const STYLE_KEYS = new Set(['token', 'fg', 'bold', 'dim']);

// ── Path ────────────────────────────────────────────────────────────────────

/**
 * `HERDR_CONFIG_PATH`, else `$XDG_CONFIG_HOME/herdr/config.toml`, else
 * `<home>/.config/herdr/config.toml` (empty values skipped); none on Windows.
 */
export function sidebarConfigPath(
	env: Record<string, string | undefined>,
	homedir: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform === 'win32') {
		return undefined;
	}
	if (env.HERDR_CONFIG_PATH) {
		return env.HERDR_CONFIG_PATH;
	}
	if (env.XDG_CONFIG_HOME) {
		return path.join(env.XDG_CONFIG_HOME, 'herdr', 'config.toml');
	}
	return path.join(homedir, '.config', 'herdr', 'config.toml');
}

// ── Parse and validate ──────────────────────────────────────────────────────

class InvalidConfig extends Error {}

function isTable(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** A table at `key` in `parent`, undefined when absent; throws when present but not a table. */
function table(parent: Record<string, unknown> | undefined, key: string, name: string): Record<string, unknown> | undefined {
	const v = parent?.[key];
	if (v === undefined) {
		return undefined;
	}
	if (!isTable(v)) {
		throw new InvalidConfig(`${name} must be a table`);
	}
	return v;
}

function checkToken(token: string, kind: 'space' | 'agent'): string {
	if (token.startsWith('$')) {
		if (!CUSTOM_NAME.test(token.slice(1))) {
			throw new InvalidConfig(`invalid custom token \`${token}\``);
		}
		return token;
	}
	const known: readonly string[] = kind === 'space' ? SPACE_TOKENS : AGENT_TOKENS;
	if (!known.includes(token)) {
		throw new InvalidConfig(`unknown ${kind} token \`${token}\``);
	}
	return token;
}

function parseRows(value: unknown, name: string, kind: 'space' | 'agent'): SidebarRows {
	if (!Array.isArray(value) || !value.every(Array.isArray)) {
		throw new InvalidConfig(`${name} must be an array of arrays`);
	}
	return (value as unknown[][]).map((row) =>
		row.map((el) => {
			if (typeof el === 'string') {
				return checkToken(el, kind);
			}
			if (!isTable(el)) {
				throw new InvalidConfig(`${name}: a token must be a string or { token = "…" }`);
			}
			for (const key of Object.keys(el)) {
				if (!STYLE_KEYS.has(key)) {
					throw new InvalidConfig(`${name}: unknown key \`${key}\` in a styled token`);
				}
			}
			if (typeof el.token !== 'string') {
				throw new InvalidConfig(`${name}: a styled token needs \`token\``);
			}
			if (el.fg !== undefined && (typeof el.fg !== 'string' || !FG.test(el.fg))) {
				throw new InvalidConfig(`${name}: invalid fg \`${String(el.fg)}\``);
			}
			for (const flag of ['bold', 'dim'] as const) {
				if (el[flag] !== undefined && typeof el[flag] !== 'boolean') {
					throw new InvalidConfig(`${name}: ${flag} must be a boolean`);
				}
			}
			return checkToken(el.token, kind);
		}),
	);
}

function checkRowGap(section: Record<string, unknown>, name: string): void {
	const v = section.row_gap;
	if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
		throw new InvalidConfig(`${name}.row_gap must be an integer ≥ 0`);
	}
}

export type ParseResult = { config: SidebarConfig } | { error: string };

/** The sidebar part of a herdr `config.toml`; any error in it is an error for the whole of it. */
export function parseSidebarConfig(text: string): ParseResult {
	let doc: Record<string, unknown>;
	try {
		doc = parse(text) as Record<string, unknown>;
	} catch (err) {
		return { error: String((err as Error).message ?? err).split('\n')[0] };
	}
	try {
		const ui = table(doc, 'ui', 'ui');
		const sidebar = table(ui, 'sidebar', 'ui.sidebar');
		const spacesT = table(sidebar, 'spaces', 'ui.sidebar.spaces');
		const agentsT = table(sidebar, 'agents', 'ui.sidebar.agents');
		const config: SidebarConfig = {};
		if (spacesT) {
			checkRowGap(spacesT, 'ui.sidebar.spaces');
			if (spacesT.rows !== undefined) {
				config.spaces = { rows: parseRows(spacesT.rows, 'ui.sidebar.spaces.rows', 'space') };
			}
		}
		if (agentsT) {
			checkRowGap(agentsT, 'ui.sidebar.agents');
			const agents: NonNullable<SidebarConfig['agents']> = {};
			if (agentsT.rows !== undefined) {
				agents.rows = parseRows(agentsT.rows, 'ui.sidebar.agents.rows', 'agent');
			}
			const byAgent = table(agentsT, 'rows_by_agent', 'ui.sidebar.agents.rows_by_agent');
			if (byAgent) {
				agents.rowsByAgent = {};
				for (const [id, rows] of Object.entries(byAgent)) {
					agents.rowsByAgent[id] = parseRows(rows, `ui.sidebar.agents.rows_by_agent.${id}`, 'agent');
				}
			}
			if (agents.rows || agents.rowsByAgent) {
				config.agents = agents;
			}
		}
		return { config };
	} catch (err) {
		if (err instanceof InvalidConfig) {
			return { error: err.message };
		}
		throw err;
	}
}

export type LoadResult = { status: 'missing' } | { status: 'ok'; config: SidebarConfig } | { status: 'error'; error: string };

/** Reads (following symlinks) and parses the file. */
export async function loadSidebarConfig(file: string): Promise<LoadResult> {
	let text: string;
	try {
		text = await fs.promises.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'missing' };
		}
		return { status: 'error', error: (err as Error).message };
	}
	const parsed = parseSidebarConfig(text);
	return 'error' in parsed ? { status: 'error', error: parsed.error } : { status: 'ok', config: parsed.config };
}

/** The config the views read, and when it changes. */
export interface SidebarRowsSource {
	readonly config: SidebarConfig | undefined;
	readonly onDidChange: vscode.Event<void>;
}

// ── Watcher ─────────────────────────────────────────────────────────────────

const POLL_MS = 2000;

/**
 * The current sidebar config of one file: loaded when enabled, polled every
 * 2 s (`fs.watchFile`, which follows symlinks and sees the file appear and go),
 * dropped when disabled. Fires when the parsed result changes.
 */
export class SidebarConfigSource implements SidebarRowsSource, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private current: SidebarConfig | undefined;
	private currentKey = 'none';
	/** The last outcome logged or passed silently, so a failure is logged once. */
	private lastOutcome: string | undefined;
	private watching = false;
	private enabled = false;
	private loadGen = 0;
	private readonly listener = (curr: fs.Stats, prev: fs.Stats) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size || curr.ino !== prev.ino) {
			void this.reload();
		}
	};

	constructor(
		readonly file: string | undefined,
		private readonly log: (line: string) => void,
		private readonly pollMs = POLL_MS,
	) {}

	/** The config in effect; undefined when off, missing or invalid. */
	get config(): SidebarConfig | undefined {
		return this.current;
	}

	/** Turns reading and polling on or off. */
	async setEnabled(enabled: boolean): Promise<void> {
		this.enabled = enabled;
		if (!enabled || !this.file) {
			this.unwatch();
			this.loadGen++;
			this.lastOutcome = undefined;
			this.set(undefined);
			return;
		}
		if (!this.watching) {
			fs.watchFile(this.file, { interval: this.pollMs, persistent: false }, this.listener);
			this.watching = true;
		}
		await this.reload();
	}

	/** Re-reads the file now. */
	async reload(): Promise<void> {
		if (!this.enabled || !this.file) {
			return;
		}
		const gen = ++this.loadGen;
		const result = await loadSidebarConfig(this.file);
		if (gen !== this.loadGen || !this.enabled) {
			return;
		}
		let config: SidebarConfig | undefined;
		let outcome: string;
		if (result.status === 'ok') {
			config = result.config;
			outcome = `ok ${JSON.stringify(config)}`;
		} else if (result.status === 'missing') {
			outcome = 'missing';
		} else {
			outcome = `error ${result.error}`;
		}
		if (outcome !== this.lastOutcome) {
			this.lastOutcome = outcome;
			if (result.status === 'error') {
				this.log(`sidebar config: ${this.file}: ${result.error}; using default rows`);
			} else if (result.status === 'ok') {
				this.log(`sidebar config: ${this.file}: loaded`);
			}
		}
		this.set(config);
	}

	private set(config: SidebarConfig | undefined): void {
		const key = config ? JSON.stringify(config) : 'none';
		this.current = config;
		if (key !== this.currentKey) {
			this.currentKey = key;
			this.emitter.fire();
		}
	}

	private unwatch(): void {
		if (this.watching && this.file) {
			fs.unwatchFile(this.file, this.listener);
		}
		this.watching = false;
	}

	dispose(): void {
		this.enabled = false;
		this.unwatch();
		this.emitter.dispose();
	}
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface RenderedRow {
	label: string;
	description?: string;
	/** Whether `state_icon` occurs: the row has its status icon, else none. */
	icon: boolean;
}

interface Segment {
	kind: string;
	value: string;
}

const BREADCRUMB_FROM = new Set(['workspace', 'tab']);
const BREADCRUMB_TO = new Set(['tab', 'pane']);

/**
 * Flattens `rows` into one row: the first `labelToken` is the label (its value
 * even when absent), `state_icon` the icon, every other token a description
 * segment (each kind once; empty values skipped; trimmed), joined with ` · `,
 * ` › ` for breadcrumbs, and `branch` + `git_status` as `pair`.
 */
export function renderRow(
	rows: SidebarRows,
	labelToken: 'workspace' | 'agent',
	value: (token: string) => string | undefined,
	pair?: string,
): RenderedRow {
	const flat = rows.flat();
	const seen = new Set<string>([labelToken, 'state_icon']);
	const segments: Segment[] = [];
	for (const token of flat) {
		if (seen.has(token)) {
			continue;
		}
		seen.add(token);
		const v = value(token)?.trim();
		if (v) {
			segments.push({ kind: token, value: v });
		}
	}
	let description = '';
	for (let i = 0; i < segments.length; i++) {
		const cur = segments[i];
		const prev = segments[i - 1];
		if (prev?.kind === 'branch' && cur.kind === 'git_status' && pair) {
			description = description.slice(0, description.length - prev.value.length) + pair;
			continue;
		}
		if (prev) {
			description += BREADCRUMB_FROM.has(prev.kind) && BREADCRUMB_TO.has(cur.kind) ? ' › ' : ' · ';
		}
		description += cur.value;
	}
	return { label: value(labelToken) ?? '', description: description || undefined, icon: flat.includes('state_icon') };
}

/** The value of a `$name` token from a token map. */
export function customToken(token: string, tokens: Readonly<Record<string, string>> | undefined): string | undefined {
	return token.startsWith('$') ? tokens?.[token.slice(1)] : undefined;
}
