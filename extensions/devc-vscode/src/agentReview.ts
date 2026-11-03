import * as crypto from 'crypto';
import * as posix from 'path/posix';
import * as vscode from 'vscode';
import { taskLabel } from './agentTree';
import {
  ContainerBindMount,
  ContainerInfo,
  mapHostPath,
} from './containerTree';
import {
  AgentInfo,
  CONTAINER_SESSION,
  promptHerdrAgent,
  readHerdrSnapshot,
} from './herdr';
import { RemoteShell } from './remoteShell';

/**
 * Comment threads on host code that ask a herdr agent in the dev container
 * about it. A comment is submitted straight into the agent's pane with
 * `herdr agent prompt`; the agent writes its answer to a reply file in the
 * container, which a per-container watcher turns into a reply in the thread.
 * Threads live in this window's memory only and are never synced to GitHub.
 */

export const CONTROLLER_ID = 'devc-vscode.agentReview';
export const REPLY_ROOT = '/tmp/devc-vscode/review';
/**
 * Schemes whose `uri.path` is a host path: files, VS Code Git diff sides, and
 * GitHub PR diff sides.
 */
const SCHEMES: ReadonlySet<string> = new Set(['file', 'git', 'review', 'pr']);
/** Above this many lines, the prompt points at the file instead of quoting. */
const MAX_SNIPPET_LINES = 200;
/** How long listBindMounts's answer is reused by the commenting range provider. */
const MOUNT_CACHE_MS = 10000;

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Where the agent writes its answer to a thread's `seq`th comment. */
export function replyPath(threadId: string, seq: number): string {
  return `${REPLY_ROOT}/${threadId}/${seq}.md`;
}

/**
 * Which version of the file a commented document shows, for the prompt.
 * VS Code's Git extension (`toGitUri`) and GitHub Pull Requests (`toReviewUri`
 * for checked-out PRs, `toPRUri` otherwise) put it in the query as JSON.
 */
export function sideLabel(uri: { scheme: string; query: string }): string {
  if (uri.scheme === 'file') {
    return 'working tree';
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
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
  if (uri.scheme === 'git') {
    // '' and '~' are the index ('~' falls back to HEAD for a staged delete).
    const ref = text(query.ref);
    if (ref === undefined) {
      return 'diff view';
    }
    if (ref === '' || ref === '~') {
      return 'git diff, index';
    }
    return /^[0-9a-f]{7,40}$/.test(ref)
      ? `git diff, commit ${ref}`
      : `git diff, ${ref}`;
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
  containerPath: string;
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
export function buildPrompt(input: PromptInput): string {
  const tag = `[devc review ${input.threadId}#${input.seq}]`;
  const location = `${input.containerPath}:${input.startLine}-${input.endLine}`;
  const reply = replyPath(input.threadId, input.seq);
  if (input.seq > 1) {
    return [
      `${tag} Follow-up on ${location}.`,
      input.comment,
      '',
      `Write your answer as Markdown to ${reply}. Don't post to GitHub or the PR; reply only in the file.`,
    ].join('\n');
  }
  const count = input.endLine - input.startLine + 1;
  const code =
    count > MAX_SNIPPET_LINES
      ? [`(${count} lines selected; read them from the file)`]
      : ['```' + input.languageId, ...input.lines, '```'];
  return [
    `${tag} Question from a code review in VS Code.`,
    `Location: ${location} (${input.side})`,
    ...code,
    input.comment,
    '',
    `Answer the question. Also write your answer as Markdown to ${reply} (the reviewer reads it in their editor). Don't change code unless the question asks you to. Don't post to GitHub or the PR; reply only in the file.`,
  ].join('\n');
}

/**
 * A thread's header: which version of the file it is about and, once known,
 * the agent answering. Full commit hashes are shortened; the prompt keeps them.
 */
export function threadLabel(side: string, agentKind?: string): string {
  const short = side.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/, '$1');
  const label = short.charAt(0).toUpperCase() + short.slice(1);
  return agentKind ? `${agentKind} · ${label}` : label;
}

/**
 * VS Code sizes a comment before its Markdown finishes rendering and can clip
 * the last line under the reply box; a trailing empty paragraph absorbs it.
 */
export function padReply(markdown: string): string {
  return `${markdown.trimEnd()}\n\n&nbsp;`;
}

/** What to tell the user when `herdr agent prompt` fails. */
export function failureMessage(
  error: { code?: string; message: string },
  agentKind: string
): string {
  switch (error.code) {
    case 'agent_blocked':
      return `${agentKind} is waiting on a prompt in its pane. Answer it, then Resend.`;
    case 'agent_not_found':
      return 'That agent is gone. Resend to pick another.';
    default:
      return error.message;
  }
}

/** A reply file the watcher saw, by thread and seq. */
export interface ReplyFile {
  threadId: string;
  seq: number;
}

const REPLY_ENTRY = new RegExp(
  `^(\\d+) (\\d+) ${REPLY_ROOT.replace(/[/.-]/g, '\\$&')}/([0-9a-f]+)/(\\d+)\\.md$`
);

/**
 * Tracks the reply watcher's `cksum` listings: `<crc> <size> <path>` entries
 * joined with `;`. Reports the files whose crc or size changed since the last
 * listing, for threads this window knows.
 */
export class ReplyTracker {
  private readonly seen = new Map<string, string>();

  changed(line: string, isKnown: (threadId: string) => boolean): ReplyFile[] {
    const out: ReplyFile[] = [];
    for (const entry of line.split(';')) {
      const m = REPLY_ENTRY.exec(entry.trim());
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
 * Runs in the container: lists the reply files' checksums every second and
 * prints the listing when it changes. Needs only POSIX sh and cksum. As with
 * herdr's watchScript, the loop runs in the background and closing stdin ends
 * it, since `docker exec` never signals the process it started.
 */
export function replyWatchScript(): string {
  return `
(
  prev=
  while :; do
    cur=$(cksum ${REPLY_ROOT}/*/*.md 2>/dev/null | tr '\\n' ';')
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

/**
 * Comment ranges for the agent controller: the whole document when its host
 * path is mounted into a running container, else none, so ordinary files get
 * no `+` from this controller.
 */
export class AgentCommentingRanges implements vscode.CommentingRangeProvider {
  constructor(
    private readonly getMounts: () => Promise<ContainerBindMount[]>,
    private readonly log: (message: string) => void = () => {}
  ) {}

  async provideCommentingRanges(
    document: vscode.TextDocument
  ): Promise<vscode.Range[]> {
    const uri = document.uri;
    if (!SCHEMES.has(uri.scheme)) {
      return [];
    }
    const mounts = await this.getMounts();
    const mapped = mapHostPath(uri.path, mounts);
    this.log(
      `agent review: ranges for ${uri.toString()} → ${
        mapped
          ? `${mapped.containerId}:${mapped.path} (${sideLabel(uri)})`
          : `unmapped (${mounts.length} bind mounts)`
      }`
    );
    if (!mapped) {
      return [];
    }
    return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
  }
}

/** The whole lines a selection covers; one ending at column 0 stops a line short. */
export function selectedLines(selection: vscode.Selection): vscode.Range {
  const start = selection.start.line;
  const end =
    selection.end.line > start && selection.end.character === 0
      ? selection.end.line - 1
      : selection.end.line;
  return new vscode.Range(start, 0, end, 0);
}

// ── Controller ──────────────────────────────────────────────────────────────

export interface AgentReviewDeps {
  /** Every running container's bind mounts (listBindMounts). */
  listMounts(): Promise<ContainerBindMount[]>;
  /** A shell in a container as its remote user. */
  containerShell(containerId: string): Promise<RemoteShell>;
  /** Reveal an agent's pane in a terminal attached to the container's herdr. */
  focusContainerAgent(
    container: ContainerInfo,
    agent: AgentInfo
  ): Promise<void>;
  /** Diagnostics for the Devc output channel. */
  log?(message: string): void;
}

class ReviewComment implements vscode.Comment {
  label?: string;
  contextValue?: string;
  constructor(
    public body: string | vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    /** The thread and the seq of the question this comment is or answers. */
    readonly threadId: string,
    readonly seq: number,
    contextValue?: string
  ) {
    this.contextValue = contextValue;
  }
  readonly mode = vscode.CommentMode.Preview;
}

/** One submitted question and what came back for it. */
interface Turn {
  question: ReviewComment;
  /** The waiting placeholder, then the agent's reply. */
  answer?: ReviewComment;
}

interface ThreadState {
  id: string;
  thread: vscode.CommentThread;
  container: ContainerInfo;
  containerPath: string;
  /** 0-based, inclusive. */
  startLine: number;
  endLine: number;
  agent?: AgentInfo;
  turns: Turn[];
}

/** Watches one container's reply files while it has replies pending. */
interface ReplyWatcher {
  tracker: ReplyTracker;
  stream?: { dispose(): void };
}

export class AgentReviewController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly threads = new Map<vscode.CommentThread, ThreadState>();
  private readonly byId = new Map<string, ThreadState>();
  /** The pane picked when a container had several agents, by container id. */
  private readonly remembered = new Map<string, string>();
  private readonly watchers = new Map<string, ReplyWatcher>();
  private mountCache?: { at: number; mounts: Promise<ContainerBindMount[]> };

  constructor(private readonly deps: AgentReviewDeps) {
    this.controller = vscode.comments.createCommentController(
      CONTROLLER_ID,
      'Agent (devc)'
    );
    this.controller.options = {
      prompt: 'Ask the agent about this code…',
      placeHolder: 'Sent to the agent running in the container',
    };
    this.controller.commentingRangeProvider = new AgentCommentingRanges(
      () => this.cachedMounts(),
      message => this.deps.log?.(message)
    );
    this.disposables.push(
      this.controller,
      vscode.commands.registerCommand('devc-vscode.askAgent', () =>
        this.askAboutSelection()
      ),
      vscode.commands.registerCommand(
        'devc-vscode.agentReviewSubmit',
        (reply: vscode.CommentReply) => this.submit(reply)
      ),
      vscode.commands.registerCommand(
        'devc-vscode.agentReviewShowAgent',
        (thread: vscode.CommentThread) => this.showAgent(thread)
      ),
      vscode.commands.registerCommand(
        'devc-vscode.agentReviewDelete',
        (thread: vscode.CommentThread) => this.deleteThread(thread)
      ),
      vscode.commands.registerCommand(
        'devc-vscode.agentReviewResend',
        (comment: ReviewComment) => this.resend(comment)
      )
    );
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.stream?.dispose();
    }
    this.watchers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private cachedMounts(): Promise<ContainerBindMount[]> {
    const now = Date.now();
    if (!this.mountCache || now - this.mountCache.at >= MOUNT_CACHE_MS) {
      this.mountCache = {
        at: now,
        mounts: this.deps.listMounts().catch(() => []),
      };
    }
    return this.mountCache.mounts;
  }

  /** The container a host document is mounted into, and the path inside it. */
  private async locate(
    uri: vscode.Uri
  ): Promise<{ container: ContainerInfo; path: string } | undefined> {
    if (!SCHEMES.has(uri.scheme)) {
      return undefined;
    }
    // Fresh, not cached: a send must reach a container that is running now.
    const mounts = await this.deps.listMounts();
    const mapped = mapHostPath(uri.path, mounts);
    const mount =
      mapped && mounts.find(m => m.containerId === mapped.containerId);
    if (!mapped || !mount) {
      return undefined;
    }
    return {
      container: {
        id: mapped.containerId,
        localFolder: mount.localFolder,
        containerName: mount.containerName,
        name: mount.localFolder
          ? posix.basename(mount.localFolder)
          : mount.containerName,
      },
      path: mapped.path,
    };
  }

  // ── Commands ────────────────────────────────────────────────────────────

  private async askAboutSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    if (!(await this.locate(uri))) {
      vscode.window.showErrorMessage(`No running container mounts ${uri.path}`);
      return;
    }
    const thread = this.controller.createCommentThread(
      uri,
      selectedLines(editor.selection),
      []
    );
    thread.label = threadLabel(sideLabel(uri));
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  private async submit(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (!text) {
      return;
    }
    let state = this.threads.get(reply.thread);
    if (!state) {
      const located = await this.locate(reply.thread.uri);
      if (!located) {
        vscode.window.showErrorMessage(
          `No running container mounts ${reply.thread.uri.path}`
        );
        return;
      }
      const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
      state = {
        id: crypto.randomBytes(4).toString('hex'),
        thread: reply.thread,
        container: located.container,
        containerPath: located.path,
        startLine: range.start.line,
        endLine: range.end.line,
        turns: [],
      };
      this.threads.set(reply.thread, state);
      reply.thread.label = threadLabel(sideLabel(reply.thread.uri));
      this.byId.set(state.id, state);
    }
    const seq = state.turns.length + 1;
    const turn: Turn = {
      question: new ReviewComment(text, { name: 'You' }, state.id, seq),
    };
    state.turns.push(turn);
    this.render(state);
    await this.send(state, turn);
  }

  private async resend(comment: ReviewComment): Promise<void> {
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

  private async showAgent(thread: vscode.CommentThread): Promise<void> {
    const state = this.threads.get(thread);
    if (!state?.agent) {
      return;
    }
    const shell = await this.deps.containerShell(state.container.id);
    const agents = await readHerdrSnapshot(shell, CONTAINER_SESSION);
    const agent = agents.find(a => a.paneId === state.agent?.paneId);
    if (!agent) {
      vscode.window.showErrorMessage('That agent is gone.');
      return;
    }
    await this.deps.focusContainerAgent(state.container, agent);
  }

  private async deleteThread(thread: vscode.CommentThread): Promise<void> {
    const state = this.threads.get(thread);
    thread.dispose();
    if (!state) {
      return;
    }
    this.threads.delete(thread);
    this.byId.delete(state.id);
    this.stopIdleWatcher(state.container.id);
    try {
      const shell = await this.deps.containerShell(state.container.id);
      await shell.run(['rm', '-rf', `${REPLY_ROOT}/${state.id}`]);
    } catch {
      // Best effort: the container may be gone.
    }
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  /** Submit a turn's question to the thread's agent; marks it failed if not sent. */
  private async send(state: ThreadState, turn: Turn): Promise<void> {
    const fail = (message?: string) => {
      turn.question.contextValue = 'failed';
      turn.question.label = 'Not sent';
      this.render(state);
      if (message) {
        vscode.window.showErrorMessage(message);
      }
    };
    let shell: RemoteShell;
    let agent: AgentInfo | undefined;
    try {
      shell = await this.deps.containerShell(state.container.id);
      agent = await this.chooseAgent(state, shell);
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    if (!agent) {
      // No agent (already reported) or the picker was dismissed.
      fail();
      return;
    }
    state.agent = agent;
    state.thread.contextValue = 'hasAgent';
    state.thread.label = threadLabel(sideLabel(state.thread.uri), agent.agent);

    const seq = turn.question.seq;
    let prompt: string;
    try {
      prompt = buildPrompt({
        threadId: state.id,
        seq,
        containerPath: state.containerPath,
        startLine: state.startLine + 1,
        endLine: state.endLine + 1,
        side: sideLabel(state.thread.uri),
        ...(await this.snippet(state)),
        comment: turn.question.body as string,
      });
    } catch (err) {
      fail((err as Error).message);
      return;
    }

    await shell
      .run(['mkdir', '-p', `${REPLY_ROOT}/${state.id}`])
      .catch(() => undefined);
    const error = await promptHerdrAgent(
      shell,
      CONTAINER_SESSION,
      agent.paneId,
      prompt
    );
    if (error) {
      if (error.code === 'agent_not_found') {
        if (this.remembered.get(state.container.id) === agent.paneId) {
          this.remembered.delete(state.container.id);
        }
        state.agent = undefined;
        state.thread.contextValue = undefined;
      }
      fail(failureMessage(error, agent.agent));
      return;
    }
    turn.answer = new ReviewComment(
      new vscode.MarkdownString(`_Waiting for ${agent.agent}…_`),
      { name: agent.agent },
      state.id,
      seq,
      'pending'
    );
    this.render(state);
    this.startWatcher(state.container.id, shell);
  }

  /** The commented lines and language, read from the document itself. */
  private async snippet(
    state: ThreadState
  ): Promise<{ lines: string[]; languageId: string }> {
    const document = await vscode.workspace.openTextDocument(state.thread.uri);
    const lines: string[] = [];
    const last = Math.min(state.endLine, document.lineCount - 1);
    if (last - state.startLine + 1 <= MAX_SNIPPET_LINES) {
      for (let i = state.startLine; i <= last; i++) {
        lines.push(document.lineAt(i).text);
      }
    }
    return { lines, languageId: document.languageId };
  }

  /**
   * The agent a thread's question goes to: the thread's own while its pane is
   * still there, else the only agent, else the one remembered for the
   * container, else the user's pick. Undefined when there is none.
   */
  private async chooseAgent(
    state: ThreadState,
    shell: RemoteShell
  ): Promise<AgentInfo | undefined> {
    const containerId = state.container.id;
    const agents = await readHerdrSnapshot(shell, CONTAINER_SESSION);
    const current = agents.find(a => a.paneId === state.agent?.paneId);
    if (current) {
      return current;
    }
    if (agents.length === 0) {
      vscode.window.showErrorMessage(
        `No agent is running in ${state.container.name}. Add one from the Agents view.`
      );
      return undefined;
    }
    if (agents.length === 1) {
      return agents[0];
    }
    const remembered = agents.find(
      a => a.paneId === this.remembered.get(containerId)
    );
    if (remembered) {
      return remembered;
    }
    const picked = await vscode.window.showQuickPick(
      agents.map(agent => ({
        label: taskLabel(agent),
        description: `${agent.agent} · ${agent.status}`,
        detail: agent.paneId,
        agent,
      })),
      { placeHolder: `Which agent in ${state.container.name}?` }
    );
    if (picked) {
      this.remembered.set(containerId, picked.agent.paneId);
    }
    return picked?.agent;
  }

  // ── Replies ─────────────────────────────────────────────────────────────

  private startWatcher(containerId: string, shell: RemoteShell): void {
    let watcher = this.watchers.get(containerId);
    if (!watcher) {
      watcher = { tracker: new ReplyTracker() };
      this.watchers.set(containerId, watcher);
    }
    if (watcher.stream) {
      return;
    }
    const w = watcher;
    let child;
    try {
      child = shell.spawn(['sh', '-c', replyWatchScript()]);
    } catch (err) {
      console.error('devc-vscode: reply watcher error', (err as Error).message);
      return;
    }
    let stopped = false;
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const files = w.tracker.changed(line, id => this.byId.has(id));
        for (const file of files) {
          this.readReply(shell, file).catch(err =>
            console.error('devc-vscode: reply read error', err)
          );
        }
      }
    });
    child.stdin?.on('error', () => {
      /* the exec already ended */
    });
    child.on('error', err => {
      console.error('devc-vscode: reply watcher error', err.message);
    });
    child.on('close', () => {
      if (!stopped && w.stream === stream) {
        w.stream = undefined;
      }
    });
    const stream = {
      dispose() {
        stopped = true;
        child.stdin?.end();
        child.kill();
      },
    };
    w.stream = stream;
  }

  private async readReply(shell: RemoteShell, file: ReplyFile): Promise<void> {
    const state = this.byId.get(file.threadId);
    const turn = state?.turns[file.seq - 1];
    if (!state || !turn) {
      return;
    }
    const res = await shell.run(['cat', replyPath(file.threadId, file.seq)]);
    if (res.exitCode !== 0 || !this.byId.has(file.threadId)) {
      return;
    }
    const author = turn.answer?.author.name ?? state.agent?.agent ?? 'agent';
    turn.answer = new ReviewComment(
      new vscode.MarkdownString(padReply(res.stdout.toString('utf8'))),
      { name: author },
      state.id,
      file.seq,
      'reply'
    );
    this.render(state);
    this.stopIdleWatcher(state.container.id);
  }

  /** Stop a container's watcher once none of its threads awaits a reply. */
  private stopIdleWatcher(containerId: string): void {
    const pending = [...this.byId.values()].some(
      s =>
        s.container.id === containerId &&
        s.turns.some(t => t.answer?.contextValue === 'pending')
    );
    const watcher = this.watchers.get(containerId);
    if (!pending && watcher?.stream) {
      watcher.stream.dispose();
      watcher.stream = undefined;
    }
  }

  private render(state: ThreadState): void {
    state.thread.comments = state.turns.flatMap(t =>
      t.answer ? [t.question, t.answer] : [t.question]
    );
  }
}
