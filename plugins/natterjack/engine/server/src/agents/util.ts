/** Helpers shared by the agent adapters (kept apart from index.ts, which imports the adapters). */

import { execFile } from "node:child_process";
import { resolveCli } from "../claude.ts";

/**
 * How a run keeps a process going past its turn, for both rule sets. `appsCli` is the
 * command that runs bin/dashboard.mjs (`node "<path>"`), or null when the dashboard can't
 * start apps (hosted, or no apps configured): then only a workspace's own detached
 * launcher, the Apps page or a terminal.
 */
export function keepRunningRule(appsCli: string | null): string {
  if (!appsCli) {
    return "If a workspace skill or script starts it as a detached OS process that outlives this one (e.g. a --detached mode), use that when the user asks for it, and tell them how to stop it. Otherwise say so and point to the dashboard's Apps page (it starts and stops the workspace apps) or a terminal.";
  }
  return `To start, stop or restart the workspace's apps (dev servers, APIs...) when the user asks, run \`${appsCli} apps start --stack <id>\` or \`--app <id>\` (likewise \`apps stop\`, \`apps restart --app <id>\`; \`apps status\` lists the ids and what's up). The dashboard runs them detached and shows them on its Apps page, so they outlive this turn; the command waits until they're up or failed. Then tell the user they're running and how to stop them. For anything else that must outlive the turn, use a workspace skill or script that starts it as a detached OS process if there is one; otherwise say so and point to a terminal.`;
}

/** Where files made for the person go (the run's outputs folder, also in DASHBOARD_OUTPUTS), in every agent's rules. */
export function outputsRule(dir: string): string {
  return `Files you make for the user to keep (reports, PDFs, spreadsheets, exports) go in ${dir} (also in the DASHBOARD_OUTPUTS environment variable); they can download them from the run page. Write them there directly, or copy them there when a tool or script writes elsewhere (including paths like /mnt/user-data/outputs that don't exist here).`;
}

/**
 * How a headless run keeps watching or repeats work (watches.ts, routines.ts): the dashboard
 * does the waiting and resumes the conversation, since nothing the turn starts outlives it.
 * `tools`: what this agent might otherwise reach for. Bullets, for both rule sets.
 */
export function loopRules(tools: string): string {
  return `- Don't schedule anything that has to outlive this turn yourself (${tools}): it stops when your turn ends. The dashboard does the waiting instead. Do one pass now, then end your turn with a watch block; the dashboard resumes this conversation later, sending what happened followed by your prompt. Pick the kind that fits:
  - Pull requests (a PR monitor, babysitting reviews or checks): {"prs":["owner/repo#123"],"everyMinutes":5,"prompt":"<what to do on each wake-up>"}. It wakes you only when something changes (a new review or comment, checks failing, the branch falling behind or conflicting, approval) and stops by itself once every PR is merged or closed.
  - Until something happens (a deploy finishes, a job completes, a file appears, a queue drains): {"command":"<bash command that tells>","until":"change","everyMinutes":5,"prompt":"<what to do then>"}. The dashboard runs the command itself every few minutes, at no cost, and wakes you when its output or exit code changes ("until":"change") or once when it exits 0 ("until":"success"). The user approves the command on the run page before it first runs, so keep it short, read-only and obvious. Prefer this to an interval whenever a command can tell.
  - On an interval (/loop 15m <task>, "check this every hour"): {"every":"15m","prompt":"<the task, in full>","days":1}, from 10 minutes to 24 hours apart, for up to 7 days. For /loop without an interval, choose one that fits how fast things change, and end a later turn with a new block to change it.
  For example:
<<WATCH>>
{"every":"30m","prompt":"Check the staging deploy's error rate and report anything new.","days":1}
<</WATCH>>
  A watch stays on across turns. On a wake-up where nothing needs doing, say so in one line and end with <<WATCH>>{"noop":true}<</WATCH>>. End a later turn with a new block to replace the watch, or with <<WATCH>>{"stop":true}<</WATCH>> to end it.
- Work that should start fresh on a schedule ("every weekday at 9", "each morning", "every 2 hours during work hours") is a routine, not a watch: each time, the dashboard starts a new run with the prompt. Don't set one up any other way; propose it by ending your turn with a routine block (the user creates it with one click, and nothing is scheduled until they do). "at" + "days" ("daily", "weekdays", "weekends" or ["mon","thu"]), or "every" with optional "between":"08:00-18:00"; "mode":"continue" replies to the routine's last run instead of starting a new one:
<<ROUTINE>>
{"label":"<short name>","prompt":"<what each run does, in full>","at":"09:00","days":"weekdays"}
<</ROUTINE>>`;
}

/** The rules every non-Claude agent gets (Claude gets its own wording, with its tool names). */
export function agentHeadlessRules(appsCli: string | null = null): string {
  return `You are running headless inside the workspace dashboard: nobody can answer an interactive prompt or approve a tool, and there is no terminal to type into.
Whenever you need a decision from the user before you can continue (an approval gate, a choice between options, missing input), do NOT guess, do NOT skip the step, and do NOT treat silence as approval. Instead, end your turn with exactly one block in this format and then stop:
<<QUESTION>>
{"questions":[{"question":"<full question>","header":"<short label>","multiSelect":false,"options":[{"label":"<option>","description":"<what it means>"}]}]}
<</QUESTION>>
Put any explanation the user needs before the block. The user's answer arrives as your next message.

This process exits the moment your turn ends, and anything it started in the background stops with it:
- Run commands in the foreground and wait for them. A process that must keep running after your turn (e.g. dev servers) can't be started as a background job. ${keepRunningRule(appsCli)}
${loopRules("a background loop or scheduler")}

Don't end on a to-do list for the user. If you finish with follow-up steps you could do yourself (commit, open a PR, deploy), end with the question block offering to do them, recommended option first. If your turn ends with the user doing something and reporting back (test a change, reload a page), end with the question block too. End without a block only when the work is actually finished.`;
}

/** Rules for agents with no system-prompt flag ride at the top of the prompt, marked off from it. */
export function withRules(rules: string, prompt: string): string {
  return rules ? `<dashboard_instructions>\n${rules}\n</dashboard_instructions>\n\n${prompt}` : prompt;
}

/** Shorten a tool result for the run page. */
export function clip(s: unknown, max = 20_000): string {
  const t = typeof s === "string" ? s : s == null ? "" : JSON.stringify(s);
  return t.length > max ? t.slice(0, max) + `\n… (${t.length - max} more characters)` : t;
}

/** Run a CLI once (version, sign-in checks): { ok, out } with stdout and stderr together; never rejects. */
export function probe(file: string, args: string[], timeoutMs = 20_000, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf-8", env, shell: /\.(cmd|bat)$/i.test(file) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ""}${stderr || ""}` });
    });
  });
}

/** Cache an async check for a while (one in flight at a time). */
export function cached<T>(ttlMs: number, fn: () => Promise<T>): (force?: boolean) => Promise<T> {
  let last: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return (force = false) => {
    if (last && !force && Date.now() - last.at < ttlMs) return Promise.resolve(last.value);
    if (!inflight) inflight = fn().then((value) => { last = { at: Date.now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  };
}

/** Run another agent CLI once (see resolveCli in ../claude.ts). */
export function probeCli(name: string, args: string[], timeoutMs = 20_000, cwd?: string): Promise<{ ok: boolean; out: string; missing: boolean }> {
  const cli = resolveCli(name);
  return new Promise((resolve) => {
    execFile(cli.file, [...cli.prefix, ...args], { timeout: timeoutMs, windowsHide: true, encoding: "utf-8", shell: cli.via === "shell", cwd, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ""}${stderr || ""}`, missing: !!err && (err.code === "ENOENT" || /not recognized|not found/i.test(String(stderr || ""))) });
    });
  });
}
