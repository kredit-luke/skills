# Agent rules

The rules every subagent prompt carries, and the ones you follow as orchestrator. Each exists because breaking it fails **silently**: the build stays green, the run reports success, and the defect shows up later, far from its cause.

## Blocks to paste into prompts

### Paths (opens every prompt, filled in)

```markdown
## Paths: read before running anything
All work for <TICKET> lives under:
  WORKROOT = <absolute baseDir>

Your working directory is NOT WORKROOT. Every path you touch is absolute and under WORKROOT:
  - git:    git -C <WORKROOT>/<repo> <command>
  - builds: pass the project/solution/package path under <WORKROOT>/<repo> explicitly
  - npm:    npm --prefix <WORKROOT>/<repo> <script>  (or cd <WORKROOT>/<repo> for that one command)
  - files:  read and edit <WORKROOT>/<repo>/... only

<mainRoot> holds another copy of the same repos on their default branch. It is not
yours: edits there land on the wrong branch, in a tree no reviewer looks at.
If you find yourself in <mainRoot>/<repo>, stop and report it.
```

For `flat` and `here`, WORKROOT is the workspace root and the block still holds: one prompt shape.

### Plan, assignment, method

```markdown
## The plan
Read <plan file path> first: the full plan. At minimum its Problem, Approach and
Assumptions, plus any step yours depends on. Paths in it already point into WORKROOT.

## Your assignment (step N)
<this agent's step, pasted verbatim>

Follow the tdd skill (red, green, refactor) where the change is testable: write the
failing test first and confirm it fails for the right reason.
Do the work yourself: no subagents that edit files or run builds (read-only search is fine).
If this is too large for one agent, say so and stop.
```

Point at the plan file; paste only the agent's own step. A pasted plan sits in your transcript and is re-sent every turn; a path costs a few tokens. The step is pasted so that an agent that skips the read still has its tasks.

### Generated code (verbatim, in every implementer prompt)

> You MUST NOT hand-write, stub or edit generated code (API clients, migrations and their snapshots, schema or contract files, anything CLAUDE.md says is generated). If generation fails because the upstream isn't running or a tool won't start, STOP and report the blocker. The recovery for a generated artifact is always its generator, never git and never hand-editing; read what the generator produced before relying on it.

Hand-written stubs compile and fail silently at runtime: a field renamed by one character is just quietly missing.

### Undoing work (verbatim)

> The whole ticket is uncommitted, so HEAD is the default branch. Never run `git checkout -- <file>`, `git restore`, `git stash` or `git clean`: they discard every earlier step's work in those files, not just your last edit. To undo your own change, edit it back. If a file truly needs resetting, report it; that's the orchestrator's call.

### Long commands

> Builds and test suites may exceed the shell tool's default timeout (2 minutes in Claude Code; 10 minutes max). Pass an explicit timeout for anything that may run long. In a headless run, run in the foreground: background work dies with the turn, and with you.

## Rules for you, the orchestrator

**Spawn every subagent without a `name`.** Record the **id** the spawn returns and resume with `SendMessage` to that id (it works after the agent finished, with its context intact). A named agent becomes a teammate: its final text isn't returned to you (the plan or report just never arrives) and its own `effort:` is ignored. No `team_name` either.

**Check a report actually came back.** An empty or truncated plan, or a report without the sections you asked for, is a failed call: don't improvise around it.

**Freeze the tree while a reviewer runs.** No background agents, no implementer still writing, no edits of your own (not even a one-line comment). The reviewer builds and reads those files and can't know you moved them. If a reviewer reports files changing during its pass, its build/test results are void; its source-reading findings stand; re-run the pass on a frozen tree.

**A stalled agent isn't a stopped agent.** One that keeps notifying without a report ("waiting on my background build") may still be writing. `TaskStop` it and confirm before you declare the tree frozen; do it at the second empty notification, not the sixth.

**Reviewer lifecycle.** Resume the **same** reviewer for every pass within a tier (its memory of earlier passes is the value). Retire it at a tier boundary (a different repo or stack) and brief the fresh one with a paragraph of contract facts, not a transcript.

**Implementer lifecycle.** Resume for fix rounds 1-2 of a live step. Round 3+, or a very long transcript: ask for a handoff note (what changed, why, what's open, which traps), retire it, and brief a fresh one from the note, the review and the plan file. Never carry an implementer across steps; retire only at a step boundary.

**Verify claims in both directions, against the tree.** Don't only doubt success: an agent reporting it did nothing or stalled may have done most of it. `git -C <repo> status` and a grep for the specific change beat anything an agent says about itself. Treat explanations of harness internals ("the tool auto-backgrounds long commands") as guesses: agents report reliably on what they changed, not on how they were run. When a build "hangs", suspect the environment first (a leftover process holding a lock).

**Verify a reviewer's red before relaying it.** Run the narrow build or test yourself; a stale build can report failures in correct code.

**Run the suites yourself at each review gate**, so the numbers in the as-built note are ones you measured.

**Watch for fabricated references.** A blocked agent sometimes documents the thing it couldn't do as done (a comment citing a migration, endpoint, config key or test that doesn't exist). Have reviewers confirm every symbol a comment references exists.

**Check every command handed back to you** before running it: each repo, project and app path in it must contain the WORKROOT segment. A `cd <main path> || cd <worktree path>` fallback always takes the first branch.

**Headless runs**: foreground only (no `run_in_background` for agents or commands you need the result of), and no shell redirects or chains the permission allowlist won't match.
