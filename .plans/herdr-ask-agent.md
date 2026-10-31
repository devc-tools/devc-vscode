# herdr-vscode: Ask Agent (comment threads answered by a herdr agent)

Mockup board C (https://claude.ai/artifact/QJAeVX6smvE4aQ2YrHrrAP): on editor lines, a comment
thread titled `Ask agent · claude (v3_auth) · lines 19–21` holds your question (`You`) and, once
it is sent, `claude` · *Waiting for reply…*, which the agent's answer replaces. The question goes
straight into the agent's pane through herdr's `agent.prompt`, with the file's path **as the
agent's environment sees it** (host, dev container, SSH host). The agent writes its answer to a
reply file in its environment; the file becomes a reply in the thread.

This is devc-vscode's [Agent Review Comments](agent-review-comments.md) (phase 9), ported into
herdr-vscode and widened from "a herdr agent in the dev container that mounts this file" to "any
agent in herdr-vscode's session model whose environment can see this file". Nothing is added to
the agent's context unless you write it in a thread: no selection tracking, no open-file sharing.

Depends on [herdr-pane-context](herdr-pane-context.md) (phase 17: the followed pane,
`EnvironmentPaths`, the `herdr-container` / `herdr-ssh` / `herdr-git` schemes). Implemented after
[herdr-pane-changes](herdr-pane-changes.md) (phase 20) for ordering only; nothing here uses it.
Paths are under `herdr-vscode/` unless they say otherwise.

## Checklist

- [ ] 1. Live probe on throwaway `hv-test` (see [Live probe](#live-probe)); record the results in
      Implementation notes before writing the send path
- [ ] 2. Copy `devc-vscode/src/agentReview.ts` to `herdr-vscode/src/agentReview.ts` with the header
      `// Copied from devc-vscode/src/agentReview.ts at <short commit>; maintained separately.`
      (`<short commit>` = `git rev-parse --short HEAD` at copy time), then adapt it as this plan
      says. devc-vscode is never imported from or edited
- [ ] 3. Document → environment path mapping in `src/paths.ts` (see [Paths](#paths))
- [ ] 4. Comment controller `herdr.agentReview` and its commenting ranges (see
      [Commenting ranges](#commenting-ranges))
- [ ] 5. `herdr.askAgent` (**Ask herdr Agent About Selection**) in the editor context menu
- [ ] 6. Choosing the agent: thread's agent → followed pane → only candidate → remembered → picker
      (see [Choosing the agent](#choosing-the-agent))
- [ ] 7. Sending through the session's bridge (`agent.prompt`), prompt text, reply directory (see
      [Sending](#sending))
- [ ] 8. Reply watcher per environment; replies shown and updated in the thread (see [Replies](#replies))
- [ ] 9. Failures with **Resend**; thread title actions **Show Agent** and **Delete Thread**
- [ ] 10. Thread state follows `pane.moved`; watchers stop with their environment
- [ ] 11. `package.json` contributions and the `herdr.hasAgents` context key (see [Contributions](#contributions))
- [ ] 12. Tests (list under Validation), including `src/test/liveAskAgent.test.ts`
- [ ] 13. README section, `docs/how-it-works.md` section, CHANGELOG entry

## Decisions

- **Any environment.** Host, dev container and SSH agents are all targets. SSH goes through the same
  `RemoteShell` (`SshShell`) seam as everything else and is **untested live**: no SSH host is
  available, so it gets unit tests only and its Manual item is marked deferred.
- **Ranges on any document some agent can see; the agent is chosen on submit.** The `+` does not
  depend on the followed pane (it changes with every tile click, and VS Code only re-asks for ranges
  when told to). The followed pane is the default target, not a gate.
- **Sent through the bridge, not the CLI.** herdr-vscode reaches herdr only through
  `herdr remote-api-bridge`; `agent.prompt` (params `{"target","text","wait"}` in herdr 0.9.5's
  `herdr api schema`) is the same operation `herdr agent prompt` performs. `SessionModel.request`
  already runs it through the environment's `RemoteShell` (so `LocalShell`'s `HERDR_*` stripping
  applies on the host; `docker exec` and `ssh` pass no local environment), and errors come back as
  `BridgeError` with herdr's `code`. No `herdr agent prompt` argv, no one-shot `herdr api snapshot`:
  agents come from the model's live snapshots.
- **One reply mechanism for every environment.** The ported `cksum` watch script runs through the
  environment's shell for host, container and SSH alike (on the host through `LocalShell`). No
  `FileSystemWatcher` path for the host: one code path, already proven in devc-vscode.
- **Threads are in memory**, never synced to GitHub, gone on reload. Reply files are removed only by
  **Delete Thread**.
- **Coexists with devc-vscode.** Every id is `herdr.*`, the controller label is `Agent (herdr)`
  (devc's is `Agent (devc)`), the reply root is `/tmp/herdr-vscode/review` (devc's is
  `/tmp/devc-vscode/review`), and the prompt tag is `[herdr-vscode review …]` (devc's is
  `[devc review …]`).
- **The agent's pane is not focused or revealed on send.** **Show Agent** does that.
- **Out of scope:** changing a thread's agent other than by its pane disappearing; persisting threads;
  file-level comments.

## Contracts

### Paths

Add to `src/paths.ts` (names at the implementer's discretion; behavior is the contract):

- `containerPathOf(hostPath, mounts)`: the reverse of `hostPathOf`. Among bind mounts whose `source`
  holds `hostPath` (`isUnder(hostPath, source)`), take the **longest `source`**; return
  `<destination without trailing /><rest>` (`/` when empty); undefined when none holds it.
- `environmentPathOf(uri, env, mounts)`: the document's path in `env`, or undefined.

| `uri.scheme` | host env | container env | SSH env |
| --- | --- | --- | --- |
| `file`, `git`, `review`, `pr` (`uri.path` is a host path) | `uri.path` | `containerPathOf(uri.path, mounts)` | undefined |
| `herdr-container` | undefined | `uri.path` when `uri.authority` equals the first 12 chars of `env.containerId` (case-insensitive) | undefined |
| `herdr-ssh` | undefined | undefined | `uri.path` when `uri.authority` equals `env.alias` ignoring case (`Uri.toString()` lower-cases authorities) |
| `herdr-git` | `parseGitHeadUri(uri)` → `<toplevel>/<file>` when its `envKey` equals `env.key` ignoring case | same | same |
| anything else | undefined | undefined | undefined |

`mounts` comes from `EnvironmentPaths.mounts(env)` (cached until the container restarts; empty for
host and SSH). A host `file:` path may map into several environments; that is expected.

**Gotcha:** for `git`, `review` and `pr` URIs `uri.path` is the host path of the file (VS Code Git's
`toGitUri`, GitHub PR's `toReviewUri` / `toPRUri`), the same assumption devc-vscode's
`copyHostContainerPath` makes.

### Candidate agents

A **candidate** for a document is an agent row (`agentRows(...)` from `src/views/agentsView.ts`, over
every connection with `state === 'connected'` and a snapshot) whose session's environment
(`model.connection(sessionKey).env`) gives `environmentPathOf(uri, env, mounts) !== undefined`.
The environment path of the thread is that value for the chosen agent's environment.

### Commenting ranges

`provideCommentingRanges(document)` returns `[new Range(0, 0, document.lineCount - 1, 0)]` when the
document's scheme is one of `file`, `git`, `review`, `pr`, `herdr-container`, `herdr-ssh`,
`herdr-git` and it has at least one candidate agent; otherwise `[]`, so ordinary files get no `+`
from this controller.

Build it around injected functions (the agent rows with their environments, and the mounts reader)
so tests pass fakes, the same injection style `PaneContextView` uses.

**Refreshing ranges:** keep a signature = the sorted keys of environments that have at least one
agent in a connected session. On `model.onDidChange`, when the signature changes, set
`herdr.hasAgents` to `signature !== ''` and **re-assign** `controller.commentingRangeProvider` (the
same object). **Gotcha:** the stable API has no change event for commenting ranges; assigning the
property is what makes VS Code re-query open editors (`$updateCommentingRanges`). Also re-assign on
`environments.onDidContainerEvent` (mounts may change).

### Thread label

- Lines part: `line <n>` for one line, else `lines <start>–<end>` (en dash U+2013), 1-based.
- Before an agent is chosen: `Ask agent · <lines>`.
- With an agent: `Ask agent · <row label> (<space label>) · <lines>`, where row label is
  `paneLabel(pane, snapshot)` and space label is the pane's workspace `label` in the snapshot (the
  workspace id when missing).
- When the side label (below) is not `working tree`, append ` · <side label>` with any 40-hex commit
  shortened to its first 7 characters (devc-vscode's `threadLabel` regex
  `/\b([0-9a-f]{7})[0-9a-f]{33}\b/` → `$1`). The prompt keeps full hashes.

Example: `Ask agent · claude (v3_auth) · lines 19–21`.

### Side label (in the prompt)

devc-vscode's `sideLabel` table is kept exactly (`file` → `working tree`; `git` → `git diff, index`
for ref `""` or `~`, `git diff, commit <ref>` for a 7–40 char hex ref, else `git diff, <ref>`;
`review` → `PR diff, base|changed side, commit <commit>`; `pr` →
`PR #<n> diff, base|head side, commit <commit>`; any `JSON.parse` failure or missing field →
`diff view`). Added rows:

| Scheme | Label |
| --- | --- |
| `herdr-container`, `herdr-ssh` | `working tree` |
| `herdr-git` with `uri.query === 'HEAD'` | `git diff, HEAD` |
| `herdr-git` with any other query | `diff view` |

### Choosing the agent

Run on every send (first send, follow-up, Resend), in order:

1. The thread's agent (a `{sessionKey, paneId}`), when that pane is still in a connected snapshot,
   still `hasAgent`, and is still a candidate.
2. Pane Context's followed pane (`PaneContextView.followed`, whether or not the view is visible),
   when it is a candidate.
3. The only candidate, when there is exactly one.
4. The window's remembered pick (one value, not persisted), when it is a candidate.
5. A QuickPick of the candidates, ordered by `sortAndFilterAgents(rows, 'all')`. Item: label = row
   label, description = `<pane.display_agent ?? pane.agent> · <pane.agent_status>`, detail = the
   Agents row description (`<session row label> › <space label>[ · <title>]`). placeHolder
   `Which agent should answer?`. The pick becomes the remembered pick. Dismissed → the comment is
   marked failed with no notification.

No candidate → error `No herdr agent can see <uri.path>.` and the comment is marked failed.

After a successful choice the thread stores the agent, sets `thread.contextValue = 'hasAgent'` and
updates its label. The agent's **kind** below is `pane.display_agent ?? pane.agent`.

### Sending

Thread id: 8 random lowercase hex characters (`crypto.randomBytes(4).toString('hex')`), made on the
thread's first submit. `seq` starts at 1 and goes up by one per comment submitted in the thread.

Reply root (in the agent's environment): `/tmp/herdr-vscode/review`. Reply path:
`/tmp/herdr-vscode/review/<threadId>/<seq>.md`. Keep the root injectable internally so the
extension-host test can point it at a temp directory; the shipped value is exactly this.

Steps:

1. Add the user's comment immediately: author `You`, `mode: Preview`, body = the trimmed text as a
   plain string. Empty text → nothing happens.
2. Choose the agent (above).
3. Build the prompt (below). The snippet is read from `vscode.workspace.openTextDocument(thread.uri)`,
   not from the environment, so base-side lines stay right.
4. Run `mkdir -p /tmp/herdr-vscode/review/<threadId>` through the environment's `shell.run` (argv,
   best effort: a failure is ignored here and surfaces as no reply).
5. `model.request(sessionKey, 'agent.prompt', { target: <paneId>, text: <prompt> })`. No `wait` key.
   A `working` agent is fine (Claude queues typed input).
6. On success: add the placeholder: author `<kind>`, body `new MarkdownString('_Waiting for reply…_')`,
   `contextValue: 'pending'`; start the environment's reply watcher.

### Prompt text (contract)

First comment (`seq == 1`):

````
[herdr-vscode review <threadId>#<seq>] Question from a code review in VS Code.
Location: <environment path>:<startLine>-<endLine> (<side label>)
```<document.languageId>
<selected lines, verbatim>
```
<comment text>

Answer the question. Also write your answer as Markdown to <replyPath> (the reviewer reads it in their editor). Don't change code unless the question asks you to. Don't post to GitHub or the PR; reply only in the file.
````

Follow-up (`seq > 1`):

```
[herdr-vscode review <threadId>#<seq>] Follow-up on <environment path>:<startLine>-<endLine>.
<comment text>

Write your answer as Markdown to <replyPath>. Don't post to GitHub or the PR; reply only in the file.
```

- Lines are 1-based and inclusive; one line still prints `N-N`. Lines joined with `\n`.
- More than 200 lines: the fence (three lines above) is replaced by the one line
  `(<n> lines selected; read them from the file)`.
- The environment path is recomputed for the chosen agent on every send (a follow-up to a different
  agent after the first one went away may be in another environment).

### Replies

One watcher per **environment key**. It starts on the first successful send to that environment and
stops when none of its threads has a `pending` answer, when the environment is removed
(`environments.onDidChange` → `removed`), or on deactivate. If its process exits on its own while
replies are pending and the environment still exists, it restarts after 5 s.

The script is devc-vscode's `replyWatchScript` with the root changed, run as
`shell.spawn(['sh', '-c', <script>])`: a background loop, stdin held open, closing stdin ends it
(`docker exec` and `ssh` never signal the remote process). POSIX `sh`, `cksum`, `tr`, `sleep` only (it
also runs on a macOS host). Every 1 s:

```sh
cur=$(cksum /tmp/herdr-vscode/review/*/*.md 2>/dev/null | tr '\n' ';')
```

and it prints `$cur` plus a newline only when it changed.

**Parsing each stdout line:** split on `;`; trim each entry; match
`^(\d+) (\d+) /tmp/herdr-vscode/review/([0-9a-f]+)/(\d+)\.md$` (crc, size, threadId, seq). Entries
that do not match (including the empty line printed when no file exists), and thread ids this window
does not know, are ignored. Per `<threadId>/<seq>`, remember `"<crc> <size>"`; when it differs from
the last seen value, `cat` the file through the environment's shell and, on exit 0, replace that
seq's answer (placeholder or earlier reply) with author `<kind>`,
`body: new MarkdownString(padReply(stdout))`, `contextValue: 'reply'`. `padReply` is devc-vscode's
(`trimEnd()` + `\n\n&nbsp;`). A later change to the file updates the reply again (covers a read that
caught a partial write, and an agent rewriting its answer).

**Gotcha (document it):** in Claude Code's default permission mode, writing outside the project
(`/tmp/...`) asks for approval in the pane, so the reply waits until the user approves there. In
auto mode it does not wait.

### Failures

A send fails when choosing the agent fails, or `model.request` rejects. For a `BridgeError`, word
`code`:

| `code` | Message |
| --- | --- |
| `agent_blocked` | `<kind> is waiting on a prompt in its pane. Answer it, then Resend.` |
| `agent_not_found` | `That agent is gone. Resend to pick another.` (also clear the thread's agent, its `hasAgent` context value, and the remembered pick if it is that pane) |
| anything else, or a plain `Error` | `herdr: <message>` |

If the [Live probe](#live-probe) shows that prompting a gone or non-agent pane returns a different
code, map that code exactly like `agent_not_found` and record it in Implementation notes.

On any failure: the user's comment gets `contextValue: 'failed'` and `label: 'Not sent'`; the
message is shown with `showErrorMessage` (except a dismissed picker); no placeholder is added.

**Resend** clears `failed` and the label, then repeats [Sending](#sending) from step 2 for that
comment's seq.

**Show Agent:** look up the thread's pane in the current snapshot; if it is there, execute
`paneClickCommand(openPaneIn(), ref)` (the same command a pane row click runs, so it opens per
`herdr.openPaneIn`); otherwise `showErrorMessage('That agent is gone.')`.

**Delete Thread:** dispose the thread, forget it, stop an idle watcher, and run
`rm -rf /tmp/herdr-vscode/review/<threadId>` through the shell of the environment of the thread's
last agent (best effort; nothing when it never had one).

**Moved panes:** on a `pane.moved` event (`parsePaneMoved` from `src/layouts.ts`), any thread or
remembered pick whose `{sessionKey, paneId}` is the old pane switches to the new pane id.

### Ask herdr Agent About Selection

`herdr.askAgent` on the active text editor: when the document has no candidate agent, show
`No herdr agent can see <uri.path>.` and stop. Otherwise create a thread with no comments on
`selectedLines(editor.selection)` (devc-vscode's: whole lines; a selection ending at column 0 of a
later line excludes that line; an empty selection is the cursor's line), set its label
(`Ask agent · <lines>`) and `collapsibleState = Expanded`, which opens the reply box directly with
no provider picker.

### Contributions

| Id | Title | Where |
| --- | --- | --- |
| comment controller `herdr.agentReview` | label `Agent (herdr)` | options `prompt: "Ask a herdr agent about this code…"`, `placeHolder: "Sent to the agent's pane in herdr"` |
| `herdr.askAgent` | Ask herdr Agent About Selection | `editor/context`, group `herdr@1`, when `herdr.hasAgents && resourceScheme =~ /^(file\|git\|review\|pr\|herdr-container\|herdr-ssh\|herdr-git)$/` |
| `herdr.agentReview.submit` | Ask Agent | `comments/commentThread/context`, when `commentController == herdr.agentReview` |
| `herdr.agentReview.showAgent` | Show Agent (icon `$(terminal)`) | `comments/commentThread/title`, group `inline`, when `commentController == herdr.agentReview && commentThread =~ /hasAgent/` |
| `herdr.agentReview.delete` | Delete Thread (icon `$(trash)`) | `comments/commentThread/title`, group `inline`, when `commentController == herdr.agentReview` |
| `herdr.agentReview.resend` | Resend | `comments/comment/title`, group `inline`, when `commentController == herdr.agentReview && comment == failed` |

`commandPalette`: `herdr.askAgent` when `herdr.hasAgents && editorIsOpen`; the four
`herdr.agentReview.*` commands `"when": "false"`.

Context key `herdr.hasAgents`: set from the range signature (above); `false` at activation, so it is
false under `HERDR_VSCODE_NO_DISCOVERY=1`. No new settings and no new activation events
(`onStartupFinished` already activates the extension; the controller is created in `activate`).

### VS Code Comments API gotchas

- A thread made by the gutter `+` is created by VS Code, not by the extension: the first
  `CommentReply` brings a `thread` the controller has never seen. Track state in a
  `Map<CommentThread, State>` by object identity, created on first submit.
- `CommentReply` is passed to the `comments/commentThread/context` command as `{thread, text}`;
  the `comments/commentThread/title` commands get the `CommentThread`; `comments/comment/title`
  commands get the `Comment` object, so comments must carry their thread id and seq (devc-vscode's
  `ReviewComment` class).
- Changing a comment's fields does not re-render: always assign a new array to `thread.comments`.
- `thread.range` is `Range | undefined` in the current API; treat undefined as `Range(0,0,0,0)`.
- `comment == failed` matches `Comment.contextValue`; `commentThread =~ /hasAgent/` matches
  `CommentThread.contextValue`. Both are scoped by `commentController == herdr.agentReview`, so
  devc-vscode's identical context values never show herdr's actions and vice versa.
- With devc-vscode installed and both controllers offering ranges on a line (a container-mounted
  file), the `+` shows VS Code's comment-provider picker (`Agent (devc)` / `Agent (herdr)`, plus
  GitHub Pull Request on a PR diff). **Ask herdr Agent About Selection** bypasses it.
- In a diff editor each side is its own document URI; ranges and threads are per side.
- VS Code can size a comment before its Markdown renders and clip the last line under the reply box:
  that is what `padReply`'s trailing `&nbsp;` paragraph is for.
- A plain string `body` is shown as text; replies use `MarkdownString`.

### Live probe

Before writing the send path, with herdr 0.9.5 in an isolated `HOME` holding only a throwaway
session `hv-test` (as the README's `HERDR_VSCODE_LIVE_HOME` describes; start it with
`sessionServerArgv('hv-test')`, and afterwards run `herdr session stop hv-test` then
`herdr session delete hv-test` in that `HOME`). Never send input to any other session.

1. `bridgeRequest(shell, 'hv-test', 'agent.prompt', {target: <plain shell pane id>, text: 'x'})`:
   record the error `code` and `message`.
2. Put an executable `claude` in `<home>/.local/bin` (a POSIX `sh` loop that appends every stdin
   line to a file in a temp directory and, for any line containing a path matching
   `/tmp/herdr-vscode/review/[0-9a-f]+/[0-9]+\.md`, writes `ok` to that path), run it in an `hv-test` pane, and check `agent.list` / `agent.get` through the
   bridge. Record whether herdr 0.9.5 detects it as an agent and with what status.
3. If detected: send a 3-line `agent.prompt` and record exactly what the fake receives (bracketed
   paste markers, line splitting, the final Enter); send a 150-line prompt and record it is accepted.

These results decide the live suite's scope (below) and go in Implementation notes.

## Validation

- [ ] `cd herdr-vscode && npm run build && npm run lint && xvfb-run -a npm test` passes, with a new
      `src/test/agentReview.test.ts` covering:
  - [ ] prompt text for `seq == 1` and `seq > 1` exactly as in [Prompt text](#prompt-text-contract),
        including `N-N` for one line and the 200-line cutoff (200 quoted, 201 not)
  - [ ] side label for `file`, `git` (index `""`, `~`, a 40-hex commit, `HEAD`), `review` (base and
        changed), `pr` (base and head), malformed and missing query → `diff view`,
        `herdr-container`, `herdr-ssh`, `herdr-git` with `HEAD` and with another query
  - [ ] thread label: before an agent, with an agent, one line (`line 7`), a PR side with a 40-hex
        commit shortened to 7, and the mockup's `Ask agent · claude (v3_auth) · lines 19–21`
  - [ ] `containerPathOf`: longest source wins, exact source → destination, outside every source →
        undefined, trailing slashes; `environmentPathOf`: every cell of the [Paths](#paths) table,
        including `herdr-container` of another container, an upper-case `herdr-ssh` authority,
        a `herdr-git` URI from `gitHeadUri` for the same and a different env key
  - [ ] commenting ranges with injected agents and mounts: full document for each mapped scheme,
        `[]` for an unmapped `file:` doc, for an `untitled:` doc, and when the only agent's
        environment cannot see the doc
  - [ ] agent choice order with fakes: thread's agent kept; followed pane beats the remembered pick;
        a followed non-agent pane or one that cannot see the doc is skipped; one candidate used
        without a picker; remembered pick used; otherwise the picker is reached (stubbed)
  - [ ] reply-listing parser: an entry that changed crc or size is reported once, an unchanged one is
        not, an empty line and an unknown thread id are ignored, a devc-vscode path
        (`/tmp/devc-vscode/review/...`) is ignored
  - [ ] failure messages for `agent_blocked`, `agent_not_found`, another code, and a plain `Error`
  - [ ] extension-host round trip on a real `CommentController` and a temp-file document, with a fake
        model whose `request` records calls and a `LocalShell` with the reply root pointed at a temp
        directory: submit → the `You` comment, one `agent.prompt` call with
        `{target, text}` and no `wait`, the placeholder `_Waiting for reply…_`; writing
        `<root>/<id>/1.md` → the reply replaces it within 3 s; rewriting it → the reply updates; a
        rejected request with `agent_blocked` → `Not sent`, `contextValue` `failed`, no placeholder;
        **Resend** after the fake succeeds → placeholder; **Delete Thread** removes `<root>/<id>`;
        after the last reply the watcher process has exited
  - [ ] `src/test/extension.test.ts`: the five commands are contributed and registered; the menus
        above exist with exactly those `when` clauses; no contributed id starts with `devc-vscode.`
- [ ] `HERDR_VSCODE_LIVE_HOME=<dir> xvfb-run -a npm test` with only `hv-test` running there passes,
      including a new `src/test/liveAskAgent.test.ts` that: sends `agent.prompt` through the real
      bridge to a plain shell pane and gets the error mapped as in [Failures](#failures); and, if the
      probe found the fake `claude` detected, runs the full round trip on it (prompt received, reply
      file written by the fake in its environment's real `/tmp/herdr-vscode/review/<id>/1.md`,
      reply shown in a real thread). `hv-test` is stopped and deleted afterwards
- [ ] `git diff --stat -- devc-vscode` is empty
- [ ] `grep -rn "devc-vscode" herdr-vscode/src --include=*.ts` shows only the `// Copied from` /
      `// Ported from` header lines (no imports)
- [ ] Manual, host: with Claude in a host herdr session following its pane in Pane Context, open a
      file in its repo, click `+` on lines 19–21, ask a question → the thread is titled
      `Ask agent · claude (<space>) · lines 19–21`, shows `claude` · *Waiting for reply…*, the prompt
      appears in the Claude pane with the host path, and the answer replaces the placeholder
- [ ] Manual: **Ask herdr Agent About Selection** on a multi-line selection opens the reply box with no
      provider picker; the prompt shows the right `start-end`
- [ ] Manual: a follow-up sends the follow-up form with `#2`; its reply lands under it
- [ ] Manual: with two agents that can see the file and the followed pane a shell, the picker shows
      once and the second thread reuses the pick; following an agent pane sends to it with no picker
- [ ] Manual, container: a file in a dev container's bind-mounted project, asked of a container agent,
      sends the **container** path; a `herdr-container:` file outside the mount sends its path too;
      the reply arrives from the container's `/tmp`
- [ ] Manual: with Claude at a permission prompt, sending marks the comment `Not sent` with the
      `agent_blocked` message; after answering, **Resend** delivers it
- [ ] Manual: **Show Agent** opens the agent's pane per `herdr.openPaneIn`; **Delete Thread** removes
      the thread
- [ ] Manual: with devc-vscode also installed, a container-mounted file's `+` offers both
      `Agent (devc)` and `Agent (herdr)`, and each answers in its own thread
- [ ] Manual: a file no agent can see gets no `+` from this controller and the context-menu command
      shows `No herdr agent can see …`
- [ ] Manual, SSH (**deferred: no SSH host available**): a `herdr-ssh:` file asked of an agent on that
      host sends the remote path and the reply arrives

## Relevant Files

- `herdr-vscode/src/agentReview.ts` (new, copied from devc-vscode and adapted: controller, commands,
  prompt builder, side label, thread label, agent choice, reply watcher, failure mapping)
- `herdr-vscode/src/paths.ts` (`containerPathOf`, `environmentPathOf`)
- `herdr-vscode/src/extension.ts` (create the controller with the model, environments,
  `EnvironmentPaths`, the Pane Context view's `followed`, and the pane-click command; set
  `herdr.hasAgents`)
- `herdr-vscode/src/paneContext.ts` (only if `followed` needs exposing through a narrower type; no
  behavior change)
- `herdr-vscode/src/views/agentsView.ts` (read: `agentRows`, `sortAndFilterAgents`; export anything
  needed, no behavior change)
- `herdr-vscode/package.json` (commands, `editor/context`, `comments/*` menus, `commandPalette`)
- `herdr-vscode/src/test/agentReview.test.ts` (new)
- `herdr-vscode/src/test/paths.test.ts` (reverse mapping cases, if kept there rather than in
  `agentReview.test.ts`)
- `herdr-vscode/src/test/extension.test.ts` (contributions)
- `herdr-vscode/src/test/liveAskAgent.test.ts` (new, opt-in `HERDR_VSCODE_LIVE_HOME`)
- `herdr-vscode/README.md` ("## Ask an agent about code" after "## Pane Context": the `+`, the
  context-menu command, how the agent is chosen, the permission-mode gotcha; the live suite in
  "## Development")
- `herdr-vscode/docs/how-it-works.md` ("## Ask Agent": path mapping, `agent.prompt` over the bridge,
  the reply directory and watcher, the permission-mode gotcha, coexistence with devc-vscode)
- `herdr-vscode/CHANGELOG.md` (`[Unreleased]` entry)
- `devc-vscode/src/agentReview.ts`, `devc-vscode/src/herdr.ts`, `devc-vscode/package.json` (read only:
  the source of the port)
- `.plans/PLAN.md` (phase 21 status)
