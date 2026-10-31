// Copied from devc-vscode/src/agentReview.ts at 8be03bd; maintained separately.

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { BridgeError, endConnection, HerdrEvent } from './bridge';
import { Environment, EnvironmentsChange } from './environments';
import { GIT_SCHEME } from './git';
import { parsePaneMoved } from './layouts';
import { BindMount, CONTAINER_SCHEME, environmentPathOf, SSH_SCHEME } from './paths';
import { RemoteShell, shQuote } from './remoteShell';
import { ConnectionState, Snapshot, SnapshotPane } from './sessions';
import { makePaneKey, splitPaneKey } from './tilesProtocol';
import { AgentRow, agentRows, sortAndFilterAgents } from './views/agentsView';
import { openPaneIn, paneClickCommand, PaneRef } from './views/spacesView';

/**
 * Comment threads on editor lines that ask a herdr agent about them. A comment
 * goes straight into the agent's pane through `agent.prompt` on the session's
 * bridge, with the file's path as the agent's environment sees it; the agent
 * writes its answer to a reply file in that environment, which a watcher per
 * environment turns into a reply in the thread. Threads live in this window's
 * memory only and are never synced to GitHub.
 */

export const CONTROLLER_ID = 'herdr.agentReview';
export const CONTROLLER_LABEL = 'Agent (herdr)';
export const REPLY_ROOT = '/tmp/herdr-vscode/review';
export const HAS_AGENTS_KEY = 'herdr.hasAgents';
export const ASK_AGENT_COMMAND = 'herdr.askAgent';
export const SUBMIT_COMMAND = 'herdr.agentReview.submit';
export const SHOW_AGENT_COMMAND = 'herdr.agentReview.showAgent';
export const DELETE_COMMAND = 'herdr.agentReview.delete';
export const RESEND_COMMAND = 'herdr.agentReview.resend';

/** Schemes a thread can be on: host paths, and herdr-vscode's own remote and git schemes. */
export const REVIEW_SCHEMES: ReadonlySet<string> = new Set(['file', 'git', 'review', 'pr', CONTAINER_SCHEME, SSH_SCHEME, GIT_SCHEME]);
/** Above this many lines, the prompt points at the file instead of quoting. */
const MAX_SNIPPET_LINES = 200;
const WATCHER_RESTART_MS = 5000;
const SHELL_TIMEOUT_MS = 15000;

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Where the agent writes its answer to a thread's `seq`th comment. */
export function replyPath(threadId: string, seq: number, root = REPLY_ROOT): string {
	return `${root}/${threadId}/${seq}.md`;
}

/**
 * Which version of the file a commented document shows, for the prompt.
 * VS Code's Git extension (`toGitUri`) and GitHub Pull Requests (`toReviewUri`
 * for checked-out PRs, `toPRUri` otherwise) put it in the query as JSON.
 */
export function sideLabel(uri: { scheme: string; query: string }): string {
	if (uri.scheme === 'file' || uri.scheme === CONTAINER_SCHEME || uri.scheme === SSH_SCHEME) {
		return 'working tree';
	}
	if (uri.scheme === GIT_SCHEME) {
		return uri.query === 'HEAD' ? 'git diff, HEAD' : 'diff view';
	}
	let query: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(uri.query);
		if (typeof parsed !== 'object' || parsed === null) {
			return 'diff view';
		}
		query = parsed as Record<string, unknown>;
	} catch {
		return 'diff view';
	}
	const text = (v: unknown): string | undefined => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
	if (uri.scheme === 'git') {
		// '' and '~' are the index ('~' falls back to HEAD for a staged delete).
		const ref = text(query.ref);
		if (ref === undefined) {
			return 'diff view';
		}
		if (ref === '' || ref === '~') {
			return 'git diff, index';
		}
		return /^[0-9a-f]{7,40}$/.test(ref) ? `git diff, commit ${ref}` : `git diff, ${ref}`;
	}
	if (uri.scheme === 'review') {
		const commit = text(query.commit);
		if (typeof query.base !== 'boolean' || !commit) {
			return 'diff view';
		}
		return `PR diff, ${query.base ? 'base' : 'changed'} side, commit ${commit}`;
	}
	if (uri.scheme === 'pr') {
		const pr = text(query.prNumber);
		const commit = text(query.isBase ? query.baseCommit : query.headCommit);
		if (typeof query.isBase !== 'boolean' || !pr || !commit) {
			return 'diff view';
		}
		return `PR #${pr} diff, ${query.isBase ? 'base' : 'head'} side, commit ${commit}`;
	}
	return 'diff view';
}

export interface PromptInput {
	threadId: string;
	seq: number;
	/** The file's path in the agent's environment. */
	environmentPath: string;
	/** 1-based, inclusive. */
	startLine: number;
	endLine: number;
	side: string;
	languageId: string;
	/** The commented lines, one per entry. Only used for `seq == 1`. */
	lines: string[];
	comment: string;
}

/** The text typed into the agent's pane. */
export function buildPrompt(input: PromptInput, root = REPLY_ROOT): string {
	const tag = `[herdr-vscode review ${input.threadId}#${input.seq}]`;
	const location = `${input.environmentPath}:${input.startLine}-${input.endLine}`;
	const reply = replyPath(input.threadId, input.seq, root);
	if (input.seq > 1) {
		return [
			`${tag} Follow-up on ${location}.`,
			input.comment,
			'',
			`Write your answer as Markdown to ${reply}. Don't post to GitHub or the PR; reply only in the file.`,
		].join('\n');
	}
	const count = input.endLine - input.startLine + 1;
	const code = count > MAX_SNIPPET_LINES ? [`(${count} lines selected; read them from the file)`] : ['```' + input.languageId, ...input.lines, '```'];
	return [
		`${tag} Question from a code review in VS Code.`,
		`Location: ${location} (${input.side})`,
		...code,
		input.comment,
		'',
		`Answer the question. Also write your answer as Markdown to ${reply} (the reviewer reads it in their editor). Don't change code unless the question asks you to. Don't post to GitHub or the PR; reply only in the file.`,
	].join('\n');
}

/** `line 7`, or `lines 19–21` (en dash); 1-based. */
export function linesLabel(startLine: number, endLine: number): string {
	return startLine === endLine ? `line ${startLine}` : `lines ${startLine}\u2013${endLine}`;
}

/**
 * A thread's header: `Ask agent · [<agent> (<space>) · ]<lines>[ · <side>]`,
 * the side only when it is not the working tree. Full commit hashes are
 * shortened; the prompt keeps them.
 */
export function threadLabel(startLine: number, endLine: number, side: string, agent?: { label: string; space: string }): string {
	const parts = ['Ask agent'];
	if (agent) {
		parts.push(`${agent.label} (${agent.space})`);
	}
	parts.push(linesLabel(startLine, endLine));
	if (side !== 'working tree') {
		parts.push(side.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/, '$1'));
	}
	return parts.join(' · ');
}

/**
 * VS Code sizes a comment before its Markdown finishes rendering and can clip
 * the last line under the reply box; a trailing empty paragraph absorbs it.
 */
export function padReply(markdown: string): string {
	return `${markdown.trimEnd()}\n\n&nbsp;`;
}

/** Whether a failed `agent.prompt` means the pane has no agent (any more). */
export function isAgentGone(error: unknown): boolean {
	return error instanceof BridgeError && error.code === 'agent_not_found';
}

/** What to tell the user when `agent.prompt` fails. */
export function failureMessage(error: unknown, agentKind: string): string {
	if (error instanceof BridgeError) {
		if (error.code === 'agent_blocked') {
			return `${agentKind} is waiting on a prompt in its pane. Answer it, then Resend.`;
		}
		if (error.code === 'agent_not_found') {
			return 'That agent is gone. Resend to pick another.';
		}
	}
	return `herdr: ${(error as Error)?.message ?? String(error)}`;
}

/** A reply file the watcher saw, by thread and seq. */
export interface ReplyFile {
	threadId: string;
	seq: number;
}

/**
 * Tracks the reply watcher's `cksum` listings: `<crc> <size> <path>` entries
 * joined with `;`. Reports the files whose crc or size changed since the last
 * listing, for threads this window knows.
 */
export class ReplyTracker {
	private readonly seen = new Map<string, string>();
	private readonly entry: RegExp;

	constructor(root = REPLY_ROOT) {
		this.entry = new RegExp(`^(\\d+) (\\d+) ${root.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}/([0-9a-f]+)/(\\d+)\\.md$`);
	}

	changed(line: string, isKnown: (threadId: string) => boolean): ReplyFile[] {
		const out: ReplyFile[] = [];
		for (const entry of line.split(';')) {
			const m = this.entry.exec(entry.trim());
			if (!m || !isKnown(m[3])) {
				continue;
			}
			const key = `${m[3]}/${m[4]}`;
			const signature = `${m[1]} ${m[2]}`;
			if (this.seen.get(key) === signature) {
				continue;
			}
			this.seen.set(key, signature);
			out.push({ threadId: m[3], seq: Number(m[4]) });
		}
		return out;
	}
}

/**
 * Runs in the agent's environment: lists the reply files' checksums every
 * second and prints the listing when it changes. POSIX sh, cksum, tr and sleep
 * only. The loop runs in the background and closing stdin ends it, since
 * `docker exec` and `ssh` never signal the process they started.
 */
export function replyWatchScript(root = REPLY_ROOT): string {
	return `
(
  prev=
  while :; do
    cur=$(cksum ${shQuote(root)}/*/*.md 2>/dev/null | tr '\\n' ';')
    if [ "$cur" != "$prev" ]; then
      printf '%s\\n' "$cur"
      prev=$cur
    fi
    sleep 1
  done
) &
loop=$!
cat >/dev/null
kill $loop
`;
}

/** The whole lines a selection covers; one ending at column 0 stops a line short. */
export function selectedLines(selection: vscode.Selection): vscode.Range {
	const start = selection.start.line;
	const end = selection.end.line > start && selection.end.character === 0 ? selection.end.line - 1 : selection.end.line;
	return new vscode.Range(start, 0, end, 0);
}

// ── Candidates ──────────────────────────────────────────────────────────────

/** What a thread needs of an environment. */
export type ReviewEnvironment = Pick<Environment, 'key' | 'kind' | 'alias' | 'containerId' | 'shell'>;

/** An agent row with the environment its session runs in. */
export interface AgentTarget {
	row: AgentRow;
	env: ReviewEnvironment;
	snapshot: Snapshot;
}

/** An agent that can see a document, and the document's path there. */
export interface Candidate extends AgentTarget {
	path: string;
}

export type MountsOf = (env: ReviewEnvironment) => Promise<BindMount[]>;

/** The agents whose environment can see `uri`, in `targets` order. */
export async function findCandidates(uri: vscode.Uri, targets: readonly AgentTarget[], mounts: MountsOf): Promise<Candidate[]> {
	if (!REVIEW_SCHEMES.has(uri.scheme)) {
		return [];
	}
	const byEnv = new Map<string, Promise<string | undefined>>();
	const out: Candidate[] = [];
	for (const target of targets) {
		let path = byEnv.get(target.env.key);
		if (!path) {
			path = mounts(target.env).then(
				(m) => environmentPathOf(uri, target.env, m),
				() => environmentPathOf(uri, target.env, []),
			);
			byEnv.set(target.env.key, path);
		}
		const p = await path;
		if (p !== undefined) {
			out.push({ ...target, path: p });
		}
	}
	return out;
}

/** The sorted keys of environments with an agent in a connected session, joined. */
export function agentSignature(targets: readonly AgentTarget[]): string {
	return [...new Set(targets.map((t) => t.env.key))].sort().join('\n');
}

/**
 * Commenting ranges for the agent controller: the whole document when some
 * agent's environment can see it, else none, so ordinary files get no `+`.
 */
export class AgentCommentingRanges implements vscode.CommentingRangeProvider {
	constructor(
		private readonly targets: () => AgentTarget[],
		private readonly mounts: MountsOf,
	) {}

	async provideCommentingRanges(document: vscode.TextDocument): Promise<vscode.Range[]> {
		const candidates = await findCandidates(document.uri, this.targets(), this.mounts);
		return candidates.length > 0 ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [];
	}
}

/** The kind of agent in a pane: what its comments are signed with. */
export function agentKind(pane: SnapshotPane): string {
	return pane.display_agent ?? pane.agent ?? 'agent';
}

export interface AgentPickItem extends vscode.QuickPickItem {
	candidate: Candidate;
}

/** The picker's items, in the Agents view's order. */
export function agentPickItems(candidates: readonly Candidate[]): AgentPickItem[] {
	const byId = new Map(candidates.map((c) => [c.row.id, c]));
	return sortAndFilterAgents(
		candidates.map((c) => c.row),
		'all',
	).map((row) => ({
		label: row.label,
		description: `${agentKind(row.pane)} · ${row.pane.agent_status}`,
		detail: row.description,
		candidate: byId.get(row.id)!,
	}));
}

export const PICK_PLACEHOLDER = 'Which agent should answer?';

export type ChoiceSource = 'thread' | 'followed' | 'only' | 'remembered' | 'picker';

/**
 * The agent a send goes to: the thread's own, the followed pane, the only
 * candidate, the remembered pick, else the user's pick. Undefined with no
 * candidate or a dismissed picker.
 */
export async function chooseAgent(input: {
	candidates: readonly Candidate[];
	thread?: PaneRef;
	/** Pane Context's followed pane key. */
	followed?: string;
	remembered?: PaneRef;
	pick(candidates: readonly Candidate[]): Promise<Candidate | undefined>;
}): Promise<{ candidate: Candidate; source: ChoiceSource } | undefined> {
	const { candidates } = input;
	const find = (ref: PaneRef | undefined) => (ref ? candidates.find((c) => c.row.ref.sessionKey === ref.sessionKey && c.row.ref.paneId === ref.paneId) : undefined);
	const steps: [ChoiceSource, Candidate | undefined][] = [
		['thread', find(input.thread)],
		['followed', find(input.followed ? splitPaneKey(input.followed) : undefined)],
		['only', candidates.length === 1 ? candidates[0] : undefined],
		['remembered', find(input.remembered)],
	];
	for (const [source, candidate] of steps) {
		if (candidate) {
			return { candidate, source };
		}
	}
	if (candidates.length === 0) {
		return undefined;
	}
	const picked = await input.pick(candidates);
	return picked && { candidate: picked, source: 'picker' };
}

// ── Controller ──────────────────────────────────────────────────────────────

/** A session connection as the controller reads it. */
export interface ReviewConnection {
	key: string;
	state: ConnectionState;
	snapshot?: Snapshot;
	env: ReviewEnvironment;
	name: string;
}

export interface AgentReviewDeps {
	model: {
		connections(): ReviewConnection[];
		request(sessionKey: string, method: string, params: unknown): Promise<unknown>;
		readonly onDidChange: vscode.Event<void>;
		readonly onDidEvent: vscode.Event<{ sessionKey: string; event: HerdrEvent }>;
	};
	environments: {
		readonly onDidChange: vscode.Event<EnvironmentsChange>;
		readonly onDidContainerEvent: vscode.Event<string>;
	};
	/** An environment's bind mounts (`EnvironmentPaths.mounts`). */
	mounts: MountsOf;
	/** A session's row label in Sessions. */
	rowLabel(sessionKey: string): string | undefined;
	/** Pane Context's followed pane key. */
	followed(): string | undefined;
	/** The picker; a QuickPick by default. */
	pick?(candidates: readonly Candidate[]): Promise<Candidate | undefined>;
	/** Shows a pane the way a pane row click does; by default per `herdr.openPaneIn`. */
	showPane?(ref: PaneRef): Thenable<unknown>;
	/** The reply root in every environment. Tests only. */
	replyRoot?: string;
	log?(message: string): void;
}

class ReviewComment implements vscode.Comment {
	label?: string;
	contextValue?: string;
	readonly mode = vscode.CommentMode.Preview;
	constructor(
		public body: string | vscode.MarkdownString,
		public author: vscode.CommentAuthorInformation,
		/** The thread and the seq of the question this comment is or answers. */
		readonly threadId: string,
		readonly seq: number,
		contextValue?: string,
	) {
		this.contextValue = contextValue;
	}
}

/** One submitted question and what came back for it. */
interface Turn {
	question: ReviewComment;
	/** The waiting placeholder, then the agent's reply. */
	answer?: ReviewComment;
	/** The environment the question was sent to, and the agent's kind. */
	env?: ReviewEnvironment;
	kind?: string;
}

interface ThreadState {
	id: string;
	thread: vscode.CommentThread;
	/** 0-based, inclusive. */
	startLine: number;
	endLine: number;
	agent?: PaneRef;
	/** The environment of the last agent asked, for Delete Thread. */
	env?: ReviewEnvironment;
	turns: Turn[];
}

/** Watches one environment's reply files while it has replies pending. */
interface ReplyWatcher {
	tracker: ReplyTracker;
	shell: RemoteShell;
	child?: cp.ChildProcess;
	restart?: NodeJS.Timeout;
}

export class AgentReviewController implements vscode.Disposable {
	readonly commentController: vscode.CommentController;
	private readonly ranges: AgentCommentingRanges;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly threads = new Map<vscode.CommentThread, ThreadState>();
	private readonly byId = new Map<string, ThreadState>();
	/** The window's last pick from the picker; not persisted. */
	private remembered: PaneRef | undefined;
	private readonly watchers = new Map<string, ReplyWatcher>();
	private signature = '';
	private readonly root: string;
	private disposed = false;

	constructor(private readonly deps: AgentReviewDeps) {
		this.root = deps.replyRoot ?? REPLY_ROOT;
		this.commentController = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
		this.commentController.options = {
			prompt: 'Ask a herdr agent about this code…',
			placeHolder: "Sent to the agent's pane in herdr",
		};
		this.ranges = new AgentCommentingRanges(
			() => this.targets(),
			(env) => deps.mounts(env),
		);
		this.commentController.commentingRangeProvider = this.ranges;
		this.disposables.push(
			this.commentController,
			deps.model.onDidChange(() => this.modelChanged()),
			deps.model.onDidEvent((e) => this.onEvent(e.sessionKey, e.event)),
			deps.environments.onDidChange((change) => {
				for (const env of change.removed) {
					this.stopWatcher(env.key);
					this.watchers.delete(env.key);
				}
			}),
			// A container restart may have changed its mounts.
			deps.environments.onDidContainerEvent(() => this.refreshRanges()),
		);
		void vscode.commands.executeCommand('setContext', HAS_AGENTS_KEY, false);
		this.modelChanged();
	}

	/** The five commands; the extension registers them once. */
	registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(ASK_AGENT_COMMAND, () => this.askAboutSelection()),
			vscode.commands.registerCommand(SUBMIT_COMMAND, (reply: vscode.CommentReply) => this.submit(reply)),
			vscode.commands.registerCommand(SHOW_AGENT_COMMAND, (thread: vscode.CommentThread) => this.showAgent(thread)),
			vscode.commands.registerCommand(DELETE_COMMAND, (thread: vscode.CommentThread) => this.deleteThread(thread)),
			vscode.commands.registerCommand(RESEND_COMMAND, (comment: ReviewComment) => this.resend(comment)),
		];
	}

	dispose(): void {
		this.disposed = true;
		for (const key of [...this.watchers.keys()]) {
			this.stopWatcher(key);
		}
		this.watchers.clear();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	/** Every agent in a connected session, with its environment. */
	private targets(): AgentTarget[] {
		const out: AgentTarget[] = [];
		for (const conn of this.deps.model.connections()) {
			if (conn.state !== 'connected' || !conn.snapshot) {
				continue;
			}
			const rows = agentRows([{ sessionKey: conn.key, rowLabel: this.deps.rowLabel(conn.key) ?? conn.name, snapshot: conn.snapshot }], 'all');
			for (const row of rows) {
				out.push({ row, env: conn.env, snapshot: conn.snapshot });
			}
		}
		return out;
	}

	private modelChanged(): void {
		const signature = agentSignature(this.targets());
		if (signature !== this.signature) {
			this.signature = signature;
			void vscode.commands.executeCommand('setContext', HAS_AGENTS_KEY, signature !== '');
			this.refreshRanges();
		}
	}

	/** The stable API has no change event for ranges: re-assigning the provider makes VS Code ask again. */
	private refreshRanges(): void {
		if (!this.disposed) {
			this.commentController.commentingRangeProvider = this.ranges;
		}
	}

	private onEvent(sessionKey: string, event: HerdrEvent): void {
		const moved = event.event === 'pane.moved' ? parsePaneMoved(event.data) : undefined;
		if (!moved) {
			return;
		}
		const follow = (ref: PaneRef | undefined) => (ref && ref.sessionKey === sessionKey && ref.paneId === moved.from ? { sessionKey, paneId: moved.to } : ref);
		for (const state of this.byId.values()) {
			state.agent = follow(state.agent);
		}
		this.remembered = follow(this.remembered);
	}

	private candidates(uri: vscode.Uri): Promise<Candidate[]> {
		return findCandidates(uri, this.targets(), this.deps.mounts);
	}

	private pick(candidates: readonly Candidate[]): Promise<Candidate | undefined> {
		if (this.deps.pick) {
			return this.deps.pick(candidates);
		}
		return Promise.resolve(vscode.window.showQuickPick(agentPickItems(candidates), { placeHolder: PICK_PLACEHOLDER })).then((item) => item?.candidate);
	}

	// ── Commands ────────────────────────────────────────────────────────────

	async askAboutSelection(): Promise<vscode.CommentThread | undefined> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		const uri = editor.document.uri;
		if ((await this.candidates(uri)).length === 0) {
			void vscode.window.showErrorMessage(`No herdr agent can see ${uri.path}.`);
			return undefined;
		}
		const range = selectedLines(editor.selection);
		const thread = this.commentController.createCommentThread(uri, range, []);
		thread.label = threadLabel(range.start.line + 1, range.end.line + 1, sideLabel(uri));
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
		return thread;
	}

	async submit(reply: { thread: vscode.CommentThread; text: string }): Promise<void> {
		const text = reply.text.trim();
		if (!text) {
			return;
		}
		let state = this.threads.get(reply.thread);
		if (!state) {
			const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
			state = {
				id: crypto.randomBytes(4).toString('hex'),
				thread: reply.thread,
				startLine: range.start.line,
				endLine: range.end.line,
				turns: [],
			};
			this.threads.set(reply.thread, state);
			this.byId.set(state.id, state);
			reply.thread.label = threadLabel(state.startLine + 1, state.endLine + 1, sideLabel(reply.thread.uri));
		}
		const seq = state.turns.length + 1;
		const turn: Turn = { question: new ReviewComment(text, { name: 'You' }, state.id, seq) };
		state.turns.push(turn);
		this.render(state);
		await this.send(state, turn);
	}

	async resend(comment: { threadId: string; seq: number }): Promise<void> {
		const state = this.byId.get(comment.threadId);
		const turn = state?.turns[comment.seq - 1];
		if (!state || !turn) {
			return;
		}
		turn.question.contextValue = undefined;
		turn.question.label = undefined;
		this.render(state);
		await this.send(state, turn);
	}

	async showAgent(thread: vscode.CommentThread): Promise<void> {
		const ref = this.threads.get(thread)?.agent;
		if (!ref) {
			return;
		}
		const conn = this.deps.model.connections().find((c) => c.key === ref.sessionKey);
		const there = conn?.state === 'connected' && conn.snapshot?.panes.some((p) => p.pane_id === ref.paneId);
		if (!there) {
			void vscode.window.showErrorMessage('That agent is gone.');
			return;
		}
		if (this.deps.showPane) {
			await this.deps.showPane(ref);
			return;
		}
		const cmd = paneClickCommand(openPaneIn(), ref);
		await vscode.commands.executeCommand(cmd.command, ...(cmd.arguments ?? []));
	}

	async deleteThread(thread: vscode.CommentThread): Promise<void> {
		const state = this.threads.get(thread);
		thread.dispose();
		if (!state) {
			return;
		}
		this.threads.delete(thread);
		this.byId.delete(state.id);
		for (const key of new Set(state.turns.map((t) => t.env?.key))) {
			if (key) {
				this.stopIdleWatcher(key);
			}
		}
		if (state.env) {
			try {
				await state.env.shell.run(['rm', '-rf', `${this.root}/${state.id}`], { timeoutMs: SHELL_TIMEOUT_MS });
			} catch {
				// Best effort: the environment may be gone.
			}
		}
	}

	// ── Sending ─────────────────────────────────────────────────────────────

	/** Submits a turn's question; marks it failed if not sent. */
	private async send(state: ThreadState, turn: Turn): Promise<void> {
		const fail = (message?: string) => {
			turn.question.contextValue = 'failed';
			turn.question.label = 'Not sent';
			this.render(state);
			if (message) {
				void vscode.window.showErrorMessage(message);
			}
		};
		const uri = state.thread.uri;
		const candidates = await this.candidates(uri);
		if (candidates.length === 0) {
			fail(`No herdr agent can see ${uri.path}.`);
			return;
		}
		const choice = await chooseAgent({
			candidates,
			thread: state.agent,
			followed: this.deps.followed(),
			remembered: this.remembered,
			pick: (c) => this.pick(c),
		});
		if (!choice) {
			// The picker was dismissed.
			fail();
			return;
		}
		const { candidate } = choice;
		if (choice.source === 'picker') {
			this.remembered = candidate.row.ref;
		}
		const ref = candidate.row.ref;
		const kind = agentKind(candidate.row.pane);
		const space = candidate.snapshot.workspaces.find((w) => w.workspace_id === candidate.row.pane.workspace_id)?.label ?? candidate.row.pane.workspace_id;
		state.agent = ref;
		state.env = candidate.env;
		state.thread.contextValue = 'hasAgent';
		const side = sideLabel(uri);
		state.thread.label = threadLabel(state.startLine + 1, state.endLine + 1, side, { label: candidate.row.label, space });

		const seq = turn.question.seq;
		let prompt: string;
		try {
			prompt = buildPrompt(
				{
					threadId: state.id,
					seq,
					environmentPath: candidate.path,
					startLine: state.startLine + 1,
					endLine: state.endLine + 1,
					side,
					...(await this.snippet(state)),
					comment: turn.question.body as string,
				},
				this.root,
			);
		} catch (err) {
			fail(failureMessage(err, kind));
			return;
		}

		const shell = candidate.env.shell;
		await shell.run(['mkdir', '-p', `${this.root}/${state.id}`], { timeoutMs: SHELL_TIMEOUT_MS }).catch(() => undefined);
		try {
			await this.deps.model.request(ref.sessionKey, 'agent.prompt', { target: ref.paneId, text: prompt });
		} catch (err) {
			if (isAgentGone(err)) {
				if (this.remembered && makePaneKey(this.remembered.sessionKey, this.remembered.paneId) === makePaneKey(ref.sessionKey, ref.paneId)) {
					this.remembered = undefined;
				}
				state.agent = undefined;
				state.thread.contextValue = undefined;
			}
			this.deps.log?.(`ask agent: agent.prompt to ${makePaneKey(ref.sessionKey, ref.paneId)} failed: ${(err as Error).message}`);
			fail(failureMessage(err, kind));
			return;
		}
		turn.env = candidate.env;
		turn.kind = kind;
		// A watcher already running may have read the reply first.
		if (turn.answer?.contextValue !== 'reply') {
			turn.answer = new ReviewComment(new vscode.MarkdownString('_Waiting for reply…_'), { name: kind }, state.id, seq, 'pending');
		}
		this.render(state);
		this.startWatcher(candidate.env);
	}

	/** The commented lines and language, read from the document itself. */
	private async snippet(state: ThreadState): Promise<{ lines: string[]; languageId: string }> {
		const document = await vscode.workspace.openTextDocument(state.thread.uri);
		const lines: string[] = [];
		const last = Math.min(state.endLine, document.lineCount - 1);
		if (state.endLine - state.startLine + 1 <= MAX_SNIPPET_LINES) {
			for (let i = state.startLine; i <= last; i++) {
				lines.push(document.lineAt(i).text);
			}
		}
		return { lines, languageId: document.languageId };
	}

	// ── Replies ─────────────────────────────────────────────────────────────

	/** The watcher's process for an environment, while it runs. Tests only. */
	watcherProcess(envKey: string): cp.ChildProcess | undefined {
		return this.watchers.get(envKey)?.child;
	}

	private hasPending(envKey: string): boolean {
		return [...this.byId.values()].some((s) => s.turns.some((t) => t.env?.key === envKey && t.answer?.contextValue === 'pending'));
	}

	private startWatcher(env: ReviewEnvironment): void {
		let watcher = this.watchers.get(env.key);
		if (!watcher) {
			watcher = { tracker: new ReplyTracker(this.root), shell: env.shell };
			this.watchers.set(env.key, watcher);
		}
		watcher.shell = env.shell;
		if (watcher.child || this.disposed) {
			return;
		}
		clearTimeout(watcher.restart);
		watcher.restart = undefined;
		const w = watcher;
		let child: cp.ChildProcess;
		try {
			child = w.shell.spawn(['sh', '-c', replyWatchScript(this.root)]);
		} catch (err) {
			this.deps.log?.(`ask agent: reply watcher in ${env.key} did not start: ${(err as Error).message}`);
			return;
		}
		w.child = child;
		let buf = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			buf += chunk.toString('utf8');
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				for (const file of w.tracker.changed(line, (id) => this.byId.has(id))) {
					this.readReply(env.key, w.shell, file).catch((err) => this.deps.log?.(`ask agent: reading a reply failed: ${(err as Error).message}`));
				}
			}
		});
		child.stdin?.on('error', () => {
			/* the watcher already ended */
		});
		child.on('error', (err) => this.deps.log?.(`ask agent: reply watcher in ${env.key}: ${err.message}`));
		child.on('close', () => {
			if (w.child !== child) {
				return;
			}
			// Ended on its own: back in 5 s while replies are still awaited there.
			w.child = undefined;
			if (!this.disposed && this.watchers.get(env.key) === w && this.hasPending(env.key)) {
				w.restart = setTimeout(() => {
					w.restart = undefined;
					if (!this.disposed && this.watchers.get(env.key) === w && this.hasPending(env.key)) {
						this.startWatcher(env);
					}
				}, WATCHER_RESTART_MS);
			}
		});
	}

	private stopWatcher(envKey: string): void {
		const w = this.watchers.get(envKey);
		if (!w) {
			return;
		}
		clearTimeout(w.restart);
		w.restart = undefined;
		const child = w.child;
		w.child = undefined;
		if (child) {
			// Closing stdin is what ends it; killed only if it has not ended after a grace period.
			endConnection(child);
		}
	}

	private async readReply(envKey: string, shell: RemoteShell, file: ReplyFile): Promise<void> {
		const state = this.byId.get(file.threadId);
		const turn = state?.turns[file.seq - 1];
		if (!state || !turn) {
			return;
		}
		const res = await shell.run(['cat', replyPath(file.threadId, file.seq, this.root)], { timeoutMs: SHELL_TIMEOUT_MS });
		if (res.exitCode !== 0 || this.byId.get(file.threadId) !== state) {
			return;
		}
		const author = turn.kind ?? turn.answer?.author.name ?? 'agent';
		turn.answer = new ReviewComment(new vscode.MarkdownString(padReply(res.stdout.toString('utf8'))), { name: author }, state.id, file.seq, 'reply');
		this.render(state);
		this.stopIdleWatcher(envKey);
	}

	/** Stops an environment's watcher once none of its threads awaits a reply. */
	private stopIdleWatcher(envKey: string): void {
		if (!this.hasPending(envKey)) {
			this.stopWatcher(envKey);
		}
	}

	private render(state: ThreadState): void {
		state.thread.comments = state.turns.flatMap((t) => (t.answer ? [t.question, t.answer] : [t.question]));
	}
}

