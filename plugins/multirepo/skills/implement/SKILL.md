---
name: implement
description: Implement a ticket (Linear, Jira or GitHub Issues) end to end across a multi-repo workspace (or a single repo) - find or create the ticket's worktree, check the repos are current, settle open questions up front, branch every affected repo, then run a pipeline of subagents in dependency order that plan, write, review and optionally QA the code, and finish with commits and PRs. Use whenever the user wants to implement, build, start, pick up or knock out a ticket, e.g. "implement ENG-123", "let's build ENG-456", "start on this ticket", "pick up acme/api#7", "work on this issue end to end", "take this ticket to PRs", or pastes a tracker URL and wants it done, even if they don't say "implement". No need to be in a worktree first; this skill handles placement. `--auto` runs unattended (decides, records each decision on the ticket, opens PRs, never merges).
argument-hint: "<TICKET | tracker-url> [--auto] [--here] [--branch <b>]"
---

# Implement

Take a ticket to working, reviewed code across the workspace. You are the **orchestrator**: you settle where the work lives, resolve the open questions, then spawn `Agent`-tool subagents per repo in dependency order and check what they report. You do not write the implementation yourself; if you catch yourself editing code, stop and delegate it.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

**Why the `Agent` tool and not agent teams.** Agent teams aren't available everywhere (cloud sessions, some harnesses), and this work is sequential with hard dependencies in one shared tree: the shape teams are worst at. Plain subagents work everywhere, return their final report to you, and run their own `effort:` setting. Use them unconditionally.

## The script

Everything deterministic is one script. Use it instead of ad-hoc git.

```bash
I="${CLAUDE_PLUGIN_ROOT}/scripts/implement.mjs"
node "$I" --ticket <ID> --resolve [--root <dir>] [--branch <b>] [--type <issue type>] [--here] [--json]
node "$I" --freshness [--pull] [--root <dir>] [--repos a,b] [--layer <layer>] [--json]
node "$I" --branches --branch <b> --repos a,b [--ticket <ID>] [--root <dir>] [--json]
```

- `--ticket` takes the id or a pasted tracker URL: a Linear or Jira URL resolves to its `KEY-123`, a GitHub issue or PR URL to `owner/repo#N`; a URL with no id exits 2. `ticket` in the output is the resolved id.
- `--resolve` makes no changes. It prints `placement`, `baseDir` (where the work lives), `worktree` (`name`, `path`, `state`: absent / complete / incomplete, `missingRepos`, `problems`, `matchedBy`: `metadata` when a folder's `.worktree.json` names the ticket (whatever the folder is called), `name` when only the folder name matches, and `duplicates[]`: other folders for the same ticket, so ask which one to use), `branch` + `branchSource`, `ports` (the worktree's slot, if the workspace allocates them), `stages` (repo names grouped by `repos.json` `dependencies`: each stage after the ones it consumes) and per repo `branch`, `onDefault`, `onBranch`, `dirty`, `ahead`/`behind` vs `origin/<default>`.
- `--freshness` fetches every repo and returns per repo `state`: `up-to-date`, `fast-forwarded`, `behind`, `dirty`, `other-branch`, `diverged`, `ahead`, `fetch-failed`, `no-origin` (a local-only repo: nothing to fetch, not a decision), `missing`, plus `needsDecision[]`. `--pull` fast-forwards **only** repos on their default branch, clean and strictly behind.
- `--branches` creates or switches to the branch in each repo under `--root`. It refuses (exit 1, `{ refused, reason, error }`) in the main workspace when the ticket's worktree exists, and inside another ticket's worktree; it skips (with a reason) a repo on an unrelated branch, on another branch for this ticket, or with uncommitted changes, and never stashes. New branches start from `origin/<default>`.

### Progress for the Factory board

When the workspace has a Natterjack dashboard, its **Factory** page shows this ticket as a card moving through the pipeline. Report each step with `factory.mjs`, never by editing JSON. It's a no-op (`{ skipped }`) without a dashboard, so call it unconditionally. A failed call never stops the work.

```bash
F="${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs"
node "$F" policy                      # the team's factory.json: { exists: false } when there's none
node "$F" start --ticket <ID> --title "<title>" --url <ticket url> --mode interactive|autonomous --branch <b> --repos a,b --plan <plan file> --workroot <WORKROOT>
node "$F" stage --ticket <ID> --stage <stage> --status running|done|failed|skipped [--repo <r>] [--agent <type>] [--note "<as-built, one line>"]
node "$F" gate  --ticket <ID> --gate spec|plan|prePr|merge --decision pending|approved|rejected --by user|auto [--rationale "<why>"]
node "$F" pr    --ticket <ID> --url <pr url> --repo <r>
node "$F" done  --ticket <ID> [--error "<why it stopped>"]
```

| When | Report |
|---|---|
| Ticket read (step 1) | `start` with the title, URL and mode, then score the spec (below) |
| WORKROOT is set (step 5) | `start` again with `--workroot`, `--branch` and `--repos` (it merges into what's there) |
| Plan file written (step 4) | `stage --stage plan --status done` |
| You ask to proceed (step 4) / the user answers | `gate --gate plan --decision pending`, then `approved` (or `rejected`, then `done --error "plan rejected"`). Autonomous: `approved --by auto` |
| Each subagent's implement and review (step 7) | `stage --stage build` and `--stage review`, per `--repo`: `running` when it starts, then `done` or `failed` |
| QA, second opinion (step 8) | `stage --stage qa`, and `--stage review` for the second opinion |
| Commit and PRs (step 9) | `gate --gate prePr --decision approved`, then `pr` per PR, `stage --stage pr --status done` |
| Wrap-up, or stopping for good | `done` (`--error` when it stopped short) |

`policy` is for reading only, for now. The gates above follow this skill's own rules (interactive asks, autonomous decides). Read `gates` from it to say on the ticket which gates the team expects a person at.

## Steps at a glance

0. Placement and mode (one script call, one look at your tools)
1. Read the ticket, its attached plan or alignment, and its blockers
2. Freshness check
3. Offer alignment when the ticket is vague
4. Plan file, affected repos, open questions
5. Establish the workspace: worktree, branches, paths, ticket "started"
6. Pre-flight checklist
7. The subagent pipeline
8. Optional gates: QA, second-opinion review, stack left running
9. Wrap up: verify, record, hand off

---

## 0. Placement and mode

Run `--resolve` first, before the tracker, before anything (`--type` only once you know the issue type; re-run then).

| `placement` | Meaning | Do |
|---|---|---|
| `in-worktree` | The session is inside this ticket's worktree | `baseDir` is your root. |
| `worktree-exists` | The ticket's worktree exists; you're not in it | Check `worktree.state` (below). **Never create another.** |
| `worktree-missing` | Worktrees are used here; this ticket has none | Create it in step 5, once you know the repos. |
| `in-other-worktree` | Inside a **different** ticket's worktree | **Stop and ask.** Two tickets in one checkout mix two branches' work. |
| `flat` | No worktrees here (cloud session, bare checkout) | Work in place; don't create one. |
| `here` | `--here` was passed | The current checkout, no lookup. Only when the user asks for it. |

**`worktree.state` for an existing worktree:**
- `complete`: reuse it. Tell the user what's in it (each repo's branch, dirty or not) and tell the planning step too, so it doesn't redo or contradict work already there.
- `incomplete` (a failed clone, no `.worktree.json`, a listed repo missing): **never reuse it silently and never delete it silently**; it can hold committed work from before the failure. Say exactly what's missing (`problems`) and offer: **Repair** (clone the `missingRepos` with `/multirepo:worktree`'s help, or append them to `.worktree.json` `repos[]`), **Recreate** (`/multirepo:worktree --remove <name>`, which guards unsaved work, then create), or **Abort**. Autonomous: stop and comment on the ticket.

**Start here or hand off?** For an absent or complete worktree, interactively offer: **Start now** (drive it from this session), **Set up, then hand off** (create it, stop, and print `cd <path>` then `claude` and `/multirepo:implement <TICKET>`, or `claude -p "/multirepo:implement <TICKET> --auto"` unattended), or **Abort**. Put this caveat in the question text: *if we start now, the code is in the worktree but this conversation stays under the starting folder; a session opened in the worktree won't list it in `/resume`. The ticket is the durable record either way.* A hand-off skips planning: the session that does the work plans it.

The session can't `cd` into a worktree (independent clones aren't registered git worktrees). You orchestrate from where you started and address the worktree by absolute path (step 5).

### Interactive or autonomous

Decide once:
- `--auto` / `--autonomous`, **or** `AskUserQuestion` isn't in your tools (scheduled and cloud runs), **or** the user said "just go, don't ask" → **autonomous**.
- Otherwise **interactive**.

Autonomous decides every question itself (smaller scope, reversible change, the pattern already in the codebase) and **records each decision as a ticket comment**: nobody reads the transcript of an unattended run. It never stalls on input that isn't coming, never runs `--force`/remove, and never merges. In dashboard and `claude -p` runs `AskUserQuestion` may still exist (rendered as a question block): then it's interactive.

## 1. Read the ticket

Prefer `/multirepo:fetch-ticket <TICKET>`: it normalizes the ticket to JSON, including `planComment` (the newest comment carrying `<!-- GENERATED-BY-SUBMIT-PLAN-SKILL -->`) and `alignComment` (`<!-- GENERATED-BY-ALIGN-SKILL -->`). Without it, read the tracker directly:

- **Which tracker**: `.claude/dashboard/workspace.json` `issues.kind` (in a worktree it's read from the source workspace), else the id's shape (`owner/repo#N`, `#N` → GitHub Issues), else what's connected (a Linear MCP, an Atlassian/Jira MCP, `gh`). Tool names vary by server; match the suffix (`get_issue`, `getJiraIssue`). Not found → report and stop.
- Take the title, description, acceptance criteria, type, labels, parent, links and all comments.

Then **score the spec**: how ready the ticket is to start on, by what any good spec has (problem, outcome, testable acceptance criteria, scope, constraints, affected areas, no open questions, how to verify), under whatever headings the team uses. The team's levels and weights come from `factory.json` `spec`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/spec-check.mjs" <ticket.json> --ticket <ID> [--overrides '<json>']
```

`<ticket.json>` is fetch-ticket's output (saved to a file; `-` reads stdin). `--ticket` records the score for the Factory board. Read each check's finding against the ticket: where the text fooled it (criteria that look testable but contradict each other, a "?" that was answered in a comment), re-run with `--overrides '{"criteria":{"score":0.5,"reason":"AC 2 and 3 contradict"}}'`. A score of 0, 0.5 or 1, and always a reason. Then the **spec gate**:
- **Ready**: carry on (`gate --gate spec --decision approved --by auto`).
- **Needs work / Not ready, interactive**: say the score and what's missing in a line each, and offer **Align first** (`/multirepo:align`, when installed) / **Proceed anyway** / **Abort**; record the answer as the spec gate's decision.
- **Autonomous**: below the result's `minScore` (when set), comment on the ticket with the score and what's missing, `gate --gate spec --decision rejected --by auto`, `done --error "spec not ready"`, and stop. Otherwise carry on and put the score and gaps in the Assumptions.

Then:
- **Blocked-by links** (`links[]` with `type: "blocked by"`) whose `state` isn't done → tell the user and ask whether to proceed. Autonomous: stop, comment that it's blocked, leave the state alone.
- **A plan comment** replaces repo discovery and most of the questions: it's a reviewed plan from plan mode. Don't re-explore what it already settles; that's the most expensive mistake available here.
- **An align comment**, or a local `~/.claude/align/<TICKET>.md`, is the agreed problem statement: planning reads it.
- **Issue type** (`type`, else labels) → branch prefix, unless CLAUDE.md has a convention: bug → `fix/`, chore → `chore/`, else `feature/` (`--resolve --type <type>` applies it). An existing worktree's branch always wins over the convention.

## 2. Freshness check

Everything after this reads code; a plan written against stale clones describes code that no longer exists, and nothing fails. Once placement is fixed (hand-offs skip it; the new session runs it):

```bash
node "$I" --freshness --pull --root <baseDir> --json
```

In `worktree-missing`/`flat` that's the main workspace; for a complete worktree run it there too (its repos are on the feature branch, so they report `other-branch` with how far behind they are).

- `fastForwarded`: done without asking; one line ("Updated: api +14, web +2").
- `needsDecision` empty: carry on.
- Otherwise ask, naming each repo with its `detail` (the user can't see the output). Never resolve these yourself: each means moving someone's branch or uncommitted work. Main workspace: **Continue on current code** / **Abort**. Worktree behind its default branch: **Rebase/merge first** (the user's call, or theirs to do) / **Continue as-is**. Autonomous: continue and record it on the ticket.

## 3. Offer alignment

When there's no plan or align comment and the ticket is vague (product wording, outcomes instead of behaviours, open questions in the text, bigger than it looks) and `/multirepo:align` is installed, offer **Align first** / **Plan directly**, recommending one in a sentence. Align is an interview: let it run, don't answer for the user. It writes no code and is safe before the worktree exists. Autonomous: don't align; note the vagueness in the assumptions.

## 4. Plan file, repos and questions

**The plan lives in a file, not in your context:** `~/.claude/plans/<TICKET>-<slug>.md` (home folder, so it resolves the same from any worktree, and it's what `/multirepo:submit-plan` posts). Fill it from, in order: the plan comment verbatim; else a plan you draft (optionally with a read-only `Plan` or `Explore` subagent for the research), with sections Problem, Approach, Repos & stages, Steps per repo, Assumptions, Open questions. Agents get its **path**, never pasted text.

**Affected repos**: from the plan; else match the ticket against `repos.json` names, `layer`, `dependencies` and what CLAUDE.md / AGENTS.md say each repo owns. If a change alters something another repo consumes, include the consumers it names. It's a guess worth confirming with the questions.

**Settle the open questions before any code.** A wrong assumption found in review costs a re-run; found now it costs a question. Worth raising: shape-changing ambiguity, unstated product/UX decisions, scope boundaries (is that repo in?), data decisions (backfill or new rows only). Not worth raising: anything the code answers, conventions, anything the plan settled, questions whose answer wouldn't change the work.

- **Interactive**: two to four questions in **one** `AskUserQuestion` round, each leading with your recommended option and why. Then walk the plan's own assumptions, most consequential first, **one decision at a time** (related ones may share a question; never a block of eight): what the plan does under it and what changes if it's wrong. Take corrections; if one invalidates steps, say so and re-plan rather than patching.
- **Autonomous**: decide each as you'd have recommended.
- **Either way**, write every resolution back into the plan file (and say where a step changed), and keep an **Assumptions** block for the ticket:

  ```markdown
  ### Assumptions
  - **<question>**: <decision>. <one line of reasoning, or "confirmed by user">.
  ```

Interactive: before building, offer **Proceed** / **Proceed and post the plan** (`/multirepo:submit-plan`, so later runs reuse it) / **View the plan** / **Abort**.

## 5. Establish the workspace

1. **Create the worktree** (`worktree-missing`, "start now"): confirm the repo list once, naming what each is for, then create it so the worktree skill doesn't ask again:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" create --name <worktree.name> --repos <a,b> --branch <branch> --ticket <TICKET>
   ```
   (or `/multirepo:worktree <TICKET> --repos <a,b>`). Then **re-run `--resolve`**: placement becomes `worktree-exists`, and read `branch` from there.
2. **Branches** (any repo with `onBranch: false`; the worktree create already did its own):
   ```bash
   node "$I" --branches --branch <branch> --repos <a,b> --ticket <TICKET> --root <baseDir>
   ```
   Report every skipped repo with its reason. A repo already on `fix/<TICKET>` while you meant `feature/<TICKET>` is the two-branches trap: use its branch.
3. **WORKROOT** = `baseDir`, absolute. Rewrite the plan file's paths: every `<mainRoot>/<repo>/` → `<WORKROOT>/<repo>/`, grep that none survive, and add a banner at the top naming WORKROOT and the branch and saying the main workspace's copies are not to be edited.
4. **Every subagent prompt opens with the paths block** (`references/agent-rules.md`). Subagents inherit your cwd, so an unqualified `git status` or build silently runs in the main workspace and "passes".
5. **Every repo-discovering skill gets `--root <WORKROOT>`**: `/multirepo:commit`, `/multirepo:pr`, `/multirepo:copilot-review`, the workspace's run/stop tooling. Without it they act on the main workspace and report success.
6. **Tell the ticket it started**: a comment with the branch, WORKROOT (and ports), the repos, the Assumptions block and the planned stages; then move it to the in-progress state (below). Autonomous: this comment is the only place your reasoning is visible, and the state change is what stops the next scheduled run taking the same ticket.

### Tracker writes

| | Comment | Move state |
|---|---|---|
| Linear | `save_comment` | `save_issue` with `state` |
| Jira | `addCommentToJiraIssue` | list the transitions, pick the one whose **name** contains the state; never a hardcoded id |
| GitHub Issues | `gh issue comment <n> -R <o/r> --body-file <f>` | a label only if CLAUDE.md names one |

States: in progress = `workspace.json` `issues.progressState`, else what CLAUDE.md names, else "In Progress". In review = `issues.reviewState`, else CLAUDE.md, else "In Review". Never a done state: whatever happens after merge is the team's process. A missing transition → warn and continue.

## 6. Pre-flight (before the first `Agent` call)

- [ ] WORKROOT is set from a fresh `--resolve` (`in-worktree`, `worktree-exists` + complete, `flat` or `here`).
- [ ] Every affected repo shows `onBranch: true`.
- [ ] The plan file exists, its paths point into WORKROOT, and it holds the resolved assumptions.
- [ ] The "started" comment (with Assumptions) is posted and the ticket is in progress.

This step is easy to half-finish (a pause, a question, an interruption) and nothing downstream notices. Fix an unchecked box now.

## 7. The pipeline

Read `references/pipeline-example.md` for concrete call shapes and `references/agent-rules.md` for the rules every prompt carries.

**Stages** are `--resolve`'s `stages` filtered to the affected repos (else the plan's order). Repos in one stage don't depend on each other and may go in one message as parallel `Agent` calls; a later stage waits for its upstream's report, since its prompt needs it.

**Agent type per repo**: the one CLAUDE.md / AGENTS.md assigns, else a `.claude/agents/*.md` whose description fits the repo or stack, else `general-purpose` with the stack named in the prompt. Reviewers likewise; a stack-specific reviewer is never pointed at another stack.

**Bounded, not a spawn loop.** One initial `Agent` call per stage; typically 2-5, **8 is a hard cap** (re-scope with the user rather than exceed it). Continuing an agent with `SendMessage` doesn't count. One correction per stage: if it fails again, **stop and escalate**; never replace-and-retry. One agent per repo at a time.

**Each stage:**
1. **Plan first.** The subagent's first task: research and propose a plan for its repo, no edits, then stop. Give it the paths block, the plan file path, its own step pasted inline, the Assumptions, the upstream stage's report, the ports, and "follow the `tdd` skill (red, green, refactor) where it applies".
2. **Verify the plan's factual claims** before approving ("nothing else calls this", "this would throw because..."). One grep usually settles it; a confident plan on a false premise is as persuasive as a true one. Approve or correct with `SendMessage` to the agent's **id**.
3. **Implement**, then **review**: every repo that changed gets a review stage, even frontend-only or config-only work (it's often the only adversarial pass). The reviewer gets the files changed (untracked ones listed explicitly: the ticket is uncommitted, so `git diff` hides new files), the implementer's claims to check, the questions you want answered, severity ranking, and permission to find nothing. Changes requested → forward to the implementer, then resume the **same** reviewer.
4. **As-built note**: after each approved step, append to the plan file what deviated from the plan and why, decisions made in review, renames, and the build/test numbers. It's what makes a step boundary a safe hand-off.
5. **Verify where it landed** after the first stage: `git -C <WORKROOT>/<repo> status` shows the change and the main workspace's copy is clean.

**Generated code gates** (only if the workspace has them; read CLAUDE.md). When a generated client or artifact must be regenerated from a running upstream: start the upstream from WORKROOT with the workspace's run tooling (or a Natterjack dashboard's `apps start`), confirm readiness by port/HTTP (not stdout), confirm the **served** contract contains the new symbol (else you're generating against the main workspace's copy), regenerate with the documented command, check the generated diff is non-empty, and stop the upstream if CLAUDE.md says so. **Nobody hand-writes, stubs or edits generated code.** If generation can't run, stop dependent work, report the blocker, fix the cause, resume.

**Read every command an agent hands back** before you run it: each project, repo and app path in it must contain the WORKROOT segment. A dropped prefix runs the main workspace's code and looks like success.

## 8. Optional gates

Each runs only when available; none blocks the run.
- **QA** for UI changes, when the workspace defines a browser QA agent (or CLAUDE.md describes one): `references/qa-subagent.md`. Interactive: ask first (it's token-heavy).
- **Second opinion**: when `copilot --version` works, offer `/multirepo:copilot-review --root <WORKROOT>` before PRs (autonomous: run it). Its fixes are uncommitted; if they touch code QA exercised, offer to re-run QA.
- **Stack for manual testing** (interactive, when the workspace has run tooling): restart (never reuse a stale build), verify by port, then give the URLs and 2-4 things to click from the acceptance criteria.

## 9. Wrap up

1. **Verify per repo**: `git -C <WORKROOT>/<repo> status` and `git -C <WORKROOT>/<repo> log --oneline origin/<default>..HEAD`. An empty repo means its stage didn't land: say so.
2. **Summarize**: per repo what changed, the review verdicts, QA, the second opinion, anything left undone, and any assumption that turned out wrong.
3. **Comment on the ticket** with the same.
4. **Hand off; never end on a list of next steps** (a run that ends "now run commit and pr" reads as done while the work is uncommitted).
   - **Interactive**: `AskUserQuestion` "Next step": **Commit and open PRs** (recommended) / **Commit only** / **Not yet** (give WORKROOT and the commands for later).
   - **Autonomous**: `/multirepo:commit --auto --root <WORKROOT> --ticket <TICKET>`, then `/multirepo:pr --root <WORKROOT>`: request Copilot where possible, one status check, **never merge**, PR links on the ticket.
   - When this conversation isn't in the worktree, say so and give `cd <WORKROOT>` for a session whose history sits with the code.

## Errors

| Situation | Do |
|---|---|
| Ticket not found / no tracker | Report and stop |
| `in-other-worktree` | Stop and ask which worktree |
| Incomplete worktree | Repair / Recreate / Abort (step 0); autonomous stops |
| `--branches` refused | `reason` says which: the main workspace (use `--root <worktree>`), or another ticket's worktree (stop and ask: that checkout belongs to a different ticket) |
| Repo skipped by `--branches` | Report it with the reason; never switch it yourself |
| Subagent errors or a bad plan | One correction via `SendMessage`; then stop and escalate |
| Generation blocked | Stop dependent work, report, fix the cause, resume |
| Scope creep | Bugs in this ticket's feature: same branch. Anything else: ask (autonomous: record as a follow-up, don't build it) |
