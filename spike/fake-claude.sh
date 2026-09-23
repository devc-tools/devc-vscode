#!/bin/sh
# Stand-in for `claude` in a container: cycles working -> blocked -> idle
# using Claude Code's real UI strings, redrawing in place on the alt screen.
frame() { printf '\033[H\033[2J'; printf "$@"; }
rule='\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200\342\224\200'
printf '\033[?1049h'
frame "* Fixing the tests\342\200\246 (3s \302\267 esc to interrupt)\r\n\r\n$rule\r\n\342\235\257 \r\n$rule\r\n"
sleep 3
frame " Bash command\r\n\r\n   rm -rf build\r\n\r\n Do you want to proceed?\r\n \342\235\257 1. Yes\r\n   2. No\r\n\r\n Esc to cancel\r\n"
sleep 3
frame "$rule\r\n\342\235\257 \r\n$rule\r\n  ? for shortcuts\r\n"
sleep 3
printf '\033[?1049l'
