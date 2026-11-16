# Running builders from this queue

take-once only moves files. This is the shape I use around it: what a brief says, what a builder agent is told, and what it may decide alone. None of it is enforced by the tool. It's here because the queue is only as good as the briefs and prompts going into it.

## The brief

```
# 042 add-retry
Blocked by: 040
Touches: src/net/, tests/net-retry.test.js
Branch: add-retry (from main)
Done when: `node --test tests/net-retry.test.js` exits 0
```

Blocked by is what has to be merged first, not just finished, and take-once checks it. Touches is the files and folders the brief may change. take-once won't start two briefs whose Touches overlap, so small briefs with narrow Touches run in parallel and big ones queue behind each other. Done when is one command. If I can't write it as a command, the brief isn't ready.

Each step in the brief also ends with its own "done when", and the brief ends with a short "Never" list of lines the builder must not cross.

## The builder prompt

```
GOAL: one line, the outcome and the branch name
SOURCES: exact paths, branches and brief names to read; nothing else
DO NOT TOUCH: main; secrets; existing tests, CI and permissions
GATES: the brief's Done when, plus the tests for what changed
PUSH: the named branch, no force; never merge
STOP IF: passing would need a test edit, a budget raise or a permission change.
  Report the options instead.
REPORT (under 150 words): branch and commit, what changed in plain words,
  gate results, anything not done and why
```

STOP IF matters most. A builder that can't clear a gate has one way out: stop and say why. It never edits the gate. The first time a builder hit that line, it listed three options instead of quietly changing a budget, which is the behavior I wanted.

## What a builder decides alone

- **does it, then mentions it:** builds on its branch, runs the gates, pushes, simplifies code to fit a limit instead of raising the limit
- **asks first, with a recommendation:** anything that edits a test, CI, permissions or merge rules, and anything new a person would notice
- **never:** sends or posts anything, force-pushes, or works around a permission it was refused

A refusal gets reported, not routed around. Merging stays out of the builder's hands entirely. Whatever merges, a person or a separate process, does it one branch at a time, and only when CI is green on that exact commit.
