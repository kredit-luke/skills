---
name: pr
description: Open pull requests for every repo a ticket touched (in dependency order, cross-linked, ticket in the title), update the ticket in Linear, Jira or GitHub Issues, and optionally request a Copilot review and watch the PRs, fixing valid review feedback, replying to and resolving threads, and keeping branches current until they merge. Use whenever the user wants to open PRs, "ship this", "raise the PRs", "push and open a PR", request a Copilot review on a PR, or watch / babysit / monitor existing PRs until merge, even if they don't say "pr".
argument-hint: "[--draft] [--root <dir>] [--auto-merge] [--monitor <pr-url> [<pr-url> ...]]"
---

# Pull requests

Open PRs with the GitHub CLI for every repo that has commits on the ticket branch, link them to each other and to the ticket, then optionally watch them through review. One ticket across several repos is one change: the PRs share the ticket in their titles and point at each other.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

## Usage

```
/pr                               # open PRs for the current ticket across every affected repo
/pr --draft                       # as drafts
/pr --root worktrees/ENG-123      # the work lives somewhere other than the current folder
/pr --monitor <url> [<url> ...]   # skip creation; watch existing PRs (Copilot optional)
/pr --auto-merge ...              # also merge each PR once it's fully green (off by default)
```

- `--root <dir>`: the workspace or worktree holding the work. Default: the current folder's workspace. Needed when the session runs from the main workspace but the code is in a worktree; otherwise every repo there looks clean and the "has commits" check fails.
- `--monitor`: every URL-looking token after it is a PR (GitHub PR URLs have no spaces); `--monitor <a> --monitor <b>` works too.
- `--auto-merge`: let the watch merge a PR whose merge gate is fully met (below). **Off unless asked**, because merging is outward-facing and hard to undo, and many teams require a human approval or a post-merge review process. CLAUDE.md can make it the team's default ("PRs may be auto-merged"); the merge method follows the repo's settings (`squash` when allowed, else `merge`).

## Pre-flight

1. `gh --version` ≥ **2.93.0** (needed for `--add-reviewer @copilot`; older still works without Copilot). No `gh` at all → use the GitHub MCP tools.
2. `gh auth status` succeeds.
3. Not in `--monitor` mode: every repo you'll open a PR from is on a ticket branch (not its default branch) with commits ahead of `origin/<default>`.

---

## Opening PRs

1. **Find the repos and the ticket:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-status.mjs" --root <root> --all --json
   ```
   Each repo has `branch`, `defaultBranch`, `ticket` (from the branch, using `.claude/dashboard/workspace.json` `issues.ticketPattern` when set), `ahead` and its changes. The ticket is the one the branches (or the worktree's `.worktree.json` `ticketId`) agree on.
   - **Open a PR** for each repo with `ahead > 0` whose branch carries **this** ticket.
   - **Skip, and name in your output**, a repo on a branch for a different ticket, or on its default branch.
   - **Uncommitted changes** in an affected repo: stop and offer to commit first (the `commit` skill) rather than opening a PR that leaves them out.
2. **Read the ticket** for the PR descriptions, by tracker (`workspace.json` `issues.kind`, else what's connected): a Linear MCP (`…__get_issue`), an Atlassian/Jira MCP (`getJiraIssue`), or `gh issue view`. Match tools by suffix; names vary by server. None connected → carry on without it and say so.
3. **In dependency order** (repos.json `dependencies`: a repo comes after the ones it consumes; else listed order), for each repo:
   - Read its commits and diff: `git -C <dir> log origin/<default>..HEAD --oneline`, `git -C <dir> diff origin/<default>...HEAD --stat`.
   - **Bring the branch level with its remote, then push**, upstream or not:
     - If `origin/<branch>` exists, `git -C <dir> fetch origin <branch>` and compare. The remote can be ahead of local without anyone else pushing: `gh pr update-branch` (Step 4 of the watch) adds a merge commit there.
     - Local is an ancestor of the remote → nothing to push; reuse the PR as it is.
     - Remote is behind or equal → `git -C <dir> push -u origin <branch>`.
     - They've diverged → `git -C <dir> pull --ff-only` won't do; `git -C <dir> pull --no-rebase origin <branch>` (or rebase if the repo prefers it), resolve, then push.
     - An existing upstream can be behind the local branch, and a PR opened (or reused) from it would leave the latest commits out, so never skip the comparison. If the push still fails (a hook, permissions), stop this repo's PR step and report it.
   - Create the PR: `gh pr create -R <owner/name> --base <default> --head <branch> --title "<title>" --body-file <file>` (`--draft` if asked). Write the body to a temp file; inline bodies break on quotes. If a PR already exists for the branch, use it instead.
   - Collect `{repo: "owner/name", number, dir}` into the **PR list**: the single source of truth for every later step.
4. **Cross-link**: once all numbers are known, edit each body's "Related PRs" section to list the others (`gh pr edit <n> -R <repo> --body-file <file>`).
5. **Update the ticket** (skip if there's no ticket or no tracker):
   - Comment with a short implementation summary and every PR link.
   - Move it to the team's review state: `workspace.json` `issues.reviewState` if set, else the state CLAUDE.md names, else "In Review".
     - **Linear:** `save_issue` with that `state`.
     - **Jira:** list the issue's transitions and pick the one whose name contains the state (or "review"); never hardcode a transition id. Not available (already there, or a different workflow) → warn and continue.
     - **GitHub Issues:** `Closes #<n>` in the PR body links it; add a review label only if CLAUDE.md names one.
6. **Ask what's next** (Post-PR actions, below), then run it.

### PR format

**Title**: conventional-commit syntax, the same style as the `commit` skill, with the ticket as a **suffix**, never a prefix (a leading `ENG-123:` breaks conventional-commit parsing):

```
feat(api): add invoice export endpoint (ENG-123)
```

Under ~80 characters including the suffix. No ticket → no suffix. The shared suffix ties a ticket's PRs together across repos.

**Body**:

```markdown
## Summary
<1–3 bullets: what this repo's part of the change does>

## Ticket
<tracker link>          (GitHub Issues: Closes owner/repo#N)

## Changes
<the significant changes, grouped by area if needed>

## Test plan
- [ ] <how to verify, specific to this change>

## Related PRs
- <other repo>: <owner/name#number>
```

End it with the attribution line the session's instructions ask for, if any.

---

## Monitor mode (`--monitor <url> ...`)

1. Parse each URL (`https://github.com/<owner>/<repo>/pull/<number>`) into the PR list.
2. Resolve each PR's `dir`, where review fixes get committed: its head branch is `gh pr view <n> -R <repo> --json headRefName -q .headRefName`; find the repo under `--root` (or the current workspace and its worktrees) checked out on that branch. None → warn: watching and branch updates still work, local fixes don't; ask whether to continue.
3. Ask the Post-PR question (without "Just create") and run the answer.

---

## Post-PR actions (one question)

Ask **once**; the answer covers every PR:

- **Copilot + watch** (Recommended): request Copilot on each PR, then watch: fix valid feedback (commit + push), reply to and resolve threads, keep branches current, and merge when green if `--auto-merge` is on.
- **Watch only**: the same, without requesting Copilot.
- **Just create**: report the PRs and stop.

Autonomous callers (an `implement` run in auto mode, or no one to ask): don't ask; open the PRs, request Copilot where possible, do one status check, and stop. Never merge.

In a terminal session, follow up by asking how often to check (every 5 / **10 (recommended)** / 15 minutes; longer means fewer cycles and fewer tokens). In a dashboard run, don't ask: the dashboard checks for free.

### Copilot review

```bash
gh pr edit <number> -R <repo> --add-reviewer @copilot
```

Per PR. A failure usually means Copilot code review isn't enabled for that org or repo: say it can be requested from the GitHub UI and carry on with the rest. Flag it clearly, since the review is what the watch waits for.

---

## Watching the PRs

The watch runs in **this** session, which has the ticket and every sibling PR in context, so a comment on one repo's PR can be judged against what the others do. Don't hand it to a self-pacing subagent: scheduling is a session capability, and a subagent can't wake itself. Keep each cycle cheap; delegate any real code fix to a subagent (the one CLAUDE.md assigns to that repo, if any) so its context stays separate.

### The merge gate

What each cycle reports against, and what `--auto-merge` requires in full:

1. **Approvals**: `reviewDecision == "APPROVED"`, or the repo requires no reviews (`reviewDecision` empty) and no reviewer, Copilot included, is at `CHANGES_REQUESTED`.
2. **Checks**: every required check passed; none failing or pending. Don't name specific checks; whatever the repo requires is the bar.
3. **No open action items**: every actionable thread has a reply from the authenticated user.
4. **Current and mergeable**: `behind_by == 0` from the compare API (not `mergeStateStatus`, which only says `BEHIND` when branch protection requires up-to-date branches) and `mergeable == MERGEABLE`.

### The cycle

Substitute the PR list (`repo=<owner/name> number=<n> dir=<abs path>` per line). Get the authenticated login once with `gh api user -q .login`.

```
Watch these PRs (one cycle):
  - repo=<REPO_1> number=<NUM_1> dir=<DIR_1>
  - repo=<REPO_2> number=<NUM_2> dir=<DIR_2>
Auto-merge: <on|off>. Authenticated user: <LOGIN>.

Step 1 — Still open? gh pr view <N> -R <REPO> --json state -q .state
  MERGED or CLOSED → done for this PR; skip to the table.

Step 2 — Readiness, in one call:
  gh pr view <N> -R <REPO> --json reviewDecision,mergeable,mergeStateStatus,latestReviews,statusCheckRollup,baseRefName,headRefName,headRefOid
  statusCheckRollup mixes two kinds: check runs (result in `conclusion`, progress in `status`) and legacy status contexts (`__typename` StatusContext, result in `state`: SUCCESS / PENDING / EXPECTED / FAILURE / ERROR). Read a check's result as `conclusion // state`.
  checks: ❌ if any result is FAILURE/ERROR/TIMED_OUT/CANCELLED/ACTION_REQUIRED/STARTUP_FAILURE; ⏳ if any is QUEUED/IN_PROGRESS/PENDING/EXPECTED or has no result yet; ✅ if all SUCCESS/NEUTRAL/SKIPPED; — if none.
  copilot: a latest review by a login containing "copilot": CHANGES_REQUESTED → ⚠️; COMMENTED/APPROVED → ✅; none → ⏳.
  Remember headRefOid: these results belong to that commit only.

Step 3 — Act on new review comments (the heart of the cycle):
  gh api --paginate repos/<REPO>/pulls/<N>/comments   (inline threads; --paginate, or a busy PR's later comments are missed)
  gh api --paginate repos/<REPO>/pulls/<N>/reviews    (summaries; CHANGES_REQUESTED)
  Actionable = an inline thread not started by <LOGIN> with no reply from <LOGIN> yet, OR a review whose body asks for something (CHANGES_REQUESTED, or a COMMENTED body with concrete requests) that no inline thread carries and that <LOGIN> hasn't answered in a later PR comment (gh api --paginate repos/<REPO>/issues/<N>/comments). A summary that only describes the PR ("reviewed 12 files, no issues") is not actionable.
  Summary-only feedback has no thread to reply on: after fixing (or deciding not to), answer it with one PR comment quoting the point, e.g. gh pr comment <N> -R <REPO> --body-file <file> ("Claude replying on behalf of <LOGIN>: re <reviewer>'s review: ... Fixed in <sha>." or the reasoning).
  For each, judge it with the ticket and the sibling PRs in mind:
  - REAL → fix it (delegate to the repo's owning agent if CLAUDE.md names one), commit from <DIR> with `git -C <DIR> commit -F -`, bring in anything the remote gained (a branch update from Step 4 of an earlier cycle) with `git -C <DIR> pull --no-rebase origin <HEAD_BRANCH>`, then `git -C <DIR> push`. Then reply on the thread:
      gh api repos/<REPO>/pulls/<N>/comments/<COMMENT_ID>/replies -X POST -f body="Claude replying on behalf of <LOGIN>: Fixed in <sha>. <what changed>"
  - NOT REAL → reply with the reasoning, same prefix. Don't implement every suggestion blindly; don't wave off a valid bug.
  Then RESOLVE the thread, reply first, resolve second. Find its node id:
      gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}' -f o=<OWNER> -f n=<NAME> -F p=<N>
    (the node whose first comment's databaseId is <COMMENT_ID>), then:
      gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=<THREAD_ID>

Step 4 — Keep the branch current:
  gh api repos/<OWNER>/<NAME>/compare/<BASE>...<HEAD> --jq .behind_by
  > 0 → gh pr update-branch <N> -R <REPO>; record "🔄 updated"; don't merge this cycle.

Step 5 — Merge (only when auto-merge is on):
  - Never in a cycle that pushed a fix or updated the branch (Steps 3–4): the readiness from Step 2 belongs to the old head. Record "⏳ re-check" and let the next cycle judge the new commit.
  - Otherwise re-read readiness right before merging (gh pr view <N> -R <REPO> --json headRefOid,reviewDecision,mergeable,statusCheckRollup) and merge only if headRefOid is still the one Step 2 saw and every gate condition holds for it.
  - Resolve any straggler threads (same queries, isResolved==false), then bind the merge to that verified commit:
      gh pr merge <N> -R <REPO> --squash --delete-branch --match-head-commit <headRefOid>     (or --merge if the repo disallows squash)
    and record "✅ merged". GitHub refuses it if the head moved meanwhile.
  - Anything ambiguous (a flaky check, an unanswered question) → don't merge; name what's blocking.

Step 6 — Print the table, every cycle:
  | PR | State | Approvals | Checks | Copilot | Behind | Mergeable | Action |
  Then one line per open PR naming what it's waiting on (e.g. "api#181 — waiting on: Copilot review, 1 approval").

Step 7 — All PRs merged or closed → stop the watch and print "✅ All PRs resolved". Otherwise carry on; drop finished PRs from the next cycle.
```

### Terminal session: a `/loop`

Start `/loop <INTERVAL>m <cycle prompt>` **once**; `/loop` owns the cadence, so never re-invoke it from inside a cycle (that stacks schedules). Each fire re-reads this session's context; for long overnight watches suggest a dedicated session running only `/pr --monitor <urls>`. The user can `/compact` between cycles (it's human-only). Tell them what's running: the PRs, the cadence, what it acts on, whether it merges, and that it stops when all are merged or closed.

### Headless (a dashboard run, `claude -p`): a watch block

A headless turn is its own process, so `/loop`, cron and wake-ups die with it.

- **Dashboard runs** (the system prompt mentions a `<<WATCH>>` block): run one cycle now (Steps 1–6), then end the turn with
  ```
  <<WATCH>>
  {"prs":["<REPO_1>#<NUM_1>","<REPO_2>#<NUM_2>"],"everyMinutes":5,"prompt":"<the cycle prompt, Steps 1-6, PR list substituted>"}
  <</WATCH>>
  ```
  It must be valid JSON: escape `"` as `\"`, backslashes as `\\`, line breaks as `\n`. **Never put the watch markers themselves inside the prompt** (not even a stop example): the block ends at the first closing marker, so a nested one cuts the JSON short and the watch silently never starts. The dashboard stops the watch itself when every PR is merged or closed, so the cycle prompt doesn't need one. On each wake-up the dashboard sends what changed followed by the prompt: run one cycle and end the turn, without a new block (the watch stays on). It ends itself when every PR is merged or closed; `<<WATCH>>{"stop":true}<</WATCH>>` ends it sooner. Tell the user what's being watched and that **Stop watching** on the run page ends it.
- **Permissions in headless runs**: only what the workspace's settings allow runs. Keep commands in plain forms: `gh pr view …`, `gh api …`, `gh pr update-branch …`, `gh pr edit … --add-reviewer …`, `git -C <DIR> commit -F -`, `git -C <DIR> push`. No `cd <dir> && …`, no shell loops. A refused command goes in the table's Action column; don't look for a way around it.
- **Other headless runs** (no watch block in the system prompt): run one cycle and say ongoing watching needs a terminal (`/pr --monitor <urls>`).

---

## Errors

- `gh` not authenticated → `gh auth login`.
- No commits ahead of the default branch → commit first.
- Ticket not found, or no tracker connected → open the PRs without the ticket update, and say so.
- A PR already exists for the branch → use it; don't open a duplicate.
- Copilot request fails → likely not enabled for that repo; continue and flag it.
