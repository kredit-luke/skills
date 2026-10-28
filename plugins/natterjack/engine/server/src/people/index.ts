/**
 * The People page (an engineer's local dashboard only): everyone in the directory, who
 * has a hosted dashboard, and their profile and role. Three sources, one row per email:
 *
 *   directory (who could have one)  +  roster (people.json in the repo: who should)  +  cluster (who does)
 *
 * and the actions that bring them in line: provision, update, change profile or role, start,
 * stop, remove (keeping the volume or not), adopt one made by hand, forget a missing one.
 * When the platform can't be asked (a lapsed az or kubectl sign-in), a roster row is "unknown",
 * never "missing": no answer isn't "not there".
 * Every write can be previewed first (dryRun). Nothing here runs on a hosted dashboard.
 */

import { CONFIG_DIR, workspaceConfig, type RoleConfig } from "../config.ts";
import type { HostingConfig, Profile } from "./config.ts";
import { readHosting } from "./config.ts";
import { runCli, type Runner } from "./cli.ts";
import { makeDirectory, type DirectoryPerson, type Fetcher } from "./directory.ts";
import { makePlatform, type Dashboard, type Platform } from "./platform.ts";
import { Roster, type RosterDoc, type RosterPerson, type RosterStatus } from "./roster.ts";
import { Roles, type RoleEdit, type RoleRow, type RolesStatus } from "./roles.ts";

export type PersonState = "not-set-up" | "running" | "starting" | "stopped" | "left" | "missing" | "unmanaged" | "unknown";

export interface PersonRow {
  email: string;
  name: string;
  /** In the directory and active; null when the directory couldn't be read or isn't used. */
  active: boolean | null;
  state: PersonState;
  /** Why the state is "unknown": the platform's error (null otherwise). */
  stateError: string | null;
  slug: string | null;
  profile: string | null;
  needsUpdate: boolean;
  /** The workspace role assigned to them (DASHBOARD_ROLE); null: they pick their own. */
  role: string | null;
  /** Their access, assigned over their role's default (DASHBOARD_ACCESS); null: the role's. */
  access: "full" | "read" | null;
  provisionedAt: string | null;
  provisionedBy: string | null;
}

export interface PeopleView {
  configured: boolean;
  problems: string[];
  errors: { source: "directory" | "roster" | "cluster" | "template"; message: string; fix: string | null }[];
  directory: { label: string; type: string; count: number | null };
  roster: RosterStatus | null;
  cluster: string | null;
  /** What a person keeps between restarts there ("volume", "file share"), for the Remove dialog. */
  dataLabel: string | null;
  profiles: { id: string; name: string; areas: string[] }[];
  defaultProfile: string | null;
  /** workspace.json roles one can be assigned (empty when the team has none), with how many in the roster have each. */
  roles: (RoleRow & { people: number })[];
  /** Output styles a role can use: the team's (.claude/output-styles) and Claude Code's own. */
  styles: string[];
  /** workspace.json, where the roles live, and what isn't committed in it yet. */
  rolesFile: RolesStatus | null;
  rows: PersonRow[];
}

export interface PeopleAction {
  action: "provision" | "update" | "profile" | "role" | "access" | "start" | "stop" | "remove" | "adopt" | "forget";
  email: string;
  profile?: string;
  /** A workspace role id, or "" for "they pick their own" (provision, role). */
  role?: string;
  /** "full" or "read" over their role's default, or "" to follow the role (provision, access). */
  access?: string;
  keepVolume?: boolean;
  dryRun?: boolean;
}

/** POST /api/people/roles: add (no id) or change a role, or remove one. */
export interface RolesAction { action: "save" | "remove"; id?: string; role?: RoleEdit }

const DIRECTORY_TTL = 5 * 60_000;
const CLUSTER_TTL = 60_000;
const errOf = (source: PeopleView["errors"][number]["source"], e: any) => ({ source, message: String(e?.message || e), fix: e?.fix || null });
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export class People {
  private readonly root: string;
  private readonly run: Runner;
  private readonly fetcher?: Fetcher;
  private readonly configDir: string;
  private readonly roles: () => RoleConfig[];
  private dirCache: { key: string; at: number; people: DirectoryPerson[] } | null = null;
  private platformCache: { key: string; p: Platform } | null = null;
  private clusterCache: { p: Platform; at: number; list: Map<string, Dashboard> } | null = null;
  private me: string | null = null;

  constructor(workspaceRoot: string, opts: { run?: Runner; fetcher?: Fetcher; configDir?: string; roles?: () => RoleConfig[] } = {}) {
    this.root = workspaceRoot;
    this.run = opts.run || runCli;
    this.fetcher = opts.fetcher;
    this.configDir = opts.configDir || CONFIG_DIR;
    // Only a team's own roles can be assigned (without any there's just Developer and Reader, nothing to pick).
    this.roles = opts.roles || (() => { const ws = workspaceConfig(); return ws.rolesConfigured ? ws.roles : []; });
  }


  private config(): { cfg: HostingConfig | null; problems: string[]; configured: boolean } {
    const { config, problems, configured } = readHosting(this.root, this.configDir);
    return { cfg: config, problems, configured };
  }

  private platform(cfg: HostingConfig): Platform {
    const key = JSON.stringify([cfg.platform, cfg.areas]);
    if (!this.platformCache || this.platformCache.key !== key) this.platformCache = { key, p: makePlatform(cfg, this.run) };
    return this.platformCache.p;
  }

  /**
   * Who has a dashboard. Listing it is a slow CLI call (az's start-up alone is seconds), so a
   * page load and the previews after it share one listing for CLUSTER_TTL. `fresh` (Refresh, and
   * every change for real) asks the platform again; a change clears it for the next load.
   */
  private async cluster(cfg: HostingConfig, fresh: boolean): Promise<Map<string, Dashboard>> {
    const k = this.platform(cfg);
    const c = this.clusterCache;
    if (!fresh && c && c.p === k && Date.now() - c.at < CLUSTER_TTL) return c.list;
    const list = await k.list();
    this.clusterCache = { p: k, at: Date.now(), list };
    return list;
  }

  private async directory(cfg: HostingConfig, force: boolean): Promise<DirectoryPerson[]> {
    const key = JSON.stringify(cfg.directory);
    if (!force && this.dirCache && this.dirCache.key === key && Date.now() - this.dirCache.at < DIRECTORY_TTL) return this.dirCache.people;
    const people = await makeDirectory(cfg.directory, this.run, this.fetcher).list();
    this.dirCache = { key, at: Date.now(), people };
    return people;
  }

  /** Who's changing things, for the roster: git's email, else the OS user. */
  private async who(): Promise<string> {
    if (this.me) return this.me;
    const r = await this.run("git", ["-C", this.root, "config", "user.email"], { timeout: 10_000 });
    this.me = (r.ok && r.stdout.trim()) || process.env.USERNAME || process.env.USER || "unknown";
    return this.me;
  }

  async view(force = false): Promise<PeopleView> {
    const { cfg, problems, configured } = this.config();
    const empty: PeopleView = { configured, problems, errors: [], directory: { label: "", type: "", count: null }, roster: null, cluster: null, dataLabel: null, profiles: [], defaultProfile: null, roles: [], styles: [], rolesFile: null, rows: [] };
    if (!cfg) return empty;
    const k = this.platform(cfg);
    const roster = this.roster();
    const rolesFile = this.rolesFile().status().catch(() => null);
    const dirLabel = makeDirectory(cfg.directory, this.run, this.fetcher).label;
    const [dir, ros, clu] = await Promise.allSettled([this.directory(cfg, force), roster.status().then((status) => ({ doc: roster.load(), status })), this.cluster(cfg, force)]);
    const errors: PeopleView["errors"] = [];
    if (dir.status === "rejected") errors.push(errOf("directory", dir.reason));
    if (ros.status === "rejected") errors.push(errOf("roster", ros.reason));
    if (clu.status === "rejected") errors.push(errOf("cluster", clu.reason));
    const directory = dir.status === "fulfilled" ? dir.value : null;
    const doc = ros.status === "fulfilled" ? ros.value.doc : null;
    const cluster = clu.status === "fulfilled" ? clu.value : null;
    // A roster row the platform didn't answer for shows this, the fix carried in it (the page shows only the message).
    const ce = cluster ? null : errors.find((e) => e.source === "cluster")!;
    const clusterError = ce && (ce.fix && !ce.message.includes(ce.fix) ? `${ce.message} (${ce.fix})` : ce.message);

    const byEmail = new Map((directory || []).map((p) => [p.email, p]));
    const emails = new Set<string>([...byEmail.keys(), ...Object.keys(doc?.people || {}), ...(cluster?.keys() || [])]);
    const rows: PersonRow[] = [];
    let templateError: any = null;
    for (const email of emails) {
      const d = byEmail.get(email) || null;
      const r = doc?.people[email] || null;
      const c = cluster?.get(email) || null;
      if (!r && !c && d && !d.active) continue; // suspended and never set up: nothing to do
      const active = cfg.directory.type === "manual" || !directory ? null : !!d?.active;
      let state: PersonState;
      if (!r && !c) state = "not-set-up";
      else if (active === false && (r || c)) state = "left";
      else if (c && !r && doc) state = "unmanaged";
      else if (c) state = c.running ? (c.ready ? "running" : "starting") : "stopped";
      else if (cluster) state = "missing";
      else state = "unknown"; // in the roster, but the platform didn't answer
      let needsUpdate = false;
      if (c && r && !templateError) {
        const profile = this.profile(cfg, r.profile);
        try { needsUpdate = (await k.render({ email, slug: r.slug, profile, role: r.role || null, access: r.access || null }, c)).hash !== c.applied; }
        catch (e) { templateError = e; }
      }
      rows.push({
        email, name: d?.name || r?.name || email, active, state,
        stateError: state === "unknown" ? clusterError : null,
        slug: r?.slug || c?.slug || null, profile: r?.profile || c?.profile || null, needsUpdate, role: r?.role || null, access: r?.access || null,
        provisionedAt: r?.provisionedAt || null, provisionedBy: r?.provisionedBy || null,
      });
    }
    if (templateError) errors.push(errOf("template", templateError));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return {
      configured, problems, errors,
      directory: { label: dirLabel, type: cfg.directory.type, count: directory ? directory.filter((p) => p.active).length : null },
      roster: ros.status === "fulfilled" ? ros.value.status : null, cluster: k.where, dataLabel: k.dataLabel,
      profiles: cfg.profiles.map((p) => ({ id: p.id, name: p.name, areas: p.areas })),
      defaultProfile: cfg.defaultProfile,
      roles: this.roles().map((r) => ({
        id: r.id, label: r.label, description: r.description, access: r.profile === "reader" ? "read" : "full", outputStyle: r.outputStyle,
        people: Object.values(doc?.people || {}).filter((p) => p.role === r.id).length,
      })),
      styles: this.rolesFile().styles(),
      rolesFile: await rolesFile,
      rows,
    };
  }

  private rolesFile(): Roles { return new Roles(this.root, this.configDir, this.run); }

  /** Add, change or remove one of the team's roles (workspace.json). Committing is a separate step. */
  editRoles(a: RolesAction): { ok: true; id: string | null } {
    const roles = this.rolesFile();
    if (a.action === "save") return { ok: true, id: roles.save(a.id ? String(a.id) : null, a.role || { label: "" }) };
    if (a.action === "remove") {
      const id = String(a.id || "");
      const assigned = Object.entries(this.roster().load().people).filter(([, p]) => p.role === id).map(([email]) => email);
      roles.remove(id, assigned);
      return { ok: true, id: null };
    }
    throw httpError(400, `Unknown action ${(a as any).action}`);
  }

  /** Commit workspace.json on its own (the Roles section's Commit button). */
  commitRoles(): Promise<RolesStatus> { return this.rolesFile().commit(); }

  private profile(cfg: HostingConfig, id: string | null | undefined): Profile {
    return cfg.profiles.find((p) => p.id === id) || cfg.profiles.find((p) => p.id === cfg.defaultProfile)!;
  }

  /** One action; returns the platform CLI's output (or the dry run's), and what would be applied. */
  async act(a: PeopleAction): Promise<{ ok: true; dryRun: boolean; output: string; objects?: unknown[] }> {
    try { return await this.act1(a); }
    catch (e) {
      // The page shows only the message: carry the fix in it.
      if (e?.fix && !String(e.message).includes(e.fix)) e.message = `${e.message} (${e.fix})`;
      throw e;
    }
  }

  private async act1(a: PeopleAction): Promise<{ ok: true; dryRun: boolean; output: string; objects?: unknown[] }> {
    const { cfg, problems } = this.config();
    if (!cfg) throw httpError(400, problems[0] || "Set up .claude/dashboard/hosting.json first.");
    const email = String(a.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "That isn't an email address.");
    const dryRun = !!a.dryRun;
    const k = this.platform(cfg);
    const roster = this.roster();
    // A preview can use the page's listing; a change for real checks the platform first.
    const cluster = await this.cluster(cfg, !dryRun);
    if (!dryRun) this.clusterCache = null; // whatever happens next, the next load asks again
    const c = cluster.get(email) || null;
    const by = await this.who();
    const at = new Date().toISOString();
    const pickProfile = (id: string | undefined, fallback?: string | null) => {
      const want = id || fallback || cfg.defaultProfile;
      const p = cfg.profiles.find((x) => x.id === want);
      if (!p) throw httpError(400, `There's no profile "${want}".`);
      return p;
    };
    // undefined keeps `fallback`; "" means they pick their own.
    const pickRole = (id: string | undefined, fallback?: string | null): string | null => {
      const want = id === undefined ? fallback || null : id || null;
      if (!want) return null;
      const roles = this.roles();
      if (!roles.some((r) => r.id === want)) throw httpError(400, roles.length ? `There's no role "${want}" (this workspace has ${roles.map((r) => r.id).join(", ")}).` : "This workspace has no roles to assign (workspace.json roles).");
      return want;
    };
    // undefined keeps `fallback`; "" means it follows their role.
    const pickAccess = (v: string | undefined, fallback?: "full" | "read" | null): "full" | "read" | null => {
      const want = v === undefined ? fallback || null : String(v || "").trim().toLowerCase() || null;
      if (want && want !== "full" && want !== "read") throw httpError(400, 'access is "full", "read", or "" to follow their role.');
      return want as "full" | "read" | null;
    };

    switch (a.action) {
      case "provision": {
        if (cfg.directory.domain && !email.endsWith(`@${cfg.directory.domain}`)) throw httpError(400, `Only ${cfg.directory.domain} addresses can have a dashboard.`);
        if (c) throw httpError(409, `${email} already has a dashboard (${c.name}).`);
        const doc = roster.load();
        const profile = pickProfile(a.profile, doc.people[email]?.profile);
        const role = pickRole(a.role, doc.people[email]?.role);
        const access = pickAccess(a.access, doc.people[email]?.access);
        const slug = doc.people[email]?.slug || uniqueSlug(email, doc, cluster);
        const rendered = await k.render({ email, slug, profile, role, access }, null);
        const objects = rendered.objects;
        const output = await k.apply(rendered, dryRun);
        if (dryRun) return { ok: true, dryRun, output, objects };
        const name = await this.nameOf(cfg, email);
        roster.update((d) => {
          const was = d.people[email];
          d.people[email] = { name, slug, profile: profile.id, ...(role ? { role } : {}), ...(access ? { access } : {}), provisionedAt: was?.provisionedAt || at, provisionedBy: was?.provisionedBy || by, ...(was ? { updatedAt: at, updatedBy: by } : {}) };
          return true;
        });
        return { ok: true, dryRun, output };
      }
      case "update":
      case "profile":
      case "role":
      case "access": {
        const r = roster.load().people[email];
        if (!r) throw httpError(404, `${email} isn't in the roster. Adopt or provision them first.`);
        const profile = pickProfile(a.action === "profile" ? a.profile : r.profile);
        // A role or access change re-applies like a profile change: their dashboard restarts with the new setting.
        const role = a.action === "role" ? pickRole(a.role ?? "") : r.role || null;
        const access = a.action === "access" ? pickAccess(a.access ?? "") : r.access || null;
        let output = "";
        let objects: unknown[] | undefined;
        if (c) {
          const rendered = await k.render({ email, slug: r.slug, profile, role, access }, c);
          objects = rendered.objects;
          output = await k.apply(rendered, dryRun);
        } else if (a.action === "update") throw httpError(404, `${email} has no dashboard on the cluster. Provision it again.`);
        const would = a.action === "role" ? (role ? `Would set ${email}'s role to ${role}.` : `Would let ${email} pick their own role.`)
          : a.action === "access" ? (access ? `Would give ${email} ${access} access.` : `Would let ${email}'s access follow their role.`)
          : `Would set ${email}'s profile to ${profile.name}.`;
        if (dryRun) return { ok: true, dryRun, output: output || would, objects };
        if (r.profile !== profile.id || (r.role || null) !== role || (r.access || null) !== access) {
          roster.update((d) => {
            if (!d.people[email]) return false;
            const { role: _was, access: _had, ...rest } = d.people[email];
            d.people[email] = { ...rest, profile: profile.id, ...(role ? { role } : {}), ...(access ? { access } : {}), updatedAt: at, updatedBy: by };
            return true;
          });
        }
        return { ok: true, dryRun, output };
      }
      case "start":
      case "stop": {
        if (!c) throw httpError(404, `${email} has no dashboard on the cluster.`);
        if (dryRun) return { ok: true, dryRun, output: `Would ${a.action} ${c.name}.` };
        return { ok: true, dryRun, output: await (a.action === "start" ? k.start(c) : k.stop(c)) };
      }
      case "remove": {
        const keepVolume = a.keepVolume !== false;
        const output = c ? await k.remove(c, keepVolume, dryRun) : "Nothing running for them.";
        if (dryRun) return { ok: true, dryRun, output };
        roster.update((d) => {
          if (!d.people[email]) return false;
          delete d.people[email];
          return true;
        });
        return { ok: true, dryRun, output };
      }
      case "adopt": {
        if (!c) throw httpError(404, `${email} has no dashboard on the cluster to adopt.`);
        const profile = pickProfile(a.profile, c.profile);
        const slug = c.slug || c.name.replace(/^dashboard-/, "");
        if (dryRun) return { ok: true, dryRun, output: `Would add ${email} to the roster as ${slug}, profile ${profile.name}. Nothing on the cluster changes.` };
        const name = await this.nameOf(cfg, email);
        roster.update((d) => {
          if (d.people[email]) return false;
          d.people[email] = { name, slug, profile: profile.id, provisionedAt: at, provisionedBy: by };
          return true;
        });
        return { ok: true, dryRun, output: `Added ${email} to the roster.` };
      }
      case "forget": {
        if (c) throw httpError(409, `${email} still has a dashboard on the cluster: remove it instead.`);
        if (dryRun) return { ok: true, dryRun, output: `Would remove ${email} from the roster.` };
        roster.update((d) => {
          if (!d.people[email]) return false;
          delete d.people[email];
          return true;
        });
        return { ok: true, dryRun, output: `Removed ${email} from the roster.` };
      }
      default:
        throw httpError(400, `Unknown action ${(a as any).action}`);
    }
  }

  private roster(): Roster { return new Roster(this.root, this.configDir, this.run); }

  /** Commit people.json on its own (the page's Commit button). Pushing stays with the engineer. */
  async commitRoster(): Promise<RosterStatus> {
    if (!this.config().cfg) throw httpError(400, "Set up .claude/dashboard/hosting.json first.");
    return this.roster().commit();
  }

  private async nameOf(cfg: HostingConfig, email: string): Promise<string> {
    try { return (await this.directory(cfg, false)).find((p) => p.email === email)?.name || email; } catch { return email; }
  }
}

/** The short name in their object names (dashboard-<slug>): from the email, unique, kept for good. */
export function uniqueSlug(email: string, doc: RosterDoc, cluster: Map<string, Dashboard>): string {
  const base = (email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "person").slice(0, 40).replace(/-+$/, "");
  const taken = new Set<string>([
    ...Object.values<RosterPerson>(doc.people).map((p) => p.slug),
    ...[...cluster.values()].flatMap((c) => [c.slug, c.name.replace(/^dashboard-/, "")].filter(Boolean) as string[]),
  ]);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
