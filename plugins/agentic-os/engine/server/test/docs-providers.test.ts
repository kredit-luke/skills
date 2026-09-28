// Docs providers: the Confluence adapter's pure parts (CQL, excerpts, links, hits), where its key
// comes from (own key, env, or the same-site Jira key), the run note, and the provider registry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfluenceProvider, absolutizeLinks, buildCql, parseExcerpt, toHit } from "../src/docs-providers/confluence.ts";
import { DocsProviders } from "../src/docs-providers/index.ts";

const LEDGER = fs.mkdtempSync(path.join(os.tmpdir(), "dash-docsprov-"));
after(() => fs.rmSync(LEDGER, { recursive: true, force: true }));
for (const k of ["CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];

const source = { key: "wiki", name: "Confluence", kind: "external" as const, provider: "confluence", url: "https://acme.atlassian.net/wiki", spaces: ["ENG", "bad key!"] };
const ctx = (issues = { kind: "none" as string, site: null as string | null }) => ({ ledgerDir: LEDGER, issues });

test("buildCql: pages, the query quoted, spaces filtered to valid keys, recent first with no query", () => {
  assert.equal(buildCql('say "hi" \\ there', ["ENG", "OPS"]), 'type = page AND siteSearch ~ "say \\"hi\\" \\\\ there" AND space IN ("ENG", "OPS")');
  assert.equal(buildCql("", ["ENG", "no spaces!"]), 'type = page AND space IN ("ENG") ORDER BY lastmodified DESC');
  assert.equal(buildCql("x", [], "text"), 'type = page AND text ~ "x"');
});

test("parseExcerpt splits Confluence's highlight markers and decodes entities", () => {
  assert.deepEqual(parseExcerpt("Pay @@@hl@@@escrow@@@endhl@@@ &amp; more\n\nlines"), [
    { text: "Pay ", hl: false }, { text: "escrow", hl: true }, { text: " & more lines", hl: false },
  ]);
  assert.deepEqual(parseExcerpt(""), []);
  assert.deepEqual(parseExcerpt(null), []);
});

test("absolutizeLinks points site-relative links and images at the site, leaving others alone", () => {
  const html = '<a href="/wiki/spaces/ENG/pages/1">p</a><img src="/wiki/download/x.png"><a href="//cdn.x/y">c</a><a href="https://e.com">e</a>';
  assert.equal(absolutizeLinks(html, "https://acme.atlassian.net"),
    '<a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/1">p</a><img src="https://acme.atlassian.net/wiki/download/x.png"><a href="//cdn.x/y">c</a><a href="https://e.com">e</a>');
});

test("toHit maps a search result; non-page results are dropped", () => {
  const hit = toHit({
    content: { id: 42, title: "@@@hl@@@Escrow@@@endhl@@@ flow", _links: { webui: "/spaces/ENG/pages/42" } },
    resultGlobalContainer: { title: "Engineering", displayUrl: "/spaces/ENG" },
    excerpt: "the @@@hl@@@escrow@@@endhl@@@ flow", lastModified: "2026-09-01T00:00:00Z",
  }, "https://acme.atlassian.net/wiki");
  assert.deepEqual(hit, {
    id: "42", title: "Escrow flow", space: "ENG", spaceName: "Engineering",
    url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/42",
    excerpt: [{ text: "the ", hl: false }, { text: "escrow", hl: true }, { text: " flow", hl: false }],
    updatedAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(toHit({ title: "a space" }, "x"), null);
});

test("key lookup: its own env vars, then its pasted key, then Jira's key only for the same site", () => {
  const p = new ConfluenceProvider(source, ctx());
  assert.equal(p.site, "acme.atlassian.net");
  assert.deepEqual(p.spaceFilter, ["ENG"]);
  assert.deepEqual(p.status(), { connected: false, source: null, viewer: null });

  // Jira on the same site: its key is used.
  fs.writeFileSync(path.join(LEDGER, "jira-api-token"), "me@acme.com:jira-token-123");
  const same = new ConfluenceProvider(source, ctx({ kind: "jira", site: "https://acme.atlassian.net/" }));
  assert.equal(same.status().source, "tracker");
  assert.equal(same._cred()!.cred, "me@acme.com:jira-token-123");
  // Jira on another site: not used.
  assert.equal(new ConfluenceProvider(source, ctx({ kind: "jira", site: "other.atlassian.net" })).status().connected, false);

  // A pasted Confluence key wins over the tracker's; env vars win over both.
  fs.writeFileSync(path.join(LEDGER, "confluence-api-token"), "me@acme.com:wiki-token-456");
  assert.equal(same._cred()!.source, "file");
  process.env.CONFLUENCE_EMAIL = "env@acme.com";
  process.env.CONFLUENCE_API_TOKEN = "env-token-789";
  try { assert.deepEqual(same._cred(), { cred: "env@acme.com:env-token-789", source: "env" }); }
  finally { delete process.env.CONFLUENCE_EMAIL; delete process.env.CONFLUENCE_API_TOKEN; }

  same.disconnect();
  assert.equal(fs.existsSync(path.join(LEDGER, "confluence-api-token")), false);
  assert.equal(same._cred()!.source, "tracker", "disconnect drops only its own key");
});

test("connect rejects a key that isn't email:token before calling anything", async () => {
  const p = new ConfluenceProvider(source, ctx());
  await assert.rejects(() => p.connect("just-a-token"), /your-email:api-token/);
});

test("the run note names the site, the spaces and the page", () => {
  const note = new ConfluenceProvider(source, ctx()).runNote("123");
  assert.match(note, /https:\/\/acme\.atlassian\.net\/wiki \(spaces ENG\)/);
  assert.match(note, /cloudId acme\.atlassian\.net/);
  assert.match(note, /page 123: read it first/);
  assert.doesNotMatch(new ConfluenceProvider(source, ctx()).runNote("../x"), /read it first/);
});

test("the registry: external sources with a known provider only; one instance until the config changes", () => {
  let issues = { kind: "none", site: null as string | null };
  const reg = new DocsProviders(() => ({ ledgerDir: LEDGER, issues }));
  assert.equal(reg.get({ ...source, kind: "notes" as any }), null);
  assert.equal(reg.get({ ...source, provider: "notion" }), null);
  assert.equal(reg.get(null), null);
  const a = reg.get(source);
  assert.ok(a instanceof ConfluenceProvider);
  assert.equal(reg.get(source), a);
  issues = { kind: "jira", site: "acme.atlassian.net" };
  assert.notEqual(reg.get(source), a, "a config change makes a fresh provider");
});
