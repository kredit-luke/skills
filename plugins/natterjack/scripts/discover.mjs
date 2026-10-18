#!/usr/bin/env node
/**
 * Scan a workspace and print what it's made of, as JSON: whether the folder is a good
 * home for a workspace (`workspace.verdict`), repos, stacks, version
 * pins, how each app runs and on which port, databases and other services from
 * docker-compose, CI and deploy targets, the code host, hints about the issue
 * tracker and docs, design-system candidates, and draft config suggestions.
 *
 *   node discover.mjs <workspace> [--out inventory.json]
 *
 * It only reads files (and asks git for remotes and recent branch names); it never
 * changes anything. Everything it reports is a *guess* for Claude to confirm with
 * the user: suggestions carry a `why` so the interview can show its reasoning.
 * Zero dependencies; runs on any Node >= 18.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brandCandidates } from "./extract-brand.mjs";
import { LEGACY_ENGINE_DIR, engineDirOf, gitOut, gitTopOf, isEngineFolder, readRepos, sameDir } from "./lib.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "bin", "obj", "vendor", "target", ".next", ".nuxt", ".angular", ".venv", "venv", "__pycache__", ".turbo", ".cache", "coverage", "worktrees", ".claude"]);

// ------------------------------------------------------------------ small helpers

const read = (f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } };
const json = (f) => { const t = read(f); if (t == null) return null; try { return JSON.parse(t.replace(/^﻿/, "")); } catch { return null; } };
const exists = (f) => fs.existsSync(f);
const rel = (root, p) => path.relative(root, p).split(path.sep).join("/") || ".";
function git(cwd, args) {
  try { return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim(); } catch { return ""; }
}
function have(cmd, args = ["--version"]) {
  // Windows needs a shell for .cmd shims (gh is an .exe, but az/aws are .cmd); pass one command string.
  const win = process.platform === "win32";
  try {
    return execFileSync(win ? [cmd, ...args].join(" ") : cmd, win ? [] : args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, shell: win })
      .trim().split(/\r?\n/)[0];
  } catch { return null; }
}
/** Files under dir matching test, depth-limited, skipping installs/builds. */
function find(dir, test, depth = 3, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && !isEngineFolder(p)) find(p, test, depth - 1, out); }
    else if (test(e.name, p)) out.push(p);
  }
  return out;
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

// ------------------------------------------------------------------ repos

/** The workspace's repos: repos.json if present, else every folder with .git (and the root itself). */
export function listRepos(root) {
  const out = [];
  for (const r of readRepos(root)) {
    out.push({ dir: r.relativePath, name: r.name, url: r.remote, declared: true, cloned: exists(path.join(root, r.relativePath, ".git")) });
  }
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".") || isEngineFolder(path.join(root, e.name))) continue;
    if (out.some((r) => r.dir === e.name)) continue;
    if (exists(path.join(root, e.name, ".git"))) out.push({ dir: e.name, name: e.name, url: null, declared: false, cloned: true });
  }
  // A single-repo workspace: the root holds the code.
  const rootHasCode = ["package.json", "composer.json", "go.mod", "pyproject.toml", "Gemfile", "Cargo.toml", "pom.xml"].some((f) => exists(path.join(root, f)));
  if (rootHasCode) out.unshift({ dir: ".", name: path.basename(root), url: null, declared: false, cloned: true });
  for (const r of out) {
    if (!r.cloned) continue;
    const dir = path.join(root, r.dir);
    r.url = r.url || git(dir, ["remote", "get-url", "origin"]) || null;
    r.host = hostOf(r.url);
    r.defaultBranch = (git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) || "").replace(/^origin\//, "") || null;
    r.recentBranches = git(dir, ["for-each-ref", "--sort=-committerdate", "--count=30", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"])
      .split(/\r?\n/).filter(Boolean).map((b) => b.replace(/^origin\//, ""));
    r.recentCommits = git(dir, ["log", "-40", "--format=%s"]).split(/\r?\n/).filter(Boolean);
  }
  return out;
}

function hostOf(url) {
  if (!url) return null;
  const m = /(?:@|:\/\/)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) return null;
  const h = m[1].toLowerCase();
  const kind = h.includes("github") ? "github" : h.includes("gitlab") ? "gitlab" : h.includes("bitbucket") ? "bitbucket"
    : h.includes("dev.azure.com") || h.includes("visualstudio.com") ? "azure-devops" : "other";
  return { kind, host: h, owner: m[2], repo: m[3], slug: `${m[2]}/${m[3]}` };
}

// ------------------------------------------------------------------ workspace shape

// Names people give a general folder of projects. Only a hint: it takes a second sign to call a folder a catch-all.
const GENERIC_NAMES = /^(dev|devel|development|code|coding|src|source|sources|projects?|repos?|repositories|git|github|gitlab|sandbox|playground)$/i;
// What a workspace repo holds besides the product's repos: none of these make the root a product repo.
const WORKSPACE_FILE = /^(\.gitignore|\.gitattributes|\.editorconfig|\.mcp\.json|repos\.json|CLAUDE\.md|AGENTS\.md|README(\.[\w-]+)?|LICEN[CS]E(\.[\w-]+)?|[^/]+\.code-workspace|\.claude\/.*|\.github\/.*|\.vscode\/.*)$/i;
// Build files that mark a folder (without git) as a code folder, beyond the ones listRepos knows.
const CODE_MARKERS = /^(package\.json|composer\.json|go\.mod|pyproject\.toml|requirements\.txt|setup\.py|Pipfile|Gemfile|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^.]+\.(sln|csproj|fsproj|vbproj)|global\.json|mix\.exs|deno\.jsonc?|pubspec\.yaml|Package\.swift|CMakeLists\.txt|Makefile|meson\.build)$/i;

/** Does the root itself hold product code (not just workspace files)? */
function rootHasProduct(root, rootIsRepo, engineDir) {
  const own = (f) => WORKSPACE_FILE.test(f) || f === engineDir || f.startsWith(`${engineDir}/`);
  if (rootIsRepo) {
    // Tracked and untracked-but-not-ignored files, minus the workspace's own: any left means a product repo.
    const files = gitOut(root, ["ls-files", "--cached", "--others", "--exclude-standard"], 256 * 1024 * 1024);
    if (files != null) return files.split(/\r?\n/).some((f) => f && !own(f));
  }
  try { return fs.readdirSync(root, { withFileTypes: true }).some((e) => e.isFile() && CODE_MARKERS.test(e.name)); } catch { return false; }
}

/**
 * Signs that `dir` is a general folder of unrelated projects (~/Development, ~/code) rather than one
 * product's folder. Strong: the home folder; subfolders holding their own sets of repos (except ones
 * repos.json declares repos in, and the worktrees folder). Weak, two needed: a general-purpose name
 * (and directly in the home folder), repos from 2+ owners, 10+ repos.
 */
function catchAllSignals(dir, children, declaredPaths, worktreesDir) {
  const strong = [], weak = [];
  const name = path.basename(dir);
  if (sameDir(dir, os.homedir())) strong.push("it's your home folder");
  const declaredTops = new Set(declaredPaths.filter((p) => p.includes("/")).map((p) => p.split("/")[0]));
  let groups = [];
  try {
    groups = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && e.name !== worktreesDir && !declaredTops.has(e.name)
        && !exists(path.join(dir, e.name, ".git")) && !isEngineFolder(path.join(dir, e.name)))
      .filter((e) => { try { return fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }).some((c) => c.isDirectory() && exists(path.join(dir, e.name, c.name, ".git"))); } catch { return false; } })
      .map((e) => e.name);
  } catch {}
  if (groups.length) strong.push(`it has folders that hold their own sets of repos (${groups.slice(0, 5).join(", ")}${groups.length > 5 ? "…" : ""}), like separate projects`);
  if (GENERIC_NAMES.test(name)) {
    weak.push(`the folder is called "${name}", a general-purpose name`);
    if (sameDir(path.dirname(dir), os.homedir())) weak.push("it sits directly in your home folder");
  }
  const owners = [...new Set(children.map((r) => r.host && r.host.owner).filter(Boolean))];
  if (owners.length >= 2) weak.push(`its repos belong to ${owners.length} different owners (${owners.slice(0, 5).join(", ")})`);
  if (children.length >= 10) weak.push(`it holds ${children.length} repos`);
  // An empty folder isn't a folder of unrelated projects, whatever it's called.
  const catchAll = (children.length > 0 || groups.length > 0) && (strong.length > 0 || weak.length >= 2);
  return { catchAll, reasons: [...strong, ...weak] };
}

/** Child folders that are git repos (no git calls: just .git). */
const childRepoDirs = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && exists(path.join(dir, e.name, ".git"))).map((e) => e.name); } catch { return []; }
};

/**
 * Is this folder a good home for a workspace? A workspace is its own git repo (the
 * dashboard, config, skills and CLAUDE.md are shared through it) with the product's
 * repos cloned inside it (gitignored, listed in repos.json). Verdicts, for the create
 * skill's first step:
 *   ok            the root is a git repo holding (or declaring) the product's repos
 *   empty         the root is a fresh folder or repo with no repos yet: ask which to add
 *   single-repo   one repo and nothing else: ask whether the product has other repos
 *   root-not-git  the product's repos side by side, but the root isn't a git repo yet
 *   catch-all     looks like a general folder of unrelated projects: pick the product's repos, use a new folder
 *   inside-repo   the root is a subfolder of another git repo
 * `reasons` says why, for the skill to show the user. `suggestedPath` is where the workspace
 * could be instead, and `suggested` says what that path is: "here" (this folder, once it's a
 * git repo), "parent" (the folder above, holding this repo and its siblings; `suggestedIsRepo`
 * says whether it's a git repo already) or "new" (a folder to create).
 */
export function workspaceShape(root, repos) {
  root = path.resolve(root);
  const top = gitTopOf(root);
  const rootIsRepo = sameDir(top, root);
  const children = repos.filter((r) => r.dir !== ".");
  const declaredPaths = repos.filter((r) => r.declared).map((r) => r.dir);
  const declared = declaredPaths.length > 0;
  const ws = json(path.join(root, ".claude", "dashboard", "workspace.json")) || {};
  const worktreesDir = (ws.worktrees && ws.worktrees.dir) || "worktrees";
  const rootCode = !top || rootIsRepo ? repos.some((r) => r.dir === ".") || rootHasProduct(root, rootIsRepo, engineDirOf(root)) : false;
  const productRepos = children.length + (rootCode ? 1 : 0);
  const out = { verdict: "ok", rootIsRepo, rootRemote: rootIsRepo ? gitOut(root, ["remote", "get-url", "origin"]) || null : null, productRepos, reasons: [] };
  const parent = path.dirname(root);
  const suggest = (p, kind, isRepo) => { out.suggestedPath = p; out.suggested = kind; if (isRepo !== undefined) out.suggestedIsRepo = isRepo; };
  // A new workspace folder: beside a repo, or inside a general folder.
  const newFolder = (base, name = "agent-os") => {
    let p = path.join(base, name);
    for (let i = 2; exists(p); i++) p = path.join(base, `${name}-${i}`);
    return p;
  };

  if (top && !rootIsRepo) {
    // The repo's top in the user's own spelling of the path (git's is the real path).
    let repoTop = root;
    while (!sameDir(repoTop, top) && path.dirname(repoTop) !== repoTop) repoTop = path.dirname(repoTop);
    if (!sameDir(repoTop, top)) repoTop = path.resolve(top);
    out.verdict = "inside-repo";
    out.reasons.push(`${root} is inside the git repo at ${repoTop}`);
    suggest(newFolder(path.dirname(repoTop)), "new");
    return out;
  }

  if (!rootIsRepo) {
    const signals = catchAllSignals(root, children, declaredPaths, worktreesDir);
    if (signals.catchAll) {
      out.verdict = "catch-all";
      out.reasons.push(...signals.reasons);
      suggest(newFolder(root), "new");
      return out;
    }
  }

  if (productRepos === 0 && !declared) {
    out.verdict = "empty";
    out.reasons.push(rootIsRepo ? "the root is a git repo with no product repos in it yet" : "the folder has no repos in it yet");
  } else if (productRepos <= 1 && !declared) {
    out.verdict = "single-repo";
    if (!rootCode) {
      // A plain folder holding one repo: it can become the workspace itself.
      out.reasons.push(`the folder holds a single repo (${children[0].dir}) and nothing else`);
      suggest(root, "here", rootIsRepo);
    } else {
      out.reasons.push(`the root is ${rootIsRepo ? "itself a product repo" : "a code folder"}, with no other repos in it`);
      // The folder above may already be the product's folder (this repo plus its siblings). A light look
      // (no remotes, branches or commits): its own git top, its child repos, the catch-all signs.
      const upTop = parent !== root ? gitTopOf(parent) : null;
      const upIsRepo = sameDir(upTop, parent);
      const siblings = parent !== root && (!upTop || upIsRepo) ? childRepoDirs(parent) : [];
      const upDeclared = readRepos(parent).map((r) => r.relativePath);
      const upCatchAll = siblings.length >= 2 && catchAllSignals(parent, siblings.map((d) => ({ dir: d })), upDeclared, "worktrees").catchAll;
      if (siblings.length >= 2 && !upCatchAll) {
        out.reasons.push(`the folder above (${parent}) holds ${siblings.length} repos including this one, and could be the workspace${upIsRepo ? "" : " once it's a git repo"}`);
        suggest(parent, "parent", upIsRepo);
      } else suggest(newFolder(parent), "new");
    }
  } else if (!rootIsRepo) {
    out.verdict = "root-not-git";
    out.reasons.push(`the root holds ${productRepos} repos but isn't a git repo itself, so the dashboard config, skills and CLAUDE.md have nowhere to be shared from`);
  }
  return out;
}

// ------------------------------------------------------------------ stacks

const FRAMEWORKS = {
  "@angular/core": { name: "Angular", port: 4200, kind: "frontend" },
  next: { name: "Next.js", port: 3000, kind: "fullstack" },
  nuxt: { name: "Nuxt", port: 3000, kind: "fullstack" },
  "@sveltejs/kit": { name: "SvelteKit", port: 5173, kind: "fullstack" },
  astro: { name: "Astro", port: 4321, kind: "frontend" },
  "@remix-run/react": { name: "Remix", port: 3000, kind: "fullstack" },
  // Expo and bare React Native apps also depend on react; their dev server is Metro, on 8081.
  expo: { name: "Expo", port: 8081, kind: "frontend" },
  "react-native": { name: "React Native", port: 8081, kind: "frontend" },
  vue: { name: "Vue", port: 5173, kind: "frontend" },
  react: { name: "React", port: 5173, kind: "frontend" },
  svelte: { name: "Svelte", port: 5173, kind: "frontend" },
  "@nestjs/core": { name: "NestJS", port: 3000, kind: "backend" },
  express: { name: "Express", port: 3000, kind: "backend" },
  fastify: { name: "Fastify", port: 3000, kind: "backend" },
  hono: { name: "Hono", port: 8787, kind: "backend" },
  electron: { name: "Electron", port: null, kind: "desktop" },
  wrangler: { name: "Cloudflare Worker", port: 8787, kind: "backend" },
};

function nodeStack(dir) {
  const pkg = json(path.join(dir, "package.json"));
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const fw = Object.keys(FRAMEWORKS).filter((d) => deps[d]).map((d) => FRAMEWORKS[d]);
  const pm = exists(path.join(dir, "pnpm-lock.yaml")) ? "pnpm" : exists(path.join(dir, "yarn.lock")) ? "yarn" : exists(path.join(dir, "bun.lockb")) || exists(path.join(dir, "bun.lock")) ? "bun" : "npm";
  const scripts = pkg.scripts || {};
  const runScript = ["dev", "start", "serve", "develop"].find((s) => scripts[s]);
  return {
    language: "node",
    frameworks: fw.map((f) => f.name),
    kind: (fw[0] && fw[0].kind) || (runScript ? "app" : "library"),
    packageManager: pm,
    run: runScript ? { cmd: `${pm === "npm" ? "npm run" : pm} ${runScript}${portFlag(scripts[runScript], pm)}`, script: scripts[runScript], why: `package.json scripts.${runScript}` } : null,
    port: portFromText(runScript ? scripts[runScript] : "") || portFromViteOrAngular(dir) || portFromEnv(dir) || (fw[0] && fw[0].port) || null,
    install: pm === "npm" ? (exists(path.join(dir, "package-lock.json")) ? "npm ci" : "npm install") : `${pm} install`,
    tailwind: !!deps.tailwindcss,
    homepage: pkg.homepage || null,
    engines: pkg.engines && pkg.engines.node ? pkg.engines.node : null,
  };
}

/**
 * Dev servers that ignore a PORT env var take the port as a flag; pass it through
 * the package script (npm needs "--" first). Empty when the script sets its own port.
 */
function portFlag(script, pm) {
  const s = String(script || "");
  if (/--port|-p\s+\d|PORT=/.test(s)) return "";
  const sep = pm === "npm" ? " --" : "";
  if (/^(vite|astro|ng serve|ng s\b|svelte-kit dev|nuxt|nuxi)/.test(s)) return `${sep} --port {{port}}`;
  if (/^next (dev|start)/.test(s)) return `${sep} -p {{port}}`;
  if (/^(expo start|react-native start)\b/.test(s)) return `${sep} --port {{port}}`;
  return "";
}

function portFromText(s) {
  const m = /(?:--port[= ]|-p |PORT=|:)(\d{4,5})\b/.exec(String(s || ""));
  return m ? Number(m[1]) : null;
}
function portFromViteOrAngular(dir) {
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
    const t = read(path.join(dir, f));
    const m = t && /port\s*:\s*(\d{4,5})/.exec(t);
    if (m) return Number(m[1]);
  }
  const ng = json(path.join(dir, "angular.json"));
  if (ng && ng.projects) {
    for (const p of Object.values(ng.projects)) {
      const port = p && p.architect && p.architect.serve && p.architect.serve.options && p.architect.serve.options.port;
      if (port) return Number(port);
    }
  }
  return null;
}
function portFromEnv(dir) {
  for (const f of [".env.example", ".env.sample", ".env.local.example", ".env.development"]) {
    const m = /^\s*(?:APP_)?PORT\s*=\s*(\d{4,5})/m.exec(read(path.join(dir, f)) || "");
    if (m) return Number(m[1]);
  }
  return null;
}

function phpStack(dir) {
  const c = json(path.join(dir, "composer.json"));
  if (!c) return null;
  const req = { ...(c.require || {}), ...(c["require-dev"] || {}) };
  const laravel = !!req["laravel/framework"];
  const symfony = Object.keys(req).some((k) => k.startsWith("symfony/framework-bundle"));
  return {
    language: "php",
    frameworks: [laravel && "Laravel", symfony && "Symfony"].filter(Boolean),
    kind: laravel || symfony ? "backend" : "library",
    phpVersion: (/(\d+\.\d+)/.exec(req.php || "") || [])[1] || null,
    run: laravel ? { cmd: "php artisan serve --port={{port}}", why: "Laravel app (artisan)" } : symfony ? { cmd: "symfony serve --port={{port}}", why: "Symfony app" } : null,
    port: portFromEnv(dir) || (laravel ? 8000 : symfony ? 8000 : null),
    install: "composer install",
  };
}

function goStack(dir) {
  const mod = read(path.join(dir, "go.mod"));
  if (mod == null) return null;
  const version = (/^go (\d+\.\d+(?:\.\d+)?)/m.exec(mod) || [])[1] || null;
  const fw = [["github.com/gin-gonic/gin", "Gin"], ["github.com/labstack/echo", "Echo"], ["github.com/gofiber/fiber", "Fiber"], ["github.com/go-chi/chi", "chi"]]
    .filter(([m]) => mod.includes(m)).map(([, n]) => n);
  const mains = find(dir, (n, p) => n === "main.go", 3).map((p) => rel(dir, path.dirname(p)));
  const main = mains.find((m) => m === ".") || mains.find((m) => m.startsWith("cmd/")) || mains[0];
  return {
    language: "go",
    frameworks: fw,
    kind: main ? "backend" : "library",
    goVersion: version,
    run: main ? { cmd: main === "." ? "go run ." : `go run ./${main}`, why: `main package in ${main}` } : null,
    port: portFromEnv(dir) || portFromGoSource(dir) || null,
    install: "go mod download",
  };
}
function portFromGoSource(dir) {
  for (const f of find(dir, (n) => n.endsWith(".go"), 3).slice(0, 80)) {
    const m = /(?:ListenAndServe|Listen|Run)\(\s*"[^"]*:(\d{4,5})"/.exec(read(f) || "");
    if (m) return Number(m[1]);
  }
  return null;
}

function dotnetStack(dir) {
  const projs = find(dir, (n) => n.endsWith(".csproj"), 3);
  if (!projs.length) return null;
  const tfms = new Set();
  const web = [];
  const secrets = [];
  for (const p of projs) {
    const t = read(p) || "";
    const tfm = (/<TargetFrameworks?>net(\d+)\.\d+/.exec(t) || [])[1];
    if (tfm) tfms.add(Number(tfm));
    if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(t)) web.push(p);
    if (/<UserSecretsId>/.test(t)) secrets.push(rel(dir, p));
  }
  const webProj = web[0];
  let port = null, https = false;
  if (webProj) {
    const ls = json(path.join(path.dirname(webProj), "Properties", "launchSettings.json"));
    const urls = ls && ls.profiles ? Object.values(ls.profiles).map((p) => p.applicationUrl).filter(Boolean).join(";") : "";
    const httpsUrl = /https:\/\/localhost:(\d+)/.exec(urls);
    const httpUrl = /http:\/\/localhost:(\d+)/.exec(urls);
    if (httpsUrl) { port = Number(httpsUrl[1]); https = true; } else if (httpUrl) port = Number(httpUrl[1]);
  }
  const sdk = (json(path.join(dir, "global.json")) || {}).sdk;
  return {
    language: "dotnet",
    frameworks: webProj ? ["ASP.NET Core"] : [],
    kind: webProj ? "backend" : "library",
    dotnetMajor: tfms.size ? Math.max(...tfms) : null,
    globalJsonSdk: sdk && sdk.version ? sdk.version : null,
    run: webProj ? { cmd: `dotnet run --project ${rel(dir, webProj)}`, why: "ASP.NET Core project (Sdk.Web)" } : null,
    port, https,
    userSecretsProjects: secrets,
    install: "dotnet restore",
    csproj: webProj ? rel(dir, webProj) : rel(dir, projs[0]),
  };
}

function pythonStack(dir) {
  const pyproject = read(path.join(dir, "pyproject.toml"));
  const reqs = read(path.join(dir, "requirements.txt"));
  if (pyproject == null && reqs == null && !exists(path.join(dir, "Pipfile"))) return null;
  const all = `${pyproject || ""}\n${reqs || ""}`.toLowerCase();
  const django = all.includes("django") && exists(path.join(dir, "manage.py"));
  const fastapi = all.includes("fastapi");
  const flask = all.includes("flask");
  const uv = exists(path.join(dir, "uv.lock"));
  const poetry = /\[tool\.poetry\]/.test(pyproject || "");
  const prefix = uv ? "uv run " : poetry ? "poetry run " : "";
  return {
    language: "python",
    frameworks: [django && "Django", fastapi && "FastAPI", flask && "Flask"].filter(Boolean),
    kind: django || fastapi || flask ? "backend" : "library",
    pythonVersion: (read(path.join(dir, ".python-version")) || "").trim() || (/requires-python\s*=\s*"[>=~^]*\s*(\d+\.\d+)/.exec(pyproject || "") || [])[1] || null,
    packageManager: uv ? "uv" : poetry ? "poetry" : "pip",
    run: django ? { cmd: `${prefix}python manage.py runserver {{port}}`, why: "Django (manage.py)" }
      : fastapi ? { cmd: `${prefix}uvicorn main:app --reload --port {{port}}`, why: "FastAPI (check the module path)" }
      : flask ? { cmd: `${prefix}flask run --port {{port}}`, why: "Flask" } : null,
    port: portFromEnv(dir) || (django || fastapi ? 8000 : flask ? 5000 : null),
    install: uv ? "uv sync" : poetry ? "poetry install" : reqs != null ? "pip install -r requirements.txt" : "pip install -e .",
  };
}

function rubyStack(dir) {
  const gemfile = read(path.join(dir, "Gemfile"));
  if (gemfile == null) return null;
  const rails = /gem ['"]rails['"]/.test(gemfile);
  return {
    language: "ruby",
    frameworks: rails ? ["Rails"] : [],
    kind: rails ? "backend" : "library",
    rubyVersion: (read(path.join(dir, ".ruby-version")) || "").trim() || null,
    run: rails ? { cmd: "bin/rails server -p {{port}}", why: "Rails app" } : null,
    port: rails ? 3000 : null,
    install: "bundle install",
  };
}

function javaStack(dir) {
  const maven = exists(path.join(dir, "pom.xml"));
  const gradle = exists(path.join(dir, "build.gradle")) || exists(path.join(dir, "build.gradle.kts"));
  if (!maven && !gradle) return null;
  const text = `${read(path.join(dir, "pom.xml")) || ""}${read(path.join(dir, "build.gradle")) || ""}${read(path.join(dir, "build.gradle.kts")) || ""}`;
  const boot = /spring-boot/.test(text);
  const wrapper = gradle ? (exists(path.join(dir, "gradlew")) ? "./gradlew" : "gradle") : exists(path.join(dir, "mvnw")) ? "./mvnw" : "mvn";
  return {
    language: "java",
    build: maven ? "maven" : "gradle",
    frameworks: boot ? ["Spring Boot"] : [],
    kind: boot ? "backend" : "library",
    javaVersion: (/<java\.version>(\d+)</.exec(text) || /languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/.exec(text) || /sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/.exec(text) || [])[1] || null,
    run: boot ? { cmd: maven ? `${wrapper} spring-boot:run` : `${wrapper} bootRun`, why: "Spring Boot" } : null,
    port: boot ? 8080 : null,
    install: maven ? `${wrapper} -q dependency:resolve` : `${wrapper} dependencies`,
    wrapper: wrapper.startsWith("./"),
  };
}

function rustStack(dir) {
  const cargo = read(path.join(dir, "Cargo.toml"));
  if (cargo == null) return null;
  const web = ["axum", "actix-web", "rocket", "warp"].filter((c) => cargo.includes(c));
  return { language: "rust", frameworks: web, kind: web.length ? "backend" : "library", run: web.length ? { cmd: "cargo run", why: `Rust web (${web.join(", ")})` } : null, port: portFromEnv(dir) || null, install: "cargo fetch" };
}

function staticSite(dir) {
  if (!exists(path.join(dir, "index.html"))) return null;
  if (["package.json", "composer.json", "go.mod"].some((f) => exists(path.join(dir, f)))) return null;
  return { language: "static", frameworks: ["Static HTML"], kind: "site", run: { cmd: "npx --yes serve -l {{port}} .", why: "plain static site (index.html, no build)" }, port: null, install: null };
}

/** Every stack in a repo: the root and first-level app folders (monorepos). */
function repoStacks(root, repoDir) {
  const base = path.join(root, repoDir);
  const detectors = [nodeStack, phpStack, goStack, dotnetStack, pythonStack, rubyStack, javaStack, rustStack, staticSite];
  const out = [];
  const scan = (dir) => {
    for (const d of detectors) {
      const s = d(dir);
      if (s) out.push({ ...s, path: rel(root, dir) });
    }
  };
  scan(base);
  // Monorepo folders (apps/*, packages/*, services/*, and direct children), for languages the
  // repo root didn't already cover: a .NET solution's projects or a site's page folders are
  // part of what the root found, not apps of their own.
  const rootLangs = new Set(out.map((s) => s.language));
  const rootStatic = rootLangs.has("static");
  const children = [];
  for (const group of ["apps", "packages", "services"]) {
    try { for (const e of fs.readdirSync(path.join(base, group), { withFileTypes: true })) if (e.isDirectory()) children.push(path.join(base, group, e.name)); } catch {}
  }
  try { for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && !["apps", "packages", "services"].includes(e.name) && !isEngineFolder(path.join(base, e.name))) children.push(path.join(base, e.name)); } catch {}
  if (!rootStatic) {
    for (const c of children) {
      if (out.some((s) => s.path === rel(root, c))) continue;
      for (const d of detectors) {
        const s = d(c);
        if (!s || rootLangs.has(s.language)) continue;
        // index.html inside another app's src/ is that app's entry page, not a site.
        if (s.language === "static" && (out.length || /(^|[\\/])(src|public|static|assets)$/.test(c))) continue;
        out.push({ ...s, path: rel(root, c) });
      }
    }
  }
  // A folder with both a Node frontend build and another backend is fine; drop Node "libraries" that are just tooling for another stack.
  return out.filter((s, i) => !(s.language === "node" && s.kind === "library" && out.some((o, j) => j !== i && o.path === s.path && o.language !== "node")));
}

// ------------------------------------------------------------------ pins, compose, CI, deploy

function versionPins(root, repoDir) {
  const base = path.join(root, repoDir);
  const pins = [];
  const pin = (tool, file, version) => version && pins.push({ tool, file: rel(root, path.join(base, file)), version: String(version).trim().replace(/^v/, "") });
  pin("node", ".nvmrc", read(path.join(base, ".nvmrc")));
  pin("node", ".node-version", read(path.join(base, ".node-version")));
  for (const line of (read(path.join(base, ".tool-versions")) || "").split(/\r?\n/)) {
    const [tool, version] = line.trim().split(/\s+/);
    if (tool && version) pin(tool === "nodejs" ? "node" : tool, ".tool-versions", version);
  }
  const gj = json(path.join(base, "global.json"));
  if (gj && gj.sdk && gj.sdk.version) pin("dotnet", "global.json", gj.sdk.version);
  pin("go", "go.mod", (/^go (\d+\.\d+(?:\.\d+)?)/m.exec(read(path.join(base, "go.mod")) || "") || [])[1]);
  pin("python", ".python-version", read(path.join(base, ".python-version")));
  pin("ruby", ".ruby-version", read(path.join(base, ".ruby-version")));
  const cj = json(path.join(base, "composer.json"));
  if (cj && cj.require && cj.require.php) pin("php", "composer.json", (/(\d+\.\d+)/.exec(cj.require.php) || [])[1]);
  const pj = json(path.join(base, "package.json"));
  if (pj && pj.engines && pj.engines.node) pin("node", "package.json", (/(\d+(?:\.\d+){0,2})/.exec(pj.engines.node) || [])[1]);
  for (const f of find(base, (n) => /^Dockerfile/.test(n), 2)) {
    for (const m of (read(f) || "").matchAll(/^FROM\s+([^\s]+)/gm)) pins.push({ tool: "docker-image", file: rel(root, f), version: m[1] });
  }
  return pins;
}

const DB_IMAGES = [
  [/postgres|postgis|timescale/i, "postgres", 5432], [/mysql/i, "mysql", 3306], [/mariadb/i, "mariadb", 3306],
  [/mongo/i, "mongodb", 27017], [/redis|valkey/i, "redis", 6379], [/rabbitmq/i, "rabbitmq", 5672],
  [/elasticsearch|opensearch/i, "search", 9200], [/kafka|redpanda/i, "kafka", 9092], [/minio/i, "minio", 9000],
  [/azurite/i, "azurite", 10000], [/localstack/i, "localstack", 4566], [/mailhog|mailpit/i, "mail", 8025],
  [/mssql|sqlserver/i, "sqlserver", 1433], [/seq/i, "seq", 5341],
];

/**
 * One compose port mapping, short syntax: [HOST_IP:][HOST_PORT:]CONTAINER_PORT[/PROTOCOL]. The host
 * IP may be IPv6 in brackets, ports may be ranges (the first port is taken), and a port may be a
 * variable: ${VAR:-default} and ${VAR-default} read as the default, and `hostVar` names a host
 * port's variable so the team knows it can differ per machine. A mapping without a host port
 * publishes on a random one: `host` is null.
 */
export function composePortOf(spec) {
  const vars = [];
  // Variables first (their defaults can hold ":"), as placeholders, then split on ":".
  let s = String(spec).trim().replace(/\/(tcp|udp|sctp)$/i, "")
    .replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (_, name, def) => { vars.push({ name, def: def ?? "" }); return `\0${vars.length - 1}\0`; });
  if (s.startsWith("[")) s = s.slice(s.indexOf("]") + 1).replace(/^:/, "");
  const parts = s.split(":");
  const [hostRaw, containerRaw] = parts.length >= 3 ? [parts[parts.length - 2], parts[parts.length - 1]] : parts.length === 2 ? parts : [null, parts[0]];
  const expand = (t) => (t == null ? null : t.replace(/\0(\d+)\0/g, (_, i) => vars[i].def));
  const num = (t) => { const m = /^\s*(\d{1,5})/.exec(expand(t) || ""); return m ? Number(m[1]) : null; };
  const container = num(containerRaw);
  if (container == null) return null;
  const hostVar = hostRaw && /\0(\d+)\0/.exec(hostRaw);
  return { host: num(hostRaw), container, ...(hostVar ? { hostVar: vars[hostVar[1]].name } : {}) };
}

/** docker-compose services (a tiny YAML reader: enough for image, container_name, build and ports). */
function composeServices(root) {
  const files = find(root, (n) => /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/i.test(n), 2);
  const out = [];
  for (const file of files) {
    const lines = (read(file) || "").split(/\r?\n/);
    let inServices = false, svc = null, svcIndent = -1;
    let block = null, blockIndent = -1, longPort = null; // block: "ports" | "build", the list or map being read
    const unquote = (v) => String(v).trim().replace(/^["']|["']$/g, "");
    const endLongPort = () => {
      const p = longPort && longPort.target != null ? composePortOf(`${longPort.published != null ? `${longPort.published}:` : ""}${longPort.target}`) : null;
      if (p) svc.ports.push(p);
      longPort = null;
    };
    const push = () => { if (svc) { endLongPort(); out.push(svc); } };
    for (const raw of lines) {
      if (/^\s*#/.test(raw) || !raw.trim()) continue;
      const indent = raw.length - raw.trimStart().length;
      const line = raw.trim().replace(/\s+#.*$/, ""); // an inline comment isn't part of the value
      if (indent === 0) { inServices = line === "services:"; push(); svc = null; continue; }
      if (!inServices) continue;
      if (svcIndent === -1 || indent === svcIndent) {
        const m = /^([\w.-]+):\s*$/.exec(line);
        if (m) { push(); svcIndent = indent; svc = { file: rel(root, file), service: m[1], image: null, container: null, build: null, ports: [] }; block = null; continue; }
      }
      if (!svc) continue;
      if (block && (indent > blockIndent || (block === "ports" && indent === blockIndent && line.startsWith("-")))) {
        if (block === "ports") {
          // Short syntax ("8080:80", "127.0.0.1:${PORT:-5432}:5432") or long ("- target: 80" + "published: 8080").
          const item = line.startsWith("-") ? line.slice(1).trim() : null;
          if (item !== null) endLongPort();
          const kv = /^(target|published|host_ip|protocol|mode|name|app_protocol):\s*(.*)$/.exec(item ?? line);
          if (kv) { longPort = longPort || {}; longPort[kv[1]] = unquote(kv[2]); }
          else if (item) { const p = composePortOf(unquote(item)); if (p) svc.ports.push(p); }
        } else {
          const kv = /^context:\s*(.+)$/.exec(line);
          if (kv) svc.build = unquote(kv[1]);
        }
        continue;
      }
      if (block === "ports") endLongPort();
      block = null;
      const kv = /^([\w_]+):\s*(.*)$/.exec(line);
      if (kv && indent > svcIndent) {
        if (kv[1] === "ports" || (kv[1] === "build" && !kv[2])) { block = kv[1]; blockIndent = indent; }
        if (kv[1] === "build" && !kv[2]) svc.build = "."; // compose's default context, unless the map names one
        if (kv[1] === "build" && kv[2]) svc.build = unquote(kv[2]);
        if (kv[1] === "image") svc.image = kv[2].replace(/["']/g, "");
        if (kv[1] === "container_name") svc.container = kv[2].replace(/["']/g, "");
      }
    }
    push();
  }
  // A build context is relative to the compose file's folder: report it workspace-relative.
  for (const s of out) if (s.build) s.build = rel(root, path.resolve(root, path.dirname(s.file), s.build));
  for (const s of out) {
    const hit = DB_IMAGES.find(([re]) => re.test(s.image || s.service));
    s.kind = hit ? hit[1] : "service";
    const published = s.ports.find((p) => p.host != null);
    s.hostPort = published ? published.host : null;
    if (published && published.hostVar) s.hostPortVar = published.hostVar;
    if (!s.container) {
      // Compose's default name: <project>-<service>-1, project = the compose file's folder.
      const project = path.basename(path.dirname(path.join(root, s.file))).toLowerCase().replace(/[^a-z0-9_-]/g, "");
      s.container = `${project}-${s.service}-1`;
      s.containerGuessed = true;
    }
  }
  return out;
}

function ciAndDeploy(root, repoDir) {
  const base = path.join(root, repoDir);
  const ci = [];
  for (const f of find(path.join(base, ".github", "workflows"), (n) => /\.ya?ml$/.test(n), 0)) {
    ci.push({ system: "github-actions", file: rel(root, f), name: (/^name:\s*(.+)$/m.exec(read(f) || "") || [])[1] || path.basename(f) });
  }
  for (const [f, system] of [[".gitlab-ci.yml", "gitlab-ci"], ["azure-pipelines.yml", "azure-pipelines"], ["bitbucket-pipelines.yml", "bitbucket-pipelines"], ["Jenkinsfile", "jenkins"], [".circleci/config.yml", "circleci"]]) {
    if (exists(path.join(base, f))) ci.push({ system, file: rel(root, path.join(base, f)) });
  }
  const deploy = [];
  const w = read(path.join(base, "wrangler.toml"));
  if (w) {
    const name = (/^name\s*=\s*"([^"]+)"/m.exec(w) || [])[1];
    const routes = [...w.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    deploy.push({ target: "cloudflare", file: "wrangler.toml", name, urls: routes.map((r) => `https://${r.replace(/\/\*$/, "")}`) });
  }
  const fly = read(path.join(base, "fly.toml"));
  if (fly) { const app = (/^app\s*=\s*['"]([^'"]+)/m.exec(fly) || [])[1]; deploy.push({ target: "fly", file: "fly.toml", name: app, urls: app ? [`https://${app}.fly.dev`] : [] }); }
  if (exists(path.join(base, "vercel.json"))) deploy.push({ target: "vercel", file: "vercel.json", urls: [] });
  if (exists(path.join(base, "netlify.toml"))) deploy.push({ target: "netlify", file: "netlify.toml", urls: [] });
  if (exists(path.join(base, "render.yaml"))) deploy.push({ target: "render", file: "render.yaml", urls: [] });
  if (exists(path.join(base, "app.yaml"))) deploy.push({ target: "google-app-engine", file: "app.yaml", urls: [] });
  if (exists(path.join(base, "serverless.yml"))) deploy.push({ target: "serverless", file: "serverless.yml", urls: [] });
  if (find(base, (n) => n.endsWith(".tf"), 2).length) deploy.push({ target: "terraform", file: "*.tf", urls: [] });
  if (exists(path.join(base, "azure.yaml")) || exists(path.join(base, ".azure"))) deploy.push({ target: "azure", file: "azure.yaml", urls: [] });
  if (find(base, (n) => /^Chart\.yaml$|^kustomization\.ya?ml$/.test(n), 3).length) deploy.push({ target: "kubernetes", file: "helm/kustomize", urls: [] });
  // Environment URLs mentioned in the README next to a telling word.
  const readme = read(path.join(base, "README.md")) || "";
  const urls = [];
  for (const line of readme.split(/\r?\n/)) {
    if (!/prod|production|staging|live|demo|preview|dev\b/i.test(line)) continue;
    for (const m of line.matchAll(/https?:\/\/[^\s)>"'`]+/g)) if (!/github\.com|shields\.io|badge|localhost|127\.0\.0\.1/.test(m[0])) urls.push({ url: m[0].replace(/[.,]$/, ""), context: line.trim().slice(0, 140) });
  }
  return { ci, deploy, readmeUrls: urls.slice(0, 12) };
}

// ------------------------------------------------------------------ docs, trackers, services

function docsHints(root, repo) {
  const base = path.join(root, repo.dir);
  const out = [];
  const md = find(path.join(base, "docs"), (n) => /\.mdx?$/.test(n), 4);
  if (md.length) out.push({ kind: "notes", dir: rel(root, path.join(base, "docs")), pages: md.length, why: "docs/ folder" });
  for (const [f, what] of [["mkdocs.yml", "MkDocs"], ["docusaurus.config.js", "Docusaurus"], ["docusaurus.config.ts", "Docusaurus"], [".vitepress", "VitePress"]]) {
    if (exists(path.join(base, f))) out.push({ kind: "site", dir: repo.dir, generator: what, why: `${f}` });
  }
  if (exists(path.join(base, "index.html")) && !exists(path.join(base, "package.json"))) {
    const html = find(base, (n) => /\.html?$/.test(n), 3).length;
    if (html > 2) out.push({ kind: "site", dir: repo.dir, pages: html, why: "static HTML site" });
  }
  if (/docs?|handbook|wiki|runbook|notes|infra/i.test(repo.dir) && !out.length) {
    const pages = find(base, (n) => /\.mdx?$/.test(n), 4).length;
    if (pages > 2) out.push({ kind: "notes", dir: repo.dir, pages, why: "a docs/notes repo by name" });
  }
  return out;
}

function trackerHints(repos, root) {
  const votes = { linear: [], jira: [], github: [], "azure-boards": [], gitlab: [], shortcut: [] };
  const keys = new Map();
  for (const r of repos) {
    for (const s of [...(r.recentBranches || []), ...(r.recentCommits || [])]) {
      for (const m of s.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g)) keys.set(m[1], (keys.get(m[1]) || 0) + 1);
      // "#12" in a commit is a GitHub issue reference, but not in "Merge pull request #12".
      if (/(^|\s)#\d+\b/.test(s) && !/^Merge pull request #/.test(s)) votes.github.push(`"${s.slice(0, 60)}"`);
    }
    const base = path.join(root, r.dir);
    const text = ["README.md", "CONTRIBUTING.md", ".github/pull_request_template.md", "CLAUDE.md"].map((f) => read(path.join(base, f)) || "").join("\n");
    if (/linear\.app/i.test(text)) votes.linear.push(`${r.dir}: links to linear.app`);
    if (/atlassian\.net|jira/i.test(text)) votes.jira.push(`${r.dir}: mentions Jira/atlassian.net`);
    if (/dev\.azure\.com.*_workitems|AB#\d+/i.test(text)) votes["azure-boards"].push(`${r.dir}: Azure Boards links`);
    if (/app\.shortcut\.com/i.test(text)) votes.shortcut.push(`${r.dir}: links to Shortcut`);
    if (exists(path.join(base, ".github", "ISSUE_TEMPLATE"))) votes.github.push(`${r.dir}: has GitHub issue templates`);
    if (r.host && r.host.kind === "gitlab") votes.gitlab.push(`${r.dir}: hosted on GitLab`);
  }
  // The workspace's own Claude config: CLAUDE.md and the MCP tools it allows.
  const claudeText = [path.join(root, "CLAUDE.md"), path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")]
    .map((f) => read(f) || "").join("\n");
  for (const [kind, re, what] of [["linear", /linear/i, "mentions Linear"], ["jira", /\bjira\b|atlassian/i, "mentions Jira"], ["shortcut", /shortcut\.com/i, "mentions Shortcut"], ["azure-boards", /azure boards|_workitems/i, "mentions Azure Boards"]]) {
    if (re.test(claudeText)) votes[kind].unshift(`CLAUDE.md / .claude/settings: ${what}`, `(workspace config counts double)`);
  }
  const mcp = json(path.join(root, ".mcp.json"));
  for (const name of Object.keys((mcp && mcp.mcpServers) || {})) {
    for (const k of Object.keys(votes)) if (name.toLowerCase().includes(k.split("-")[0])) votes[k].push(`.mcp.json server "${name}"`);
  }
  const ticketKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 2).map(([k, n]) => ({ key: k, mentions: n }));
  const ranked = Object.entries(votes).filter(([, v]) => v.length).map(([kind, evidence]) => ({ kind, evidence: evidence.slice(0, 5) }))
    .sort((a, b) => b.evidence.length - a.evidence.length);
  return { candidates: ranked, ticketKeys };
}

function envHints(root, repos) {
  const services = new Map();
  const PATTERNS = { sentry: /SENTRY_/, datadog: /DATADOG_|DD_API/, newrelic: /NEW_RELIC/, slack: /SLACK_/, stripe: /STRIPE_/, twilio: /TWILIO_/, sendgrid: /SENDGRID/, mailgun: /MAILGUN/, aws: /AWS_/, azure: /AZURE_/, gcp: /GOOGLE_CLOUD|GCP_/, auth0: /AUTH0_/, okta: /OKTA_/, openai: /OPENAI_/, anthropic: /ANTHROPIC_/, jira: /JIRA_/, linear: /LINEAR_/ };
  for (const r of repos) {
    for (const f of [".env.example", ".env.sample", ".env.template"]) {
      const t = read(path.join(root, r.dir, f));
      if (!t) continue;
      for (const [svc, re] of Object.entries(PATTERNS)) if (re.test(t)) services.set(svc, [...(services.get(svc) || []), `${r.dir}/${f}`]);
    }
  }
  return [...services.entries()].map(([service, where]) => ({ service, where }));
}

// ------------------------------------------------------------------ suggestions

const LANG_TO_CATALOG = { php: ["php", "composer"], go: ["go"], python: ["python"], ruby: ["ruby", "bundler"], rust: ["cargo"] };

async function suggest(root, repos, compose, pins, codeHost) {
  const machine = [{ use: "package-manager" }];
  const addUse = (use, extra = {}) => { if (!machine.some((m) => (m.id || m.use) === (extra.id || use))) machine.push({ use, ...extra }); };
  const apps = [];
  const usedPorts = new Set(compose.map((c) => c.hostPort).filter(Boolean));
  const claimed = new Set(); // ports already given to an app
  const appIds = new Set();
  const idFor = (raw) => { const s = /^[A-Z0-9_-]+$/.test(raw) ? raw.toLowerCase() : raw; let id = s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z]+/, "") || "app"; id = id[0].toLowerCase() + id.slice(1); let n = id, i = 2; while (appIds.has(n)) n = `${id}${i++}`; appIds.add(n); return n; };

  const nodePin = pins.find((p) => p.tool === "node");
  let needsNode = true;
  for (const r of repos) {
    for (const s of r.stacks || []) {
      const appDir = s.path;
      if (s.language === "node") {
        const lockUse = s.packageManager === "npm" ? "npm" : s.packageManager;
        addUse(lockUse);
        if (s.kind !== "library") {
          machine.push({ use: "path", id: `deps-${appDir.replace(/[^\w-]+/g, "-")}`, group: "Dependencies", label: `${appDir} dependencies`, repo: r.dir, path: `${appDir}/node_modules`, detail: { ok: "node_modules installed.", missing: "node_modules missing." }, install: { label: s.install, win: s.install, mac: s.install, linux: s.install, cwd: appDir }, _appPath: appDir });
        }
      } else if (s.language === "dotnet") {
        addUse("dotnet", { required: s.csproj ? { file: `${appDir}/${s.csproj}`, regex: "<TargetFrameworks?>net(\\d+)\\.\\d+", default: String(s.dotnetMajor || 8) } : undefined });
        if (s.https) addUse("dotnet-dev-cert", { id: "devcert" });
        for (const p of s.userSecretsProjects || []) machine.push({ use: "dotnet-user-secrets", id: `secrets-${p.replace(/[^\w-]+/g, "-")}`, label: `${path.basename(p, ".csproj")} user secrets`, project: `${appDir}/${p}` });
      } else if (s.language === "java") {
        // The repo's wrapper (gradlew / mvnw) fetches its own build tool: only Java itself is needed then.
        addUse("java"); if (!s.wrapper) addUse(s.build === "maven" ? "maven" : "gradle");
      } else if (LANG_TO_CATALOG[s.language]) {
        // The toolchain version, read from the repo where it's pinned.
        const at = s.path === "." ? "" : `${s.path}/`;
        const req = {
          go: { file: `${at}go.mod`, regex: "^go (\\d+\\.\\d+(?:\\.\\d+)?)" },
          php: { file: `${at}composer.json`, regex: "\"php\"\\s*:\\s*\"[^\\d]*(\\d+\\.\\d+)" },
          python: fs.existsSync(path.join(root, at, ".python-version")) ? { file: `${at}.python-version` } : undefined,
          ruby: fs.existsSync(path.join(root, at, ".ruby-version")) ? { file: `${at}.ruby-version` } : undefined,
        }[s.language];
        LANG_TO_CATALOG[s.language].forEach((u, i) => addUse(u, i === 0 && req ? { required: req } : {}));
        if (s.language === "python" && s.packageManager === "uv") addUse("uv");
      }
      if (s.run && s.kind !== "library") {
        let port = s.port;
        // A compose service built from exactly this app's folder is this app in a container: its port is the app's
        // (once: a second app wanting it still moves aside).
        const own = new Set(compose.filter((c) => c.hostPort && c.build === s.path && !claimed.has(c.hostPort)).map((c) => c.hostPort));
        while (port && usedPorts.has(port) && !own.has(port)) port += 1;
        if (port) { usedPorts.add(port); claimed.add(port); }
        const name = s.path === "." ? path.basename(root) : s.path.split("/").pop();
        apps.push({
          id: idFor(name),
          name,
          type: [s.frameworks[0] || s.language].join(""),
          dir: r.dir === "." ? "." : r.dir,
          workDir: s.path !== r.dir && s.path !== "." ? s.path : undefined,
          port: port || null,
          https: !!s.https,
          launch: { cmd: s.run.cmd.replace(/\{\{port\}\}/g, "{{port}}"), env: port ? { PORT: "{{port}}" } : undefined },
          why: `${s.run.why}${s.port ? `; port from ${s.port === port ? "config/defaults" : "default, bumped to avoid a clash"}` : "; port unknown, ask"}`,
        });
      }
    }
  }
  if (needsNode) machine.splice(1, 0, { use: "node", required: nodePin ? { file: nodePin.file, min: "24.15.0" } : { min: "24.15.0" }, why: "the dashboard itself runs on Node" });
  addUse("git");
  if (codeHost === "gitlab") addUse("glab"); else addUse("gh");
  addUse("claude");
  if (compose.length) {
    addUse("docker");
    const seenContainers = new Set();
    for (const c of compose.filter((c) => c.kind !== "service")) {
      if (seenContainers.has(c.container || c.service)) continue;
      seenContainers.add(c.container || c.service);
      machine.push({ use: "docker-container", id: c.container || c.service, name: c.container || c.service, port: (!c.hostPortVar && c.hostPort) || undefined, fix: `docker compose -f ${c.file} up -d ${c.service}`, label: `${c.kind[0].toUpperCase() + c.kind.slice(1)} (${c.image || c.service})`, group: "Services", why: `${c.file} service "${c.service}"${c.containerGuessed ? " (no container_name: this is compose's default name, unless the project is named otherwise)" : ""}${c.hostPortVar ? `; its host port comes from ${c.hostPortVar} (default ${c.hostPort}), so it can differ per machine: checked by name only` : ""}` });
    }
  }

  // Dashboard port: 3333 unless an app or something on this machine already uses it.
  let dashboardPort = 3333;
  while (usedPorts.has(dashboardPort) || apps.some((a) => a.port === dashboardPort) || !(await portFree(dashboardPort))) dashboardPort += 1;

  return { machine, apps, dashboardPort };
}

// ------------------------------------------------------------------ main

export async function discover(root) {
  root = path.resolve(root);
  const repos = listRepos(root);
  const pins = [];
  const docs = [];
  for (const r of repos) {
    if (!r.cloned) continue;
    r.stacks = repoStacks(root, r.dir);
    r.pins = versionPins(root, r.dir);
    pins.push(...r.pins);
    Object.assign(r, ciAndDeploy(root, r.dir));
    docs.push(...docsHints(root, r));
    delete r.recentCommits; // used for tracker hints below, too noisy to print
  }
  const reposForHints = listRepos(root); // fresh copy with commits for tracker hints
  const compose = composeServices(root);
  const hostKinds = repos.map((r) => r.host && r.host.kind).filter(Boolean);
  const codeHost = hostKinds.sort((a, b) => hostKinds.filter((x) => x === b).length - hostKinds.filter((x) => x === a).length)[0] || null;
  const clis = Object.fromEntries(["gh", "glab", "az", "aws", "gcloud", "docker", "claude"].map((c) => [c, have(c)]));
  const nodeVersion = process.version;
  // An engine already here: in engine.json's folder, or an older workspace's dashboard/.
  const installedEngine = [engineDirOf(root), LEGACY_ENGINE_DIR].find((d) => exists(path.join(root, d, "server", "src", "main.ts"))) || null;
  return {
    root,
    name: path.basename(root),
    workspace: workspaceShape(root, repos),
    existing: {
      dashboard: !!installedEngine,
      engineDir: installedEngine,
      config: fs.existsSync(path.join(root, ".claude", "dashboard")) ? fs.readdirSync(path.join(root, ".claude", "dashboard")) : [],
      reposJson: exists(path.join(root, "repos.json")),
      claudeMd: exists(path.join(root, "CLAUDE.md")),
      skills: fs.existsSync(path.join(root, ".claude", "skills")) ? fs.readdirSync(path.join(root, ".claude", "skills")) : [],
      mcpServers: Object.keys(((json(path.join(root, ".mcp.json")) || {}).mcpServers) || {}),
    },
    repos,
    compose,
    codeHost: { kind: codeHost, orgs: [...new Set(repos.map((r) => r.host && r.host.owner).filter(Boolean))] },
    tracker: trackerHints(reposForHints, root),
    services: envHints(root, repos),
    docs,
    brand: brandCandidates(root).slice(0, 8),
    tools: { ...clis, node: nodeVersion },
    suggestions: await suggest(root, repos, compose, pins, codeHost),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--")) || process.cwd();
  const outIdx = args.indexOf("--out");
  const result = await discover(root);
  const text = JSON.stringify(result, null, 2);
  if (outIdx !== -1 && args[outIdx + 1]) { fs.writeFileSync(args[outIdx + 1], text + "\n"); console.log(`Wrote ${args[outIdx + 1]}`); }
  else console.log(text);
}
