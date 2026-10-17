#!/usr/bin/env node
/**
 * Build, and push, the images hosted dashboards run (references/hosting.md, "The image"):
 * templates/hosted/Dockerfile (each person's dashboard) and router/Dockerfile (the shared
 * address), from the natterjack plugin release this workspace's engine is.
 *
 *   node <engine>/bin/hosted-images.mjs [--router | --all] [--registry <server>] [--tag <tag>]
 *                                       [--push] [--update-hosting] [--plugin <dir>] [--workspace <dir>] [--dry-run]
 *
 *   (default)         build the dashboard image only; --router the router's only; --all both.
 *   --registry        where they go: a registry server (acme.azurecr.io, europe-docker.pkg.dev/proj/repo...).
 *                     Default: hosting.json's App Service platform.parameters.registry, as <name>.azurecr.io.
 *   --tag             default <engine version>-<yyyymmddhhmm>: a new tag every build, so dashboards really move.
 *   --push            push them; an Azure registry (*.azurecr.io) is signed in to first (az acr login).
 *   --update-hosting  after the push, point hosting.json platform.parameters.image at the new dashboard
 *                     image (App Service), so the People page shows who needs an update.
 *   --plugin          the natterjack plugin folder to build from. Default: the plugin checkout this engine
 *                     sits in, else the installed plugin of this engine's version
 *                     (<claude config>/plugins/cache/<marketplace>/natterjack/<version>).
 *   --workspace       the workspace (default: the one this engine is in, or WORKSPACE_ROOT).
 *   --dry-run         print the commands, run nothing.
 *
 * Every build is --pull --no-cache: both images install Debian's security updates when they're built,
 * and a cached layer would keep the old packages. It changes nothing but the registry and, with
 * --update-hosting, that one line of hosting.json; rolling the router onto its new image is yours.
 *
 * Plain JavaScript, like dashboard.mjs: it runs on whatever Node is on PATH.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const SELF = process.argv[1] && /hosted-images\.mjs$/i.test(process.argv[1]) ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
const ENGINE_DIR = path.resolve(path.dirname(SELF), "..");

const IMAGES = {
  dashboard: { dockerfile: ["templates", "hosted", "Dockerfile"], name: "natterjack-dashboard" },
  router: { dockerfile: ["router", "Dockerfile"], name: "natterjack-router" },
};

// ------------------------------------------------------------------ pure parts (tested)

export function parseArgs(argv) {
  const o = { which: "dashboard", registry: null, tag: null, push: false, updateHosting: false, plugin: null, workspace: null, dryRun: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--router") o.which = "router";
    else if (a === "--all") o.which = "all";
    else if (a === "--push") o.push = true;
    else if (a === "--update-hosting") o.updateHosting = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--registry") o.registry = value(i++, a).replace(/\/+$/, "");
    else if (a === "--tag") o.tag = value(i++, a);
    else if (a === "--plugin") o.plugin = value(i++, a);
    else if (a === "--workspace") o.workspace = value(i++, a);
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`Unknown option ${a}. Run with --help.`);
  }
  if (o.tag && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(o.tag)) throw new Error(`"${o.tag}" isn't a valid image tag.`);
  if (o.updateHosting && !o.push) throw new Error("--update-hosting needs --push: hosting.json should only name an image that's in the registry.");
  if (o.updateHosting && o.which === "router") throw new Error("--update-hosting is about the dashboard image; build it too (--all).");
  return o;
}

/** <version>-<yyyymmddhhmm> (UTC). */
export function defaultTag(version, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${version}-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

/** The registry from hosting.json: an App Service platform names its Azure Container Registry. */
export function registryFromHosting(hosting) {
  const reg = hosting?.platform?.type === "azure-app-service" ? hosting.platform.parameters?.registry : null;
  if (typeof reg !== "string" || !reg.trim()) return null;
  return reg.includes(".") ? reg.trim() : `${reg.trim()}.azurecr.io`;
}

/** acme.azurecr.io → acme (what az acr login wants); null for other registries. */
export function acrName(registry) {
  const m = /^([a-z0-9]+)\.azurecr\.io$/i.exec(registry || "");
  return m ? m[1] : null;
}

/** The dashboard image's repository in hosting.json ("natterjack-dashboard:1" → natterjack-dashboard). */
export function dashboardRepo(hosting) {
  const img = hosting?.platform?.parameters?.image;
  return typeof img === "string" && img.includes(":") ? img.slice(0, img.lastIndexOf(":")) : IMAGES.dashboard.name;
}

/** A folder that is the natterjack plugin (its manifest says so, and it has both Dockerfiles). */
export function isPluginDir(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf-8"));
    return manifest.name === "natterjack" && Object.values(IMAGES).every((i) => fs.existsSync(path.join(dir, ...i.dockerfile)));
  } catch { return false; }
}

/** Where to build from: --plugin, the checkout this engine is in, else the installed plugin of `version`. */
export function findPlugin({ plugin, engineDir, version, claudeDir }) {
  if (plugin) {
    if (!isPluginDir(plugin)) throw new Error(`${plugin} isn't the natterjack plugin folder (it needs .claude-plugin/plugin.json, templates/hosted/Dockerfile and router/Dockerfile).`);
    return { dir: path.resolve(plugin), how: "--plugin" };
  }
  const around = path.resolve(engineDir, "..");
  if (isPluginDir(around)) return { dir: around, how: "the plugin checkout this engine is in" };
  const cache = path.join(claudeDir, "plugins", "cache");
  const seen = [];
  let marketplaces = [];
  try { marketplaces = fs.readdirSync(cache); } catch {}
  for (const m of marketplaces) {
    const base = path.join(cache, m, "natterjack");
    let versions = [];
    try { versions = fs.readdirSync(base); } catch { continue; }
    seen.push(...versions);
    if (version && versions.includes(version) && isPluginDir(path.join(base, version))) return { dir: path.join(base, version), how: `the installed plugin, ${version}` };
  }
  const had = seen.length ? ` (installed: ${[...new Set(seen)].join(", ")})` : "";
  throw new Error(`The natterjack plugin ${version || "release"} this engine is isn't installed${had}. Update the plugin (claude plugin update natterjack@<marketplace>), or pass --plugin <folder>.`);
}

/** The commands to run, in order: [label, command, args]. */
export function plan({ which, registry, tag, push, pluginDir, repo }) {
  const want = which === "all" ? ["dashboard", "router"] : [which];
  const steps = [];
  const refs = {};
  for (const k of want) {
    const ref = `${registry}/${k === "dashboard" ? repo : IMAGES[k].name}:${tag}`;
    refs[k] = ref;
    steps.push([`Building the ${k} image`, "docker", ["build", "-f", path.join(pluginDir, ...IMAGES[k].dockerfile), "--pull", "--no-cache", "-t", ref, pluginDir]]);
  }
  if (push) {
    const acr = acrName(registry);
    if (acr) steps.push([`Signing in to ${registry}`, "az", ["acr", "login", "--name", acr]]);
    for (const k of want) steps.push([`Pushing ${refs[k]}`, "docker", ["push", refs[k]]]);
  }
  return { steps, refs };
}

/** hosting.json with platform.parameters.image set to `image`, changing only that line. */
export function withImage(text, image) {
  const re = /("image"\s*:\s*)"[^"]*"/g;
  const hits = text.match(re) || [];
  if (hits.length !== 1) throw new Error(`hosting.json has ${hits.length ? "more than one" : "no"} "image" setting; set platform.parameters.image to "${image}" by hand.`);
  return text.replace(re, `$1${JSON.stringify(image)}`);
}

// ------------------------------------------------------------------ running it

function findWorkspaceRoot(engineDir) {
  const parent = path.dirname(path.resolve(engineDir));
  for (let dir = parent; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".claude", "dashboard"))) return dir;
    if (path.dirname(dir) === dir) return parent;
  }
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; } };

/** az is az.cmd on Windows, which only a shell runs; docker is a real executable everywhere. */
function exec(cmd, args) {
  const shell = IS_WIN && cmd === "az";
  const r = spawnSync(shell ? [cmd, ...args].join(" ") : cmd, shell ? [] : args, { stdio: "inherit", shell });
  if (r.error) throw new Error(r.error.code === "ENOENT" ? `${cmd} isn't installed (or isn't on PATH).` : r.error.message);
  return r.status ?? 1;
}

function usage() {
  const top = fs.readFileSync(fileURLToPath(import.meta.url), "utf-8").split("*/")[0];
  console.log(top.replace(/^#!.*\n\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (o.help) { usage(); return 0; }

  const root = path.resolve(o.workspace || process.env.WORKSPACE_ROOT || findWorkspaceRoot(ENGINE_DIR));
  const hostingFile = path.join(root, ".claude", "dashboard", "hosting.json");
  const hosting = readJson(hostingFile);
  const version = readJson(path.join(root, ".claude", "dashboard", "engine.json"))?.version || readJson(path.join(ENGINE_DIR, "ENGINE.json"))?.version || null;

  const registry = o.registry || registryFromHosting(hosting);
  if (!registry) { console.error("No registry: pass --registry <server>, or set platform.parameters.registry in hosting.json (App Service)."); return 2; }
  if (o.updateHosting && hosting?.platform?.type !== "azure-app-service") {
    console.error(`--update-hosting is for App Service, where hosting.json names the image. On Kubernetes, change the image in ${hosting?.platform?.template || "your copy of kubernetes-person.yaml"}.`);
    return 2;
  }
  let plugin;
  try { plugin = findPlugin({ plugin: o.plugin, engineDir: ENGINE_DIR, version, claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") }); }
  catch (e) { console.error(e.message); return 2; }
  const tag = o.tag || defaultTag(version || "0.0.0");
  const { steps, refs } = plan({ which: o.which, registry, tag, push: o.push, pluginDir: plugin.dir, repo: dashboardRepo(hosting) });

  console.log(`Workspace: ${root}`);
  console.log(`Building from ${plugin.dir} (${plugin.how}), engine ${version || "version unknown"}.`);
  if (o.dryRun) {
    for (const [, cmd, args] of steps) console.log(`  ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    if (o.updateHosting) console.log(`  then set platform.parameters.image in ${hostingFile} to ${refs.dashboard.slice(registry.length + 1)}`);
    return 0;
  }

  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8" });
  if (docker.error || docker.status !== 0) { console.error("Docker isn't running (or isn't installed): start Docker, then run this again."); return 1; }

  for (const [label, cmd, args] of steps) {
    console.log(`\n> ${label}`);
    const code = exec(cmd, args);
    if (code !== 0) { console.error(`\n${label} failed (exit ${code}). Nothing after it ran.`); return code; }
  }

  if (o.updateHosting) {
    const image = refs.dashboard.slice(registry.length + 1);
    fs.writeFileSync(hostingFile, withImage(fs.readFileSync(hostingFile, "utf-8"), image));
    console.log(`\nhosting.json now names ${image}: the People page shows everyone as Needs update. Commit it.`);
  }
  console.log(`\n${o.push ? "Pushed" : "Built"}: ${Object.values(refs).join(", ")}`);
  if (!o.push) console.log("Push them with --push (nothing has left this machine).");
  if (o.push && refs.router) console.log("Point the router at its new image yourself (its Web App or Deployment); dashboards follow from the People page.");
  return 0;
}

if (/hosted-images\.mjs$/i.test(process.argv[1] || "")) process.exit(main());
