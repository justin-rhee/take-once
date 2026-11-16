#!/usr/bin/env bash
# Reproduces the output at the top of the README in a throwaway folder: a bare
# "origin", a queue branch with three tasks, and two clones standing in for two
# machines. Nothing outside the temp folder is touched.
# Run from the repo root: bash examples/demo.sh   (the prompts show "take-once", which is what npx runs)
set -euo pipefail
T="$(cd "$(dirname "$0")/.." && pwd)/src/take-once.mjs"
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
export GIT_CONFIG_GLOBAL="$D/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global user.name demo
git config --global user.email demo@example.invalid
git config --global init.defaultBranch main

cd "$D"
git init -q --bare origin.git
git clone -q origin.git seed 2>/dev/null
cd seed
git commit -q --allow-empty -m main
git push -q origin HEAD:main
git switch -q --orphan queue
mkdir queue
printf '# 040 retry-config\nBlocked by: none\nTouches: src/net/config.js\nBranch: retry-config\n' > queue/040-retry-config.md
printf '# 041 add-retry\nBlocked by: 040\nTouches: src/net/\nBranch: add-retry\n' > queue/041-add-retry.md
printf '# 042 docs-pass\nBlocked by: none\nTouches: docs/\nBranch: docs-pass\n' > queue/042-docs-pass.md
git add -A && git commit -q -m "three tasks"
git push -q origin queue
cd "$D"
git clone -q origin.git laptop 2>/dev/null
git clone -q origin.git desktop 2>/dev/null

echo '$ take-once pick'
(cd laptop && node "$T" pick)
echo
echo '$ take-once take 040-retry-config.md laptop'
(cd laptop && node "$T" take 040-retry-config.md laptop)
echo
echo '$ take-once take 040-retry-config.md desktop    # the other machine, a second later'
(cd desktop && node "$T" take 040-retry-config.md desktop) || true
