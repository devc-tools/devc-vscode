#!/bin/sh
# A stand-in for ssh in the workspace sync tests. It ignores every option and
# the host, and runs the remote command string (always the last argument, for
# both the extension's ssh and git's) locally, with HOME set to the test's
# "remote home". Serves SshShell and GIT_SSH_COMMAND alike.
# With FAKE_SSH_LOG set, each invocation's arguments are appended to it, one
# line per call, so tests can check what reached ssh.
if [ -n "$FAKE_SSH_LOG" ]; then printf '%s\n' "$*" >> "$FAKE_SSH_LOG"; fi
for last; do :; done
HOME="$FAKE_SSH_REMOTE_HOME" exec sh -c "$last"
