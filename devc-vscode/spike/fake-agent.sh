#!/bin/sh
# Mimics a TUI agent: OSC 0 title spinner, alt screen, Claude-like frames.
printf '\033]0;\342\240\213 Fixing tests\007'        # "⠋ Fixing tests"
printf '\033[?1049h\033[H\033[2J'
printf '* Fixing the tests\342\200\246 (1s \302\267 esc to interrupt)\r\n\r\n'
printf '\342\224\200\342\224\200\342\224\200\r\n\342\235\257 \r\n\342\224\200\342\224\200\342\224\200\r\n'
sleep 2
printf '\033]0;\342\234\263 Fixing tests\007'        # "✳ Fixing tests" (idle)
printf '\033[H\033[2J'
printf '\342\224\200\342\224\200\342\224\200\r\n\342\235\257 \r\n\342\224\200\342\224\200\342\224\200\r\n  ? for shortcuts\r\n'
sleep 2
printf '\033[?1049l'
