# Worked pipeline example

ENG-123, "Show an invoice's payment status", touching three repos of the acme workspace:

```json
{ "repos": [
  { "name": "api",   "relativePath": "api",   "dependencies": [] },
  { "name": "web",   "relativePath": "web",   "dependencies": ["api"] },
  { "name": "portal", "relativePath": "portal", "dependencies": ["api"] }
] }
```

CLAUDE.md says: `api` belongs to the `api-expert` agent; `web` consumes a TypeScript client generated from the running api's OpenAPI document (`npm run generate-client`); there's a `browser-qa` agent; nothing for `portal`.

After step 5, `--resolve` returns (trimmed):

```
placement: worktree-exists      worktree.state: complete
baseDir:   /home/dev/acme/worktrees/ENG-123
branch:    feature/ENG-123 (from worktree)
ports:     { api: 24101, web: 24102, portal: 24103 }
stages:    [["api"], ["web", "portal"]]
```

So WORKROOT = `/home/dev/acme/worktrees/ENG-123`, the plan file is `~/.claude/plans/ENG-123-payment-status.md`, and every prompt below opens with the paths block from `agent-rules.md`, abbreviated to `<PATHS>` here. Never abbreviate it in a real prompt.

---

## Stage 1: api

```
Agent({
  description: "Plan api changes for ENG-123",
  subagent_type: "api-expert",
  prompt: "<PATHS>\n\n<plan + assignment block, step 1 pasted>\n\n<generated-code block>\n<undoing-work block>\n\n"
        + "Work in <WORKROOT>/api on feature/ENG-123. Assumptions: <block>.\n\n"
        + "First research and propose a plan for your step. Do NOT edit files yet: stop and report the plan."
})
```

Record the returned **id** (no `name`). Read the plan against the acceptance criteria and check its factual claims (a grep each). Then:

```
SendMessage({ to: "<api agent id>", message: "Approved: proceed, test first, then report exactly what changed (files, endpoints, models) and the build/test numbers." })
```

A wrong premise: say which and why in the correction. Don't spawn a second agent for a fresh plan.

## Review of stage 1 (tree frozen)

No dedicated reviewer is named, so `general-purpose`, briefed to review:

```
Agent({
  description: "Review api changes for ENG-123",
  subagent_type: "general-purpose",
  prompt: "<PATHS>\n\nYou are reviewing, not implementing: edit nothing. Another agent wrote this; be adversarial.\n\n"
        + "Plan: <plan file path>. Step under review: 1.\n"
        + "Files changed (tracked): <list>. New, untracked (no diff shows these: read them in full): <list>.\n"
        + "The implementer claims <X because Y>: verify Y yourself.\n"
        + "Questions: <ordering, other callers, migrations, error paths, does it match the codebase's idiom>.\n\n"
        + "The tree is frozen for this pass. Report APPROVED or CHANGES REQUESTED, findings ranked most severe "
        + "first, each with file, concrete failure scenario, and whether you're confident or speculating. "
        + "If you find nothing serious, say so plainly."
})
```

Changes requested → forward the full list to the api agent's id, wait for its fix report, then `SendMessage` the **same reviewer id** for another pass. Approved → append the as-built note to the plan file.

## Generated-client gate (between stages 1 and 2)

1. Start the worktree's api with the workspace's run tooling, `--root <WORKROOT>`, on port 24101.
2. Ready = port bound and `GET http://localhost:24101/openapi.json` returns 200.
3. The served document contains `paymentStatus` (else it's the main workspace's api).
4. Stage 2's agent runs `npm run generate-client` against port 24101 and reports the generated diff; an empty diff is a failure.

## Stage 2: web and portal (independent: one message, two calls)

```
Agent({ description: "Plan web changes for ENG-123", subagent_type: "general-purpose",
        prompt: "<PATHS>\n\n<blocks>\n\nWork in <WORKROOT>/web (React + TypeScript). The api stage reported: <report>. "
              + "Regenerate the client against http://localhost:24101 first, then propose a plan. No edits yet." })

Agent({ description: "Plan portal changes for ENG-123", subagent_type: "general-purpose",
        prompt: "<PATHS>\n\n<blocks>\n\nWork in <WORKROOT>/portal ... propose a plan. No edits yet." })
```

Approve each by id. Then one review stage covering both: two reviewer calls in one message, or one reviewer for both repos when the stack is the same. A new tier, so a fresh reviewer: brief it with the api contract facts in a paragraph.

## Stage 3: QA (web only)

`browser-qa` with the prompt from `qa-subagent.md`, app at `http://localhost:24102`. Portal has no QA path, so its reviewer is the only adversarial pass: brief it accordingly.

Agents used: api implementer, api reviewer, web, portal, frontend reviewer, QA: six, under the cap of eight.

---

## Smaller shapes

- **One repo**: plan, implement, review. Still plan-first, still reviewed.
- **Backend only**: stage 1 and its review; no client gate if nothing consumes the change yet.
- **Frontend only**: one implementer, a review stage (a frontend-only change has no compiler catching contract drift, so don't skip it), QA if a QA agent applies.
- **Config/infra only**: the implementer reports the plan and the exact commands; you run nothing against shared infrastructure without the user.
