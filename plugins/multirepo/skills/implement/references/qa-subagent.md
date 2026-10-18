# QA subagent

Read this when the pipeline reaches QA. It applies only when the workspace defines a browser QA agent (a `.claude/agents/*.md` whose description says it drives a browser, or one CLAUDE.md names) and the ticket changed a UI.

Frontend changes routinely look right in the diff and break in the browser: an unbound field after a client regeneration, broken navigation, console errors no build sees. A QA agent catches these by running the app.

## Skip it when

- No UI changed.
- CLAUDE.md says the agent can't get past an app's login (SSO it can't complete): it would spend a whole run failing at the sign-in page. Say why in the summary.
- Interactive and the user declines (ask first: browser snapshots are token-heavy).

## Before you spawn it

The QA agent tests; it doesn't stand up infrastructure. Start the stack yourself from WORKROOT with the workspace's run tooling (`--root <WORKROOT>`), then confirm by port and an HTTP 200, not by watching stdout.

**In a worktree the ports aren't the defaults.** Use `--resolve`'s `ports`. Pointing the agent at the main workspace's app produces a passing run for code you didn't change, which looks exactly like success.

## Prompt

Derive it from the acceptance criteria and what the frontend stage built:

```
QA test the <app> changes for <TICKET>.

The app under test is at http://localhost:<port from --resolve>.
<how to sign in, from CLAUDE.md or the agent's own docs; which role, by default one with full access>
Save screenshots under <WORKROOT>/<screenshots folder if CLAUDE.md names one>.

## Failure protocol
If a step doesn't produce the expected result, retry it ONCE. If it still fails, STOP:
no workarounds, no wandering. Report what failed, what you expected, what you saw
(screenshot, console, network), and wait.

## What changed
<routes and components from the frontend stage's report>

## Test plan
1. **<flow>**
   - Go to <route>, <interaction>
   - Verify: <expected state>
   - Screenshot: <name>.png

## Regression checks
- <adjacent feature> still works
- <existing page> loads without console errors
- No 4xx/5xx from <related endpoints>

## Acceptance criteria coverage
- [ ] <criterion> -> flow 1

End with QA PASSED or QA BLOCKED, with evidence.
```

## Reading the result

A "everything passed" with no screenshots or specific observations usually means the agent never reached the feature: check the port and that it got past sign-in before counting it.

- **PASSED**: note it for the summary.
- **BLOCKED**: show the report. Interactive: ask **Fix and re-run QA** / **Proceed anyway**; fixes go to the owning implementer, then QA again. Autonomous: route the fix once; if still blocked, record it on the ticket and in the PR description.
