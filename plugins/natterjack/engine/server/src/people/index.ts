/**
 * The People page (an engineer's local dashboard only): everyone in the directory, who
 * has a hosted dashboard, and their profile and role. Three sources, one row per email:
 *
 *   directory (who could have one)  +  roster (people.json in the repo: who should)  +  cluster (who does)
 *
 * and the actions that bring them in line: provision, update, change profile or role, start,
 * stop, remove (keeping the volume or not), adopt one made by hand, forget a missing one.
 * Every write can be previewed first (dryRun). Nothing here runs on a hosted dashboard.
 */

import { CONFIG_DIR, workspaceConfig, type RoleConfig } from "../config.ts";
import type { HostingConfig, Profile } from "./config.ts";
import { readHosting } from "./config.ts";
import { runCli, type Runner } from "./cli.ts";
import { makeDirectory, type DirectoryPerson, type Fetcher } from "./directory.ts";
import { makePlatform, type Dashboard, type Platform } from "./platform.ts";
import { Roster, type RosterDoc, type RosterPerson, type RosterStatus } from "./roster.ts";

export type PersonState = "not-set-up" | "running" | "starting" | "stopped" | "left" | "missing" | "unmanaged";

export interface PersonRow {
  email: string;
  name: string;
  /** In the directory and active; null when the directory couldn't be read or isn't used. */
  active: boolean | null;
  state: PersonState;
  slug: string | null;
  profile: string | null;
  needsUpdate: boolean;
  /** The workspace role assigned to them (DASHBOARD_ROLE); null: they pick their own. */
  role: string | null;
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
  /** workspace.json roles one can be assigned; empty when the team has none. */
  roles: { id: string; label: string }[];
  rows: PersonRow[];
}

export interface PeopleAction {
  action: "provision" | "update" | "profile" | "role" | "start" | "stop" | "remove" | "adopt" | "forget";
  email: string;
  profile?: string;
  /** A workspace role id, or "" for "they pick their own" (provision, role). */
  role?: string;
  keepVolume?: boolean;
  dryRun?: boolean;
}

const DIRECTORY_TTL = 5 * 60_000;
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
    const empty: PeopleView = { configured, problems, errors: [], directory: { label: "", type: "", count: null }, roster: null, cluster: null, dataLabel: null, profiles: [], defaultProfile: null, roles: [], rows: [] };
    if (!cfg) return empty;
    const k = this.platform(cfg);
    const roster = this.roster();
    const dirLabel = makeDirectory(cfg.directory, this.run, this.fetcher).label;
    const [dir, ros, clu] = await Promise.allSettled([this.directory(cfg, force), roster.status().then((status) => ({ doc: roster.load(), status })), k.list()]);
    const errors: PeopleView["errors"] = [];
    if (dir.status === "rejected") errors.push(errOf("directory", dir.reason));
    if (ros.status === "rejected") errors.push(errOf("roster", ros.reason));
    if (clu.status === "rejected") errors.push(errOf("cluster", clu.reason));
    const directory = dir.status === "fulfilled" ? dir.value : null;
    const doc = ros.status === "fulfilled" ? ros.value.doc : null;
    const cluster = clu.status === "fulfilled" ? clu.value : null;

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
      else if (r && !c && cluster) state = "missing";
      else if (c) state = c.running ? (c.ready ? "running" : "starting") : "stopped";
      else state = "missing";
      let needsUpdate = false;
      if (c && r && !templateError) {
        const profile = this.profile(cfg, r.profile);
        try { needsUpdate = (await k.render({ email, slug: r.slug, profile, role: r.role || null }, c)).hash !== c.applied; }
        catch (e) { templateError = e; }
      }
      rows.push({
        email, name: d?.name || r?.name || email, active, state,
        slug: r?.slug || c?.slug || null, profile: r?.profile || c?.profile || null, needsUpdate, role: r?.role || null,
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
      roles: this.roles().map((r) => ({ id: r.id, label: r.label })),
      rows,
    };
  }

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
    const cluster = await k.list();
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

    switch (a.action) {
      case "provision": {
        if (cfg.directory.domain && !email.endsWith(`@${cfg.directory.domain}`)) throw httpError(400, `Only ${cfg.directory.domain} addresses can have a dashboard.`);
        if (c) throw httpError(409, `${email} already has a dashboard (${c.name}).`);
        const doc = roster.load();
        const profile = pickProfile(a.profile, doc.people[email]?.profile);
        const role = pickRole(a.role, doc.people[email]?.role);
        const slug = doc.people[email]?.slug || uniqueSlug(email, doc, cluster);
        const rendered = await k.render({ email, slug, profile, role }, null);
        const objects = rendered.objects;
        const output = await k.apply(rendered, dryRun);
        if (dryRun) return { ok: true, dryRun, output, objects };
        const name = await this.nameOf(cfg, email);
        roster.update((d) => {
          const was = d.people[email];
          d.people[email] = { name, slug, profile: profile.id, ...(role ? { role } : {}), provisionedAt: was?.provisionedAt || at, provisionedBy: was?.provisionedBy || by, ...(was ? { updatedAt: at, updatedBy: by } : {}) };
          return true;
        });
        return { ok: true, dryRun, output };
      }
      case "update":
      case "profile":
      case "role": {
        const r = roster.load().people[email];
        if (!r) throw httpError(404, `${email} isn't in the roster. Adopt or provision them first.`);
        const profile = pickProfile(a.action === "profile" ? a.profile : r.profile);
        // A role change re-applies like a profile change: their dashboard restarts with the new DASHBOARD_ROLE.
        const role = a.action === "role" ? pickRole(a.role ?? "") : r.role || null;
        let output = "";
        let objects: unknown[] | undefined;
        if (c) {
          const rendered = await k.render({ email, slug: r.slug, profile, role }, c);
          objects = rendered.objects;
          output = await k.apply(rendered, dryRun);
        } else if (a.action === "update") throw httpError(404, `${email} has no dashboard on the cluster. Provision it again.`);
        const would = a.action === "role" ? (role ? `Would set ${email}'s role to ${role}.` : `Would let ${email} pick their own role.`) : `Would set ${email}'s profile to ${profile.name}.`;
        if (dryRun) return { ok: true, dryRun, output: output || would, objects };
        if (r.profile !== profile.id || (r.role || null) !== role) {
          roster.update((d) => {
            if (!d.people[email]) return false;
            const { role: _was, ...rest } = d.people[email];
            d.people[email] = { ...rest, profile: profile.id, ...(role ? { role } : {}), updatedAt: at, updatedBy: by };
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
