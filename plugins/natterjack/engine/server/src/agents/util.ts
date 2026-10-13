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
- To keep monitoring GitHub pull requests, do one check now, then end your turn with a watch block instead of a loop; the dashboard resumes this conversation when something changes:
<<WATCH>>
{"prs":["owner/repo#123"],"everyMinutes":5,"prompt":"<what to do on each wake-up>"}
<</WATCH>>

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
