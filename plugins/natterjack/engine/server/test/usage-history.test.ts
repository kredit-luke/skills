import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageHistory, family, projectName } from "../src/usage-history.ts";

function line(o: object) { return JSON.stringify(o) + "\n"; }
const now = new Date().toISOString();
const msg = (id: string, model: string, out: number) => ({
  type: "assistant", timestamp: now, requestId: "req-" + id, sessionId: "s1",
  cwd: "C:\\work\\agentic-workspace\\worktrees\\ENG-9\\API",
  message: { id, model, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
});

test("indexes assistant usage, deduplicating repeated content-block lines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
  const dir = path.join(root, "C--work-agentic-workspace");
  fs.mkdirSync(dir);
  const file = path.join(dir, "s1.jsonl");
  // The CLI writes one line per content block, repeating the same usage: count once.
  fs.writeFileSync(file, line(msg("m1", "claude-opus-5", 50)) + line(msg("m1", "claude-opus-5", 50)) + line({ type: "user", timestamp: now }));
  const h = new UsageHistory(root);
  let r = await h.report(7);
  assert.equal(r.totals.requests, 1);
  assert.equal(r.totals.output, 50);
  assert.equal(r.models[0].family, "opus");
  assert.equal(r.projects[0].project, "worktrees/ENG-9");

  // Appended lines (incl. a synthetic one, skipped) are picked up incrementally.
  fs.appendFileSync(file, line(msg("m2", "claude-sonnet-5", 7)) + line(msg("m3", "<synthetic>", 999)));
  await h.refresh(true);
  r = await h.report(7);
  assert.equal(r.totals.requests, 2);
  assert.deepEqual(r.models.map((m) => m.family).sort(), ["opus", "sonnet"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("family and projectName", () => {
  assert.equal(family("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(family("gpt-x"), "other");
  assert.equal(projectName("/home/me/agentic-workspace"), "agentic-workspace");
  assert.equal(projectName("C:\\ws\\worktrees\\ENG-1\\API"), "worktrees/ENG-1");
});
