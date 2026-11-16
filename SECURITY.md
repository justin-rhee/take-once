# Security policy. take-once

## Posture

take-once is provided as-is, with NO WARRANTY (see LICENSE). It coordinates
work; it is not an access control. Anyone with push access to the queue branch
can move a brief by hand or force-push over the branch, and the tool cannot
prevent that. Protect the branch on your git host if that matters.

Brief names and contents come from a branch that agents write, so every git
call takes an argument array, never a shell string, and only names matching
`NNN-*.md` or `fix-*.md` are ever moved. take-once never runs anything a brief
says; what your own loop does with a brief is up to your loop.

It makes no network call of its own. It runs `git fetch`, `git push` and
`git ls-remote` against the remote you name, with whatever credentials your
git already uses.

## Validation status

The offline suite has been RUN and passes on Linux: 12 tests against real git
repos, including an eight-machine race and two load-bearing mutations (a force
push, and skipping the re-check), each of which turns the race tests red. The
CI matrix runs the same suite on macOS and Ubuntu.

## Reporting a vulnerability

Report privately via a GitHub security advisory on this repository (Security
tab, "Report a vulnerability"). Please do not open a public issue for a
suspected vulnerability. Give a reasonable window for a fix first.
