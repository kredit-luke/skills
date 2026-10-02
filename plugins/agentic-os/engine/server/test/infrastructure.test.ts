import { test } from "node:test";
import assert from "node:assert/strict";
import { quickFacts, table } from "../src/infrastructure.ts";

// One group of each kind infrastructure.json supports (rows, table, extract, kv).
const GROUPS = [
  {
    title: "Cloud",
    rows: [
      { label: "Tenant", header: "Tenant" },
      { label: "Tenant ID", regex: String.raw`tenant \(\x60([0-9a-f-]{36})\x60\)` },
      { label: "Subscription", header: "Subscription" },
      { label: "Primary region", header: "Primary Region" },
    ],
  },
  { title: "Outbound (egress) IPs", table: "Public IP Addresses", label: ["Used By", "Name"], value: "IP Address", note: "Name" },
  {
    title: "Allowed inbound",
    extract: { table: "Access Restrictions", column: "Main Site", pattern: String.raw`([^,()]+?)\s*\((\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?)\)`, noteColumn: "App" },
  },
  { title: "Databases", kv: [{ heading: "Production: shared-prod-db", label: "Production" }], value: "FQDN", note: ["Version"] },
  { title: "App Services", table: ["Production", "Staging"], label: "App", value: "Custom Domains", firstOf: true, noteFromHeading: true },
  { title: "Resource groups", table: "Resource Groups", label: "Resource Group", value: "Location", note: "Purpose" },
];

const DOC = `# Acme Cloud Environment

**Tenant:** Acme (acme.example) tenant (\`11111111-2222-3333-4444-555555555555\`)
**Subscription:** 1111-2222
**Primary Region:** East US 2

## Resource Groups

| Resource Group | Location | Purpose |
|---|---|---|
| app-prod-rg | East US | Production |

## App Services

### Production

| App | Plan | Resource Group | Custom Domains | Runtime |
|---|---|---|---|---|
| app-prod-web | p | app-prod-rg | app.example.org, app-prod.example.net | Linux |

### Staging

| App | Plan | Resource Group | Custom Domains | Runtime |
|---|---|---|---|---|
| app-staging-web | p | app-staging-rg | app-staging.example.org | Linux |

## PostgreSQL Flexible Servers

### Production: shared-prod-db

| Property | Value |
|---|---|
| FQDN | prod.postgres.example |
| Version | PostgreSQL 17 |

### Access Restrictions

| App | Main Site | SCM Site |
|---|---|---|
| svc-prod-web | CI runners (203.0.113.0/28), deny all | Same |
| app-prod-web | Cloudflare IPs, CI runners (203.0.113.0/28), deny all | Open |

### Public IP Addresses

| Name | Resource Group | IP Address | SKU | Used By |
|---|---|---|---|---|
| nat-pip-prod | app-prod-rg | 198.51.100.7 | Standard | natgw-prod |
`;

test("table() reads the first pipe table under an exact heading", () => {
  const rows = table(DOC, "Public IP Addresses");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["IP Address"], "198.51.100.7");
  assert.deepEqual(table(DOC, "No Such Heading"), []);
});

test("quickFacts() builds the groups people look up", () => {
  const groups = Object.fromEntries(quickFacts(DOC, GROUPS).map((g) => [g.title, g.rows]));
  assert.equal(groups["Cloud"].find((r) => r.label === "Subscription")!.value, "1111-2222");
  assert.equal(groups["Cloud"].find((r) => r.label === "Tenant ID")!.value, "11111111-2222-3333-4444-555555555555");
  assert.equal(groups["Outbound (egress) IPs"][0].value, "198.51.100.7");
  assert.equal(groups["Outbound (egress) IPs"][0].label, "natgw-prod");
  assert.equal(groups["Databases"][0].value, "prod.postgres.example");
  assert.deepEqual(groups["App Services"].map((r) => r.value), ["app.example.org", "app-staging.example.org"]);
  assert.equal(groups["Resource groups"][0].label, "app-prod-rg");
  assert.deepEqual(groups["Allowed inbound"], [
    { label: "CI runners", value: "203.0.113.0/28", note: "svc-prod-web, app-prod-web" },
  ]);
});

test("quickFacts() on a doc without the tables is just empty", () => {
  assert.deepEqual(quickFacts("# Nothing here", GROUPS), []);
});

test("quickFacts() with no groups configured is empty (the page just shows the doc)", () => {
  assert.deepEqual(quickFacts(DOC, []), []);
});
