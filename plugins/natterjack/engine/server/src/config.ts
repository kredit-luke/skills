/**
 * The team's workspace config: everything that makes this dashboard *theirs*
 * lives in <workspace>/.claude/dashboard/*.json (committed) and brand/ (tokens,
 * logo). The dashboard code itself names no team, repo, app, port or service.
 *
 *   workspace.json  identity, dashboard port, worktrees, issue tracker, code host, copy, profiles
 *   apps.json       apps, stacks and the app launcher (Apps / Workspaces pages)
 *   machine.json    requirement checks (Machine page), built from the check catalog
 *   docs.json       docs sources (Docs page, Search)
 *   infrastructure.json  the Infrastructure page's doc and quick facts (was reference.json)
 *   links.json      Links page tiles (+ .claude/ledger/links.local.json, personal)
 *   deck.json       presets, routines, limits, defaults, issues view
 *
 * Every file is optional: a missing one means "not configured" and its page
 * shows how to set it up instead of failing. Files are re-read when they change
 * (mtime), so edits apply on the next request without a restart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DASHBOARD_DIR = path.resolve(HERE, "..", "..");

/** The workspace root: WORKSPACE_ROOT, else the folder that holds dashboard/. */
export const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || path.join(DASHBOARD_DIR, ".."),
);
export const CONFIG_DIR = path.join(WORKSPACE_ROOT, ".claude", "dashboard");
/** Local state (gitignored). DASHBOARD_LEDGER_DIR points a second instance (e.g. a test run) elsewhere. */
export const LEDGER_DIR = path.resolve(process.env.DASHBOARD_LEDGER_DIR || path.join(WORKSPACE_ROOT, ".claude", "ledger"));
export const BRAND_DIR = path.join(CONFIG_DIR, "brand");

export const DEFAULT_PORT = 3333;
export const DEFAULT_DEV_PORT = 4339;

export interface LegacyRedirect {
  port: number;
  routes?: Record<string, string>;
  prefixes?: Record<string, string>;
  fallback?: string;
}

export interface IssuesConfig {
  /** Adapter: "linear" | "jira" | "github" | "none" (see issues/index.ts). */
  kind: string;
  /** Shown in the UI ("Linear", "Jira", ...). */
  label: string;
  /** Tracker-specific settings (Linear org, Jira site, GitHub repo, ...). */
  org?: string | null;
  site?: string | null;
  repo?: string | null;
  /** Issue URL with {id}; the adapter's own URL wins when the API returns one. */
  urlTemplate?: string | null;
  /** States whose issues get the Implement button (with deck.json issues.implementTeams). */
  implementStates: string[];
  /** A ticket id, anchored. Branch names, /implement args and run matching use it. */
  ticketPattern: string;
}

export interface WorkspaceConfig {
  name: string;
  dashboard: { title: string; port: number; devPort: number; legacyRedirects: LegacyRedirect[] };
  /** ports: allocate worktree port slots in the ports file (null = the team's tooling does). */
  worktrees: { dir: string; portsFile: string; screenshots: string; ports: { base: number; slotSize: number } | null };
  issues: IssuesConfig;
  codeHost: { kind: string; ciRepos: string[]; ciBranch: string };
  brand: { logo: string | null; logoAlt: string | null; favicon: string | null };
  copy: Record<string, any>;
  /**
   * What the reader profile (people who read the code but don't build or run it)
   * doesn't see: nav pages by route ("apps", "workspaces", ...) and project skills by
   * name. Readers never get Implement.
   */
  profiles: { reader: { hiddenPages: string[]; hiddenSkills: string[] } };
  /**
   * The roles people pick from (in order), each on the developer or reader profile.
   * Without workspace.json `roles` there are just Developer and Reader
   * (rolesConfigured false), and nobody is asked.
   */
  roles: RoleConfig[];
  rolesConfigured: boolean;
}

/**
 * One role in workspace.json `roles` ({ "<id>": { label, profile, ... } }). Its hidden
 * pages and skills are its profile's (`profiles.reader` for readers) plus its own.
 */
export interface RoleConfig {
  id: string;
  label: string;
  description: string;
  profile: "developer" | "reader";
  /** An output style (.claude/output-styles/<name>.md, or a built-in one) set for this person; null = Claude's default. */
  outputStyle: string | null;
  hiddenPages: string[];
  hiddenSkills: string[];
}

/** Pages a reader has no use for (they start and stop apps, and worktrees). */
export const DEFAULT_READER_HIDDEN_PAGES = ["apps", "workspaces"];

/** A page id from hiddenPages: no leading slash; "reference" is the Infrastructure page's old name. */
function pageId(p: string): string {
  const id = p.replace(/^\/+/, "");
  return id === "reference" ? "infrastructure" : id;
}

const ROLE_ID = /^[a-z0-9][\w-]*$/i;
const DEFAULT_ROLES = {
  developer: { label: "Developer", profile: "developer", description: "Builds and runs the code: everything." },
  reader: { label: "Reader", profile: "reader", description: "Reads and asks about the code without building or running it." },
};

function roleList(raw: unknown, reader: { hiddenPages: string[]; hiddenSkills: string[] }): RoleConfig[] {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : {};
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  const out: RoleConfig[] = [];
  for (const [id, r] of Object.entries(src)) {
    if (!ROLE_ID.test(id) || !r || typeof r !== "object") continue;
    const profile = r.profile === "reader" ? "reader" : "developer";
    const base = profile === "reader" ? reader : { hiddenPages: [], hiddenSkills: [] };
    out.push({
      id,
      label: str(r.label, id),
      description: str(r.description, ""),
      profile,
      outputStyle: strOrNull(r.outputStyle),
      hiddenPages: union(base.hiddenPages, strList(r.hiddenPages, []).map(pageId)),
      hiddenSkills: union(base.hiddenSkills, strList(r.hiddenSkills, [])),
    });
  }
  return out.length || src === DEFAULT_ROLES ? out : roleList(DEFAULT_ROLES, reader);
}

const DEFAULT_ISSUES: IssuesConfig = {
  kind: "none",
  label: "Issues",
  implementStates: ["Todo"],
  ticketPattern: "^[A-Z][A-Z0-9]*-\\d+$",
};

/** Per-tracker defaults: its name, the state that means "ready to build", and its id shape. */
const TRACKER_DEFAULTS: Record<string, Partial<IssuesConfig>> = {
  linear: { label: "Linear", implementStates: ["Todo"] },
  jira: { label: "Jira", implementStates: ["To Do"] },
  // GitHub issue ids are "<repo>#<number>"; the others are KEY-123.
  github: { label: "GitHub Issues", implementStates: ["Open"], ticketPattern: "^[\\w.-]+#\\d+$" },
};

// ------------------------------------------------------------------ reading

const cache = new Map<string, { mtimeMs: number; data: any; error: string | null }>();

/**
 * A config file's parsed JSON, cached until its mtime changes.
 * { data: null, error: null } = not configured; { data: null, error } = broken.
 */
export function readConfigFile(name: string, dir = CONFIG_DIR): { data: any; error: string | null; file: string } {
  const file = path.join(dir, name);
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { cache.delete(file); return { data: null, error: null, file }; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return { data: hit.data, error: hit.error, file };
  let data = null, error = null;
  try { data = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (e) { error = `${name}: ${e.message}`; }
  cache.set(file, { mtimeMs: st.mtimeMs, data, error });
  return { data, error, file };
}

/** Write a config file (pretty, trailing newline) and drop it from the cache. */
export function writeConfigFile(name: string, data: unknown, dir = CONFIG_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
  cache.delete(file);
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** worktrees.ports: { base, slotSize } with sane numbers, else null. */
function slotRule(v: any): { base: number; slotSize: number } | null {
  const base = Number(v && v.base), slotSize = Number(v && v.slotSize);
  return Number.isInteger(base) && base > 0 && Number.isInteger(slotSize) && slotSize > 0 && base + slotSize < 65535 ? { base, slotSize } : null;
}

const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const strList = (v: unknown, d: string[]) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : d);

/** workspace.json with every default filled in. */
export function workspaceConfig(): WorkspaceConfig {
  const raw = readConfigFile("workspace.json").data || {};
  const dash = raw.dashboard || {};
  const wt = raw.worktrees || {};
  const iss = raw.issues || {};
  const ch = raw.codeHost || {};
  const brand = raw.brand || {};
  const reader = (raw.profiles && raw.profiles.reader) || {};
  const readerProfile = {
    hiddenPages: strList(reader.hiddenPages, DEFAULT_READER_HIDDEN_PAGES).map(pageId),
    hiddenSkills: strList(reader.hiddenSkills, []),
  };
  const name = str(raw.name, path.basename(WORKSPACE_ROOT));
  const kindDefaults = TRACKER_DEFAULTS[iss.kind] || {};
  return {
    name,
    dashboard: {
      title: str(dash.title, "Workspace Dashboard"),
      port: Number(dash.port) || DEFAULT_PORT,
      devPort: Number(dash.devPort) || DEFAULT_DEV_PORT,
      legacyRedirects: Array.isArray(dash.legacyRedirects) ? dash.legacyRedirects.filter((r) => Number(r && r.port)) : [],
    },
    worktrees: {
      dir: str(wt.dir, "worktrees"),
      portsFile: str(wt.portsFile, "~/.agentic-workspace-ports.json"),
      screenshots: str(wt.screenshots, ".claude/qa-artifacts/screenshots"),
      ports: slotRule(wt.ports),
    },
    issues: {
      ...DEFAULT_ISSUES,
      ...kindDefaults,
      ...iss,
      kind: str(iss.kind, DEFAULT_ISSUES.kind),
      label: str(iss.label, kindDefaults.label || (iss.kind ? iss.kind[0].toUpperCase() + iss.kind.slice(1) : DEFAULT_ISSUES.label)),
      implementStates: strList(iss.implementStates, kindDefaults.implementStates || DEFAULT_ISSUES.implementStates),
      ticketPattern: str(iss.ticketPattern, kindDefaults.ticketPattern || DEFAULT_ISSUES.ticketPattern),
    },
    codeHost: {
      kind: str(ch.kind, "github"),
      ciRepos: strList(ch.ciRepos, []),
      ciBranch: str(ch.ciBranch, "main"),
    },
    brand: { logo: strOrNull(brand.logo), logoAlt: strOrNull(brand.logoAlt) || name, favicon: strOrNull(brand.favicon) },
    copy: raw.copy && typeof raw.copy === "object" ? raw.copy : {},
    profiles: { reader: readerProfile },
    roles: roleList(raw.roles, readerProfile),
    rolesConfigured: hasRoles(raw.roles),
  };
}

const hasRoles = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((id) => ROLE_ID.test(id));

/** The dashboard's port: --port, else DASHBOARD_PORT (per machine), else workspace.json, else 3333. */
export function dashboardPort(argv = process.argv): number {
  const i = argv.indexOf("--port");
  const fromArg = i !== -1 ? parseInt(argv[i + 1], 10) : NaN;
  if (fromArg > 0) return fromArg;
  const fromEnv = parseInt(process.env.DASHBOARD_PORT || "", 10);
  if (fromEnv > 0) return fromEnv;
  return workspaceConfig().dashboard.port;
}

export function worktreeRoot(): string {
  return path.resolve(WORKSPACE_ROOT, workspaceConfig().worktrees.dir);
}

export function portsFile(): string {
  return path.resolve(expandHome(workspaceConfig().worktrees.portsFile));
}

/** The team's ticket-id regex (anchored). Falls back to the default on a bad pattern. */
export function ticketRe(): RegExp {
  try { return new RegExp(workspaceConfig().issues.ticketPattern); } catch { return new RegExp(DEFAULT_ISSUES.ticketPattern); }
}

/** The same pattern, unanchored, for finding a ticket id inside text. */
export function ticketInTextRe(): RegExp {
  const src = workspaceConfig().issues.ticketPattern.replace(/^\^/, "").replace(/\$$/, "");
  try { return new RegExp(src); } catch { return /[A-Z][A-Z0-9]*-\d+/; }
}

/**
 * A skill folder's SKILL.md, whatever its case (skill.md, Skill.md): Windows and a
 * default macOS disk don't care, but Linux and case-sensitive volumes do.
 */
export function skillFile(skillDir: string): string {
  try {
    const hit = fs.readdirSync(skillDir).find((n) => n.toLowerCase() === "skill.md");
    if (hit) return path.join(skillDir, hit);
  } catch {}
  return path.join(skillDir, "SKILL.md");
}
