#!/bin/sh
# Stand-in for `claude` in a container: cycles working -> blocked -> idle
# using Claude Code's real UI strings, redrawing in place on the alt screen.
# Rules span the pty's full width, as Claude's prompt box does, so rendering
# at the wrong size wraps them and breaks detection. LOOP=1 repeats forever.
frame() { printf '\033[H\033[2J'; printf "$@"; }
cols=$(stty size | cut -d' ' -f2)
rule=$(i=0; while [ $i -lt "$cols" ]; do printf '\342\224\200'; i=$((i+1)); done)
printf '\033[?1049h'
while :; do
  frame "* Fixing the tests\342\200\246 (3s \302\267 esc to interrupt)\r\n\r\n$rule\342\235\257 \r\n$rule"
  sleep 3
  frame " Bash command\r\n\r\n   rm -rf build\r\n\r\n Do you want to proceed?\r\n \342\235\257 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n"
  sleep 3
  frame "$rule\342\235\257 \r\n$rule  ? for shortcuts\r\n"
  sleep 3
  [ -n "$LOOP" ] || break
done
printf '\033[?1049l'
