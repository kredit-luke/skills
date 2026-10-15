// github-login.ts's parsing: who `gh auth status` says is signed in, and the commit identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { commitIdentity, keyBody, signingKeyPath, signingKeyTitle, statusAccount } from "../src/github-login.ts";

test("statusAccount: the account in gh auth status, old and new wording", () => {
  assert.equal(statusAccount("github.com\n  ✓ Logged in to github.com account ana-gh (/data/gh/hosts.yml)\n  - Active account: true"), "ana-gh");
  assert.equal(statusAccount("github.com\n  ✓ Logged in to github.com as ana-gh (oauth_token)"), "ana-gh");
  assert.equal(statusAccount("You are not logged into any GitHub hosts. To log in, run: gh auth login"), null);
});

test("commitIdentity: GitHub name else login; the given email else the noreply address", () => {
  assert.deepEqual(commitIdentity({ login: "ana-gh", id: 42, name: "Ana Example" }, "ana@example.com"), { name: "Ana Example", email: "ana@example.com" });
  assert.deepEqual(commitIdentity({ login: "ana-gh", id: 42, name: null }), { name: "ana-gh", email: "42+ana-gh@users.noreply.github.com" });
  assert.deepEqual(commitIdentity({ login: "ana-gh", id: 42, name: "  " }, ""), { name: "ana-gh", email: "42+ana-gh@users.noreply.github.com" });
});

test("signing key: beside gh's config, titled with the dashboard's address, matched without its comment", () => {
  assert.equal(signingKeyPath({ GH_CONFIG_DIR: path.join("data", "gh") }), path.join("data", "gh", "signing_ed25519"));
  assert.equal(signingKeyTitle({ DASHBOARD_PUBLIC_URL: "https://agents.example.com/" }), "Natterjack dashboard (agents.example.com)");
  assert.match(signingKeyTitle({}), /^Natterjack dashboard \(.+\)$/);
  assert.equal(keyBody("ssh-ed25519 AAAAkey Natterjack dashboard (x)\n"), "ssh-ed25519 AAAAkey");
});
