#!/usr/bin/env bash
# Builds resources/agent-icons.woff (the agent marks as an icon font for `contributes.icons`)
# from the vendored Lobe Icons SVGs in resources/agent-icons/. Run by hand when the marks change;
# not part of `npm run build`. Needs pipx (picosvg, fonttools) and npx (fantasticon).
#
# 1. picosvg rewrites the marks' even-odd shapes as non-zero outlines (font glyphs fill
#    non-zero, so the raw files would lose their holes) into resources/agent-icons/nonzero/.
# 2. fantasticon builds the font with fixed code points U+E001-U+E004.
# 3. scripts/check-agent-icons.py checks the holes survived.
set -euo pipefail

cd "$(dirname "$0")/.."
src=resources/agent-icons
names=(claudecode githubcopilot pi opencode)

mkdir -p "$src/nonzero"
for name in "${names[@]}"; do
	pipx run picosvg "$src/$name.svg" > "$src/nonzero/$name.svg"
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# fantasticon 3.0.0 has no --codepoints flag: fixed code points go through a config file.
echo '{"codepoints":{"claudecode":57345,"githubcopilot":57346,"pi":57347,"opencode":57348}}' > "$tmp/fantasticonrc.json"
npx --yes fantasticon@3.0.0 "$src/nonzero" -c "$tmp/fantasticonrc.json" -o "$tmp" -t woff -g json -n agent-icons \
	--normalize --font-height 1000 --descent 0
cp "$tmp/agent-icons.woff" resources/agent-icons.woff

pipx run --spec fonttools python scripts/check-agent-icons.py resources/agent-icons.woff
