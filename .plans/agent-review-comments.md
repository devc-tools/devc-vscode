# Agent Review Comments

Ask a herdr agent running in a dev container about code you are looking at on the host,
from a comment thread on the code. That includes GitHub Pull Requests review diffs. The
comment is submitted straight into the agent's pane with `herdr agent prompt`, using the
container path of the file. The agent writes its answer to a file in the container, and
that answer shows up as a reply in the same thread.

Nothing is added to the agent's context unless you write it in a thread. There is no
selection tracking and no open-file sharing.

## Checklist

The implementing agent runs inside the dev container. It has no host VS Code, no
GitHub Pull Requests extension and no display. Items and validations marked
**(user, host)** are for the user to check afterwards. They don't block
implementation. Build the code exactly as this plan specifies, including the
defensive parsing in [Diff side](#diff-side).

- [x] Comment controller `devc-vscode.agentReview` with commenting ranges only on mapped documents (see [Commenting ranges](#commenting-ranges))
- [x] Command `devc-vscode.askAgent` (**Ask Agent About Selection**) in the editor context menu
- [x] Submit handler: resolve target agent, build prompt, `mkdir` reply dir, `herdr agent prompt` (see [Sending](#sending))
- [x] Agent picker with per-container memory (see [Choosing the agent](#choosing-the-agent))
- [x] Reply watcher per container; replies shown and updated in the thread (see [Replies](#replies))
- [x] Failure handling: unsent comment marked, **Resend** action (see [Failures](#failures))
- [x] Thread title actions: **Show Agent**, **Delete Thread**
- [x] Menus and `when` clauses in `package.json` (see [Contributions](#contributions))
- [x] Tests (see Validation)
- [x] Docs: README section, `docs/how-it-works.md` section, CHANGELOG entry

## Decisions

- **Dev containers only.** SSH hosts and host herdr sessions are out of scope. A file
  qualifies only when `mapHostPath` maps it into a running container.
- **Independent of GitHub.** Agent threads belong to this controller only. They are never
  synced to GitHub: no drafts, pending reviews or posted PR comments. They live in the
  window's memory and in the container's reply files. The GitHub PR extension's threads
  are untouched. On a PR diff the gutter `+` may ask which provider to use; picking
  **GitHub Pull Request** there makes a real PR comment, which is that extension's
  behaviour, not ours.
- **Push, not pull.** The comment is submitted to the agent immediately. The agent never
  has to be told to "check comments".
- **Replies through a file.** The extension installs nothing in the container. The
  prompt asks the agent to write Markdown to a path the extension watches, the same
  fallback herdr's own skill uses.
- **Agents are found at send time** with one `herdr api snapshot` in the target
  container (`CONTAINER_SESSION`, parsed with `parseSnapshot`). This also works for
  containers the Agents view isn't watching, such as a PR repo mounted into another
  window's container.
- **Threads are in memory.** They are gone after a window reload. Reply files left in
  the container's `/tmp` are not cleaned up, except by **Delete Thread**.
- **Any detected agent kind** can be the target, not only `claude`. The thread shows
  the agent's kind as the reply author.
- **herdr 0.9.3 or later in the container** (verified: it has `agent prompt` and its `agent_blocked` error). An older herdr fails the send with herdr's own error message, shown through the [Failures](#failures) path. There is no version check.
- **The agent's pane is not focused on send.** The reviewer stays in the diff. Use
  **Show Agent** to jump to it.

## Contributions

| Id | Title | Where |
| --- | --- | --- |
| comment controller `devc-vscode.agentReview` | label `Agent (devc)` | — |
| `devc-vscode.askAgent` | Ask Agent About Selection | `editor/context`, group `devc@1`, when `devc-vscode.hasDocker && resourceScheme =~ /^(file\|review\|pr)$/` |
| `devc-vscode.agentReviewSubmit` | Ask Agent | `comments/commentThread/context`, when `commentController == devc-vscode.agentReview` |
| `devc-vscode.agentReviewShowAgent` | Show Agent (icon `$(terminal)`) | `comments/commentThread/title`, group `inline`, when `commentController == devc-vscode.agentReview && commentThread =~ /hasAgent/` |
| `devc-vscode.agentReviewDelete` | Delete Thread (icon `$(trash)`) | `comments/commentThread/title`, group `inline`, when `commentController == devc-vscode.agentReview` |
| `devc-vscode.agentReviewResend` | Resend | `comments/comment/title`, group `inline`, when `commentController == devc-vscode.agentReview && comment == failed` |

Hide all five commands from the command palette (`"when": "false"`), except `askAgent`, which
shows when `editorHasSelection`.

Controller options: `prompt: "Ask the agent about this code…"`,
`placeHolder: "Sent to the agent running in the container"`.

## Commenting ranges

`provideCommentingRanges(document)` returns `[new Range(0, 0, lineCount - 1, 0)]` only when
all of these hold:

- the document's scheme is `file`, `review` or `pr`
- `document.uri.path` maps to a container through `mapHostPath`

Otherwise it returns `[]`, so ordinary files get no `+`. Bind mounts come from
`listBindMounts`, cached for 10 s, since the provider runs on every editor open.
Build the provider around an injected `() => Promise<ContainerBindMount[]>` so tests
can pass fake mounts. This is the same injection style `agentTree.ts` uses for
`WatchAgents`.

**Gotcha:** for `review` and `pr` URIs, `uri.path` is the host path. This is the same
assumption `copyHostContainerPath` relies on. Reuse `resourceOf`.

**Ask Agent About Selection** creates a thread with no comments on the selected lines
(whole lines, `Range(startLine, 0, endLine, 0)`). With an empty selection it uses the
cursor's line. A selection that ends at column 0 of a later line does not include that
line, with `collapsibleState = Expanded`. That
opens the reply box directly, with no provider picker. If the editor's document does not
map, it shows the error `No running container mounts <host path>` (the same text as
**Copy Container Path**).

## Diff side

The side label goes in the prompt so the agent knows which version the lines come from.
Parse `uri.query` as JSON inside try/catch. Any parse failure or missing field uses
`diff view`.

| Scheme | Query fields used | Label |
| --- | --- | --- |
| `file` | — | `working tree` |
| `review` | `base: boolean`, `commit: string` | `PR diff, base side, commit <commit>` if `base`, else `PR diff, changed side, commit <commit>` |
| `pr` | `isBase: boolean`, `baseCommit`, `headCommit`, `prNumber` | `PR #<prNumber> diff, base side, commit <baseCommit>` if `isBase`, else `PR #<prNumber> diff, head side, commit <headCommit>` |

These shapes are what GitHub Pull Requests builds as of its 0.1xx releases (`toReviewUri`,
`toPRUri`). The first spike item confirms them.

## Choosing the agent

1. `containerShell(containerId)`, then
   `herdr --session=devc api snapshot`, parsed with `parseSnapshot`.
2. No agents: show the error `No agent is running in <container label>. Add one from the Agents view.` and keep the comment as failed (see [Failures](#failures)).
3. One agent: use it.
4. More than one: if a pane was remembered for this container and is still in the
   snapshot, use it. Otherwise show a QuickPick. Each item has label `taskLabel(agent)`,
   description `<agent.agent> · <status>` and detail `agent.paneId`. Remember the choice
   per container id in memory for the window's lifetime.

**Container label and `ContainerInfo`.** Mapped files can be in containers that aren't
this workspace's, so the Sandboxes tree's `ContainerInfo` may not exist for them. Add
`containerName` to `ContainerBindMount` by putting `{{.Name}}` (strip the leading `/`)
into `listBindMounts`'s inspect format, after `{{.ID}}`. Then build a `ContainerInfo` from
the winning mount: `id` = the short id, `localFolder` = the mount's `localFolder`,
`containerName` = the inspected name, and `name` = `posix.basename(localFolder)`, or
`containerName` when `localFolder` is empty. The container label in messages is
`name`. Update the existing `listBindMounts` tests in `src/test/containerTree.test.ts`
for the new field.

A thread keeps its agent (container id plus pane id) after the first send. For a
follow-up, if that pane is no longer in the snapshot, rerun steps 2–4.

## Sending

Thread id: 8 random hex characters, made when the thread is created. `seq` starts at 1
and goes up by one per comment the user submits in the thread.

Reply path: `/tmp/devc-vscode/review/<threadId>/<seq>.md`.

Steps:

1. Add the user's comment to the thread immediately: author `You`, `mode: Preview`, body as
   plain text.
2. Run `mkdir -p /tmp/devc-vscode/review/<threadId>` through the container shell. That
   shell runs as the remote user, so the agent can write there.
3. Run `herdr --session=devc agent prompt <paneId> <prompt>` through the container shell,
   passed as argv, never interpolated into a shell string. Pass no `--wait`. A busy agent
   (`working`) is fine, because Claude queues input typed while it works.
4. On success, add a placeholder comment: author `<agent.agent>`, body
   `_Waiting for <agent.agent>…_`, `contextValue: "pending"`.

### Prompt text (contract)

First comment in a thread (`seq == 1`):

````
[devc review <threadId>#<seq>] Question from a code review in VS Code.
Location: <containerPath>:<startLine>-<endLine> (<side label>)
```<document.languageId>
<selected lines, verbatim>
```
<comment text>

Answer the question. Also write your answer as Markdown to <replyPath> (the reviewer reads it in their editor). Don't change code unless the question asks you to. Don't post to GitHub or the PR; reply only in the file.
````

Follow-up (`seq > 1`):

```
[devc review <threadId>#<seq>] Follow-up on <containerPath>:<startLine>-<endLine>.
<comment text>

Write your answer as Markdown to <replyPath>. Don't post to GitHub or the PR; reply only in the file.
```

- Lines are 1-based and inclusive. A one-line range still prints `N-N`.
- When the range spans more than 200 lines, replace the code fence with the line
  `(<n> lines selected; read them from the file)`.
- The snippet is read from `document.getText()` of the commented document, not from the
  container. That keeps base-side lines correct even when they no longer match the
  working tree.

## Replies

There is one watcher per container. It starts on the first send to that container and
is disposed when that container has no pending replies left, or on extension
deactivate.

It uses the `watchScript` pattern: the loop runs in the background, stdin is held open,
and closing stdin ends it. It needs only POSIX `sh` and `cksum`. Don't use
`find -printf` or `stat -c`, which are GNU-only. Every 1 s it runs:

```sh
cur=$(cksum /tmp/devc-vscode/review/*/*.md 2>/dev/null | tr '\n' ';')
```

It prints `$cur` followed by a newline only when `$cur` changes. Each `;`-separated
entry is `<crc> <size> /tmp/devc-vscode/review/<threadId>/<seq>.md`. Thread ids are
hex, so paths have no spaces. When nothing matches, the glob stays literal and `cksum`
fails silently, giving an empty line.

On each line, for every `<threadId>/<seq>.md` whose crc or size differs from what was
last seen:

- `cat` it through the container shell.
- Replace that seq's placeholder, or update the reply if it was already shown, with
  author `<agent.agent>`, `body: new MarkdownString(content)`, `contextValue: "reply"`.

Updating on a later change covers both a read that caught a partial write and an agent
that rewrites its answer. Files for threads this window doesn't know are ignored.

**Gotcha:** in Claude Code's default permission mode, writing outside the project asks
for approval, so the reply waits until the user approves in the pane. Document this. In
auto mode it does not wait.

## Failures

`herdr agent prompt` failures are recognised by a non-zero exit code. Get the reason
with the existing `herdrError`. herdr prints `{"error":{"code":...}}`. Codes to word
specially:

| Code | Message |
| --- | --- |
| `agent_blocked` | `<agent> is waiting on a prompt in its pane. Answer it, then Resend.` |
| `agent_not_found` | `That agent is gone. Resend to pick another.` (and forget the remembered pane) |

On any failure:

- set the user's comment's `contextValue` to `failed` and its label to `Not sent`
- show the message as an error notification
- add no placeholder

**Resend** rebuilds the prompt for that comment's seq (agent resolution included),
clears `failed`, and repeats [Sending](#sending) from step 2.

**Show Agent:** move the container branch of `focusAgent` in `extension.ts` (from the
`// Reveal the terminal attached to herdr in that container` comment to the end of the
function) into `focusContainerAgent(container: ContainerInfo, agent: AgentInfo)`.
`focusAgent` then calls it with `node.container` and `node.agent`, so its behaviour is
unchanged. **Show Agent** calls it with the thread's `ContainerInfo` (see
[Choosing the agent](#choosing-the-agent)) and the agent from a fresh snapshot. If the
pane is gone, show `That agent is gone.`

**Delete Thread** disposes the thread and runs
`rm -rf /tmp/devc-vscode/review/<threadId>` in the container (best effort).

## Validation

- [x] `npm run compile && npm run lint` passes
- [x] `npm run compile && xvfb-run -a npm test` passes (211 passing; xvfb and Electron libraries installed in the container with apt). `.npmrc` sets `ignore-scripts`, so `pretest` doesn't compile. The container has no `xvfb-run` or Electron libraries, so if they can't be installed, run `npm test` on the host **(user, host)** and say so in the hand-off. Includes a new `src/test/agentReview.test.ts` covering:
  - [x] prompt text for `seq == 1` and `seq > 1` matches [Prompt text](#prompt-text-contract) exactly, including the 200-line cutoff
  - [x] side label for `file`, `review` (base and changed), `pr` (base and head), and malformed or missing query → `diff view`
  - [x] reply-listing line parser (`cksum` format above, empty line, entry for an unknown thread): changed crc/size triggers a read, unchanged doesn't, unknown thread ids ignored
  - [x] failure message mapping for `agent_blocked`, `agent_not_found` and an unknown code
  - [x] `listBindMounts` / `mapHostPath` existing tests still pass with `containerName` added
  - [x] commenting ranges: empty for unmapped paths and other schemes, full document for a mapped `file`/`review`/`pr` URI (injected mounts)
- [ ] **(user, host)** Spike: in a host VS Code with GitHub Pull Requests, log `uri.toString()` for both sides of a review diff (checked-out and not-checked-out PR) and confirm the query shapes in [Diff side](#diff-side). If they differ, file a fix to the side-label parser
- [ ] **(user, host)** Spike: with the PR extension and this controller both offering ranges on a line, the gutter `+` shows VS Code's comment-provider picker, and **Ask Agent About Selection** bypasses it
- [ ] **(user, host)** With Claude running in herdr in the container: on a checked-out PR's review diff, click `+` on a changed line, pick **Agent (devc)**, ask "what does this line do?" → the prompt appears in the Claude pane with the container path, and the answer appears as a reply in the thread
- [ ] **(user, host)** **Ask Agent About Selection** on a multi-line selection in a plain `file` editor opens the reply box with no picker, and the prompt shows the right `start-end`
- [ ] **(user, host)** a follow-up in the same thread sends the follow-up form with `#2`, and the reply lands under it
- [ ] **(user, host)** with two agents in the container, the picker shows once, and the second thread reuses the choice
- [ ] **(user, host)** with Claude at a permission dialog, sending marks the comment `Not sent` with the `agent_blocked` message; after answering the dialog, **Resend** delivers it
- [ ] **(user, host)** a file outside any container mount gets no `+` from this controller, and **Ask Agent About Selection** shows `No running container mounts …`

## Relevant Files

- `src/agentReview.ts` (new): controller, commands, prompt builder, side label, reply watcher, failure mapping
- `src/extension.ts`: create the controller on activate. Extract `focusContainerAgent` from `focusAgent`. Pass the controller `containerShell`, `resourceOf`, `getDockerCommand`, and the focus-agent flow
- `src/herdr.ts`: add `promptHerdrAgent(shell, session, paneId, text)` and a one-shot `readHerdrSnapshot(shell, session)`, alongside `focusHerdrAgent`
- `src/containerTree.ts`: `ContainerBindMount.containerName`, plus `{{.Name}}` in `listBindMounts`'s inspect format
- `src/test/containerTree.test.ts`: cover the new field
- `src/test/agentReview.test.ts` (new)
- `package.json`: commands, `editor/context`, `comments/*` menus, `commandPalette` hiding
- `README.md`: an "Ask an agent about code" section under **Using the views**, and the new commands in the **Commands** table
- `docs/how-it-works.md`: how comments reach the agent, the reply directory, and the permission-mode gotcha
- `CHANGELOG.md`
- `.plans/PLAN.md`: phase 9 status
