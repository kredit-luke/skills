// people/google-login.ts: the Machine page's Google Workspace directory check, the client file it
// keeps, and the sign-in command it builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientFile, googleDirectoryCheck, loginCommand, parseClient, readClient, saveClient, tokenScopes, type TokenInfoFetch } from "../src/people/google-login.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "google-login-")));
const DESKTOP = JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", project_id: "acme-admin", client_secret: "GOCSPX-x", redirect_uris: ["http://localhost"] } });
const DIRECTORY = "https://www.googleapis.com/auth/admin.directory.user.readonly";

type ProbeResult = { ok: boolean; out: string; err: string };
const probeOf = (answers: Record<string, ProbeResult>) => async (cmd: string, args: string[]) =>
  answers[`${cmd} ${args.join(" ")}`] || { ok: false, out: "", err: "not faked" };
const ok = (out: string): ProbeResult => ({ ok: true, out, err: "" });
const no = (err = "ERROR: (gcloud.auth.application-default.print-access-token) Your default credentials were not found."): ProbeResult => ({ ok: false, out: "", err });
const installed = { "gcloud --version": ok("Google Cloud SDK 520.0.0\nbq 2.1.0") };
const scopesFetch = (scope: string | null): TokenInfoFetch => async () => (scope == null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ scope }) });

test("parseClient takes a Desktop app client and explains the usual wrong files", () => {
  assert.deepEqual(parseClient(DESKTOP), { clientId: "123-abc.apps.googleusercontent.com", projectId: "acme-admin" });
  assert.throws(() => parseClient("not json"), /isn't a JSON file/);
  assert.throws(() => parseClient(JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com" } })), /Web application client.*Desktop app/);
  assert.throws(() => parseClient(JSON.stringify({ type: "service_account", private_key: "..." })), /isn't a Google OAuth client file/);
  assert.throws(() => parseClient(JSON.stringify({ installed: { client_id: "x.apps.googleusercontent.com" } })), /client_secret/);
});

test("saveClient keeps it in the ledger; a bad file leaves the old one alone", () => {
  const ledger = path.join(TMP, "ledger-save");
  assert.equal(readClient(ledger), null);
  assert.equal(saveClient(ledger, DESKTOP).projectId, "acme-admin");
  assert.equal(fs.readFileSync(clientFile(ledger), "utf-8"), DESKTOP);
  assert.throws(() => saveClient(ledger, "{}"), /isn't a Google OAuth client file/);
  assert.equal(readClient(ledger)?.clientId, "123-abc.apps.googleusercontent.com");
});

test("loginCommand: cmd /c on Windows (cmd.exe would split the scopes at the comma), quoted elsewhere", () => {
  const win = loginCommand("C:\\Users\\o'neil\\ws\\.claude\\ledger\\google-oauth-client.json", "win");
  assert.match(win, /^cmd \/c '.*'$/);
  assert.ok(win.includes(`--client-id-file="C:\\Users\\o''neil\\ws\\.claude\\ledger\\google-oauth-client.json"`), "a quote in the path is doubled for PowerShell");
  assert.ok(win.includes(`--scopes="${DIRECTORY},https://www.googleapis.com/auth/cloud-platform"`));
  const mac = loginCommand("/Users/ana/ws/.claude/ledger/google-oauth-client.json", "mac");
  assert.equal(mac, `gcloud auth application-default login --client-id-file='/Users/ana/ws/.claude/ledger/google-oauth-client.json' --scopes='${DIRECTORY},https://www.googleapis.com/auth/cloud-platform'`);
});

test("tokenScopes asks Google with a POST, not the token in a URL", async () => {
  let seen: any = null;
  const scopes = await tokenScopes("ya29.tok", async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ scope: `${DIRECTORY} openid` }) }; });
  assert.deepEqual(scopes, [DIRECTORY, "openid"]);
  assert.equal(seen.url, "https://oauth2.googleapis.com/tokeninfo");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, "access_token=ya29.tok");
  assert.equal(await tokenScopes("t", async () => { throw new Error("offline"); }), null);
});

test("check: gcloud missing offers its install", async () => {
  const c = await googleDirectoryCheck({ probe: probeOf({}), ledgerDir: path.join(TMP, "l1"), osKey: "win", project: null });
  assert.equal(c.status, "warn");
  assert.equal(c.install?.cmd, "winget install --id Google.CloudSDK -e");
  assert.equal(c.upload, undefined, "nothing to upload until gcloud is there");
  const linux = await googleDirectoryCheck({ probe: probeOf({}), ledgerDir: path.join(TMP, "l1"), osKey: "linux", project: null });
  assert.equal(linux.install, undefined);
  assert.match(linux.fix!, /cloud\.google\.com/);
});

test("check: not signed in and no client file asks for the file, with no Sign in yet", async () => {
  const c = await googleDirectoryCheck({ probe: probeOf({ ...installed, "gcloud auth application-default print-access-token": no() }), ledgerDir: path.join(TMP, "l2"), osKey: "mac", project: null });
  assert.equal(c.status, "warn");
  assert.equal(c.upload, "google-client");
  assert.equal(c.install, undefined);
  assert.match(c.detail, /Choose your team's Google OAuth client file/);
  assert.equal(c.version, "520.0.0");
});

test("check: with the client file, Sign in runs the command for it", async () => {
  const ledger = path.join(TMP, "l3");
  saveClient(ledger, DESKTOP);
  const c = await googleDirectoryCheck({ probe: probeOf({ ...installed, "gcloud auth application-default print-access-token": no() }), ledgerDir: ledger, osKey: "mac", project: "acme-admin" });
  assert.equal(c.install?.label, "Sign in");
  assert.equal(c.install?.cmd, loginCommand(clientFile(ledger), "mac"));
  assert.doesNotMatch(c.detail, /bills the directory/, "same project: nothing to say");
  const other = await googleDirectoryCheck({ probe: probeOf({ ...installed, "gcloud auth application-default print-access-token": no() }), ledgerDir: ledger, osKey: "mac", project: "billing-proj" });
  assert.match(other.detail, /from project acme-admin; hosting.json bills the directory to billing-proj/);
});

test("check: ok only when the sign-in has the directory scope", async () => {
  const ledger = path.join(TMP, "l4");
  const signedIn = { ...installed, "gcloud auth application-default print-access-token": ok("ya29.tok") };
  const good = await googleDirectoryCheck({ probe: probeOf(signedIn), ledgerDir: ledger, osKey: "win", project: null, fetcher: scopesFetch(`${DIRECTORY} https://www.googleapis.com/auth/cloud-platform`) });
  assert.equal(good.status, "ok", "signed in by hand, without the page's file, counts too");

  const wrong = await googleDirectoryCheck({ probe: probeOf(signedIn), ledgerDir: ledger, osKey: "win", project: null, fetcher: scopesFetch("https://www.googleapis.com/auth/cloud-platform") });
  assert.equal(wrong.status, "warn");
  assert.match(wrong.detail, /without the directory scope/);

  const offline = await googleDirectoryCheck({ probe: probeOf(signedIn), ledgerDir: ledger, osKey: "win", project: null, fetcher: scopesFetch(null) });
  assert.equal(offline.status, "warn");
  assert.match(offline.detail, /offline/);
});
