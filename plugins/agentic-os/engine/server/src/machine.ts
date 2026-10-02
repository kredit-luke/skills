/**
 * Machine checks: everything this computer needs to run the workspace's apps,
 * on Windows and macOS (Linux: checks and copyable commands, no Install button).
 * Which checks run is .claude/dashboard/machine.json, built from the catalog in
 * machine-catalog.ts; required versions can be read from the repos where they're
 * declared (an .nvmrc, a csproj, go.mod, ...), so the page stays right as they change.
 *
 * Each result: { id, group, label, status: ok|warn|missing|info, version,
 * required, detail, fix, install?, action?, apps: [appKey] }
 *   ok       satisfied
 *   warn     works, but something is off (old default Node rescued by nvm, …)
 *   missing  a required piece is absent; the listed apps won't start
 *   info     optional and absent (only matters for an optional stack)
 *
 * install = { label, cmd, cwd } for THIS OS, from config only. The browser asks
 * to run a check's install by id; it never supplies command text. Installs open
 * in a visible terminal (Windows Terminal / Terminal.app) so admin prompts,
 * license agreements and sign-ins happen in front of the user.
 */

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { LEDGER_DIR, readConfigFile } from "./config.ts";
import { readProfile } from "./profile.ts";
import { CATALOG } from "./machine-catalog.ts";
import { claudeAuth, connectorState } from "./claude.ts";
import { NOT_HOSTED } from "./hosted.ts";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const CACHE_TTL_MS = 60 * 1000;

export function run(cmd: string, args: string[], opts: { timeout?: number; shell?: boolean } = {}): Promise<{ ok: boolean; code: any; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, windowsHide: true, shell: !!opts.shell, encoding: "utf-8" },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || "").trim(), err: String(stderr || "").trim() }));
  });
}

export function parseVer(v) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
export function cmpVer(a, b) {
  const pa = parseVer(a) || [0, 0, 0], pb = parseVer(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
export function fmtVer(v) { const p = parseVer(v); return p ? p.join(".") : null; }

/** Tries twice before calling a port down: one slow answer on a busy machine isn't an outage. */
async function portOpen(port) {
  return (await connectOnce(port, 800)) || connectOnce(port, 1500);
}

function connectOnce(port, timeout): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => { s.destroy(); resolve(false); });
    s.connect(port, "127.0.0.1");
  });
}

function read(file) { try { return fs.readFileSync(file, "utf-8"); } catch { return null; } }

/** Installed nvm Node versions (nvm-windows, or nvm on macOS). */
function nvmVersions() {
  const roots = IS_WIN
    ? [process.env.NVM_HOME, path.join(os.homedir(), "AppData", "Roaming", "nvm")]
    : [process.env.NVM_DIR && path.join(process.env.NVM_DIR, "versions", "node"), path.join(os.homedir(), ".nvm", "versions", "node")];
  for (const root of roots.filter(Boolean)) {
    try {
      return fs.readdirSync(root).filter((d) => /^v?\d+\.\d+\.\d+$/.test(d)).map((d) => d.replace(/^v/, ""));
    } catch {}
  }
  return [];
}

// ------------------------------------------------------------- PATH freshness

/**
 * Installers update the *system* PATH, but this long-lived process keeps the PATH
 * it started with, so a re-check right after an install would still say
 * "missing" (and apps the dashboard launches couldn't find the new tool). Before
 * each check, merge in the current PATH: Windows from the registry (Machine +
 * User), macOS from a login shell (picks up Homebrew, nvm, dotnet).
 */
async function refreshPath() {
  let fresh = null;
  if (IS_WIN) {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
    if (r.ok) fresh = r.out;
  } else {
    const shell = process.env.SHELL || (IS_MAC ? "/bin/zsh" : "/bin/bash");
    const r = await run(shell, ["-lic", 'printf "__PATH__%s" "$PATH"'], { timeout: 10000 });
    const m = /__PATH__(.*)$/s.exec(r.out || "");
    if (m) fresh = m[1].trim();
  }
  if (!fresh) return;
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
  const sep = path.delimiter;
  const seen = new Set();
  const merged = [];
  // Fresh entries first, then anything this process had that the fresh PATH lacks
  // (e.g. an nvm symlink or a per-session addition).
  for (const p of [...fresh.split(sep), ...String(process.env[key] || "").split(sep)]) {
    const norm = IS_WIN ? p.toLowerCase().replace(/\\+$/, "") : p.replace(/\/+$/, "");
    if (!p || seen.has(norm)) continue;
    seen.add(norm);
    merged.push(p);
  }
  process.env[key] = merged.join(sep);
}

// ------------------------------------------------------------- install terminal

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function asQuote(s) { return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

/**
 * Open a visible terminal running `cmd` in `cwd`. Returns { opened, command }.
 * Windows: PowerShell in Windows Terminal (falls back to a plain PowerShell
 * window); the script goes in as -EncodedCommand so no quoting or `;` can be
 * mangled by wt's own argument parsing. macOS: Terminal.app via AppleScript.
 */
export function openTerminal(cmd: string, cwd: string, title: string, doneMsg = "Done. Close this window, then click Re-check in the dashboard."): Promise<{ opened: boolean; command: string }> {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const script = [
        `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
        `Write-Host ${psQuote("> " + cmd)} -ForegroundColor Cyan`,
        cmd,
        "Write-Host ''",
        `Write-Host ${psQuote(doneMsg)} -ForegroundColor Green`,
      ].join("\n");
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const fallback = () => {
        const p = spawn("powershell.exe", ["-NoProfile", "-Command",
          `Start-Process powershell -WorkingDirectory ${psQuote(cwd)} -ArgumentList '-NoExit','-EncodedCommand','${encoded}'`],
          { detached: true, stdio: "ignore", windowsHide: true });
        p.on("error", () => resolve({ opened: false, command: cmd }));
        p.unref();
        resolve({ opened: true, command: cmd });
      };
      const wt = spawn("wt.exe", ["-w", "new", "-d", cwd, "powershell", "-NoExit", "-EncodedCommand", encoded], { detached: true, stdio: "ignore" });
      wt.on("error", fallback);
      wt.on("spawn", () => { wt.unref(); resolve({ opened: true, command: cmd }); });
      return;
    }
    if (IS_MAC) {
      const script = `cd ${shQuote(cwd)} && printf '\\033[36m> %s\\033[0m\\n' ${shQuote(cmd)} && ${cmd}; echo; echo ${shQuote(doneMsg)}`;
      const p = spawn("osascript", ["-e", `tell application "Terminal" to do script ${asQuote(script)}`, "-e", 'tell application "Terminal" to activate'],
        { detached: true, stdio: "ignore" });
      p.on("error", () => resolve({ opened: false, command: cmd }));
      p.on("spawn", () => { p.unref(); resolve({ opened: true, command: cmd }); });
      return;
    }
    resolve({ opened: false, command: cmd });
  });
}

// ------------------------------------------------------------- checks

const OS_KEY = IS_WIN ? "win" : IS_MAC ? "mac" : "linux";
const osStr = (v: any): string | null => (v == null ? null : typeof v === "string" ? v : v[OS_KEY] ?? null);
const fill = (s: string, vars: Record<string, string | number | null | undefined>) =>
  s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

/** An install for this OS from a { label, win, mac, linux, cwd } spec (or one string), or undefined. */
function installFor(spec: any, vars: Record<string, any> = {}, label = "Install") {
  if (!spec) return undefined;
  const cmdText = typeof spec === "string" ? spec : spec[OS_KEY];
  if (!cmdText) return undefined;
  return { label: (typeof spec === "object" && spec.label) || label, cmd: fill(cmdText, vars), cwd: (typeof spec === "object" && spec.cwd) || null };
}

/** A required version: "1.2" or { min?, file?, regex?, default? } → "24.15.0" / "10", or null. */
export function requiredVersion(spec: any, root: string): string | null {
  if (!spec) return null;
  if (typeof spec === "string") return spec;
  let fromFile: string | null = null;
  if (spec.file) {
    const text = read(path.join(root, spec.file));
    if (text != null) {
      if (spec.regex) fromFile = (new RegExp(spec.regex, "m").exec(text) || [])[1] || null;
      else fromFile = text.trim().split(/\r?\n/)[0].trim().replace(/^v/, "") || null;
    }
  }
  const v = fromFile || spec.default || null;
  if (spec.min && (!v || cmpVer(spec.min, v) > 0)) return spec.min;
  return v;
}

/** machine.json checks merged over their catalog entries, with `when` conditions applied. */
export function resolvedSpecs(root: string) {
  const { data, error } = readConfigFile("machine.json");
  const list = data && Array.isArray(data.checks) ? data.checks : [];
  const out: any[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const base = raw.use ? CATALOG[raw.use] : null;
    if (raw.use && !base) continue;
    const spec: any = { ...(base || {}), ...raw, detail: { ...((base && base.detail) || {}), ...(raw.detail || {}) } };
    if (!spec.kind) continue;
    spec.id = raw.id || raw.use;
    if (!spec.id) continue;
    if (raw.when && raw.when.exists && !fs.existsSync(path.join(root, raw.when.exists))) continue;
    if (raw.when && raw.when.os && ![].concat(raw.when.os).includes(OS_KEY)) continue;
    // "developer" / "reader": e.g. build tools only for people who build (profile.ts).
    if (raw.when && (raw.when.profile || raw.when.role)) {
      const me = readProfile(LEDGER_DIR);
      if (raw.when.profile && ![].concat(raw.when.profile).includes(me.profile)) continue;
      // A role id from workspace.json roles: a check only one role needs.
      if (raw.when.role && ![].concat(raw.when.role).includes(me.current.id)) continue;
    }
    out.push(spec);
  }
  return { specs: out, error, configured: !!data };
}

class Machine {
  root: any;
  cache: any;
  inflight: any;
  /** The _configSig the in-flight run was started for. */
  inflightSig: string | null;
  /** Hosted mode (hosted.ts): no terminal to open; Claude's sign-in happens in the page (claude-login.ts). */
  hosted: boolean;

  constructor(workspaceRoot, opts: { hosted?: boolean } = {}) {
    this.root = workspaceRoot;
    this.hosted = !!opts.hosted;
    this.cache = null;
    this.inflight = null;
    this.inflightSig = null;
  }

  /**
   * machine.json and apps.json mtimes, plus the viewer's profile and role: an edit to either file,
   * or a role change (which `when` filters on), re-runs the checks on the next request.
   */
  _configSig() {
    const me = readProfile(LEDGER_DIR);
    return ["machine.json", "apps.json"].map((f): number | string => {
      try { return fs.statSync(path.join(this.root, ".claude", "dashboard", f)).mtimeMs; } catch { return 0; }
    }).concat([me.profile, me.current.id]).join(":");
  }

  async get(force = false) {
    for (;;) {
      const sig = this._configSig();
      if (this.cache && !force && this.cache._sig === sig && Date.now() - this.cache.checkedAt < CACHE_TTL_MS) return this.cache;
      // A run started for another role or config (e.g. the startup warm-up before a role change):
      // let it finish, then look again rather than hand back its report.
      if (this.inflight && this.inflightSig !== sig) { await this.inflight.catch(() => {}); continue; }
      if (!this.inflight) {
        this.inflightSig = sig;
        this.inflight = this._check()
          .then((c) => { Object.defineProperty(c, "_sig", { value: sig, enumerable: false }); this.cache = c; })
          .finally(() => { this.inflight = null; this.inflightSig = null; });
      }
      await this.inflight;
      if (this.cache && this.cache._sig === sig) return this.cache;
      // The config or role changed while it ran: go round for the current one.
    }
  }

  /** Run a check's install in a visible terminal. Only commands from the config can run. */
  async install(id) {
    if (this.hosted) throw new Error(NOT_HOSTED);
    const report = await this.get();
    const check = report.checks.find((c) => c.id === id);
    if (!check || !check.install) throw new Error("Nothing to install for that item on this OS.");
    const cwd = check.install.cwd ? path.join(this.root, check.install.cwd) : this.root;
    if (!path.resolve(cwd).startsWith(path.resolve(this.root))) throw new Error("Install folder must be inside the workspace.");
    return openTerminal(check.install.cmd, cwd, `Setup: ${check.label}`);
  }

  async _check() {
    await refreshPath();
    const { specs, error, configured } = resolvedSpecs(this.root);

    // Each distinct probe runs once, all in parallel.
    const probes = new Map<string, Promise<any>>();
    const probe = (c: string, args: string[], opts: { timeout?: number } = {}) => {
      const key = `${c}\u0000${args.join("\u0000")}`;
      // Windows .cmd/.bat shims (npm, composer, mvn, az, ...) need a shell; only fall back to one
      // when the plain exec can't find the command, since cmd.exe would mangle args like name=^x$.
      if (!probes.has(key)) {
        probes.set(key, run(c, args, { timeout: opts.timeout }).then((r) =>
          IS_WIN && !r.ok && r.code === "ENOENT" ? run([c, ...args].join(" "), [], { timeout: opts.timeout, shell: true }) : r));
      }
      return probes.get(key)!;
    };
    const p = {
      probe,
      dockerSrv: () => probe("docker", ["version", "--format", "{{.Server.Version}}"]),
      dockerCli: () => probe("docker", ["--version"]),
      dotnetSdks: () => probe("dotnet", ["--list-sdks"]),
      npmRoot: () => probe("npm", ["root", "-g"]),
    };

    const results = await Promise.all(specs.map((s) => this._one(s, p).catch((e) => ({
      id: s.id, group: s.group || "Everyone", label: s.label, status: "warn", detail: `Check failed: ${e.message}`, apps: s.apps || [],
    }))));

    const checks = [];
    for (const c of results) {
      if (!c) continue;
      // The copyable hint is the install command itself when there is one, so they never drift.
      const fixText = c.fix || (c.install ? c.install.cmd : "");
      checks.push({ apps: [], ...c, detail: c.detail || "", fix: fixText });
    }
    // Install buttons only where there's something to do.
    for (const c of checks) if (c.status === "ok") delete c.install;

    const blocked = {};
    for (const c of checks) {
      if (c.status !== "missing") continue;
      for (const a of c.apps) (blocked[a] = blocked[a] || []).push(c.label);
    }
    return {
      os: IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux",
      osVersion: os.release(),
      arch: process.arch,
      host: os.hostname(),
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
      checks,
      blocked, // appKey -> labels of missing requirements (Apps cards show these)
      problems: checks.filter((c) => c.status === "missing").length,
      warnings: checks.filter((c) => c.status === "warn").length,
      configured,
      error,
      checkedAt: Date.now(),
    };
  }

  /** One check. Returns its result, or null to leave it out (e.g. nothing to check on this OS). */
  async _one(s: any, p: any) {
    const base = { id: s.id, group: s.group || "Everyone", label: s.label, apps: s.apps || [] };
    const optional = !!s.optional;
    const absent = optional ? "info" : "missing";
    const detail = s.detail || {};
    const req = requiredVersion(s.required, this.root);
    const major = req ? (parseVer(req) || [Number(req)])[0] : null;
    const vars = { required: req, major };
    const label = fill(s.label, vars);
    const fixOf = (v?: string) => { const f = osStr(s.fix); return f ? fill(f, vars) : v; };

    switch (s.kind) {
      case "package-manager": {
        if (IS_WIN) {
          const r = await p.probe("winget", ["--version"]);
          return {
            ...base, label: "winget", version: r.ok ? fmtVer(r.out) : null, status: r.ok ? "ok" : "warn",
            detail: r.ok ? "Used by the Install buttons below." : "The Install buttons use winget. It ships with Windows 11 as \"App Installer\".",
            install: installFor({ label: "Get App Installer", win: "Start-Process 'ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1'" }),
          };
        }
        if (IS_MAC) {
          const r = await p.probe("brew", ["--version"]);
          return {
            ...base, label: "Homebrew", version: r.ok ? fmtVer(r.out) : null, status: r.ok ? "ok" : "warn",
            detail: r.ok ? "Used by the Install buttons below." : "Most Install buttons below use Homebrew; install it first.",
            install: installFor({ mac: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' }),
          };
        }
        return null;
      }

      case "node": {
        const r = await p.probe("node", ["-v"]);
        const need = req || "18.0.0";
        const ver = r.ok ? fmtVer(r.out) : null;
        const nvmList = nvmVersions();
        const nvmOk = nvmList.filter((v) => cmpVer(v, need) >= 0).sort(cmpVer).pop();
        const hasNvm = nvmList.length > 0 || !!process.env.NVM_HOME || !!process.env.NVM_DIR;
        return {
          ...base, label, required: `≥ ${need}`, version: ver,
          status: !ver ? "missing" : cmpVer(ver, need) >= 0 ? "ok" : nvmOk ? "warn" : "missing",
          detail: !ver ? "Not on PATH. The dashboard itself needs Node, and so do the Node-based apps."
            : cmpVer(ver, need) >= 0 ? "Default Node satisfies the apps."
            : nvmOk ? `Default is older than ${need}; nvm has v${nvmOk}, which the app launcher switches to. Direct npm commands outside it still use the old default.`
            : `Older than ${need}; the apps that need it won't build.`,
          install: hasNvm
            ? installFor({ label: nvmOk ? "Make default" : "Install", win: `nvm install ${need}; nvm use ${need}`, mac: `nvm install ${need} && nvm alias default ${need}`, linux: `nvm install ${need} && nvm alias default ${need}` })
            : installFor(s.install || { win: "winget install --id OpenJS.NodeJS -e", mac: "brew install node" }, vars),
          fix: fixOf(),
        };
      }

      case "command": {
        const c = osStr(s.probe && s.probe.cmd);
        if (!c) return null;
        const r = await p.probe(c, s.probe.args || []);
        const text = s.probe.stream === "err" ? r.err : s.probe.stream === "both" ? `${r.out}\n${r.err}` : r.out;
        const ok = r.ok;
        const ver = ok ? fmtVer(text) : null;
        const tooOld = ok && req && ver ? (String(req).includes(".") ? cmpVer(ver, req) < 0 : (parseVer(ver) || [0])[0] < Number(major)) : false;
        const auth = ok && !tooOld && s.auth ? await p.probe(s.auth.cmd, s.auth.args) : null;
        const signedOut = !!auth && !auth.ok;
        return {
          ...base, label, version: ver, required: req ? `≥ ${req}` : undefined,
          status: !ok || tooOld ? absent : signedOut ? "warn" : "ok",
          detail: !ok ? detail.missing || (optional ? "Optional." : "")
            : tooOld ? `Older than ${req}.`
            : signedOut ? s.auth.detail || "Installed but not signed in."
            : detail.ok || "",
          install: !ok || tooOld ? installFor(s.install, vars) : signedOut ? installFor(s.auth.signIn, vars, "Sign in") : undefined,
          fix: fixOf(),
        };
      }

      case "claude-connector": {
        // A claude.ai connector (e.g. Atlassian): connected once in the browser, it reaches Claude Code in
        // every folder and in the dashboard's runs, with no tokens or /mcp.
        const name = String(s.connector || "");
        if (!name) return null;
        const r = await p.probe("claude", ["mcp", "list"], { timeout: 60000 });
        if (!r.ok && !r.out) return { ...base, label, status: "warn", detail: "Couldn't run `claude mcp list` to check it." };
        const c = connectorState(r.out, name);
        const install = installFor(s.install, vars, "Open claude.ai");
        if (c.state === "connected") return { ...base, label, status: "ok", detail: detail.ok || `Connected through claude.ai.` };
        if (c.state === "disabled") return { ...base, label, status: "warn", detail: `Turned off for this workspace. In a Claude session, run /mcp and enable "claude.ai ${name}".` };
        if (c.state === "signed-out") return { ...base, label, status: "warn", detail: `Not connected (${c.text}). Connect it at claude.ai → Settings → Connectors.`, install };
        return { ...base, label, status: "warn", detail: detail.missing || `Your claude.ai account doesn't have the ${name} connector. An org admin adds it in claude.ai's admin settings; then connect it at claude.ai → Settings → Connectors.`, install };
      }

      case "claude-code": {
        // Every dashboard run, the usage meters and autocomplete need it installed and signed in.
        const [v, auth] = await Promise.all([p.probe("claude", ["--version"]), claudeAuth(true)]);
        const ver = v.ok ? fmtVer(v.out) : null;
        if (!v.ok || !auth.installed) {
          return { ...base, label, version: null, status: "missing", detail: detail.missing || "", install: installFor(s.install, vars), fix: fixOf() };
        }
        const how = auth.subscription ? "your Claude subscription" : /api.?key/i.test(auth.authMethod || "") ? "an API key" : auth.apiProvider && auth.apiProvider !== "firstParty" ? auth.apiProvider : auth.authMethod || "your account";
        return {
          ...base, label, version: ver,
          status: auth.loggedIn ? "ok" : "missing",
          detail: auth.loggedIn ? `Signed in with ${how}.` : this.hosted
            ? "Not signed in yet, so runs can't start. Click Sign in to Claude and follow the two steps."
            : "Installed but not signed in, so dashboard runs can't start. Sign in opens a terminal; finish in the browser, then Re-check.",
          install: auth.loggedIn ? undefined : installFor({ label: this.hosted ? "Sign in to Claude" : "Sign in", win: "claude auth login", mac: "claude auth login", linux: "claude auth login" }),
          fix: auth.loggedIn || this.hosted ? fixOf() : "claude auth login",
        };
      }

      case "dotnet-sdk": {
        const r = await p.dotnetSdks();
        const want = major || 8;
        const sdks = r.ok ? r.out.split(/\r?\n/).map((l) => fmtVer(l)).filter(Boolean) : [];
        const matching = sdks.filter((v) => parseVer(v)[0] === want).sort(cmpVer).pop();
        return {
          ...base, label: fill(s.label === ".NET SDK" ? ".NET {major} SDK" : s.label, { ...vars, major: want }), required: `${want}.x`,
          version: matching || (sdks.length ? sdks.sort(cmpVer).pop() : null),
          status: matching ? "ok" : absent,
          detail: matching ? `${sdks.length} SDK${sdks.length === 1 ? "" : "s"} installed.`
            : sdks.length ? `Installed SDKs (${sdks.join(", ")}) don't include ${want}.x, which the apps target.` : "dotnet isn't on PATH.",
          install: installFor(s.install || { win: "winget install --id Microsoft.DotNet.SDK.{major} -e", mac: "brew install --cask dotnet-sdk" }, { ...vars, major: want }),
          fix: fixOf(),
        };
      }

      case "dotnet-dev-cert": {
        const sdk = await p.dotnetSdks();
        const r = sdk.ok ? await p.probe("dotnet", ["dev-certs", "https", "--check", "--trust"], { timeout: 20000 }) : null;
        return {
          ...base, label,
          status: !sdk.ok ? "info" : r && r.ok ? "ok" : "warn",
          detail: !sdk.ok ? "Checked once .NET is installed." : r && r.ok ? "Trusted; https://localhost works in the browser." : detail.missing || "Missing or not trusted; browsers will reject the HTTPS dev servers.",
          install: sdk.ok ? installFor({ label: "Trust", win: "dotnet dev-certs https --trust", mac: "dotnet dev-certs https --trust" }) : undefined,
          fix: fixOf("dotnet dev-certs https --trust"),
        };
      }

      case "dotnet-user-secrets": {
        const proj = s.project ? read(path.join(this.root, s.project)) : null;
        const id = proj ? (/<UserSecretsId>([^<]+)<\/UserSecretsId>/.exec(proj) || [])[1] : null;
        if (!id) return null;
        const dir = IS_WIN ? path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "UserSecrets") : path.join(os.homedir(), ".microsoft", "usersecrets");
        const file = path.join(dir, id, "secrets.json");
        const exists = fs.existsSync(file);
        return {
          ...base, label,
          status: exists ? "ok" : absent,
          detail: exists ? file : fill(detail.missing || "Expected at {file}", { file }),
          // Deliberately no install: secrets come from a teammate, never generated here.
          fix: fill(osStr(s.fix) || "Get secrets.json from a teammate and save it to {file}", { file }),
        };
      }

      case "docker": {
        const [srv, cli] = await Promise.all([p.dockerSrv(), p.dockerCli()]);
        const up = srv.ok && !!srv.out;
        return {
          ...base, label, version: up ? fmtVer(srv.out) : cli.ok ? fmtVer(cli.out) : null,
          status: up ? "ok" : absent,
          detail: up ? "Engine running." : cli.ok ? "Installed, but the engine isn't running." : detail.missing || "Runs the local containers the apps use. Docker Desktop asks you to accept its license and may need a restart.",
          install: cli.ok
            ? installFor({ label: "Start Docker", win: "Start-Process \"$Env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe\"", mac: "open -a Docker", linux: "sudo systemctl start docker" })
            : installFor({ win: "winget install --id Docker.DockerDesktop -e", mac: "brew install --cask docker" }),
          fix: fixOf(),
        };
      }

      case "docker-container": {
        const [srv, ps] = await Promise.all([p.dockerSrv(), p.probe("docker", ["ps", "-a", "--filter", `name=^${s.name}$`, "--format", "{{.Status}}"])]);
        const dockerUp = srv.ok && !!srv.out;
        const st = ps.ok ? ps.out.split(/\r?\n/)[0] : "";
        const running = /^Up\b/.test(st);
        const image = s.image && typeof s.image === "object" ? requiredVersion(s.image, this.root) : s.image;
        const out: any = {
          ...base, label: fill(s.label, { ...vars, image: image || "" }),
          // Running containers are judged by their port below, not Docker's health flag.
          status: !dockerUp ? absent : running ? "ok" : absent,
          detail: !dockerUp ? "Needs Docker running." : running ? `${st}${s.port ? ` · :${s.port}` : ""}` : st ? `Container exists but is stopped (${st}).` : "Container not created yet.",
          fix: dockerUp ? fixOf("Run setup") : "Get Docker running first (see above), then Run setup",
          action: dockerUp && !running && s.setup !== false ? "setup" : undefined,
        };
        // A running container counts as healthy when its service answers on the host port;
        // Docker's own health flag can be wrong (a health check using a tool the image lacks).
        if (running && s.port) {
          if (!(await portOpen(Number(s.port)))) {
            out.status = "warn";
            out.detail = `Container is up but :${s.port} isn't answering yet.`;
          } else if (/unhealthy/.test(out.detail)) {
            out.detail = out.detail.replace(/\s*\(unhealthy\)/, "") + " · answering (Docker's health check for it is broken, safe to ignore)";
          }
        }
        return out;
      }

      case "path": {
        if (s.repo && !fs.existsSync(path.join(this.root, s.repo))) {
          return { ...base, label: s.repoLabel || s.repo, status: "info", detail: "Repo not cloned.", fix: s.cloneFix || "Clone it from the Repos page" };
        }
        const rel = fill(String(s.path || ""), { exe: IS_WIN ? ".exe" : "" });
        const exists = !!rel && fs.existsSync(path.join(this.root, rel));
        return {
          ...base, label,
          status: exists ? "ok" : absent,
          detail: exists ? detail.ok || "" : detail.missing || `${rel} not found.`,
          install: exists ? undefined : installFor(s.install, vars),
          fix: fixOf(),
        };
      }

      case "npm-global": {
        const r = await p.npmRoot();
        const ok = r.ok && !!s.package && fs.existsSync(path.join(r.out.split(/\r?\n/)[0], s.package));
        const cmdText = `npm install -g ${s.package}`;
        return {
          ...base, label, status: ok ? "ok" : absent,
          detail: ok ? detail.ok || "" : detail.missing || "",
          install: ok ? undefined : installFor(s.install || { win: cmdText, mac: cmdText, linux: cmdText }),
          fix: fixOf(),
        };
      }

      case "env-var": {
        const set = !!process.env[s.name];
        return { ...base, label, status: set ? "ok" : absent, detail: set ? detail.ok || `${s.name} is set.` : detail.missing || `${s.name} isn't set.`, fix: fixOf() };
      }

      case "port": {
        const up = s.port ? await portOpen(Number(s.port)) : false;
        return {
          ...base, label, status: up ? "ok" : absent,
          detail: up ? detail.ok || `:${s.port} is answering.` : detail.missing || `Nothing answers on :${s.port}.`,
          fix: fixOf(), action: !up && s.setup ? "setup" : undefined,
        };
      }
    }
    return null;
  }
}

export { Machine };
