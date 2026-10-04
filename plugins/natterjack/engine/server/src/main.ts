/**
 * Workspace dashboard server: a local console for a multi-repo workspace.
 *
 *   node --disable-warning=ExperimentalWarning <engine>/server/src/main.ts [--port N]
 *   Port: --port, else the DASHBOARD_PORT env var, else workspace.json dashboard.port, else 3333.
 *
 * Serves the JSON API under /api (contract: <engine>/shared/api.ts) and the
 * built Angular app from <engine>/dist/browser. Local by default: binds 127.0.0.1,
 * rejects non-loopback Host headers, and every POST needs the per-install token.
 * Hosted mode (DASHBOARD_HOSTED, see hosted.ts) serves one person from a container
 * behind the company's login proxy instead.
 *
 * Config: .claude/dashboard/*.json + brand/ (the team's; see config.ts).
 * State:  .claude/ledger/ (gitignored): runs, app jobs, token, tracker key, personal links.
 */

import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { restartSelf } from "./self-restart.ts";
import type { Boot, LaunchRequest, ProfileInfo, PublishPlanResponse, RunEvent, RunMeta } from "../../shared/api.ts";
import { runTicket } from "../../shared/run-ticket.ts";
import { runWorkspace } from "../../shared/run-workspace.ts";
import { CLAUDE_SESSION_ENV } from "./claude.ts";
import {
  BRAND_DIR, DASHBOARD_DIR, ENGINE_FOLDER, LEDGER_DIR, WORKSPACE_ROOT,
  dashboardPort, portsFile, ticketInTextRe, ticketRe, workspaceConfig, worktreeRoot,
} from "./config.ts";
import * as workspaces from "./workspaces.ts";
import type { Ws } from "./workspaces.ts";

// The dashboard outlives whatever launched it. If that was a Claude Code session,
// its per-session markers are in our env and would leak into every process we
// start (apps, terminals). claude.ts strips them per spawn too; drop them here once.
for (const key of CLAUDE_SESSION_ENV) delete process.env[key];

import { RunManager, httpError } from "./runs.ts";
import { Deck, Scheduler } from "./deck.ts";
import { Inbox } from "./inbox.ts";
import { Watcher } from "./watches.ts";
import { Usage } from "./usage.ts";
import { UsageHistory } from "./usage-history.ts";
import { AppLauncher, appsConfig } from "./apps.ts";
import { LiveHub } from "./live.ts";
import { Trackers } from "./issues/index.ts";
import { readLinks, saveLink, deleteLink, readRepoReadme } from "./links.ts";
import { Machine, openTerminal } from "./machine.ts";
import { cloneStep, cloneTargets, readRepos, reposStatus } from "./repos.ts";
import { buildSnapshot, carryOver, downloadStep, downloadTargets, dropManifestCache, fetchManifest, planSnapshot, publishSnapshot, snapshotStatus, writeManifest } from "./snapshot.ts";
import type { PublishPlan } from "./snapshot.ts";
import { installerRoles } from "./installer.ts";
import type { SnapshotFile } from "./snapshot-sources/index.ts";
import type { Manifest } from "./snapshot-sources/manifest.ts";
import { SnapshotSources } from "./snapshot-sources/index.ts";
import type { SnapshotSource } from "./snapshot-sources/index.ts";
import { readProfile, reapplyProfile, setRole } from "./profile.ts";
import { DocSites, docAreas, docSources } from "./docs.ts";
import { Knowledge } from "./knowledge/index.ts";
import { agentOf, agentStatuses, isAgentId, type AgentStatus } from "./agents/index.ts";
import { KNOWLEDGE_TOOLS, addStoreSource, chosenTools, saveTools } from "./knowledge/tools.ts";
import { DocsProviders } from "./docs-providers/index.ts";
import { Memory } from "./memory.ts";
import { Connections, listedName } from "./connections.ts";
import { McpLogin, PTY_SIGN_IN } from "./mcp-login.ts";
import { Search } from "./search.ts";
import { claudeAuth, claudeAuthCached, claudeEnv } from "./claude.ts";
import { infrastructure } from "./infrastructure.ts";
import { RunChanges } from "./run-changes.ts";
import type { RunWorktree } from "./run-changes.ts";
import { Attachments, MAX_ATTACHMENT_BYTES, contentTypeOf } from "./attachments.ts";
import { Explore, MAX_SAVE_BYTES, rawType, resolveSafe } from "./explore.ts";
import { forgetAtlassianKeys } from "./atlassian.ts";
import { HOSTED_HIDDEN_PAGES, NOT_HOSTED, checkHostedRequest, hostedConfig } from "./hosted.ts";
import { ClaudeLogin } from "./claude-login.ts";

const DIST_DIR = path.join(DASHBOARD_DIR, "dist", "browser");
const VERSION = JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, "package.json"), "utf-8")).version;
/** When this server process started: the page compares it to tell a restarted server from the old one. */
const STARTED_AT = new Date().toISOString();

const MAIN_WORKSPACE_PATH: string = WORKSPACE_ROOT;
const GIT_CACHE_TTL_MS = 3000;
const GIT_DIFF_MAX_BYTES = 512 * 1024;

const DASHBOARD_PORT = dashboardPort();
/** Hosted mode's settings (hosted.ts), or null when running on someone's own machine. */
const HOSTED = (() => {
  try { return hostedConfig(); } catch (e) { console.error(e.message); process.exit(1); }
})();
const screenshotsSubdir = () => workspaceConfig().worktrees.screenshots;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

function listScreenshots(workspacePath: string) {
  const dir = path.join(workspacePath, screenshotsSubdir());
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_CONTENT_TYPES[path.extname(e.name).toLowerCase()])
      .map((e) => {
        const stat = fs.statSync(path.join(dir, e.name));
        return { name: e.name, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ git

const gitCache = new Map<string, { data: string; expires: number }>();

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: GIT_DIFF_MAX_BYTES, timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(stdout || "");
    });
  });
}

async function execGitCached(args: string[], cwd: string) {
  const key = `${cwd}::${args.join(" ")}`;
  const cached = gitCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.data;
  const data = await execGit(args, cwd);
  gitCache.set(key, { data, expires: Date.now() + GIT_CACHE_TTL_MS });
  return data;
}

/** Git repos in a workspace (see workspaces.ts): .worktree.json repos, the apps' repos, or "." for a monorepo. */
function listRepos(workspacePath: string): string[] {
  return workspaces.listRepos(workspacePath, appsConfig().apps);
}

/** The worktree's ticket: .worktree.json ticketId, else from its branch (native git worktrees). */
function readTicketId(workspacePath: string): string | null {
  const ws = listWorkspaces().find((w) => path.resolve(w.path) === path.resolve(workspacePath));
  return ws && ws.ticketId !== undefined ? ws.ticketId || null : workspaces.ticketOf(workspacePath, null, ticketInTextRe());
}

async function resolveMainRef(repoPath: string) {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      const out = await execGitCached(["rev-parse", "--verify", "--quiet", ref], repoPath);
      if (out.trim()) return ref;
    } catch {}
  }
  return null;
}

async function getRepoInfo(repoPath: string) {
  const mainRef = await resolveMainRef(repoPath);
  const [branchRaw, statusRaw, logRaw, aheadBehindRaw, branchDiffRaw] = await Promise.allSettled([
    execGitCached(["rev-parse", "--abbrev-ref", "HEAD"], repoPath),
    execGitCached(["status", "--porcelain=v1", "-u"], repoPath),
    execGitCached(["log", "--oneline", "--no-decorate", "-5"], repoPath),
    execGitCached(["rev-list", "--left-right", "--count", "@{u}...HEAD"], repoPath),
    mainRef ? execGitCached(["diff", "--name-status", `${mainRef}...HEAD`], repoPath) : Promise.resolve(""),
  ]);
  const ok = (r: PromiseSettledResult<string>) => (r.status === "fulfilled" ? r.value : "");
  const branch = ok(branchRaw).trim() || "unknown";

  // Uncommitted changes (working tree + staged + untracked) keyed by path.
  const fileMap = new Map<string, { status: string; source: string }>();
  for (const line of ok(statusRaw).split("\n")) {
    if (!line) continue;
    const code = line.substring(0, 2);
    let filePath = line.substring(3);
    if (code.trim().startsWith("R") && filePath.includes(" -> ")) filePath = filePath.split(" -> ").pop()!;
    const untracked = code === "??";
    fileMap.set(filePath, { status: untracked ? "??" : code.trim().charAt(0) || "M", source: untracked ? "untracked" : "uncommitted" });
  }
  // Committed on the branch; a file with both becomes "modified".
  for (const line of ok(branchDiffRaw).split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const filePath = parts[parts.length - 1];
    if (!filePath) continue;
    const existing = fileMap.get(filePath);
    if (existing) existing.source = "modified";
    else fileMap.set(filePath, { status: (parts[0] || "M").charAt(0), source: "committed" });
  }
  const changedFiles = [...fileMap.entries()].map(([file, info]) => ({ file, ...info })).sort((a, b) => a.file.localeCompare(b.file));

  const recentCommits: { hash: string; message: string }[] = [];
  for (const line of ok(logRaw).trim().split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0) recentCommits.push({ hash: line.substring(0, i), message: line.substring(i + 1) });
  }
  const ab = ok(aheadBehindRaw).trim().split(/\s+/);
  return { branch, mainRef, changedFiles, recentCommits, behind: parseInt(ab[0], 10) || 0, ahead: parseInt(ab[1], 10) || 0 };
}

async function getWorkspaceGitInfo(workspacePath: string) {
  const repos = listRepos(workspacePath);
  const results: Record<string, any> = {};
  await Promise.all(repos.map(async (dir) => {
    try {
      results[dir] = await getRepoInfo(path.join(workspacePath, dir));
    } catch {
      results[dir] = { branch: "error", mainRef: null, changedFiles: [], recentCommits: [], ahead: 0, behind: 0 };
    }
  }));
  const repoPaths: Record<string, string> = {};
  for (const dir of repos) repoPaths[dir] = path.join(workspacePath, dir);
  return { repos: results, ticketId: readTicketId(workspacePath), _paths: repoPaths };
}

async function getFileDiff(workspacePath: string, repoDir: string, filePath: string) {
  if (filePath.includes("..") || path.isAbsolute(filePath)) return null;
  const repoPath = path.join(workspacePath, repoDir);
  if (!fs.existsSync(path.join(repoPath, ".git"))) return null;
  // Cumulative diff vs main: committed-on-branch + staged + unstaged for tracked files.
  const base = (await resolveMainRef(repoPath)) || "HEAD";
  try {
    const diff = await execGit(["diff", base, "--", filePath], repoPath);
    if (diff.trim()) return diff;
  } catch {}
  // Untracked: diff against /dev/null (exit 1 with a diff comes back via stdout).
  try {
    return await execGit(["diff", "--no-index", "--", "/dev/null", filePath], repoPath);
  } catch (e) {
    return e?.stdout || "";
  }
}

// ------------------------------------------------------------------ apps / workspaces

/**
 * Port an app's own instance uses in a workspace, or null if the worktree hasn't been
 * allocated ports yet. Main (and mainOnly apps everywhere) use apps.json's port; worktrees
 * read theirs from the ports file (workspace.json worktrees.portsFile).
 */
function portOf(ws: Ws, key: string): number | null {
  return workspaces.ownPort(ws, key, appsConfig().apps, workspaces.readPortsData(portsFile()), worktreeRoot());
}

/** The port a workspace's apps should use to reach `key` ("fallback": "main" aware). */
function resolvePort(ws: Ws, key: string, starting: Set<string> = new Set()) {
  return workspaces.resolvePort(ws, key, appsConfig().apps, {
    own: portOf, isUp: checkPort, starting, cloned: (w, k) => launcher.available(w, k),
  });
}

/** Give a worktree its port slot (only when workspace.json worktrees.ports is set). */
function ensurePorts(ws: Ws) {
  const rule = workspaceConfig().worktrees.ports;
  if (rule && ws.slug !== "main") workspaces.ensureSlot(portsFile(), ws, appsConfig().apps, rule, worktreeRoot());
}

/**
 * TCP probe on IPv4 and IPv6 loopback (some dev servers bind only ::1). Tries twice
 * before calling a port down: one slow answer on a busy machine isn't an outage.
 */
async function checkPort(port: number): Promise<boolean> {
  return (await probePort(port, 800)) || probePort(port, 1500);
}

function probePort(port: number, timeout: number): Promise<boolean> {
  const probe = (host: string) => new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
  return probe("127.0.0.1").then((up) => up || probe("::1"));
}

/** Main workspace + every worktree: ports file, worktrees/<name>/.worktree.json, native git worktrees. */
function listWorkspaces(): Ws[] {
  return workspaces.listWorkspaces({
    root: MAIN_WORKSPACE_PATH,
    wtRoot: worktreeRoot(),
    portsData: workspaces.readPortsData(portsFile()),
    apps: appsConfig().apps,
    ticketInText: ticketInTextRe(),
  });
}

function workspaceBySlug(slug: unknown): Ws | null {
  return listWorkspaces().find((w) => w.slug === slug) || null;
}

/** The worktree a run worked in (the run page's rule) and its repos, or null for a run that stayed in main. */
function runWorktree(meta: RunMeta, events: RunEvent[]): RunWorktree | null {
  const all = listWorkspaces().map((w) => ({ slug: w.slug, path: w.path, _ticketId: w.ticketId || null }));
  const own = all.find((w) => w.slug === meta.workspace);
  const ws = runWorkspace(meta, all, events, runTicket(meta, own?._ticketId)?.id);
  if (!ws || ws.slug === "main") return null;
  return { path: ws.path, repos: listRepos(ws.path).map((r) => path.join(ws.path, r)) };
}

async function appStatus(ws: Ws, key: string) {
  const meta = appsConfig().apps[key];
  const port = portOf(ws, key);
  // An app with no port in apps.json (a worker) counts as running while the process we started is alive.
  const running = port ? await checkPort(port) : !meta.port && !!launcher.runningPid(ws, key);
  const job = launcher.busy(ws.slug, key);
  // A worktree app that falls back to main and isn't running here: its dependents use main's.
  // Shown when main's is up (it's what they use) or the app isn't cloned here (it's the only one).
  let fallback = null;
  if (ws.slug !== "main" && meta.fallback === "main" && !running && meta.port) {
    const mainUp = await checkPort(meta.port);
    if (mainUp || !launcher.available(ws, key)) fallback = { port: meta.port, running: mainUp };
  }
  return {
    fallback,
    key,
    name: meta.name,
    type: meta.type,
    group: meta.group,
    port,
    url: port ? `${meta.https ? "https" : "http"}://localhost:${port}` : null,
    running,
    repo: meta.workDir || meta.dir, // the folder "Make changes" names (an app in a sub-folder: that sub-folder)
    available: launcher.available(ws, key),
    busy: job ? job.label : null,
    blockedBy: (machine.cache && machine.cache.blocked[key]) || [],
  };
}

/** A main-workspace app this worktree relies on: it shares a stack with an app cloned here. */
function borrowed(ws: Ws, key: string): boolean {
  return Object.values(appsConfig().stacks).some((s) => s.apps.includes(key) && s.apps.some((k) => k !== key && launcher.available(ws, k)));
}

async function getStatus() {
  const apps = appsConfig().apps;
  const workspaces = await Promise.all(listWorkspaces().map(async (ws) => {
    // Main shows every app (unavailable ones as "not cloned"); a worktree only its cloned, non-mainOnly apps.
    const keys = ws.slug === "main"
      ? Object.keys(apps)
      : Object.keys(apps).filter((k) => !apps[k].mainOnly && (launcher.available(ws, k) || (launcher.fromMain(ws, k) && borrowed(ws, k))));
    return {
      name: ws.name, slug: ws.slug, path: ws.path,
      apps: await Promise.all(keys.map((k) => appStatus(ws, k))),
      screenshots: listScreenshots(ws.path),
      _ticketId: ws.ticketId || null,
    };
  }));
  return { workspaces, timestamp: new Date().toISOString() };
}

/** One probe pass at a time: callers that arrive while one is running share its result. */
let statusInFlight: Promise<Awaited<ReturnType<typeof getStatus>>> | null = null;
function sharedStatus() {
  return (statusInFlight ||= getStatus().finally(() => { statusInFlight = null; }));
}

// ------------------------------------------------------------------ services

fs.mkdirSync(LEDGER_DIR, { recursive: true });
const usage = new Usage(path.join(LEDGER_DIR, "usage-snapshots.jsonl"));
const usageHistory = new UsageHistory();
usageHistory.refresh().catch(() => {}); // first scan in the background so the Usage page opens fast
const runChanges = new RunChanges(path.join(LEDGER_DIR, "runs"));
const attachments = new Attachments(LEDGER_DIR);
const live = new LiveHub(); // topics registered once every service exists, below
const runs = new RunManager(LEDGER_DIR, {
  onFinish: () => { usage.invalidate(); live.refresh("runs"); live.refresh("overview"); }, // a finished turn moves the meters and preset stats
  onTurnStart: (meta) => { runChanges.snapshot({ ...meta }).catch(() => {}); },
  onChange: (meta) => live.publish("run", meta), // one run, not the whole list: a live run saves every 1.5 s
  // Messages queued during a turn go out under the same limits as a reply you send.
  queueGate: (meta) => ({ blocker: launchBlocker(meta.agent), budgetUsd: deck.config().limits.runBudget ? undefined : null }),
  attachments,
});
const deck = new Deck(MAIN_WORKSPACE_PATH, path.join(LEDGER_DIR, "settings.json"));

/** Delete done runs' attachments after keepAttachmentsDays (at start, then every 6 hours). */
function cleanupAttachments() {
  try {
    const removed = attachments.cleanup((id) => runs.get(id), (id) => runs.live.has(id), deck.config().limits.keepAttachmentsDays);
    for (const id of removed) runs.markAttachmentsRemoved(id);
  } catch { /* best effort */ }
}
cleanupAttachments();
setInterval(cleanupAttachments, 6 * 3600 * 1000).unref();
const inbox = new Inbox(runs);
const trackers = new Trackers(LEDGER_DIR);
const machine = new Machine(MAIN_WORKSPACE_PATH, { hosted: !!HOSTED });
const claudeLogin = new ClaudeLogin();
const docSites = new DocSites(MAIN_WORKSPACE_PATH);
const docsProviders = new DocsProviders(() => ({ ledgerDir: LEDGER_DIR, issues: workspaceConfig().issues }));
const snapshotSources = new SnapshotSources(() => ({ ledgerDir: LEDGER_DIR, issues: workspaceConfig().issues }));
// Someone's hidden skills and output style follow workspace.json roles if they changed while the dashboard was down.
reapplyProfile(LEDGER_DIR, MAIN_WORKSPACE_PATH);

const isReader = () => readProfile(LEDGER_DIR).profile === "reader";

function profileInfo(): ProfileInfo {
  const ws = workspaceConfig();
  const p = readProfile(LEDGER_DIR, ws.roles);
  return {
    profile: p.profile,
    role: p.current.id,
    chosen: p.chosen,
    roleChosen: p.roleChosen,
    configured: ws.rolesConfigured,
    // Their own outputStyle in settings.local.json wins over the role's.
    styleApplied: !p.current.outputStyle || p.outputStyle === p.current.outputStyle,
    roles: ws.roles,
  };
}

/** repos.json's snapshot source (null when there's no snapshot block); an unknown kind is a 400. */
function snapshotSource(): SnapshotSource | null {
  const cfg = readRepos(MAIN_WORKSPACE_PATH).snapshot;
  if (!cfg) return null;
  try { return snapshotSources.get(cfg); } catch (e) { throw httpError(400, e.message); }
}

/** Publish now: a developer, connected to a source that takes uploads; else a 4xx saying which. */
function publishableSource(): SnapshotSource {
  if (isReader()) throw httpError(403, "Publishing isn't available in the reader profile.");
  const source = snapshotSource();
  if (!source) throw httpError(400, "repos.json has no snapshot source.");
  if (!source.upload) throw httpError(400, `The ${source.label} source is download-only; publish to it from CI.`);
  if (!source.status().connected) throw httpError(400, `Connect ${source.label} first.`);
  return source;
}

/** The last plan shown in Publish now's confirmation: publish uploads exactly that, if it's recent. */
let pendingPlan: { id: string; at: number; plan: PublishPlan } | null = null;
const PLAN_TTL_MS = 15 * 60_000;

/** An external docs source and its provider, or a 404 (unknown source / no adapter for its provider). */
function externalDocs(key: unknown) {
  const source = docSources().sources.find((s) => s.key === String(key || ""));
  const provider = docsProviders.get(source);
  if (!source || !provider) throw httpError(404, `No searchable docs source ${String(key || "")}`);
  return { source, provider };
}

/** Provider failures reach the browser as 502 (the service), except bad input (400) and "connect first" (409). */
async function viaProvider<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e && e.status === 400) throw httpError(400, e.message);
    if (e && (e.status === 401 || e.status === 403)) throw httpError(409, e.message);
    throw httpError(502, (e && e.message) || "The docs service failed.");
  }
}

async function externalDocsStatus(key: unknown) {
  const { source, provider } = externalDocs(key);
  const st = provider.status();
  let spaces = [], error = null;
  if (st.connected) {
    try { spaces = await provider.spaces(); } catch (e) { error = e.message; }
  }
  return {
    site: source.key, name: source.name, provider: provider.kind, label: provider.label, url: source.url || null,
    ...st, help: st.connected ? null : provider.connectHelp(), spaces, error,
  };
}

/** The Knowledge setup panel: the catalog, what the team picked, its stores, and whether this dashboard can change it. */
function knowledgeSetup() {
  return {
    catalog: KNOWLEDGE_TOOLS, chosen: chosenTools(),
    stores: docSources().sources.filter((s) => s.kind === "store").map((s) => s.key),
    canEdit: !HOSTED,
  };
}

/**
 * What a run that should use these sources gets (unknown ones are refused): external
 * providers add a note on reaching them through their connector; knowledge stores add
 * their local copy as a folder to read, and a note on what's in it.
 */
function docsRunNote(keys: unknown, page: unknown): { keys: string[]; note: string | null; addDirs: string[] } {
  const list = Array.isArray(keys) ? [...new Set(keys.map(String))].slice(0, 5) : [];
  const stores = list.filter((k) => knowledge.source(k).kind === "store");
  const notes = list.filter((k) => !stores.includes(k)).map((k) => externalDocs(k).provider.runNote(list.length === 1 && page ? String(page) : null));
  const access = knowledge.runAccess(stores);
  if (access.note) notes.push(access.note);
  return { keys: list, note: notes.length ? notes.join("\n\n") : null, addDirs: access.addDirs };
}
const memory = new Memory(MAIN_WORKSPACE_PATH);
const knowledge = new Knowledge(MAIN_WORKSPACE_PATH, LEDGER_DIR);
const connections = new Connections(MAIN_WORKSPACE_PATH);
const mcpLogin = new McpLogin(MAIN_WORKSPACE_PATH);
const explore = new Explore(MAIN_WORKSPACE_PATH);
const search = new Search({
  root: MAIN_WORKSPACE_PATH,
  memory,
  issues: () => { const t = trackers.get(); return (t.cache && t.cache.issues) || []; },
  issueLabel: () => trackers.config().label,
  runs: () => runs.list(),
});
const launcher = new AppLauncher({
  logDir: path.join(LEDGER_DIR, "apps"),
  portOf,
  isUp: checkPort,
  mainWs: { slug: "main", name: "Main Workspace", path: MAIN_WORKSPACE_PATH },
  resolvePort: async (ws, key, starting) => (await resolvePort(ws, key, starting)).port,
  ensurePorts,
});
launcher.onChange = () => { live.refresh("jobs"); live.refresh("status"); };

/** /api/apps/jobs and the live `jobs` topic. */
function jobsView() {
  const cfg = appsConfig();
  return { jobs: launcher.list(), stacks: cfg.stacks, groups: cfg.groups, defaultStack: cfg.defaultStack, hasSetup: !!cfg.setup, configured: cfg.configured, error: cfg.error };
}

/** /api/deck and the live `deck` topic. */
function deckView() {
  return {
    ...deck.config(),
    stats: runs.stats(),
    // A role's hidden skills are off in Claude too (profile.ts); don't offer them here.
    skills: ((hidden) => deck.skills().filter((s) => !hidden.includes(s.name)))(readProfile(LEDGER_DIR).current.hiddenSkills),
    workspaces: listWorkspaces().map(({ slug, name, ticketId }) => ({ slug, name, ticketId })),
    options: { models: MODELS, efforts: EFFORTS, permissionModes: PERMISSION_MODES },
  };
}

claudeAuth().catch(() => {}); // sign-in state: runs check it before starting
machine.get().catch(() => {}); // warm caches so the first page load has them
usage.get().catch(() => {});
Promise.resolve().then(() => trackers.get().issues(deck.config().issues)).catch(() => {});

/** A ticket id from a request, normalized, or null if it doesn't look like one of the team's. */
function ticketParam(v: unknown): string | null {
  const raw = String(v || "").trim();
  if (ticketRe().test(raw)) return raw;
  const up = raw.toUpperCase();
  return ticketRe().test(up) ? up : null;
}
const MODEL_RE = /^[a-z][a-z0-9.\-]{1,63}(\[[a-z0-9]+\])?$/;
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Every effort another agent may take (Codex adds "ultra"); the CLI rejects one its model doesn't. */
const AGENT_EFFORTS = [...EFFORTS, "ultra", "none"];
const PERMISSION_MODES = ["auto", "acceptEdits", "dontAsk", "plan"];
const TRIGGERS = new Set(["manual", "ask", "explain", "search", "issues", "make-changes"]);
const MAX_RUN_BUDGET_USD = 100;
const SESSIONS_TTL_MS = 5000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The agents' last status (installed, signed in, models), refreshed in the background. */
let agentsCache: { at: number; list: AgentStatus[] } | null = null;
function agentsNow(force = false): Promise<AgentStatus[]> {
  return agentStatuses(force).then((list) => { agentsCache = { at: Date.now(), list }; return list; });
}
agentsNow().catch(() => {});

/** Shared guard for manual and scheduled launches (and replies). Returns an error string or null. */
function launchBlocker(agentId: unknown = "claude"): string | null {
  const agent = agentOf(agentId);
  if (agent.id !== "claude") {
    // Another agent: its last known status (installed, signed in); the dashboard's own limits still apply.
    if (!agentsCache || Date.now() - agentsCache.at > 60_000) agentsNow().catch(() => {});
    const st = agentsCache?.list.find((a) => a.id === agent.id);
    if (st && st.problem) return st.problem;
    const { limits } = deck.config();
    if (runs.runningCount() >= limits.maxConcurrentRuns) return `Already ${runs.runningCount()} runs in flight (limit ${limits.maxConcurrentRuns}).`;
    return null;
  }
  // Claude Code itself: a clear message now beats a run that fails on its first turn.
  const auth = claudeAuthCached();
  if (!auth || Date.now() - auth.checkedAt > 60000) claudeAuth().catch(() => {}); // refresh for next time
  if (auth && !auth.installed) return "Claude Code isn't installed on this machine. Open the Machine page to install it.";
  if (auth && !auth.loggedIn) {
    return HOSTED
      ? "You aren't signed in to Claude yet. Open the Machine page and click Sign in to Claude, then try again."
      : "Claude Code isn't signed in. Open the Machine page and click Sign in (it opens a terminal for the browser sign-in), then try again.";
  }
  const { limits } = deck.config();
  if (runs.runningCount() >= limits.maxConcurrentRuns) {
    return `Already ${runs.runningCount()} runs in flight (limit ${limits.maxConcurrentRuns}).`;
  }
  // Subscription limits, from the last /usage read (at most a couple of minutes old).
  const report = usage.peek();
  for (const m of (report && report.meters) || []) {
    const cap = m.kind === "session" ? limits.pauseAtSessionPct : m.kind === "week" ? limits.pauseAtWeeklyPct : null;
    if (cap != null && m.pct >= cap) return `${m.label} is at ${m.pct}% (runs pause at ${cap}%)${m.resets ? `; resets ${m.resets}` : ""}.`;
  }
  if (limits.dailyBudgetUsd) {
    const spent = runs.spentSince(startOfToday());
    if (spent >= limits.dailyBudgetUsd) return `Daily budget reached: $${spent.toFixed(2)} of $${limits.dailyBudgetUsd}.`;
  }
  return null;
}

/** Validate a launch request and start the run. Throws with a user-facing message. */
function launchRun(body: LaunchRequest, trigger: string): RunMeta {
  const presetAgent = body.presetId ? (deck.preset(body.presetId) as any)?.agent : undefined;
  const agentId = body.agent ?? presetAgent ?? deck.config().defaults.agent ?? "claude";
  if (!isAgentId(agentId)) throw httpError(400, `Unknown agent ${agentId}`);
  const blocker = launchBlocker(agentId);
  if (blocker) throw httpError(429, blocker);

  const preset = body.presetId ? deck.preset(body.presetId) : null;
  if (body.presetId && !preset) throw httpError(400, `Unknown preset ${body.presetId}`);
  const prompt = preset ? deck.renderPrompt(preset, body.args || {}, body.options || {}) : String(body.prompt || "").trim();
  if (!prompt) throw httpError(400, "Prompt is empty.");

  const pick = (key: string) => ((body as any)[key] !== undefined && (body as any)[key] !== "" ? (body as any)[key] : preset ? preset[key] : undefined);
  // Nothing chosen (Explain, routines, Implement from Issues…): the deck's default model/effort.
  const { defaults, limits } = deck.config();
  // The deck's default model and effort are Claude's; another agent uses its own default unless one is picked.
  const model = pick("model") || (agentId === "claude" ? defaults.model : null);
  const effort = pick("effort") || (agentId === "claude" ? defaults.effort : null);
  const permissionMode = pick("permissionMode") || "auto";
  // No per-run cap unless the runBudget setting is on (on a subscription it only stops working runs).
  const budgetUsd = limits.runBudget ? Number(pick("budgetUsd")) || 5 : null;
  // A model becomes a CLI argument: aliases or full ids only (e.g. rejects "--bare").
  if (model && !MODEL_RE.test(model)) throw httpError(400, `Invalid model ${model}`);
  if (effort && !(agentId === "claude" ? EFFORTS : AGENT_EFFORTS).includes(effort)) throw httpError(400, `Unknown effort ${effort}`);
  if (!PERMISSION_MODES.includes(permissionMode)) throw httpError(400, `Unsupported permission mode ${permissionMode}`);
  if (budgetUsd !== null && (budgetUsd <= 0 || budgetUsd > MAX_RUN_BUDGET_USD)) throw httpError(400, `Budget must be between $0 and $${MAX_RUN_BUDGET_USD}.`);
  const attachmentIds = attachments.check(body.attachments);

  const ws = workspaceBySlug(body.workspace || (preset && preset.workspace) || "main");
  if (!ws) throw httpError(400, `Unknown workspace ${body.workspace}`);
  const args = body.args || {};
  const argText = Object.values(args).filter(Boolean).join(" ");
  const docs = docsRunNote(body.docSources, body.docPage);

  return runs.start({
    docSources: docs.keys,
    extraPrompt: docs.note,
    addDirs: docs.addDirs,
    presetId: preset ? preset.id : null,
    label: preset ? `${preset.label}${argText ? ` · ${argText}` : ""}` : prompt.split("\n")[0].slice(0, 60),
    prompt,
    cwd: ws.path,
    workspace: ws.slug,
    model,
    effort,
    permissionMode: permissionMode === "plan" ? "auto" : permissionMode,
    planMode: !!body.planMode || permissionMode === "plan",
    budgetUsd,
    trigger: body.trigger && TRIGGERS.has(body.trigger) ? body.trigger : trigger,
    attachments: attachmentIds,
    agent: agentId,
  });
}

function settingsView() {
  const team = deck.teamConfig();
  const mine = deck.personal();
  const eff = deck.config();
  return {
    team: { limits: team.limits, defaults: team.defaults },
    mine,
    effective: { limits: eff.limits, defaults: eff.defaults },
    options: { models: MODELS, efforts: EFFORTS },
    attachments: attachments.usage(),
  };
}

/** A raw request body (an upload), up to `max` bytes. */
function readRawBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > max) { reject(httpError(413, `Files can be up to ${Math.round(max / 1024 / 1024)} MB.`)); req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const scheduler = new Scheduler(deck, path.join(LEDGER_DIR, "scheduler-state.json"), (routine, preset) => {
  try {
    return { ok: true, run: launchRun({ presetId: preset.id, workspace: routine.workspace, args: routine.args }, `routine:${routine.id}`) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
scheduler.start();

// PR watches (<<WATCH>> blocks): a change on a watched PR is a reply to its run, under the same limits as yours.
const watcher = new Watcher(runs, {
  wake: (id, text) => {
    const blocker = launchBlocker(runs.get(id)?.agent);
    if (blocker) return blocker;
    try {
      runs.reply(id, text, { budgetUsd: deck.config().limits.runBudget ? undefined : null });
      return null;
    } catch (e) {
      return e.message;
    }
  },
});
watcher.start();

// /api/events: the shared data each page used to poll. Cadences are the old poll
// intervals; runs and jobs also refresh the moment they change (hooks above).
live.register("jobs", jobsView, 10000);
live.register("runs", () => ({ runs: runs.list().slice(0, 200), stats: runs.stats() }), 15000);
live.register("overview", getOverview, 5000);
live.register("status", sharedStatus, 5000);
live.register("deck", deckView, 30000);
live.register("inbox", () => inbox.get(false), 60000);

let sessionsCache = { at: 0, data: [] as any[] };
function listSessions(): Promise<any[]> {
  if (Date.now() - sessionsCache.at < SESSIONS_TTL_MS) return Promise.resolve(sessionsCache.data);
  return new Promise((resolve) => {
    execFile("claude", ["agents", "--json"], { timeout: 10000, windowsHide: true, env: claudeEnv() }, (err, stdout) => {
      let data: any[] = [];
      try { data = JSON.parse(stdout || "[]"); } catch {}
      if (err && !data.length) data = sessionsCache.data;
      sessionsCache = { at: Date.now(), data };
      resolve(data);
    });
  });
}

async function getOverview() {
  const all = runs.list();
  const today = startOfToday();
  const weekAgo = Date.now() - 7 * 86400000;
  const week = all.filter((r) => Date.parse(r.startedAt) >= weekAgo && r.status !== "running");
  const { limits } = deck.config();
  const runBySession = new Map(all.map((r) => [r.sessionId, r.id]));
  const [rawSessions, usageReport] = await Promise.all([listSessions(), usage.get().catch(() => null)]);
  return {
    stats: {
      runsToday: all.filter((r) => Date.parse(r.startedAt) >= today).length,
      running: runs.runningCount(),
      waiting: all.filter((r) => r.status === "waiting").length,
      maxConcurrentRuns: limits.maxConcurrentRuns,
      pauseAtSessionPct: limits.pauseAtSessionPct,
      pauseAtWeeklyPct: limits.pauseAtWeeklyPct,
      weekRuns: week.length,
      weekSucceeded: week.filter((r) => r.status === "succeeded").length,
    },
    usage: usageReport,
    sessions: rawSessions.map((s) => ({ ...s, runId: runBySession.get(s.sessionId) || null })),
    routines: scheduler.view(),
    desktopTasks: deck.desktopTasks(),
    timestamp: new Date().toISOString(),
  };
}

/** Dashboard runs per local day for the Usage page: counts by status and by what started them. */
function runsByDay(days: number) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const out = new Map<string, { date: string; byStatus: Record<string, number>; byTrigger: Record<string, number>; turns: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.set(key, { date: key, byStatus: {}, byTrigger: {}, turns: 0 });
  }
  for (const r of runs.list()) {
    const t = new Date(r.startedAt);
    const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    const day = out.get(key);
    if (!day) continue;
    day.byStatus[r.status] = (day.byStatus[r.status] || 0) + 1;
    const trig = r.trigger.startsWith("routine:") ? "routine" : r.presetId ? "preset" : r.trigger;
    day.byTrigger[trig] = (day.byTrigger[trig] || 0) + 1;
    day.turns += r.turns || 1;
  }
  return [...out.values()];
}

/** Issues plus local context: an existing worktree, and any dashboard implement/explain run. */
async function getIssues(force: boolean) {
  const cfg = deck.config().issues;
  const tracker = trackers.get();
  const tcfg = trackers.config();
  const reader = isReader();
  // Your own board filter (Settings → issues.query), when the tracker has a query language.
  const queryHelp = tracker.queryHelp();
  const query = queryHelp ? deck.personal().issues.query || "" : "";
  let data;
  try { data = await tracker.issues({ ...cfg, query }, force); }
  catch (e) { data = { connected: true, issues: [], error: `Your filter: ${e.message}` }; }
  const list = data.issues || [];
  const worktrees = new Set(listWorkspaces().map((w) => (w.ticketId || w.name || "").toUpperCase()));
  const lastRuns = new Map<string, any>();
  for (const r of runs.list()) {
    // "Explain Linear issue X" is how older runs were worded.
    const m = /^\/implement\s+(\S+)/.exec(r.prompt || "") || /^Explain (?:Linear )?issue (\S+?):/.exec(r.prompt || "");
    if (m && !lastRuns.has(m[1])) lastRuns.set(m[1], { id: r.id, status: r.status, startedAt: r.startedAt });
  }
  // No states/teams configured: show whatever the tracker returned, in the order first seen.
  const seen = (key: string) => [...new Set(list.map((i) => i[key]).filter(Boolean))] as string[];
  const implementTeams: string[] = cfg.implementTeams || [];
  return {
    ...data,
    tracker: { kind: tcfg.kind, label: tcfg.label, configured: tcfg.configured, supported: tcfg.supported },
    connect: data.connected ? null : tracker.connectHelp(),
    states: cfg.states && cfg.states.length ? cfg.states : seen("state"),
    teams: cfg.teams && cfg.teams.length ? cfg.teams : seen("team"),
    viewer: tracker.status().viewer,
    keySource: tracker.status().source,
    query: queryHelp ? { value: query, ...queryHelp } : null,
    issues: list.map((i) => ({
      ...i,
      canImplement: !reader && tcfg.implementStates.includes(i.state) && (!implementTeams.length || implementTeams.includes(i.team)),
      hasWorktree: worktrees.has(String(i.id).toUpperCase()),
      lastRun: lastRuns.get(i.id) || null,
    })),
  };
}

function explainPrompt(issue: any) {
  return [
    `Explain issue ${issue.id}: "${issue.title}" (${issue.team}, ${issue.state}${issue.assignee ? `, assigned to ${issue.assignee}` : ""}).`,
    "",
    "Issue description:",
    "---",
    issue.description.trim() || "(no description)",
    "---",
    "",
    "Explain in plain language what it asks for and why, which parts of the codebase it likely touches (look at the code to confirm, and name files), open questions or risks, and a rough size. Don't change anything.",
  ].join("\n");
}

// ------------------------------------------------------------------ server

// The server can start processes with the user's credentials, so a page on
// another origin must not reach it:
//   1. listen on 127.0.0.1 only
//   2. Host must be localhost/127.0.0.1 on our port (defeats DNS rebinding)
//   3. every POST needs the token, sent as a custom header: a cross-origin page
//      can't read it (GET /api/boot is same-origin only) and can't send the header
//      without a CORS preflight we never approve.
// The token persists in the gitignored ledger so open tabs survive a restart.
// Hosted mode swaps 1 and 2 for hosted.ts's checks (the proxy's secret, the public Host
// and Origin, the signed-in owner); the token stays.
function loadDashToken() {
  const file = path.join(LEDGER_DIR, "dashboard-token");
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (/^[0-9a-f]{48}$/.test(existing)) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
const DASH_TOKEN = loadDashToken();
const ALLOWED_HOSTS = new Set([`localhost:${DASHBOARD_PORT}`, `127.0.0.1:${DASHBOARD_PORT}`]);
/** Our own origin, plus the UI dev server (ng serve, workspace.json dashboard.devPort) that proxies to us. */
function originAllowed(origin: string) {
  const ports = [DASHBOARD_PORT, workspaceConfig().dashboard.devPort];
  return ["http://localhost", "http://127.0.0.1"].some((o) => ports.some((port) => origin === `${o}:${port}`));
}

/** GET /api/boot: the token plus who this workspace is (name, brand, tracker) for the UI. `user`: hosted mode's signed-in email. */
function bootInfo(user: string | null): Boot {
  const ws = workspaceConfig();
  const tracker = trackers.get();
  const tcfg = trackers.config();
  return {
    token: DASH_TOKEN,
    platform: process.platform,
    workspaceRoot: MAIN_WORKSPACE_PATH,
    engineDir: ENGINE_FOLDER,
    version: VERSION,
    startedAt: STARTED_AT,
    port: DASHBOARD_PORT,
    workspace: {
      name: ws.name,
      title: ws.dashboard.title,
      logo: ws.brand.logo ? `/ds/${ws.brand.logo}` : null,
      logoAlt: ws.brand.logoAlt || ws.name,
      favicon: ws.brand.favicon ? `/ds/${ws.brand.favicon}` : null,
      copy: ws.copy,
    },
    issues: {
      kind: tcfg.kind,
      label: tcfg.label,
      configured: tcfg.configured,
      ticketPattern: tcfg.ticketPattern,
      // {id} placeholder; built from the adapter so the UI never hardcodes a tracker's URLs.
      urlTemplate: tracker.issueUrl("{id}"),
    },
    profile: (() => {
      const me = readProfile(LEDGER_DIR, ws.roles);
      // ask: the team has roles and this person hasn't picked one yet (the first-start question).
      const hiddenPages = HOSTED ? [...new Set([...me.current.hiddenPages, ...HOSTED_HIDDEN_PAGES])] : me.current.hiddenPages;
      return { current: me.profile, role: me.current.id, roleLabel: me.current.label, ask: ws.rolesConfigured && !me.roleChosen, hiddenPages };
    })(),
    hosted: HOSTED ? { user } : null,
  };
}

/**
 * /ds/<file>: the team's brand (tokens CSS, logo, favicon) from .claude/dashboard/brand/,
 * falling back to the neutral defaults built into the UI (dist/browser/ds/).
 */
function serveBrand(res: http.ServerResponse, pathname: string): boolean {
  let rel: string;
  try { rel = decodeURIComponent(pathname.slice("/ds/".length)); } catch { return false; }
  if (!rel || rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) return false;
  const full = path.resolve(BRAND_DIR, rel);
  if (!full.startsWith(path.resolve(BRAND_DIR) + path.sep)) return false;
  let st: fs.Stats;
  try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    "Content-Type": STATIC_TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ttf": "font/ttf", ".otf": "font/otf",
};

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, { error: message }, status);
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 64 * 1024) { reject(httpError(413, "Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(httpError(400, "Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The built Angular app, read from disk on each request (a rebuild needs no restart). */
function serveApp(res: http.ServerResponse, pathname: string) {
  const index = path.join(DIST_DIR, "index.html");
  if (!fs.existsSync(index)) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><title>Dashboard not built</title><body style="font-family:sans-serif;padding:2rem">
      <h1>The dashboard UI isn't built yet</h1><p>Run <code>node ${esc(ENGINE_FOLDER)}/bin/dashboard.mjs restart</code>
      (it builds the UI when needed), or <code>npm ci &amp;&amp; npm run build</code> in <code>${esc(ENGINE_FOLDER)}/</code>.</p>`);
  }
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  const full = path.resolve(DIST_DIR, "." + rel);
  const inside = full.startsWith(path.resolve(DIST_DIR) + path.sep);
  if (inside && fs.existsSync(full) && fs.statSync(full).isFile()) {
    const hashed = /-[A-Z0-9]{8,}\.(js|css)$/i.test(full);
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    return fs.createReadStream(full).pipe(res);
  }
  // A path with a file extension that doesn't exist is a 404; anything else is an app route.
  if (path.extname(rel)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  fs.createReadStream(index).pipe(res);
}

function serveScreenshot(req: http.IncomingMessage, res: http.ServerResponse) {
  const match = req.url!.match(/^\/screenshots\/([^/]+)\/([^/?#]+)/);
  if (!match) { res.writeHead(404); return res.end("Not found"); }
  const slug = decodeURIComponent(match[1]);
  const filename = decodeURIComponent(match[2]);
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || filename.startsWith(".")) { res.writeHead(400); return res.end("Bad request"); }
  const ws = workspaceBySlug(slug);
  if (!ws) { res.writeHead(404); return res.end("Unknown workspace"); }
  const contentType = IMAGE_CONTENT_TYPES[path.extname(filename).toLowerCase()];
  if (!contentType) { res.writeHead(415); return res.end("Unsupported media type"); }
  const base = path.resolve(ws.path, screenshotsSubdir());
  const full = path.resolve(base, filename);
  if (!full.startsWith(base + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size, "Cache-Control": "no-cache" });
    fs.createReadStream(full).pipe(res);
  });
}

async function openTerminalForRun(run: RunMeta) {
  const agent = agentOf(run.agent);
  const command = agent.resumeCommand(run.sessionId);
  const r = await openTerminal(command, run.cwd, `${agent.label} · ${run.label}`.slice(0, 60), "Session ended. You can close this window.");
  return { opened: r.opened, command: `cd "${run.cwd}"; ${command}` };
}

const RUN_ROUTE = /^\/api\/runs\/([a-z0-9-]+)(?:\/(stream|cancel|verdict|flag|terminal|continuation|reply|plan-mode|changes|diff|rename|watch-stop|queue|queue-edit|queue-remove|queue-send|queue-auto))?$/i;
const RUN_FILE_ROUTE = /^\/api\/runs\/([a-z0-9-]+)\/files\/([^/]+)$/i;

/** One of a run's attached files: images and PDFs inline, anything else as a download. */
function serveRunFile(res: http.ServerResponse, runId: string, file: string) {
  const full = attachments.file(runId, file);
  if (!full) return sendError(res, 404, "That file is gone (attachments are deleted a while after a run is done).");
  const type = contentTypeOf(full);
  const inline = type.startsWith("image/") || type === "application/pdf" || type.startsWith("text/");
  const name = file.replace(/^[a-f0-9]{12}-/, "");
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": fs.statSync(full).size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    // Text is shown as text; nothing uploaded is ever rendered as a page.
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`,
  });
  fs.createReadStream(full).pipe(res);
}

/**
 * GET /api/explore/raw/<path>: a workspace file's bytes, for Explore's previews.
 * `sandbox` gives a previewed page an opaque origin even if opened directly, so
 * its requests carry Origin: null and can't reach the rest of the API.
 */
function serveExploreRaw(res: http.ServerResponse, pathname: string) {
  let rel: string;
  try { rel = decodeURIComponent(pathname.slice("/api/explore/raw/".length)); } catch { return sendError(res, 400, "Bad path"); }
  const full = resolveSafe(MAIN_WORKSPACE_PATH, rel);
  const st = fs.statSync(full);
  if (!st.isFile()) return sendError(res, 404, "Not a file");
  res.writeHead(200, {
    "Content-Type": rawType(full),
    "Content-Length": st.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
  });
  fs.createReadStream(full).pipe(res);
}

/** POSTs that open something on the server's own screen or ports, refused when hosted. */
const LOCAL_ONLY_POSTS = new Set(["/api/machine/install", "/api/knowledge/setup", "/api/knowledge/store-source", "/api/docs/preview", "/api/apps/action", "/api/restart"]);

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, user: string | null) {
  const p = url.pathname;
  const q = (k: string) => url.searchParams.get(k);
  const force = q("force") === "1";
  const runMatch = p.match(RUN_ROUTE);

  if (req.method === "GET") {
    const fileMatch = p.match(RUN_FILE_ROUTE);
    if (fileMatch) return serveRunFile(res, fileMatch[1], decodeURIComponent(fileMatch[2]));
    if (p === "/api/settings") return sendJson(res, settingsView());
    if (p.startsWith("/api/explore/raw/")) return serveExploreRaw(res, p);
    if (p === "/api/explore/list") return sendJson(res, explore.list(q("path")));
    if (p === "/api/explore/file") return sendJson(res, explore.read(q("path")));
    if (p === "/api/boot") return sendJson(res, bootInfo(user));
    if (p === "/api/events") return live.subscribe(res);
    if (p === "/api/status") return sendJson(res, await sharedStatus());
    if (p === "/api/overview") return sendJson(res, await getOverview());
    if (p === "/api/inbox") return sendJson(res, await inbox.get(force));
    if (p === "/api/usage") return sendJson(res, await usage.get(force));
    if (p === "/api/usage/history") {
      const days = Math.min(Math.max(parseInt(q("days") || "", 10) || 30, 7), 90);
      if (force) await usageHistory.refresh(true);
      return sendJson(res, {
        tokens: await usageHistory.report(days),
        limits: usage.history(Math.min(days, 14)),
        runs: runsByDay(days),
      });
    }
    if (p === "/api/commands") return sendJson(res, { commands: await usage.listCommands() });
    if (p === "/api/issues" || p === "/api/linear/issues") return sendJson(res, await getIssues(force));
    if (p === "/api/issues/issue" || p === "/api/linear/issue") {
      const id = ticketParam(q("id"));
      if (!id) return sendError(res, 400, "Invalid ticket id");
      return sendJson(res, await trackers.get().issue(id));
    }
    if (p === "/api/machine") {
      const report = await machine.get(force);
      if (appsConfig().setup || !report) return sendJson(res, report);
      // No setup step in apps.json: a "Run setup" button would only fail, so point at compose instead.
      return sendJson(res, {
        ...report,
        checks: report.checks.map((c) => (c.action === "setup"
          ? { ...c, action: undefined, fix: c.fix === "Run setup" ? "docker compose up -d  (in the folder with the compose file)" : c.fix }
          : c)),
      });
    }
    if (p === "/api/repos") return sendJson(res, await reposStatus(MAIN_WORKSPACE_PATH));
    if (p === "/api/snapshot") {
      // A source this engine has no adapter for is a state the Repos page explains (label null), not an error;
      // connect, download and publish still refuse it.
      let source: SnapshotSource | null = null;
      try { source = snapshotSource(); } catch { source = null; }
      return sendJson(res, await snapshotStatus(MAIN_WORKSPACE_PATH, source, force));
    }
    if (p === "/api/profile") return sendJson(res, profileInfo());
    if (p === "/api/apps/jobs") return sendJson(res, jobsView());
    if (p === "/api/apps/log") {
      const job = q("job");
      const files = job ? launcher.log(job) : launcher.appLog(q("workspace"), q("app"));
      return files ? sendJson(res, { files }) : sendError(res, 404, "No log");
    }
    if (p === "/api/docs") {
      const defs = docSources().sources;
      const stale = knowledge.staleCounts();
      const sites = docSites.list().map((s) => {
        const store = s.kind === "store" ? knowledge.storeStatus(s.key) : null;
        // A connected store keeps itself fresh while people use the page.
        if (store && store.connected) knowledge.sync(s.key).catch(() => {});
        return {
          ...s, stale: stale[s.key] || 0, store,
          // "Use <source>" in Ask and the launch dialog: searchable external sources, and stores with a copy.
          searchable: s.kind === "store" ? !!(store && store.files) : !!docsProviders.get(defs.find((d) => d.key === s.key)),
        };
      });
      return sendJson(res, { sites, areas: docAreas() });
    }
    if (p === "/api/knowledge/notes") {
      const key = String(q("source") || "");
      const src = knowledge.source(key);
      if (src.kind === "store") knowledge.sync(key).catch(() => {});
      const notes = knowledge.notesWithFreshness(key);
      const tags: Record<string, number> = {};
      for (const n of notes) for (const t of n.tags) tags[t] = (tags[t] || 0) + 1;
      return sendJson(res, { source: key, notes, tags, store: src.kind === "store" ? knowledge.storeStatus(key) : null });
    }
    if (p === "/api/knowledge/note") return sendJson(res, knowledge.read(q("source"), q("rel")));
    if (p === "/api/knowledge/setup") return sendJson(res, knowledgeSetup());
    if (p === "/api/knowledge/image") {
      const img = knowledge.imageFile(q("source"), q("rel"));
      if (!img) return sendError(res, 404, "No such image");
      // An SVG can carry script: sandboxed, like run files.
      res.writeHead(200, { "Content-Type": img.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox" });
      fs.createReadStream(img.file).pipe(res);
      return;
    }
    if (p === "/api/docs/external") return sendJson(res, await externalDocsStatus(q("site")));
    if (p === "/api/docs/external/search") {
      const { provider } = externalDocs(q("site"));
      const spaces = String(q("spaces") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const limit = Math.min(50, Math.max(1, parseInt(q("limit") || "", 10) || 25));
      return sendJson(res, { hits: await viaProvider(() => provider.search(String(q("q") || "").slice(0, 200), spaces, limit)) });
    }
    if (p === "/api/docs/external/page") {
      const { provider } = externalDocs(q("site"));
      return sendJson(res, await viaProvider(() => provider.page(String(q("id") || ""))));
    }
    if (p === "/api/docs/external/search-all") {
      // Global search: every connected source, a few hits each; a failing source is left out.
      const text = String(q("q") || "").trim().slice(0, 200);
      if (text.length < 3) return sendJson(res, { groups: [] });
      const groups = [];
      await Promise.all(docSources().sources.map(async (s) => {
        const provider = docsProviders.get(s);
        if (!provider || !provider.status().connected) return;
        try { groups.push({ site: s.key, name: s.name, hits: await provider.search(text, [], 5) }); } catch {}
      }));
      return sendJson(res, { groups: groups.filter((g) => g.hits.length) });
    }
    if (p === "/api/docs/pages") {
      const site = String(q("site") || "");
      const info = docSites.list().find((s) => s.key === site);
      if (!info) return sendError(res, 404, `Unknown docs site ${site}`);
      return sendJson(res, { site: info, pages: search.pages(site) });
    }
    if (p === "/api/links") return sendJson(res, readLinks(MAIN_WORKSPACE_PATH));
    if (p === "/api/readme") {
      const r = readRepoReadme(MAIN_WORKSPACE_PATH, q("repo"));
      return r ? sendJson(res, r) : sendError(res, 404, "No README in that repo");
    }
    if (p === "/api/infrastructure") return sendJson(res, infrastructure(MAIN_WORKSPACE_PATH));
    if (p === "/api/memory") return sendJson(res, memory.list());
    if (p === "/api/agents") return sendJson(res, { agents: await agentsNow(force) });
    if (p === "/api/connections") return sendJson(res, await connections.list({ wait: q("wait") === "1", force }));
    if (p === "/api/search") {
      const limit = Math.min(parseInt(q("limit") || "", 10) || 40, 100);
      return sendJson(res, search.query(String(q("q") || "").slice(0, 200), { source: q("source") || undefined, site: q("site") || undefined, limit }));
    }
    if (p === "/api/search/stats") return sendJson(res, search.stats());
    if (p === "/api/search/doc") {
      const d = search.doc(String(q("id") || ""));
      return d ? sendJson(res, d) : sendError(res, 404, "Not in the index");
    }
    if (p === "/api/deck") return sendJson(res, deckView());
    if (p === "/api/runs") {
      const limit = Math.min(parseInt(q("limit") || "", 10) || 100, 500);
      return sendJson(res, { runs: runs.list().slice(0, limit), stats: runs.stats() });
    }
    if (runMatch && !runMatch[2]) {
      const meta = runs.get(runMatch[1]);
      if (!meta) return sendError(res, 404, "Unknown run");
      // ?events=0: the run page gets the events from the stream's replay instead.
      return sendJson(res, { run: meta, events: q("events") === "0" ? [] : runs.events(meta.id) });
    }
    if (runMatch && runMatch[2] === "changes") {
      const meta = runs.get(runMatch[1]);
      if (!meta) return sendError(res, 404, "Unknown run");
      const events = runs.events(meta.id);
      return sendJson(res, await runChanges.changes(meta, events, force, runWorktree(meta, events)));
    }
    if (runMatch && runMatch[2] === "diff") {
      const meta = runs.get(runMatch[1]);
      if (!meta) return sendError(res, 404, "Unknown run");
      const repo = String(q("repo") || ""), file = String(q("file") || "");
      if (!repo || !file || file.includes("..") || path.isAbsolute(file)) return sendError(res, 400, "Missing or invalid repo/file");
      const events = runs.events(meta.id);
      return sendJson(res, { diff: await runChanges.fileDiff(meta, events, repo, file, runWorktree(meta, events)) });
    }
    if (runMatch && runMatch[2] === "continuation") {
      const cont = runs.continuation(runMatch[1]);
      return cont ? sendJson(res, cont) : sendError(res, 409, "Run is still running or unknown");
    }
    if (runMatch && runMatch[2] === "stream") {
      if (!runs.get(runMatch[1])) return sendError(res, 404, "Unknown run");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": connected\n\n");
      // A reconnect (Last-Event-ID) or a client that already has the events up to ?after: send only what came after.
      const lastId = parseInt(String(req.headers["last-event-id"] ?? q("after") ?? ""), 10);
      runs.subscribe(runMatch[1], res, Number.isFinite(lastId) ? lastId : -1);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      res.on("close", () => clearInterval(ping));
      return;
    }
    if (p === "/api/git") {
      const ws = workspaceBySlug(q("workspace"));
      if (!ws) return sendError(res, 404, "Unknown workspace");
      return sendJson(res, await getWorkspaceGitInfo(ws.path));
    }
    if (p === "/api/diff") {
      const ws = workspaceBySlug(q("workspace"));
      const repo = q("repo"), file = q("file");
      if (!ws || !repo || !file) return sendError(res, 400, "Missing parameters");
      if (!/^[\w.-]+$/.test(repo) || repo.includes("..")) return sendError(res, 400, "Invalid repo");
      return sendJson(res, { diff: (await getFileDiff(ws.path, repo, file)) || "" });
    }
    return sendError(res, 404, "Not found");
  }

  if (req.method !== "POST") return sendError(res, 405, "Method not allowed");
  if (req.headers["x-dash-token"] !== DASH_TOKEN) return sendError(res, 403, "Missing or stale token; reload the page.");
  if (p === "/api/attachments") {
    // The raw file (not JSON), named by ?name=.
    const data = await readRawBody(req, MAX_ATTACHMENT_BYTES);
    return sendJson(res, attachments.stage(String(q("name") || "file"), data), 201);
  }
  if (p === "/api/explore/save") {
    // Its own reader: a file can be far bigger than readJsonBody's 64 KB.
    let save: any;
    try { save = JSON.parse((await readRawBody(req, MAX_SAVE_BYTES)).toString("utf-8")); } catch (e) { throw e.status ? e : httpError(400, "Invalid JSON"); }
    return sendJson(res, explore.save(save));
  }
  const body = await readJsonBody(req);

  if (HOSTED && (LOCAL_ONLY_POSTS.has(p) || (runMatch && runMatch[2] === "terminal") || (body.mode === "terminal" && /^\/api\/(issues|linear)\/implement$/.test(p)))) {
    return sendError(res, 400, NOT_HOSTED);
  }
  if (p === "/api/claude/login") {
    // { action: "start" } → { url } to open; { action: "code", code } → { ok, message }.
    if (body.action === "start") return sendJson(res, await claudeLogin.start(user));
    if (body.action === "code") return sendJson(res, await claudeLogin.finish(String(body.code || "")));
    if (body.action === "cancel") { claudeLogin.cancel(); return sendJson(res, { ok: true }); }
    return sendError(res, 400, "Unknown action");
  }
  if (p === "/api/restart") {
    // The restart stops this server, ending any turn in flight (it shows as interrupted; replying carries on).
    restartSelf({ script: path.join(DASHBOARD_DIR, "bin", "dashboard.mjs"), ledgerDir: LEDGER_DIR, env: { ...process.env, WORKSPACE_ROOT } });
    return sendJson(res, { ok: true, interrupted: runs.runningCount() }, 202);
  }
  if (p === "/api/runs") {
    // A run that uses a knowledge store reads the latest notes: sync them first (briefly; a slow store doesn't hold the run up).
    const stores = (Array.isArray(body.docSources) ? body.docSources.map(String) : []).filter((k) => docSources().sources.some((s) => s.key === k && s.kind === "store"));
    if (stores.length) await Promise.race([Promise.allSettled(stores.map((k) => knowledge.sync(k, true))), new Promise((r) => setTimeout(r, 10_000))]);
    return sendJson(res, { run: launchRun(body, "manual") }, 201);
  }
  if (runMatch && runMatch[2] === "reply") {
    const blocker = launchBlocker(runs.get(runMatch[1])?.agent);
    if (blocker) return sendError(res, 429, blocker);
    const ids = attachments.check(body.attachments);
    // The cap follows the current setting: off drops it, even for a run started with one.
    const budgetUsd = deck.config().limits.runBudget ? undefined : null;
    return sendJson(res, { run: runs.reply(runMatch[1], body.text, { budgetUsd, attachments: ids }) });
  }
  if (runMatch && runMatch[2] === "rename") return sendJson(res, { run: runs.rename(runMatch[1], body.label) });
  // Queued messages: typed while Claude works, sent when the turn ends (shared/api.ts RunMeta.queued).
  if (runMatch && runMatch[2] === "queue") return sendJson(res, { run: runs.enqueue(runMatch[1], body.text, typeof body.autoSend === "boolean" ? body.autoSend : undefined) });
  if (runMatch && runMatch[2] === "queue-auto") return sendJson(res, { run: runs.setQueueAutoSend(runMatch[1], !!body.on) });
  if (runMatch && runMatch[2] === "queue-edit") return sendJson(res, { run: runs.editQueued(runMatch[1], String(body.id || ""), body.text) });
  if (runMatch && runMatch[2] === "queue-remove") return sendJson(res, { run: runs.removeQueued(runMatch[1], String(body.id || "")) });
  if (runMatch && runMatch[2] === "queue-send") {
    const blocker = launchBlocker(runs.get(runMatch[1])?.agent);
    if (blocker) return sendError(res, 429, blocker);
    return sendJson(res, { run: runs.sendQueued(runMatch[1], { budgetUsd: deck.config().limits.runBudget ? undefined : null }) });
  }
  if (p === "/api/settings") {
    try {
      deck.savePersonal({ limits: body.limits, defaults: body.defaults, issues: body.issues }, { models: (m) => MODEL_RE.test(m), efforts: EFFORTS });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
    // A shorter retention applies right away.
    if (body.limits && "keepAttachmentsDays" in body.limits) cleanupAttachments();
    return sendJson(res, settingsView());
  }
  if (runMatch && runMatch[2] === "plan-mode") return sendJson(res, { run: runs.setPlanMode(runMatch[1], !!body.on) });
  if (runMatch && runMatch[2] === "cancel") {
    return runs.cancel(runMatch[1]) ? sendJson(res, { ok: true }) : sendError(res, 409, "Nothing to cancel: the run isn't working or waiting.");
  }
  if (runMatch && runMatch[2] === "verdict") {
    const verdict = body.verdict === "good" || body.verdict === "needed-fix" ? body.verdict : null;
    const meta = runs.setVerdict(runMatch[1], verdict);
    return meta ? sendJson(res, { run: meta }) : sendError(res, 409, "Run not found or still running");
  }
  if (runMatch && runMatch[2] === "flag") return sendJson(res, { run: runs.setFlag(runMatch[1], !!body.flagged) });
  if (runMatch && runMatch[2] === "watch-stop") return sendJson(res, { run: runs.stopWatch(runMatch[1]) });
  if (runMatch && runMatch[2] === "terminal") {
    const meta = runs.handOff(runMatch[1]);
    // Give a just-killed turn a moment to release the session before the terminal resumes it.
    if (meta && runs.live.has(meta.id)) await new Promise((r) => setTimeout(r, 1500));
    return sendJson(res, { ...(await openTerminalForRun(meta)), run: runs.get(meta.id) });
  }
  if (p === "/api/issues/connect" || p === "/api/linear/connect") return sendJson(res, await trackers.get().connect(body.key));
  if (p === "/api/issues/disconnect" || p === "/api/linear/disconnect") return sendJson(res, trackers.get().disconnect());
  if (p === "/api/atlassian/disconnect") {
    // Issues and Docs fall back to each other's Atlassian key, so forgetting one forgets both.
    const out = forgetAtlassianKeys(LEDGER_DIR);
    if (workspaceConfig().issues.kind === "jira") trackers.get().disconnect();
    for (const src of docSources().sources) { const dp = docsProviders.get(src); if (dp && dp.kind === "confluence") dp.disconnect(); }
    return sendJson(res, out);
  }
  if (p === "/api/issues/implement" || p === "/api/linear/implement") {
    const ticket = ticketParam(body.ticket);
    if (!ticket) return sendError(res, 400, "Invalid ticket id");
    if (isReader()) return sendError(res, 403, `Implement isn't available to the ${readProfile(LEDGER_DIR).current.label} role (Settings → Role).`);
    // Only implement-state issues of issues.implementTeams do code work; refuse the rest.
    const known = ((await getIssues(false)).issues || []).find((i) => i.id === ticket);
    if (known && !known.canImplement) {
      const teams = deck.config().issues.implementTeams || [];
      return sendError(res, 400, teams.length && !teams.includes(known.team)
        ? `${ticket} is a ${known.team} issue; /implement is only for ${teams.join(", ")}.`
        : `${ticket} is ${known.state}; /implement is for ${trackers.config().implementStates.join(" / ")} issues.`);
    }
    if (body.mode === "terminal") {
      const r = await openTerminal(`claude "/implement ${ticket}"`, MAIN_WORKSPACE_PATH, `Claude · /implement ${ticket}`, "Session ended. You can close this window.");
      return sendJson(res, { opened: r.opened, command: `claude "/implement ${ticket}"` });
    }
    // Headless. Its open questions come back as "waiting" (Needs your answer) unless
    // options.auto is set, which appends --auto so it decides them and notes them on the ticket.
    const options = typeof body.auto === "boolean" ? { auto: body.auto } : {};
    return sendJson(res, { run: launchRun({ presetId: deck.config().issues.implementPreset, args: { ticket }, options }, "issues") }, 201);
  }
  if (p === "/api/issues/explain" || p === "/api/linear/explain") {
    const ticket = ticketParam(body.ticket);
    if (!ticket) return sendError(res, 400, "Invalid ticket id");
    const issue = await trackers.get().issue(ticket);
    const run = launchRun({
      prompt: explainPrompt(issue), planMode: true, workspace: "main",
      model: body.model, effort: body.effort, trigger: "explain",
    }, "explain");
    return sendJson(res, { run }, 201);
  }
  if (p === "/api/machine/install") return sendJson(res, await machine.install(String(body.id || ""))); // only the id crosses the wire
  if (p === "/api/repos/clone") {
    // Only names cross the wire; what to clone and from where is repos.json's.
    const names = Array.isArray(body.names) ? body.names.map(String) : null;
    const targets = cloneTargets(MAIN_WORKSPACE_PATH, names);
    if (!targets.length) return sendError(res, 400, "Nothing to clone: every repo in repos.json with a remote is already here.");
    if (launcher.jobs.some((j) => j.status === "running" && j.workspace === "main" && j.label.startsWith("Clone"))) {
      return sendError(res, 409, "A clone is already running.");
    }
    const main = { slug: "main", name: "Main Workspace", path: MAIN_WORKSPACE_PATH };
    const label = targets.length === 1 ? `Clone ${targets[0].name}` : `Clone ${targets.length} repos`;
    const job = launcher.job(main, label, async (step) => {
      // One failure doesn't stop the rest; the job fails at the end if any did.
      const failed: string[] = [];
      for (const r of targets) {
        try { await step(`Clone ${r.name} into ${r.relativePath}`, cloneStep(MAIN_WORKSPACE_PATH, r)); } catch { failed.push(r.name); }
      }
      if (failed.length) throw new Error(`Couldn't clone ${failed.join(", ")}`);
    });
    const { _log, ...pub } = job;
    return sendJson(res, { job: pub }, 202);
  }
  if (p === "/api/snapshot/connect" || p === "/api/snapshot/disconnect") {
    const source = snapshotSource();
    if (!source) return sendError(res, 400, "repos.json has no snapshot source.");
    const status = p.endsWith("/connect") ? await source.connect(body.key) : source.disconnect();
    dropManifestCache();
    return sendJson(res, status);
  }
  if (p === "/api/snapshot/download") {
    const source = snapshotSource();
    if (!source) return sendError(res, 400, "repos.json has no snapshot source.");
    if (!source.status().connected) return sendError(res, 400, `Connect ${source.label} first.`);
    if (launcher.jobs.some((j) => j.status === "running" && j.workspace === "main" && j.label.startsWith("Download"))) {
      return sendError(res, 409, "A download is already running.");
    }
    const names = Array.isArray(body.names) ? body.names.map(String) : null;
    const targets = await downloadTargets(MAIN_WORKSPACE_PATH, source, names);
    if (!targets.length) return sendError(res, 400, "Nothing to download: every published repo here is up to date.");
    const main = { slug: "main", name: "Main Workspace", path: MAIN_WORKSPACE_PATH };
    const label = targets.length === 1 ? `Download ${targets[0].repo.name}` : `Download ${targets.length} repos`;
    const job = launcher.job(main, label, async (step) => {
      const failed: string[] = [];
      for (const t of targets) {
        try { await step(`Download ${t.repo.name} into ${t.repo.relativePath}`, downloadStep(MAIN_WORKSPACE_PATH, source, t)); } catch { failed.push(t.repo.name); }
      }
      // Someone downloading code instead of cloning it reads it: default them to the reader profile once
      // (the first reader role; if the team has roles, they're still asked which).
      if (!readProfile(LEDGER_DIR).chosen) {
        try { setRole(LEDGER_DIR, MAIN_WORKSPACE_PATH, { profile: "reader" }); } catch {}
      }
      if (failed.length) throw new Error(`Couldn't download ${failed.join(", ")}`);
    });
    const { _log, ...pub } = job;
    return sendJson(res, { job: pub }, 202);
  }
  if (p === "/api/snapshot/plan") {
    const source = publishableSource();
    const plan = await planSnapshot(MAIN_WORKSPACE_PATH, { fetch: true, allowMissing: true });
    if (!plan.repos.length) return sendError(res, 400, `Nothing to publish from here: ${plan.skipped.map((s) => `${s.name} (${s.reason})`).join(", ") || "no repos in repos.json are included"}.`);
    pendingPlan = { id: crypto.randomBytes(6).toString("hex"), at: Date.now(), plan };
    const out: PublishPlanResponse = { planId: pendingPlan.id, label: source.label, ...plan };
    return sendJson(res, out);
  }
  if (p === "/api/snapshot/publish") {
    const source = publishableSource();
    // Only what was shown and confirmed goes up; a stale or unknown plan has to be looked at again.
    if (!pendingPlan || pendingPlan.id !== String(body.planId || "") || Date.now() - pendingPlan.at > PLAN_TTL_MS) {
      return sendError(res, 409, "That publish plan has expired; open Publish now again to see what would be uploaded.");
    }
    if (launcher.jobs.some((j) => j.status === "running" && j.workspace === "main" && j.label.startsWith("Publish"))) {
      return sendError(res, 409, "A publish is already running.");
    }
    const { plan } = pendingPlan;
    pendingPlan = null;
    const main = { slug: "main", name: "Main Workspace", path: MAIN_WORKSPACE_PATH };
    const job = launcher.job(main, `Publish ${plan.repos.length} repo${plan.repos.length === 1 ? "" : "s"} to ${source.label}`, async (step, note) => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "aos-publish-"));
      try {
        let manifest!: Manifest;
        await step("Build the archives", async (log) => { manifest = await buildSnapshot(MAIN_WORKSPACE_PATH, out, { plan, log, installer: { name: workspaceConfig().name, sourceLabel: source.label, roles: installerRoles(workspaceConfig()) } }); });
        if (plan.skipped.length) {
          await step("Keep what's published for skipped repos", async (log) => {
            let previous: Manifest | null = null, files: SnapshotFile[] = [];
            try { ({ manifest: previous, files } = await fetchManifest(source, JSON.stringify(readRepos(MAIN_WORKSPACE_PATH).snapshot), true)); } catch (e) { log(`no earlier publish to keep from (${e.message})`); }
            const kept = carryOver(manifest, previous, files, plan.skipped.map((s) => s.name));
            writeManifest(out, manifest);
            log(kept.length ? `kept the published copy of ${kept.join(", ")}` : "nothing earlier to keep");
            for (const s of plan.skipped) if (!kept.includes(s.name)) note(`${s.name} isn't in this publish (${s.reason}) and had no earlier copy.`);
          });
        }
        await step(`Upload to ${source.label}`, (log) => publishSnapshot(source, out, manifest, log));
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
        dropManifestCache();
      }
    });
    const { _log, ...pub } = job;
    return sendJson(res, { job: pub }, 202);
  }
  if (p === "/api/profile") {
    // { role } picks a role; { profile } (older installers) takes the first role on that profile.
    const pick = typeof body.role === "string" ? { role: body.role }
      : body.profile === "reader" || body.profile === "developer" ? { profile: body.profile as "reader" | "developer" } : null;
    if (!pick) return sendError(res, 400, 'Send { role: "<id>" } (one of workspace.json roles).');
    try { setRole(LEDGER_DIR, MAIN_WORKSPACE_PATH, pick); }
    catch (e) { return sendError(res, 400, e.message); }
    return sendJson(res, profileInfo());
  }
  if (p === "/api/docs/preview") return sendJson(res, { url: await docSites.preview(String(body.site || "")) });
  if (p === "/api/docs/external/connect") {
    const { provider } = externalDocs(body.site);
    try { await provider.connect(String(body.key || "")); } catch (e) { return sendError(res, 400, e.message); }
    return sendJson(res, await externalDocsStatus(body.site));
  }
  if (p.startsWith("/api/knowledge/")) {
    const what = p.slice("/api/knowledge/".length);
    const done = (out: unknown) => { search.invalidate(); return sendJson(res, out); };
    if (what === "save") return done(await knowledge.save(body.source, body.rel, body.text, body.etag));
    if (what === "delete") { await knowledge.remove(body.source, body.rel, body.etag); return done({ ok: true }); }
    if (what === "rename") return done(await knowledge.rename(body.source, body.from, body.to, body.etag));
    if (what === "reviewed") return done(await knowledge.markReviewed(body.source, body.rel));
    if (what === "sync") { await knowledge.sync(String(body.source || ""), true); return done(knowledge.storeStatus(body.source)); }
    if (what === "connect") return done(await knowledge.connect(body.source, String(body.key || "")));
    if (what === "disconnect") return done(knowledge.disconnect(body.source));
    if (what === "claude-access") return sendJson(res, knowledge.setClaudeAccess(body.source, body.on !== false));
    if (what === "setup") { saveTools(body); return done(knowledgeSetup()); }
    if (what === "store-source") { addStoreSource(body); return done(knowledgeSetup()); }
    return sendError(res, 404, "Unknown knowledge action");
  }
  if (p === "/api/docs/external/disconnect") {
    externalDocs(body.site).provider.disconnect();
    return sendJson(res, await externalDocsStatus(body.site));
  }
  if (p === "/api/links/save") return sendJson(res, saveLink(MAIN_WORKSPACE_PATH, body));
  if (p === "/api/links/delete") return sendJson(res, deleteLink(MAIN_WORKSPACE_PATH, body));
  if (p === "/api/connections/login") {
    // In the page, no terminal (mcp-login.ts): start → a URL to open; finish → the address the browser ended on (hosted).
    const name = listedName(body.name);
    if (body.action === "start" && !PTY_SIGN_IN) {
      // Windows (always local): no `script` for a pseudo-terminal, so a terminal window it is; the page re-checks on focus.
      const terminal = await openTerminal(`claude mcp login '${name.replace(/'/g, "''")}'`, MAIN_WORKSPACE_PATH, `Sign in: ${name.slice(0, 60)}`);
      return sendJson(res, { url: "", callback: null, terminal });
    }
    if (body.action === "start") return sendJson(res, await mcpLogin.start(name));
    if (body.action === "status") return sendJson(res, mcpLogin.status(name));
    if (body.action === "finish") {
      try { return sendJson(res, await mcpLogin.finish(name, String(body.url || ""))); } catch (e) { return sendError(res, 400, e.message); }
    }
    if (body.action === "cancel") { mcpLogin.cancel(name); return sendJson(res, { ok: true }); }
    return sendError(res, 400, "Unknown action");
  }
  if (p === "/api/connections/logout") return sendJson(res, await connections.logout(body.name));
  if (p === "/api/connections/remove") return sendJson(res, await connections.remove(body.name));
  if (p === "/api/connections/add") return sendJson(res, await connections.add(body));
  if (p === "/api/connections/approve") return sendJson(res, await connections.approve(body.name));
  if (p === "/api/connections/allow") return sendJson(res, connections.allow(body.name, body.on !== false));
  if (p === "/api/memory/delete") {
    const out = memory.remove(String(body.file || ""));
    search.invalidate();
    return sendJson(res, out);
  }
  if (p === "/api/apps/action") {
    const ws = workspaceBySlug(body.workspace);
    if (!ws) return sendError(res, 400, `Unknown workspace ${body.workspace}`);
    let job;
    switch (body.action) {
      case "start": job = body.stack ? launcher.startStack(ws, body.stack) : launcher.startApp(ws, body.app); break;
      case "stop": job = body.stack ? launcher.stopStack(ws, body.stack) : launcher.stopApp(ws, body.app); break;
      case "restart": job = launcher.restartApp(ws, body.app); break;
      case "stop-all": job = launcher.stopWorkspace(ws); break;
      case "setup": job = launcher.setupWorkspace(ws); break;
      default: return sendError(res, 400, `Unknown action ${body.action}`);
    }
    const { _log, ...pub } = job;
    return sendJson(res, { job: pub }, 202);
  }
  return sendError(res, 404, "Not found");
}

const server = http.createServer(async (req, res) => {
  // For a container platform's liveness/readiness probe, which sends no Host, secret or login.
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  let user: string | null = null;
  if (HOSTED) {
    const verdict = checkHostedRequest(HOSTED, req.headers);
    if (verdict.ok === false) {
      res.writeHead(verdict.status, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(verdict.message);
    }
    user = verdict.user;
  } else {
    if (!ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())) {
      res.writeHead(421);
      return res.end("Misdirected request");
    }
    // A browser POST from another site carries its Origin; only our own is allowed.
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) {
      res.writeHead(403);
      return res.end("Cross-origin request refused");
    }
  }
  const url = new URL(req.url || "/", `http://localhost:${DASHBOARD_PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, user);
    if (url.pathname.startsWith("/screenshots/")) return serveScreenshot(req, res);
    if (url.pathname.startsWith("/ds/") && serveBrand(res, url.pathname)) return;
    return serveApp(res, url.pathname);
  } catch (e) {
    const status = e && e.status ? e.status : 400;
    if (!res.headersSent) sendError(res, status, e.message || String(e));
    else res.end();
  }
});

server.listen(DASHBOARD_PORT, HOSTED ? HOSTED.bind : "127.0.0.1", () => {
  if (HOSTED) console.log(`Hosted dashboard listening on ${HOSTED.bind}:${DASHBOARD_PORT}, opened at ${HOSTED.publicOrigin}${HOSTED.owner ? ` by ${HOSTED.owner}` : ""}`);
  else console.log(`Workspace dashboard running at http://localhost:${DASHBOARD_PORT}`);
});

// workspace.json dashboard.legacyRedirects: old tools' ports that now answer with a
// redirect, so their bookmarks land on the matching dashboard page. Each is
// { port, routes: { "/old": "/new" }, prefixes: { "/old/": "/new" }, fallback }.
// Best effort: skipped if the port is taken. Local only: a hosted container has no old tools.
for (const r of HOSTED ? [] : workspaceConfig().dashboard.legacyRedirects) {
  const legacy = http.createServer((req, res) => {
    const p = new URL(req.url || "/", "http://x").pathname.replace(/\/+$/, "") || "/";
    const prefix = Object.keys(r.prefixes || {}).find((k) => p.startsWith(k));
    const to = (r.routes || {})[p] || (prefix ? r.prefixes![prefix] : null) || r.fallback || "/";
    res.writeHead(301, { Location: `http://localhost:${DASHBOARD_PORT}${to}` });
    res.end();
  });
  legacy.on("error", () => {});
  legacy.listen(Number(r.port), "127.0.0.1");
}

// Leave nothing behind: kill running turns when the server stops.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const id of runs.live.keys()) runs.cancel(id);
    claudeLogin.cancel();
    mcpLogin.cancelAll();
    setTimeout(() => process.exit(0), 300);
  });
}
