/**
 * The People page does everything through CLIs the engineer already has and is signed in
 * to (kubectl, gcloud, az, aws): Natterjack holds no cloud or directory credentials of
 * its own. One runner for all of them, injectable so tests can fake every command.
 */

import { spawnCli } from "../claude.ts";

export interface CliResult { ok: boolean; code: number | string | null; stdout: string; stderr: string }
export type Runner = (name: string, args: string[], opts?: { input?: string; timeout?: number }) => Promise<CliResult>;

/** Run a CLI without a shell where possible (Windows .cmd shims via claude.ts's spawnCli). */
export const runCli: Runner = (name, args, opts = {}) => new Promise((resolve) => {
  let stdout = "", stderr = "", settled = false;
  const done = (r: CliResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
  let child: ReturnType<typeof spawnCli>;
  try {
    child = spawnCli(name, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return resolve({ ok: false, code: (e as NodeJS.ErrnoException).code || "ENOENT", stdout: "", stderr: (e as Error).message });
  }
  const timer = setTimeout(() => { child.kill(); done({ ok: false, code: "ETIMEDOUT", stdout, stderr: stderr || `${name} took too long.` }); }, opts.timeout || 60_000);
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  child.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, code: e.code || "ENOENT", stdout, stderr: e.message }));
  child.on("close", (code) => done({ ok: code === 0, code, stdout, stderr }));
  child.stdin!.on("error", () => {});
  child.stdin!.end(opts.input ?? "");
});

/** A CLI that isn't installed (or, on Windows, a shim cmd.exe couldn't find). */
export function notInstalled(r: CliResult): boolean {
  return r.code === "ENOENT" || /is not recognized as an internal or external command|command not found/i.test(r.stderr);
}

/** A failed command as one readable error, naming the fix when we know it. */
export function cliError(what: string, r: CliResult, fix?: string): Error {
  const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);
  return Object.assign(new Error(`${what}: ${detail || `exit ${r.code}`}${fix ? ` (${fix})` : ""}`), { status: 502, fix });
}

export function parseJson(text: string, what: string): any {
  try { return JSON.parse(text); } catch { throw new Error(`${what} didn't return JSON.`); }
}
