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

/**
 * A CLI's output without the warnings Python prints ahead of the real error: az on a 32-bit
 * Python says "backend.py:8: UserWarning: You are using cryptography on a 32-bit Python..."
 * on every call. Python's format is `<file>.py:<line>: <Category>Warning: <message>`,
 * sometimes followed by the indented source line.
 */
export function withoutWarnings(text: string): string[] {
  const out: string[] = [];
  let skipSource = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*\.py:\d+: [A-Za-z]*Warning: /.test(line)) { skipSource = true; continue; }
    if (skipSource && /^\s+\S/.test(line)) { skipSource = false; continue; }
    skipSource = false;
    if (line.trim()) out.push(line);
  }
  return out;
}

/** A failed command as one readable error, naming the fix when we know it. */
export function cliError(what: string, r: CliResult, fix?: string): Error {
  const lines = withoutWarnings(r.stderr);
  const detail = (lines.length ? lines : withoutWarnings(r.stdout)).slice(-3).join(" ").trim().slice(0, 400);
  return Object.assign(new Error(`${what}: ${detail || `exit ${r.code}`}${fix ? ` (${fix})` : ""}`), { status: 502, fix });
}

/** A failure the network caused (the connection dropped mid-call), not the command: worth one more try. */
export function transientFailure(r: CliResult): boolean {
  return !r.ok && /ConnectionResetError|Connection aborted|connection reset|ECONNRESET|RemoteDisconnected|Connection broken|unexpected EOF|EOF occurred in violation of protocol|TLS handshake timeout/i.test(`${r.stderr}\n${r.stdout}`);
}

/** Run a read-only command, trying once more if the network dropped the first attempt. Never for writes. */
export async function runReading(run: Runner, name: string, args: string[], opts?: { input?: string; timeout?: number }): Promise<CliResult> {
  const r = await run(name, args, opts);
  return transientFailure(r) ? run(name, args, opts) : r;
}

export function parseJson(text: string, what: string): any {
  try { return JSON.parse(text); } catch { throw new Error(`${what} didn't return JSON.`); }
}

/** Several JSON documents one after another, as `kubectl create -o json` prints a multi-object file. */
export function parseJsonStream(text: string, what: string): any[] {
  const docs: any[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"' && depth > 0) inString = true;   // a top-level string isn't a document: it's rejected below
    else if (c === "{" || c === "[") { if (depth++ === 0) start = i; }
    else if (c === "}" || c === "]") { if (--depth === 0) docs.push(parseJson(text.slice(start, i + 1), what)); }
    else if (depth === 0 && !/\s/.test(c)) throw new Error(`${what} didn't return JSON.`);
  }
  if (depth !== 0 || !docs.length) throw new Error(`${what} didn't return JSON.`);
  return docs;
}
