// A run's outputs folder: made before each turn and named in the agent's rules, add-dirs and
// environment; listed for the run page; served only from inside it (no traversal, no symlink
// out), PDFs and images inline and everything else (HTML and SVG included) as a download.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, drainable } from "../src/runs.ts";
import { Attachments, MAX_OUTPUTS, outputHeaders } from "../src/attachments.ts";
import { agentOf } from "../src/agents/index.ts";
import type { RunMeta } from "../../shared/api.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dash-run-outputs-"));
const LOG = path.join(TMP, "turns.log");
// Records the outputs folder it was given and writes a report there, like a script would.
const FAKE = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.DASHBOARD_OUTPUTS || null;
if (dir) fs.writeFileSync(path.join(dir, "report.pdf"), "%PDF-1.4");
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ outputs: dir }) + "\\n");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, num_turns: 1 }));
`;

before(() => {
  const bin = path.join(TMP, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fake-claude.mjs"), FAKE);
  const file = process.platform === "win32" ? path.join(bin, "claude.cmd") : path.join(bin, "claude");
  if (process.platform === "win32") fs.writeFileSync(file, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
  process.env.DASHBOARD_CLAUDE_BIN = file;
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function settled(runs: RunManager, id: string, ms = 15000): Promise<RunMeta> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const m = runs.get(id);
      if (m && !runs.live.has(id) && m.status === "succeeded" && !drainable(m)) return resolve(m);
      if (Date.now() > end) return reject(new Error(`run ${id} still ${m && m.status}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const tmp = () => fs.mkdtempSync(path.join(TMP, "store-"));
const RUN = "20260101000000-abcdef";

/** A folder link that needs no admin rights on Windows (a junction); false where links can't be made. */
function linkDir(target: string, at: string): boolean {
  try { fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir"); return true; } catch { return false; }
}

test("each turn gets the outputs folder: in its rules, its add-dirs and DASHBOARD_OUTPUTS; a file it writes there is listed", async () => {
  const claude = agentOf("claude");
  const built: string[][] = [];
  const turnArgs = claude.turnArgs.bind(claude);
  claude.turnArgs = (t) => { const a = turnArgs(t); built.push(a); return a; };
  const ledger = path.join(TMP, "ledger");
  const attachments = new Attachments(ledger);
  const runs = new RunManager(ledger, { attachments });
  try {
    const run = runs.start({ prompt: "make the report", cwd: TMP, agent: "claude" });
    await settled(runs, run.id);
    const dir = attachments.outputsDir(run.id);
    assert.ok(fs.statSync(dir).isDirectory(), "made before the turn");

    const val = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
    const [args] = built;
    assert.ok(val(args, "--append-system-prompt")!.includes(`go in ${dir}`), "the rule names the folder");
    const addDirs = args.flatMap((a, i) => (args[i - 1] === "--add-dir" ? [a] : []));
    assert.ok(addDirs.some((d) => dir.startsWith(d)), `an --add-dir covers ${dir}: ${addDirs.join(", ")}`);

    const [turn] = fs.readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(turn.outputs, dir, "DASHBOARD_OUTPUTS reaches the agent's process");
    assert.deepEqual(attachments.outputs(run.id).map((o) => [o.name, o.size]), [["report.pdf", 8]]);
    assert.equal(attachments.output(run.id, "report.pdf"), fs.realpathSync(path.join(dir, "report.pdf")));
  } finally {
    claude.turnArgs = turnArgs;
  }
});

test("a spawn that throws (a command line over Windows' limit) fails the run instead of leaving it running", () => {
  const claude = agentOf("claude");
  const spawn = claude.spawn;
  claude.spawn = () => { throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" }); };
  const ledger = path.join(TMP, "ledger-spawn");
  const finished: string[] = [];
  const runs = new RunManager(ledger, { attachments: new Attachments(ledger), onFinish: (m) => finished.push(m.status) });
  try {
    const run = runs.start({ prompt: "too long", cwd: TMP, agent: "claude" });
    const saved = runs.get(run.id)!;
    assert.equal(saved.status, "failed");
    assert.match(saved.error || "", /Could not start Claude: spawn ENAMETOOLONG/);
    assert.ok(saved.endedAt);
    assert.equal(runs.live.has(run.id), false);
    assert.deepEqual(finished, ["failed"]);
  } finally {
    claude.spawn = spawn;
  }
});

test("outputs lists files by path inside the folder, newest first, without dotfiles, links or more than the cap", () => {
  const a = new Attachments(tmp());
  const dir = a.ensureOutputs(RUN);
  fs.mkdirSync(path.join(dir, "charts", "q3"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".cache"));
  fs.writeFileSync(path.join(dir, "summary.csv"), "a,b");
  fs.writeFileSync(path.join(dir, "charts", "q3", "sales.png"), "png");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
  fs.writeFileSync(path.join(dir, ".cache", "hidden.txt"), "x");
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(dir, "summary.csv"), old, old);
  const outside = fs.mkdtempSync(path.join(TMP, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  linkDir(outside, path.join(dir, "elsewhere"));

  const list = a.outputs(RUN);
  assert.deepEqual(list.map((o) => o.name), ["charts/q3/sales.png", "summary.csv"]);
  assert.equal(list[1].size, 3);
  assert.ok(!Number.isNaN(Date.parse(list[0].modifiedAt)));
  assert.deepEqual(a.outputs("no-such-run"), []);
  assert.deepEqual(a.outputs("../x"), []);

  const many = a.ensureOutputs("20260101000000-many00");
  const hourAgo = new Date(Date.now() - 3600_000);
  for (let i = 0; i < MAX_OUTPUTS + 5; i++) { const f = path.join(many, `f${String(i).padStart(3, "0")}.txt`); fs.writeFileSync(f, "x"); fs.utimesSync(f, hourAgo, hourAgo); }
  fs.writeFileSync(path.join(many, "zz-newest.pdf"), "x"); // sorts last by name, first by date
  const capped = a.outputs("20260101000000-many00");
  assert.equal(capped.length, MAX_OUTPUTS);
  assert.equal(capped[0].name, "zz-newest.pdf", "the cap keeps the newest, not the first by name");
});

test("output only resolves files inside the folder: no traversal, absolute paths, dotfiles, folders or links out", () => {
  const a = new Attachments(tmp());
  const dir = a.ensureOutputs(RUN);
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "a");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(a.runDir(RUN), "0123456789ab-upload.txt"), "u"); // an attachment, one level up
  const outside = fs.mkdtempSync(path.join(TMP, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");

  const subA = fs.realpathSync(path.join(dir, "sub", "a.txt"));
  assert.equal(a.output(RUN, "sub/a.txt"), subA);
  assert.equal(a.output(RUN, "sub\\a.txt"), subA);
  for (const bad of ["../0123456789ab-upload.txt", "sub/../../0123456789ab-upload.txt", "..\\0123456789ab-upload.txt",
    path.join(outside, "secret.txt"), "/etc/passwd", "C:/Windows/win.ini", ".env", "sub", "", "missing.txt", "sub//a.txt", "a\0b"]) {
    assert.equal(a.output(RUN, bad), null, JSON.stringify(bad));
  }
  assert.equal(a.output("../" + RUN, "sub/a.txt"), null);

  if (linkDir(outside, path.join(dir, "elsewhere"))) {
    assert.equal(a.output(RUN, "elsewhere/secret.txt"), null, "a folder link out of the folder");
  }
  let fileLink = false;
  try { fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "secret.txt"), "file"); fileLink = true; } catch { /* Windows without symlink rights */ }
  if (fileLink) assert.equal(a.output(RUN, "secret.txt"), null, "a file symlink out of the folder");
});

test("a link in place of the outputs folder (or the run's folder) is never followed, and the next turn replaces it", () => {
  const a = new Attachments(tmp());
  const outside = fs.mkdtempSync(path.join(TMP, "outside-root-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");

  const run = "20260101000000-link00";
  fs.mkdirSync(a.runDir(run), { recursive: true });
  if (!linkDir(outside, a.outputsDir(run))) return; // no folder links here
  assert.equal(a.output(run, "secret.txt"), null, "the outputs folder is a link");
  assert.deepEqual(a.outputs(run), []);
  const dir = a.ensureOutputs(run);
  assert.ok(!fs.lstatSync(dir).isSymbolicLink(), "ensureOutputs makes a real folder again");
  assert.ok(fs.existsSync(path.join(outside, "secret.txt")), "and leaves what the link pointed to alone");
  assert.deepEqual(a.outputs(run), []);

  const run2 = "20260101000000-link01";
  fs.mkdirSync(path.join(outside, "outputs"));
  fs.writeFileSync(path.join(outside, "outputs", "secret.txt"), "s");
  linkDir(outside, a.runDir(run2));
  assert.equal(a.output(run2, "secret.txt"), null, "the run's folder is a link");
  assert.deepEqual(a.outputs(run2), []);
});

test("outputHeaders: PDFs and images inline, HTML, SVG and the rest as downloads, never sniffed", () => {
  const h = (n: string) => outputHeaders(n, 10);
  assert.match(String(h("report.pdf")["Content-Disposition"]), /^inline; filename="report\.pdf"/);
  assert.equal(h("report.pdf")["Content-Type"], "application/pdf");
  assert.match(String(h("chart.png")["Content-Disposition"]), /^inline;/);
  for (const n of ["page.html", "logo.svg", "data.csv", "book.xlsx", "notes.txt"]) {
    assert.match(String(h(n)["Content-Disposition"]), /^attachment;/, n);
    assert.ok(!/html|svg/.test(String(h(n)["Content-Type"])), `${n} is never served as a page`);
  }
  assert.equal(h("page.html")["X-Content-Type-Options"], "nosniff");
  assert.equal(h("x.pdf")["Content-Length"], 10);
  // Header values must stay Latin-1; the real name rides in filename*.
  const name = "Résumé \"final\" ✓.pdf";
  const cd = String(h(name)["Content-Disposition"]);
  assert.match(cd, /filename="R_sum_ _final_ _\.pdf"/);
  assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent(name)}`));
});
