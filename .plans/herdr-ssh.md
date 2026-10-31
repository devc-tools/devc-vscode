# herdr-vscode: SSH hosts, live

Every herdr-vscode feature already has an SSH path through `SshShell` (`src/remoteShell.ts`) and
`herdr.sshHosts`, but none of it has run against a real host: phase 14 deferred SSH, and the SSH
checks in phases 15–21 are unticked. This plan runs them against a reachable host, fixes what
breaks, and brings SSH up to parity with dev containers for session start and stop.

**Blocked until a reachable SSH host with herdr ≥ 0.9.5 is available.** The implementing agent
needs an alias in `~/.ssh/config` that connects without a prompt (key auth), and a throwaway herdr
session on that host named `hv-test`, stopped and deleted afterwards. Never touch any other herdr
session on the host.

Depends on [herdr-sidebar](implemented/herdr-sidebar.md), [herdr-mirrored-tabs](herdr-mirrored-tabs.md),
[herdr-pane-context](herdr-pane-context.md), and is ordered after phases 18–23 (its checks cover
their SSH paths too). Paths are under `herdr-vscode/`.

## Checklist

- [ ] 1. Opt-in live suite `src/test/liveSsh.test.ts`, skipped unless `HERDR_VSCODE_LIVE_SSH=<alias>`
      is set: discovery lists the alias's sessions, `remote-api-bridge` subscribe and a one-shot
      request work, `terminal session control` streams a pane, `herdr-ssh:` read / write / stat /
      readDirectory / rename / delete round-trip in a temp dir under the remote `$HOME`, and
      `git` status runs remotely. Every herdr call uses `--session hv-test`.
- [ ] 2. Run the suite and every SSH Validation item below; fix each failure in herdr-vscode
      (record each fix under Implementation notes with the failing symptom).
- [ ] 3. Session **Start** / **Stop** on SSH session rows, with the same command ids, titles and
      confirmation as this machine's (`src/sessionControl.ts`, commit c47a952) and as phase 19's
      container Start; run through `SshShell` (`herdr --session <S> server start` /
      `server stop` argv as host). Skip if phase 19 already covers SSH.
- [ ] 4. ControlMaster: confirm the control socket in `ensureControlDir()` is reused across the
      bridge, terminal streams, file system and git calls (one `ssh` authentication per host per
      window); `ps -eo args | grep -c 'ssh .*<alias>'` stays bounded with three tiles open.
- [ ] 5. Docs: herdr-vscode README § SSH hosts (requirements: key auth, herdr on `PATH` for
      non-interactive shells, `herdr.sshHosts`), CHANGELOG entry; tick the SSH items in the phase
      14–21 plans that this run verified, citing this plan.

## Validation

- [ ] `npm run build && npm run lint && xvfb-run -a npm test` passes (live suites skipped)
- [ ] `HERDR_VSCODE_LIVE_SSH=<alias> xvfb-run -a npm test` passes the SSH live suite
- [ ] Manual, SSH: add the alias to `herdr.sshHosts`; `SSH · <alias>` lists its running sessions;
      an unreachable alias shows `unreachable` and no error notification
- [ ] Manual, SSH: open a mirrored tab of an `hv-test` tab on the host; typing works; a split in
      the remote herdr TUI appears within 1 s
- [ ] Manual, SSH: a Layout tab holds a host pane and an SSH pane side by side, and survives reload
- [ ] Manual, SSH: Pane Context on an SSH pane shows its repo, changes and files; open a file
      through `herdr-ssh:`, edit, save; `cat` in the SSH pane shows the change
- [ ] Manual, SSH: a path printed in an SSH tile opens the remote file beside the tile
- [ ] Manual, SSH: Ask agent (phase 21) on an SSH agent gets a reply in the thread
- [ ] Manual, SSH: Start and Stop on an SSH session row start and stop `hv-test` on the host
- [ ] After closing the window, `ssh <alias> ps -eo args | grep -E 'remote-api-bridge|terminal session control'`
      shows none of this window's processes within 5 s

## Relevant Files

- `herdr-vscode/src/test/liveSsh.test.ts` (new)
- `herdr-vscode/src/remoteShell.ts`, `herdr-vscode/src/environments.ts`, `herdr-vscode/src/remoteFs.ts`,
  `herdr-vscode/src/sessionControl.ts`, `herdr-vscode/src/views/sessionsView.ts`,
  `herdr-vscode/package.json` (Start / Stop menus on SSH rows, if step 3 applies)
- `herdr-vscode/.vscode-test.mjs` (pass `HERDR_VSCODE_LIVE_SSH` through)
- `herdr-vscode/README.md`, `herdr-vscode/CHANGELOG.md`, `herdr-vscode/docs/how-it-works.md`
- `.plans/implemented/herdr-sidebar.md`, `.plans/herdr-mirrored-tabs.md`,
  `.plans/herdr-pane-context.md`, `.plans/herdr-ask-agent.md` (tick verified SSH items)
- `.plans/PLAN.md`

Files named under step 2 depend on what fails; list each one touched in Implementation notes.
