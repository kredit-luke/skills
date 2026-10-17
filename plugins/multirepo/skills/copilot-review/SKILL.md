---
name: copilot-review
description: Get a local second-opinion code review from the GitHub Copilot CLI (a different model, e.g. GPT) on your local changes BEFORE pushing or opening a PR. Use this whenever the user wants a pre-push review, a "second pair of eyes" / "second opinion" on a diff, to "have Copilot/GPT look at my changes", to sanity-check a branch or worktree before opening PRs, or to catch bugs locally before the team reviews, even if they don't say "copilot-review". Triggers on "review my changes", "review before I push", "what would another model think of this", "local review", "check my diff", "self-review this feature". Runs entirely locally against uncommitted + committed work across every repo in the workspace; no PR needed.
argument-hint: "[--id <reviewId>] [--base <branch>] [--model <model>] [--no-fix] [--root <dir>] [context...]"
---

# Copilot Review: a local second-opinion gate

Run the GitHub Copilot CLI as an independent reviewer over the user's local changes, so a *different model* catches bugs, security issues and convention slips **before** the work is pushed and the team spends review cycles on it. The work may span several repos (a multi-repo workspace or worktree) or live in one; one review covers all of it together.

Keep it a cheap, fast, local gate: stage context, let Copilot review, surface findings, optionally fix and re-check, then hand back to the user.

Nothing about a company, stack or ticket system is hardcoded. The helper discovers the repo layout, detects each repo's base branch and infers the ticket id. The project knowledge it needs (what the change is for, which stack) comes from you, the orchestrating session; see step 2.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## How it works (the contract with Copilot)

Review state lives in `.copilot/reviews/<reviewId>/` at the workspace/worktree root, as a mailbox:

- **`inbox/`**: what *we* give Copilot. `manifest.json` (the changed repos, branches, base, and the exact `git diff` commands to run) and `summary.md` (what the change is *supposed* to do: intent Copilot can't infer from the diff).
- **`outbox/`**: what *Copilot* gives back. `review.json` (structured findings) and `review.md` (readable).

Copilot is agentic and runs git itself: we point it at the repos and the diff commands rather than pre-dumping diffs. It may read files and run git, is **denied `git push`**, and is told never to modify source. Granular allows work non-interactively (no `--allow-all-tools`).

## Prerequisites

- `copilot --version` succeeds (GitHub Copilot CLI ≥ 1.0). If it's missing, tell the user to install it and stop.

## Arguments (`$ARGUMENTS`)

- `--id <reviewId>`: name of the state folder. Default: the ticket id in a branch or folder name (e.g. `ENG-196`), else a timestamp.
- `--base <branch>`: base branch to diff against. Default, per repo: `repos.json` `defaultBranch`, else origin's default branch, else `main`/`master`/`develop`.
- `--model <model>`: passed to Copilot's `--model`.
- `--no-fix`: review and report only; skip the fix loop.
- `--root <dir>`: workspace/worktree root to review. Default: the current directory (the enclosing worktree's root if inside one).
- Remaining free text is **review context/intent**, folded into `summary.md` (e.g. "focus on the retry logic").

---

## Process

### 1. Discover what changed and scaffold state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare-review.mjs" --root <root> [--base <base>] [--id <id>]
```

Use the real root path; inside a worktree, point `--root` at the worktree root, not the main workspace. It prints JSON: `reviewId`, `reviewDir`, `inbox`, `outbox`, and `repos[]` (each with `name`, `path`, `branch`, `base`, `commitsAhead`, `dirty`, `diffCommands`, `diffStat`, `newFiles`). It also creates the inbox/outbox, writes `inbox/manifest.json`, and adds `.copilot/` to `info/exclude` in every touched repo. It handles single repos, `repos.json` workspaces and `.worktree.json` worktrees on its own, and reviews the workspace root too when it's a repo itself (minus its nested repos). If it exits 1 because a base branch can't be resolved, relay the message and fix that (fetch, or pass `--base`) rather than reviewing without that repo. The ticket id follows `.claude/dashboard/workspace.json` `issues.ticketPattern` when the workspace has one.

**`newFiles` is not optional context.** It lists the untracked files, and `git diff HEAD` doesn't show untracked files. Work that stays uncommitted until the PR (the usual flow when implementing a ticket) has its new modules, migrations, handlers and components all untracked. A review that only runs the diff commands can return a confident verdict having seen none of them, next to a plausible-looking diffStat.

If `repos[]` is empty there's nothing to review (no commits ahead of base, clean tree): say so and stop.

### 2. Write the intent (`inbox/summary.md`): this is where YOU add the value

Copilot reviews far better when it knows what the change is for and what bar to judge it against. Build `summary.md` from, roughly in order:

1. **What you know from this session.** If this conversation designed or implemented the change, write the goal and risk areas from that. Highest signal.
2. **Free-text context** from `$ARGUMENTS`.
3. **The ticket**, if `reviewId` looks like one and a tracker is reachable: Linear (`mcp__*Linear*`), Jira (`mcp__*atlassian*`), or GitHub Issues (`gh issue view`). Pull the goal and acceptance criteria. Skip silently if none is connected.
4. **Commit messages** (`git log <base>..HEAD --oneline` per repo) and the manifest's `diffStat`.

Also give the reviewer **the bar to judge against**: a few lines on the stack and conventions (e.g. "Express + Postgres via Prisma; React with hooks; API errors use `{ error: { code, message } }`"). Take it from what you know, the root / per-repo `CLAUDE.md` / `AGENTS.md` / `README`, or the file types in the diff. If you don't know the stack, leave it out.

**If context is genuinely thin** (a fresh session, no args, no ticket), don't guess: ask the user what the change is for and what to scrutinize. A wrong intent misleads the reviewer.

Keep it tight: a few sentences of goal, the stack note, specific risk areas. Write it to `inbox/summary.md`.

### 3. Run the Copilot review

**First, clear the outbox of any earlier report**, so an old result can't pass for this run's: move `review.json` and `review.md`, if present, to `review-round<N>.json` / `review-round<N>.md` (the next free N). A reused `--id` otherwise still holds the last round's verdict.

Invoke Copilot **once** for the whole change, with the prompt below (substitute the manifest's `inbox`/`outbox`):

```bash
copilot -p "<PROMPT>" \
  --add-dir <root> \
  -C <root> \
  --allow-tool 'shell(git:*)' \
  [--allow-tool 'shell(powershell:*)' --allow-tool 'shell(pwsh:*)'] \
  --allow-tool 'write' \
  --deny-tool 'shell(git push)' \
  --log-level error \
  [--model <model>]
```

`--add-dir <root>` grants access under the root (every repo and the outbox). A pass takes a minute or two.

**On Windows, add the PowerShell allows.** `shell(git:*)` matches a bare git command but not git piped into a cmdlet, and Copilot on Windows reaches for things like `git ls-files | Where-Object {...}`. Denied, a run may read that as a tool failure and review less.

**Tell the user how to watch it**, since there's no visible progress otherwise: give the task's output/log path and a tail command (`tail -f <log>`, or `Get-Content <log> -Wait -Tail 20` in PowerShell).

- **Interactive terminal session:** run it in the background (`run_in_background: true`) and let the harness re-invoke you when it exits; don't poll.
- **Headless (`claude -p`, a dashboard run, CI):** run it in the **foreground** with a long timeout (up to 10 minutes). A background task dies when the turn ends.

> To *guarantee* Copilot can't touch source, drop `--allow-tool 'write'`, have it print the JSON to stdout, and write the file yourself. The prompt already forbids source edits and that's honored in practice, so prefer the simpler path.

**Prompt template** (the stack/convention line lives in `summary.md`, so the prompt stays generic):

```
You are an independent code reviewer giving a second opinion on local changes BEFORE they are pushed. A senior engineer will read your findings, so be precise and skip nits dressed up as blockers.

Read these files first:
- <inbox>/summary.md      — what this change is intended to accomplish, and the stack/conventions to judge it against
- <inbox>/manifest.json   — the repos involved, their branches, and the git diff commands to run

For EACH repo in the manifest, do BOTH of these:
1. cd to its `path` and run its `diffCommands` (e.g. `git diff main...HEAD`, `git diff HEAD`) to see what changed in tracked files.
2. Read every path in that repo's `newFiles` array in full. These are untracked, so NO diff command shows them — they are invisible unless you open them, and they are often the most important files in the change (new modules, migrations, handlers, components). If `newFiles` is non-empty and you did not read them, your review is incomplete and you must say so rather than issue a verdict.

Review the union of the diffs and the new files against the stated intent.

Review for, in priority order: correctness bugs, security issues, data-integrity/migration risks, missing or broken tests, then performance and convention/style. Judge the changes against the conventions described in summary.md (or infer them from the surrounding code if none are given). Only flag what you can point to in the diff. Don't flag generated/vendored files (e.g. auto-generated API clients, lockfiles, migration designer files) for style.

Do NOT modify, stage, commit, or push any files. Your ONLY write is the report.

Write your review as JSON to <outbox>/review.json with EXACTLY this shape:
{
  "verdict": "approve" | "changes_requested",
  "summary": "2-3 sentence overall assessment",
  "findings": [
    {
      "id": "F1",
      "severity": "critical" | "high" | "medium" | "low",
      "category": "correctness" | "security" | "data" | "test" | "performance" | "style" | "architecture",
      "repo": "<repo name from manifest>",
      "file": "<path>",
      "line": "<line or range, or null>",
      "issue": "what is wrong and why it matters",
      "suggestion": "concrete fix",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
Use verdict "approve" only when there are no critical/high findings. Also write a readable Markdown version to <outbox>/review.md.
```

### 4. Read findings and report

Read `<outbox>/review.json`. Only a report written by **this** run counts (the outbox was cleared in step 3). If Copilot exited non-zero, or there's no fresh `review.json`, the review is **incomplete**: fall back to a fresh `review.md`, then stdout, tell the user, and consider one re-run; never present an archived round's verdict as the current one. Present a table grouped by severity:

```
| Sev | Repo | File:Line | Category | Issue |
```

then the verdict and Copilot's summary. That's the deliverable under `--no-fix` or when the verdict is `approve`.

### 5. Triage + fix loop (skip under `--no-fix` or on `approve`)

Copilot is a second opinion, not an oracle. For each finding:

- **Decide if it's real**, with full context: a backend concern may be handled in the frontend changes, or be deliberate. Dismiss false positives with a reason; don't wave off a valid bug.
- **Fix real ones in the right place**: directly, or, if the workspace's `CLAUDE.md` assigns specialized subagents to areas of the code, delegate to the one that owns it. Keep fixes scoped to the finding.
- **Never commit or push.** Leave fixes in the working tree: this is a pre-push gate.

Then **re-review**: re-run step 1 with the same `--id` (fixes change what's dirty and what's new, so the old manifest's diff commands and `newFiles` would miss them; a repo that was clean may now have changes), keep `summary.md`, then step 3 (which archives the previous report) and step 4. Stop at `approve`, at no critical/high findings left, or after **3 rounds**, whichever comes first.

### 6. Final report

- Verdict and round count.
- What was fixed (per repo) and what was dismissed, with reasons.
- What's left for the user to decide (low-confidence or subjective findings).
- Where the full review lives: `<reviewDir>/outbox/`.

Fixes are **uncommitted**: the user reviews them, then commits and opens PRs.

---

## Notes

- **One review per unit of work, not per repo.** A backend contract and its frontend consumers get judged together.
- **State is disposable.** `.copilot/` is git-excluded and safe to delete. Re-running with the same `--id` reuses the folder (earlier rounds stay archived).
- **Cost.** Each pass spends Copilot credits; the 3-round cap bounds a pathological case. Say so if you hit it with findings open.
- **Relation to PR reviews.** This is the local, pre-PR gate. Requesting Copilot as a reviewer on an open PR is a separate step; they compose.
