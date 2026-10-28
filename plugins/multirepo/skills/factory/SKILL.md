---
name: factory
description: Run the software factory from a terminal session. Pull the tickets the team's Factory policy takes in (by tracker state and label), up to its WIP limit, and run each through implement under the policy, one at a time, each in its own worktree. Use when the user wants to "run the factory", "pull work in", "work the queue" or "do the ready tickets", or asks the agents to take whatever is ready. The Natterjack dashboard's Factory page does the same with Pull work in, or on its own with intake.auto.
argument-hint: "[--max <n>] [--dry-run]"
---

# Factory

A thin layer over `/multirepo:implement`, which stays the per-ticket engine. This skill decides **which** tickets and **how many**; the team's policy (`.claude/dashboard/factory.json`, edited on the dashboard's Factory → Policy page) decides everything else: gates, stages, limits, the Approver.

> **Plugin folder.** `${CLAUDE_PLUGIN_ROOT}` below is this plugin's folder (the one with `scripts/`). Claude Code fills it in. GitHub Copilot CLI and OpenAI Codex CLI don't: there, use the folder two levels above this SKILL.md (`<plugin>/skills/<name>/SKILL.md` → `<plugin>`).

```bash
F="${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs"
```

## 1. Read the policy

`node "$F" policy`. Stop and say why when:
- there's none (`exists: false`), or it isn't `enabled`: the team hasn't turned the factory on;
- `intake` has no `states` and no `labels`: tickets only come in by hand (`/multirepo:implement <ticket>`).

When the dashboard is running (`node <workspace>/dashboard/bin/dashboard.mjs status` says so), prefer it: its **Pull work in** (Factory page) runs the same intake, and its runs show on the board live. Say so, and carry on here only if asked.

**Budgets:** the dashboard is what records each run's cost and time, so only it can hold the policy's `limits.itemBudgetUsd`, `dayBudgetUsd` and `itemHours`. When the policy sets any of them, don't pull work in from here: say so and point to Pull work in.

## 2. Find the tickets

From the workspace's tracker (`.claude/dashboard/workspace.json` `issues.kind`, else what's connected): a Linear MCP (`list_issues` by state and label), an Atlassian/Jira MCP (JQL `status in (...) AND labels in (...)`), or `gh issue list --label <l> --state open`. Take a ticket when:
- it's in one of the intake `states` (when any are set), **and** it has one of the intake `labels` (when any are set);
- it's **assigned to you** on the tracker (the signed-in account: Linear `assignee: me`, JQL `assignee = currentUser()`, `gh issue list --assignee @me`). With `intake.unassigned`, unassigned ones too: assign one to yourself first and read it back; if someone else has it by then, leave it. Assignment is how several people's factories avoid taking the same ticket;
- intake may take it: `node "$F" intake --ticket <ID>` says `ok` (it isn't in the factory, done or not, and was never pulled in before, by this skill or the dashboard). A ticket the factory stopped isn't retried on its own; a person decides that.

Keep the tracker's order (it's usually the team's priority). `--dry-run`: list them with why each qualifies, and stop.

## 3. Run them, under the limits

For each ticket, up to `--max` (default: as many as the WIP limit allows):
1. `node "$F" wip --ticket <ID>`: not `ok` means the WIP limit is full. Stop here and say how many are left.
2. `node "$F" intake --ticket <ID> --record` (again `ok`: nobody took it meanwhile), then run `/multirepo:implement <ID> --auto` (autonomous: the policy's gates decide; a gate that needs a person stops that ticket with a comment on it, and you move on). Each gets its own worktree.
3. One line per ticket as it finishes: where it ended (PR open, waiting at a gate, stopped and why).

Run them one at a time: a session is one agent. For several at once, use the dashboard (each Pull work in is its own run).

## 4. Hand off

Summarize: what came in, where each ticket is, what waits on a person (and where: the Factory page's Tickets view, or the PR), and what's left in the queue.

Never merge, never change the policy, and never pull a ticket the intake doesn't name.
