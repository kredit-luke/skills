import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateCheck, newer, parseVersionFile, updateCheckAllowed } from "../src/update-check.ts";
import { webManifest } from "../src/pwa.ts";

const answering = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("newer compares x.y.z numerically", () => {
  assert.equal(newer("0.22.0", "0.21.1"), true);
  assert.equal(newer("0.21.10", "0.21.9"), true);
  assert.equal(newer("1.0.0", "0.99.99"), true);
  assert.equal(newer("0.21.1", "0.21.1"), false);
  assert.equal(newer("0.21.0", "0.21.1"), false);
});

test("parseVersionFile takes a plain x.y.z and only an https notes link", () => {
  assert.deepEqual(parseVersionFile({ version: "0.22.0", notes: "https://asknatterjack.com/#releases" }), { version: "0.22.0", notes: "https://asknatterjack.com/#releases" });
  assert.deepEqual(parseVersionFile({ version: "0.22.0", notes: "javascript:alert(1)" }), { version: "0.22.0", notes: null });
  assert.equal(parseVersionFile({ version: "0.22.0-beta" }), null);
  assert.equal(parseVersionFile({ version: 22 }), null);
  assert.equal(parseVersionFile(null), null);
});

test("NATTERJACK_UPDATE_CHECK=0 turns the check off", () => {
  assert.equal(updateCheckAllowed({}), true);
  assert.equal(updateCheckAllowed({ NATTERJACK_UPDATE_CHECK: "0" }), false);
  assert.equal(updateCheckAllowed({ NATTERJACK_UPDATE_CHECK: "off" }), false);
  assert.equal(updateCheckAllowed({ NATTERJACK_UPDATE_CHECK: "1" }), true);
});

test("UpdateCheck reports a newer release, and keeps the last answer through a failed check", async () => {
  let fetchImpl = answering({ version: "0.22.0" });
  const check = new UpdateCheck({ current: "0.21.1", enabled: () => true, fetch: ((...a: Parameters<typeof fetch>) => fetchImpl(...a)) as typeof fetch });
  assert.equal(check.info().latest, null);
  await check.check();
  assert.equal(check.info().available, true);
  assert.equal(check.info().latest, "0.22.0");
  fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  await check.check();
  assert.equal(check.info().latest, "0.22.0");
  fetchImpl = answering({ nope: true });
  await check.check();
  assert.equal(check.info().latest, "0.22.0");
});

test("UpdateCheck says nothing is available when it's current, and doesn't fetch when off", async () => {
  const current = new UpdateCheck({ current: "0.22.0", enabled: () => true, fetch: answering({ version: "0.22.0" }) });
  await current.check();
  assert.equal(current.info().available, false);

  let calls = 0;
  const off = new UpdateCheck({ current: "0.21.1", enabled: () => false, fetch: (async () => { calls++; return { ok: true, json: async () => ({ version: "9.9.9" }) }; }) as unknown as typeof fetch });
  await off.check();
  assert.equal(calls, 0);
  assert.deepEqual({ enabled: off.info().enabled, available: off.info().available }, { enabled: false, available: false });
});

test("webManifest uses the team's name, colors and icons, with the neutral defaults behind them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-pwa-"));
  try {
    const brand = path.join(dir, "brand"), defaults = path.join(dir, "ds");
    fs.mkdirSync(brand); fs.mkdirSync(defaults);
    fs.writeFileSync(path.join(defaults, "tokens.css"), ":root { --paper: #F8FAFC; --brand-900: #1E1B4B; }");
    const neutral = webManifest({ title: "Workspace Dashboard", name: "acme", favicon: null, brandDir: brand, defaultsDir: defaults });
    assert.equal(neutral.name, "acme dashboard");
    assert.equal(neutral.short_name, "acme");
    assert.equal(neutral.display, "standalone");
    assert.equal(neutral.theme_color, "#1E1B4B");
    assert.deepEqual(neutral.icons.map((i) => i.src), ["/ds/icon-192.png", "/ds/icon-512.png"]);

    fs.writeFileSync(path.join(brand, "theme.css"), ":root {\n  --brand-900:     #1E2A16;\n}");
    fs.writeFileSync(path.join(brand, "favicon.svg"), "<svg/>");
    const branded = webManifest({ title: "Acme Engineering", name: "acme", favicon: "favicon.svg", brandDir: brand, defaultsDir: defaults });
    assert.equal(branded.name, "Acme Engineering");
    assert.equal(branded.theme_color, "#1E2A16");
    assert.equal(branded.background_color, "#F8FAFC");
    assert.deepEqual(branded.icons.map((i) => i.src), ["/ds/favicon.svg", "/ds/icon-192.png", "/ds/icon-512.png"]);

    fs.writeFileSync(path.join(brand, "icon-192.png"), "");
    fs.writeFileSync(path.join(brand, "icon-512.png"), "");
    const ownPngs = webManifest({ title: "Acme Engineering", name: "acme", favicon: "favicon.svg", brandDir: brand, defaultsDir: defaults });
    assert.deepEqual(ownPngs.icons.map((i) => i.src), ["/ds/icon-192.png", "/ds/icon-512.png"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
