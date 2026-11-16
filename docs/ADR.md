# Why take-once works the way it does

## A git branch instead of a service

The machines running agents already have git and push access, and that's all they share. A queue service would be one more thing to run, secure and keep alive, and it would hold state nobody can read with tools they already have. A branch gives me an append-only log of every take, lease and reclaim for free, readable with `git log`.

The cost is speed. Every take is a fetch, a commit and a push, under a second on a local remote and more over a network. For briefs that each take an agent many minutes, that's fine.

## The push is the lock

Git refuses a push that doesn't build on the current tip unless it's forced. take-once never forces, so whichever machine pushes first owns the brief. The loser doesn't rebase, because a rebase would happily replay "move 042 to taken" on top of someone else's identical move and report success. It throws the attempt away, fetches again and asks `pick` from scratch, and at that point the brief is no longer in `queue/`.

The race test stages exactly this, and a copy of the tool with the push changed to a force push fails it.

## Done means merged

My first version treated a `Status: DONE` report as enough to unblock the briefs that depend on it. It isn't. A finished branch that hasn't merged yet isn't in the code the next agent starts from, so that agent builds on something missing and stops at its first step. A blocker now counts only once the branch its report names is in main's history.

That check fails closed. If the main ref can't be resolved, `pick` exits 2 and prints no decisions, instead of reading every blocker as unmerged or every blocker as merged.

## Stale needs two signals

A claim with no expiry outlives a crashed builder and holds its files hostage. But age alone would reclaim long-running live work. So a claim goes stale only when its lease is old and its branch has had no push inside the same window. An agent that pushes as it goes stays alive without doing anything extra.

## One commit per read

Two takes on one machine can run at once and share a remote-tracking ref. Reading the file list and then the file contents against a moving ref meant one could vanish between the two reads. Every read now resolves the ref to a commit first and uses that commit throughout, and a take decides against the exact commit its worktree holds.
