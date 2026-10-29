/**
 * The Get started page: one checklist of what a new person needs to do (pick a role, sign in to
 * Claude and GitHub, get the Atlassian secret and connect, get the code, set up the machine,
 * connect the team's MCP servers), each step's state read from the check that already exists
 * for it, so nothing here keeps a second copy of it.
 *
 * The built-in steps (BUILTIN_STEPS) come from config that's already there; the optional
 * .claude/dashboard/onboarding.json reorders, rewords or turns them off, names who to ask
 * (`contacts`), and adds the team's own steps:
 *
 *   { "intro": "Welcome to Acme engineering.",
 *     "contacts": { "eng-lead": { "label": "Your engineering lead", "how": "Ask in #eng-help" } },
 *     "steps": [ { "use": "github", "detail": "Ask {contact} to add you to the org.", "contact": "eng-lead" },
 *                { "use": "connections", "off": true },
 *                { "check": "vpn-client" },
 *                { "id": "slack", "kind": "manual", "label": "Join #acme-dev", "link": "https://…", "optional": true } ] }
 *
 * "steps": false turns the page off. Built-ins it doesn't list keep their place: right after
 * the nearest earlier built-in it does list. Every step can have a `when` (machine.ts whenMatches).
 *
 * Per person, in <ledger>/onboarding.json: the manual steps they ticked and when they clicked
 * "I'll finish later". The Atlassian client secret they paste goes to <ledger>/atlassian-client-secret
 * (owner-only), where atlassian-auth.ts reads it on every call.
 */

import fs from "node:fs";
import path from "node:path";
import type { Connection, OnboardingBoot, OnboardingBuiltin, OnboardingCheck, OnboardingContact, OnboardingResponse, OnboardingStep } from "../../shared/api.ts";
import { writeAtomic } from "./atomic-write.ts";
import { SECRET_ENV, SECRET_FILE, atlassianConfig, clientSecret } from "./atlassian-auth.ts";
import { readConfigFile, workspaceConfig } from "./config.ts";
import { needsAttention, readRequired } from "./connections.ts";
import { resolvedSpecs, whenMatches, type WhenContext } from "./machine.ts";
import { readProfile } from "./profile.ts";
import { readRepos, repoState, type RepoDef } from "./repos.ts";

type BuiltinStep = { label: string; detail: string };
/** The built-in steps in their default order, with their default wording. validate.mjs reads these keys. */
export const BUILTIN_STEPS: Record<OnboardingBuiltin, BuiltinStep> = {
  role: { label: "Pick your role", detail: "Your role decides which pages and skills you see. You can change it later in Settings." },
  claude: { label: "Sign in to Claude", detail: "Every run on this dashboard uses your own Claude account." },
  github: { label: "Sign in to GitHub", detail: "Runs clone, push branches and open pull requests as you." },
  "atlassian-secret": { label: "Get the Atlassian client secret", detail: "Connecting to Atlassian needs the team's app secret on this computer. Ask {contact} for it and paste it here; it stays on this computer." },
  atlassian: { label: "Connect to Atlassian", detail: "Jira and Confluence are read as you." },
  repos: { label: "Clone the repos", detail: "The team's code, from repos.json." },
  machine: { label: "Set up this computer", detail: "The tools the apps need: the Machine page's required checks." },
  connections: { label: "Connect the team's tools", detail: "The MCP servers the team relies on: the Connections page." },
};
const DEFAULT_ORDER = Object.keys(BUILTIN_STEPS) as OnboardingBuiltin[];
const DOWNLOAD = { label: "Download the code", detail: "Read-only copies of the team's repos, so you can ask about them and explore them." };
/** {contact} in a detail when the step names no contact. */
const NO_CONTACT = "someone on your team";
const MAX_SECRET = 512;
const CONFIG_FILE = "onboarding.json";
const LEDGER_FILE = "onboarding.json";
const STEP_ID = /^[a-z0-9][\w-]{0,63}$/i;

const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

/** onboarding.json: { data: null, error: null } when there's none. */
export function readOnboarding() { return readConfigFile(CONFIG_FILE); }

// ------------------------------------------------------------------ which steps

/** What decides which steps apply (stepContext reads it from the workspace's config). */
export interface StepContext extends WhenContext {
  /** workspace.json has roles, and none was assigned (DASHBOARD_ROLE). */
  rolesConfigured: boolean;
  roleLocked: boolean;
  codeHost: string;
  atlassian: { used: boolean; clientId: boolean };
  /** ATLASSIAN_CLIENT_SECRET supplies the secret: nothing to paste. */
  secretFromEnv: boolean;
  /** repos.json repos with a remote (to clone), and in the snapshot when there's a source (to download). */
  repos: { clone: number; download: number };
  /** machine.json's checks for this person (machine.ts resolvedSpecs). */
  machine: { configured: boolean; checks: { id: string; label: string; kind: string; use?: string; hostedSignIn?: string }[] };
  /** connections.json `required` servers. */
  connectionsRequired: number;
}

/** A step from resolveSteps: what it is and says, before its state is known. */
export interface ResolvedStep {
  id: string;
  kind: OnboardingStep["kind"];
  label: string;
  /** With {contact} filled in. */
  detail: string | null;
  contact: OnboardingContact | null;
  link: string | null;
  optional: boolean;
  /** repos: how this person gets the code. */
  via?: "clone" | "download";
  /** claude, github, check: the machine.json check it mirrors, if there is one. */
  checkId?: string | null;
}

const isGithubCheck = (c: { id: string; use?: string; hostedSignIn?: string }) => c.hostedSignIn === "github" || c.use === "gh" || c.id === "gh";

/** Does a built-in step apply here at all (before its `when`, the file's step for it)? */
function applies(b: OnboardingBuiltin, ctx: StepContext, when: any): boolean {
  switch (b) {
    case "role": return ctx.rolesConfigured && !ctx.roleLocked;
    case "claude": return true;
    // The code host's sign-in is the Machine page's gh check; no gh check, no step (validate.mjs warns).
    // A reader only downloads, so not for them unless its `when` names their access (as machine.ts does for run checks).
    case "github": return ctx.codeHost === "github" && ctx.machine.checks.some(isGithubCheck) && (ctx.profile !== "reader" || !!(when && (when.profile || when.access)));
    // Hosted, the deployment supplies the secret.
    case "atlassian-secret": return ctx.atlassian.used && ctx.atlassian.clientId && !ctx.hosted && !ctx.secretFromEnv;
    case "atlassian": return ctx.atlassian.used && ctx.atlassian.clientId;
    // A hosted dashboard has its code already; a reader can only download it, when there's somewhere to download it from.
    case "repos": return !ctx.hosted && (ctx.profile === "reader" ? ctx.repos.download : ctx.repos.clone) > 0;
    case "machine": return !ctx.hosted && ctx.machine.configured;
    case "connections": return ctx.connectionsRequired > 0;
  }
}

/** The file's step list with the built-ins it doesn't list put in: right after the nearest earlier built-in it does list. */
function withUnlisted(listed: any[]): any[] {
  const named = new Set(listed.map((s) => (s && typeof s.use === "string" ? s.use : null)).filter(Boolean));
  const lead: any[] = [];
  const after = new Map<string, any[]>();
  DEFAULT_ORDER.forEach((b, i) => {
    if (named.has(b)) return;
    const anchor = DEFAULT_ORDER.slice(0, i).reverse().find((x) => named.has(x));
    if (anchor) after.set(anchor, [...(after.get(anchor) || []), { use: b }]);
    else lead.push({ use: b });
  });
  const out = [...lead];
  for (const s of listed) {
    out.push(s);
    const more = s && typeof s.use === "string" ? after.get(s.use) : undefined;
    if (more) { out.push(...more); after.delete(s.use); }
  }
  return out;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The steps for this person: the built-ins merged with onboarding.json (`file`, its parsed JSON or
 * null), each kept only where it applies and its `when` matches. `problems`: what's wrong with the
 * file (that step is skipped, or the first of two with one id is kept); the rest still works.
 */
export function resolveSteps(file: any, ctx: StepContext): { enabled: boolean; intro: string | null; steps: ResolvedStep[]; problems: string[] } {
  const f = file && typeof file === "object" && !Array.isArray(file) ? file : {};
  const intro = text(f.intro);
  const problems: string[] = [];
  if (f.steps === false) return { enabled: false, intro, steps: [], problems };

  const contacts = new Map<string, OnboardingContact>();
  const rawContacts = f.contacts && typeof f.contacts === "object" && !Array.isArray(f.contacts) ? f.contacts : {};
  for (const [id, c] of Object.entries<any>(rawContacts)) {
    if (!c || !text(c.label)) { problems.push(`contacts.${id} needs a "label"`); continue; }
    contacts.set(id, { id, label: text(c.label)!, how: text(c.how) || "" });
  }

  let listed: any[];
  if (f.steps === undefined) listed = [];
  else if (Array.isArray(f.steps)) listed = f.steps;
  else { problems.push('"steps" must be a list of steps, or false to turn the page off'); listed = []; }

  const seen = new Set<string>();
  const steps: ResolvedStep[] = [];
  for (const raw of withUnlisted(listed)) {
    if (!raw || typeof raw !== "object") { problems.push("every step is an object"); continue; }
    if (raw.off === true) continue;
    let step: ResolvedStep;
    if (raw.use !== undefined) {
      const b = raw.use as OnboardingBuiltin;
      if (!DEFAULT_ORDER.includes(b)) { problems.push(`"use": "${raw.use}" isn't a built-in step (${DEFAULT_ORDER.join(", ")})`); continue; }
      if (!applies(b, ctx, raw.when)) continue;
      const via = b === "repos" ? (ctx.profile === "reader" ? "download" : "clone") : undefined;
      const base = via === "download" ? DOWNLOAD : BUILTIN_STEPS[b];
      step = { id: b, kind: b, label: text(raw.label) || base.label, detail: text(raw.detail) ?? base.detail, contact: null, link: null, optional: raw.optional === true };
      if (via) step.via = via;
      if (b === "claude") step.checkId = ctx.machine.checks.find((c) => c.kind === "claude-code")?.id ?? null;
      if (b === "github") step.checkId = ctx.machine.checks.find(isGithubCheck)?.id ?? null;
    } else if (raw.check !== undefined) {
      // Left out with the check: its own `when` (or the access) may leave it out of machine.json's list here.
      const c = ctx.machine.checks.find((x) => x.id === raw.check);
      if (!c) continue;
      const id = text(raw.id) || c.id;
      if (!STEP_ID.test(id)) { problems.push(`step "${id}": an "id" is letters, digits, - and _${text(raw.id) ? "" : ' (give the step its own "id")'}`); continue; }
      step = { id, kind: "check", label: text(raw.label) || c.label, detail: text(raw.detail), contact: null, link: null, optional: raw.optional === true, checkId: c.id };
    } else {
      const id = text(raw.id), label = text(raw.label);
      if (raw.kind !== undefined && raw.kind !== "manual") { problems.push(`step "${id || "?"}": kind "${raw.kind}" isn't a step kind (use a built-in with "use", a Machine check with "check", or "kind": "manual")`); continue; }
      if (!id || !STEP_ID.test(id) || !label) { problems.push(`a manual step needs an "id" (letters, digits, - and _) and a "label"${id ? ` (${id})` : ""}`); continue; }
      const link = text(raw.link);
      if (link && !/^https:\/\//i.test(link)) problems.push(`step "${id}": link must start with https://`);
      step = { id, kind: "manual", label, detail: text(raw.detail), contact: null, link: link && /^https:\/\//i.test(link) ? link : null, optional: raw.optional === true };
    }
    // A built-in the file doesn't list is still added, under its own name (validate.mjs says the same).
    if (step.kind !== step.id && DEFAULT_ORDER.includes(step.id as OnboardingBuiltin)) { problems.push(`step "${step.id}": "${step.id}" is a built-in step's id; give your step another "id"`); continue; }
    if (!whenMatches(raw.when, ctx)) continue;
    if (seen.has(step.id)) { problems.push(`two steps have the id "${step.id}"; the first is used`); continue; }
    seen.add(step.id);
    if (raw.contact !== undefined) {
      step.contact = contacts.get(String(raw.contact)) || null;
      if (!step.contact) problems.push(`step "${step.id}": contact "${raw.contact}" isn't in contacts`);
    }
    if (step.detail) step.detail = step.detail.replace(/\{contact\}/g, step.contact ? step.contact.label : NO_CONTACT);
    steps.push(step);
  }
  return { enabled: true, intro, steps, problems };
}

// ------------------------------------------------------------------ their state

/** Where each step's state comes from; main.ts passes the dashboard's own, tests stand-ins. */
export interface Probes {
  claudeAuth(force: boolean): Promise<{ installed: boolean; loggedIn: boolean }>;
  /** The Machine page's report (machine.ts Machine.get). */
  machine(force: boolean): Promise<{ checks: any[] }>;
  /** The Connections page (connections.ts Connections.list): checkedAt null until `claude mcp list` has run. */
  connections(): Promise<{ connections: Connection[]; checkedAt: number | null }>;
  atlassian(): { connected: boolean; viewer: string | null; signInProblem: string | null };
  /** repos.json's snapshot source, or null. */
  snapshot(): { label: string; connected: boolean } | null;
  /** The client secret is there (the env var or the ledger file). */
  secret(): boolean;
  repos(): RepoDef[];
  repoState(rel: string): string;
  profile(): { roleChosen: boolean; roleLabel: string };
  ticks(): Record<string, string>;
}

const asCheck = (c: any): OnboardingCheck => ({
  id: c.id, label: c.label, status: c.status, detail: c.detail || "", install: c.install ? c.install.label || "Install" : null, fix: c.fix || "",
});
const list = (names: string[], max = 4) => names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isGithubHttps = (remote: string | null) => !!remote && /^https:\/\/github\.com\//i.test(remote);

/**
 * Each step's state, in parallel, then what waits for what (blockedBy). `warm` (the startup warm-up):
 * the connections step stays checking rather than start `claude mcp list`.
 */
export async function evaluate(steps: ResolvedStep[], probes: Probes, opts: { force?: boolean; hosted?: boolean; warm?: boolean } = {}): Promise<OnboardingStep[]> {
  const force = !!opts.force;
  let report: Promise<{ checks: any[] }> | null = null;
  const machine = () => (report ||= probes.machine(force).catch(() => ({ checks: [] })));
  const checkOf = async (id: string | null | undefined) => (id ? (await machine()).checks.find((c) => c.id === id) || null : null);
  // The machine step leaves out what the claude, github and check steps show on their own.
  const claimed = new Set(steps.map((s) => s.checkId).filter((id): id is string => !!id));
  const ticks = probes.ticks();
  const githubHttps: { [id: string]: boolean } = {};

  const one = async (s: ResolvedStep): Promise<OnboardingStep> => {
    const out: OnboardingStep = {
      id: s.id, kind: s.kind, label: s.label, detail: s.detail, contact: s.contact, link: s.link, optional: s.optional,
      state: "todo", blockedBy: [], status: null, doneAt: null, check: null, signIn: null,
    };
    const done = (yes: boolean, status: string | null) => { out.state = yes ? "done" : "todo"; out.status = status; };
    switch (s.kind) {
      case "role": {
        const p = probes.profile();
        done(p.roleChosen, p.roleChosen ? `You're ${p.roleLabel}.` : null);
        break;
      }
      case "claude": {
        const [a, c] = await Promise.all([probes.claudeAuth(force).catch(() => ({ installed: false, loggedIn: false })), checkOf(s.checkId)]);
        done(a.loggedIn, !a.installed ? "Claude Code isn't installed on this computer." : a.loggedIn ? "Signed in." : "Not signed in yet.");
        if (c) out.check = asCheck(c);
        if (opts.hosted && !a.loggedIn) out.signIn = "claude";
        break;
      }
      case "github":
      case "check": {
        const c = await checkOf(s.checkId);
        done(c?.status === "ok", c ? c.detail || null : "Not checked yet: Re-check.");
        if (c) out.check = asCheck(c);
        if (s.kind === "github" && c?.signIn === "github" && c.status !== "ok") out.signIn = "github";
        break;
      }
      case "atlassian-secret": {
        const yes = probes.secret();
        done(yes, yes ? "Saved on this computer." : null);
        break;
      }
      case "atlassian": {
        const st = probes.atlassian();
        done(st.connected, st.connected ? (st.viewer ? `Connected as ${st.viewer}.` : "Connected.") : st.signInProblem);
        break;
      }
      case "repos": {
        const repos = probes.repos().filter((r) => (s.via === "download" ? r.snapshot : !!r.remote));
        const missing = repos.filter((r) => probes.repoState(r.relativePath) === "missing");
        // Only a clone signs in to GitHub; a download comes from the snapshot source.
        githubHttps[s.id] = s.via !== "download" && missing.some((r) => isGithubHttps(r.remote));
        const source = s.via === "download" ? probes.snapshot() : null;
        out.repos = { via: s.via || "clone", missing: missing.map((r) => r.name), source };
        const verb = s.via === "download" ? "download" : "clone";
        done(!missing.length, !missing.length ? `${plural(repos.length, "repo")} here.`
          : source && !source.connected ? `Connect ${source.label} first, then download ${plural(missing.length, "repo")}.`
          : `${plural(missing.length, "repo")} to ${verb}: ${list(missing.map((r) => r.name))}.`);
        break;
      }
      case "machine": {
        const missing = (await machine()).checks.filter((c) => c.status === "missing" && !claimed.has(c.id));
        out.machine = { missing: missing.map(asCheck) };
        done(!missing.length, missing.length ? `Missing: ${list(missing.map((c) => c.label))}.` : "Everything required is installed.");
        break;
      }
      case "connections": {
        const r = opts.warm ? { connections: [] as Connection[], checkedAt: null } : await probes.connections().catch(() => ({ connections: [] as Connection[], checkedAt: null }));
        const attention = r.connections.filter(needsAttention).map((c) => c.name);
        out.connections = { attention };
        if (!r.checkedAt) { out.state = "checking"; out.status = "Checking the team's MCP servers…"; break; }
        done(!attention.length, attention.length ? `Not working for you yet: ${list(attention)}.` : "All connected.");
        break;
      }
      case "manual": {
        out.doneAt = (Object.hasOwn(ticks, s.id) && ticks[s.id]) || null;
        done(!!out.doneAt, null);
        break;
      }
    }
    return out;
  };
  const out = await Promise.all(steps.map(one));

  // What waits for what: the code (cloned from GitHub over https) for the GitHub sign-in, Atlassian for its secret, MCP servers for Claude.
  const byId = new Map(out.map((s) => [s.id, s]));
  const waits = (s: OnboardingStep): string[] =>
    s.kind === "repos" && githubHttps[s.id] ? ["github"]
      : s.kind === "atlassian" ? ["atlassian-secret"]
      : s.kind === "connections" ? ["claude"] : [];
  for (const s of out) {
    if (s.state === "done") continue;
    const open = waits(s).filter((id) => byId.has(id) && byId.get(id)!.state !== "done");
    if (open.length) { s.state = "blocked"; s.blockedBy = open; }
  }
  return out;
}

/** Required steps still to do (todo or blocked; checking ones aren't counted until they're known). */
export const remainingOf = (steps: OnboardingStep[]) => steps.filter((s) => !s.optional && (s.state === "todo" || s.state === "blocked")).length;

// ------------------------------------------------------------------ the ledger

interface Ledger { ticks: Record<string, string>; dismissedAt: string | null }

export function readLedger(ledgerDir: string): Ledger {
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(ledgerDir, LEDGER_FILE), "utf-8")); } catch {}
  const ticks: Record<string, string> = Object.create(null); // a step id like "constructor" isn't ticked
  for (const [id, at] of Object.entries<any>(raw && typeof raw.ticks === "object" && raw.ticks ? raw.ticks : {})) if (typeof at === "string") ticks[id] = at;
  return { ticks, dismissedAt: raw && typeof raw.dismissedAt === "string" ? raw.dismissedAt : null };
}

const writeLedger = (ledgerDir: string, l: Ledger) => writeAtomic(path.join(ledgerDir, LEDGER_FILE), JSON.stringify(l, null, 2) + "\n");

/** Tick (or untick) a manual step. */
export function setTick(ledgerDir: string, id: string, done: boolean) {
  const l = readLedger(ledgerDir);
  if (done) l.ticks[id] = new Date().toISOString();
  else delete l.ticks[id];
  writeLedger(ledgerDir, l);
}

/** "I'll finish later" (dismissed), or Settings → Reopen (not). */
export function setDismissed(ledgerDir: string, dismissed: boolean) {
  writeLedger(ledgerDir, { ...readLedger(ledgerDir), dismissedAt: dismissed ? new Date().toISOString() : null });
}

/**
 * Save the Atlassian app's client secret they were given to <ledger>/atlassian-client-secret: one line,
 * owner-only, written to a temp file and renamed. Refused (409) when ATLASSIAN_CLIENT_SECRET is set,
 * since that's the one in use. Returns nothing: the secret never goes back to the browser.
 */
export function saveClientSecret(ledgerDir: string, secret: unknown): void {
  if (String(process.env[SECRET_ENV] || "").trim()) throw failure(409, `${SECRET_ENV} is set on this computer, so that's the secret in use; change it there instead.`);
  // What clientSecret() reads back: a pasted `ATLASSIAN_CLIENT_SECRET=` line holds the secret, and matching quotes aren't part of it.
  let s = typeof secret === "string" ? secret.trim() : "";
  if (s.startsWith(`${SECRET_ENV}=`)) s = s.slice(SECRET_ENV.length + 1).trim();
  s = s.replace(/^(["'])(.*)\1$/s, "$2").trim();
  if (!s) throw failure(400, "Paste the client secret.");
  if (/[\u0000-\u001f\u007f]/.test(s)) throw failure(400, "The client secret is one line, with no spaces at the ends.");
  if (s.length > MAX_SECRET) throw failure(400, `That's too long for a client secret (${MAX_SECRET} characters at most).`);
  // As KEY=value: atlassian-auth.ts reads that form too, and a secret starting with # isn't taken for a comment.
  writeAtomic(path.join(ledgerDir, SECRET_FILE), `${SECRET_ENV}=${s}\n`, 0o600);
}

// ------------------------------------------------------------------ the page

export interface OnboardingOptions {
  root: string;
  ledgerDir: string;
  hosted: boolean;
  /** A role assigned on the People page (DASHBOARD_ROLE): no role step. */
  roleLocked: boolean;
  /** The dashboard's own checks; the rest default to the workspace and ledger. */
  probes: Pick<Probes, "claudeAuth" | "machine" | "connections" | "atlassian" | "snapshot"> & Partial<Probes>;
}

export class Onboarding {
  private readonly opts: OnboardingOptions;
  private readonly probes: Probes;
  /** The last evaluation, for the boot payload (which can't wait for one). */
  private last: OnboardingResponse | null = null;
  private seq = 0;
  private lastSeq = 0;
  /** A refresh() evaluated the page again (main.ts sends it on the live `onboarding` topic). */
  onChange: ((r: OnboardingResponse) => void) | null = null;

  constructor(opts: OnboardingOptions) {
    this.opts = opts;
    const { root, ledgerDir } = opts;
    this.probes = {
      secret: () => !!clientSecret(ledgerDir),
      repos: () => readRepos(root).repos,
      repoState: (rel) => repoState(root, rel),
      profile: () => { const p = readProfile(ledgerDir); return { roleChosen: p.roleChosen, roleLabel: p.current.label }; },
      ticks: () => readLedger(ledgerDir).ticks,
      ...opts.probes,
    };
  }

  /** What decides which steps apply, from the workspace's config now. */
  context(): StepContext {
    const ws = workspaceConfig();
    const me = readProfile(this.opts.ledgerDir, ws.roles);
    const atl = atlassianConfig();
    const repos = readRepos(this.opts.root);
    const m = resolvedSpecs(this.opts.root, { hosted: this.opts.hosted });
    return {
      root: this.opts.root, hosted: this.opts.hosted, profile: me.profile, role: me.current.id,
      rolesConfigured: ws.rolesConfigured, roleLocked: this.opts.roleLocked,
      codeHost: ws.codeHost.kind,
      atlassian: { used: atl.used, clientId: !!atl.clientId },
      secretFromEnv: !!String(process.env[SECRET_ENV] || "").trim(),
      repos: { clone: repos.repos.filter((r) => !!r.remote).length, download: repos.snapshot ? repos.repos.filter((r) => r.snapshot).length : 0 },
      machine: { configured: m.configured, checks: m.specs.map((s) => ({ id: s.id, label: s.label, kind: s.kind, use: s.use, hostedSignIn: s.hostedSignIn })) },
      connectionsRequired: readRequired().required.size,
    };
  }

  private resolved() {
    const { data, error } = readOnboarding();
    const r = resolveSteps(data, this.context());
    return { ...r, problems: error ? [error, ...r.problems] : r.problems };
  }

  /** GET /api/onboarding. `force`: run the Machine checks and `claude auth status` again. */
  async get(force = false, warm = false): Promise<OnboardingResponse> {
    const seq = ++this.seq;
    const { enabled, intro, steps, problems } = this.resolved();
    const evaluated = enabled ? await evaluate(steps, this.probes, { force, hosted: this.opts.hosted, warm }) : [];
    const { dismissedAt } = readLedger(this.opts.ledgerDir);
    const remaining = remainingOf(evaluated);
    const out: OnboardingResponse = {
      enabled, intro, steps: evaluated, remaining, dismissedAt,
      show: enabled && !dismissedAt && remaining > 0,
      error: problems.length ? problems.join(" ") : null,
      checkedAt: Date.now(),
    };
    // A slower, older evaluation doesn't replace a newer one.
    if (seq >= this.lastSeq) { this.lastSeq = seq; this.last = out; }
    return out;
  }

  /** POST /api/onboarding/tick: only a manual step that's on their list. */
  async tick(id: unknown, done: boolean): Promise<OnboardingResponse> {
    const step = this.resolved().steps.find((s) => s.id === id);
    if (!step || step.kind !== "manual") throw failure(400, "That isn't a step you tick off yourself.");
    setTick(this.opts.ledgerDir, step.id, done);
    return this.get();
  }

  /** POST /api/onboarding/dismiss. */
  async dismiss(dismissed: boolean): Promise<OnboardingResponse> {
    setDismissed(this.opts.ledgerDir, dismissed);
    return this.get();
  }

  /** POST /api/onboarding/atlassian-secret: Connect to Atlassian works straight after (atlassian-auth.ts reads it on each call). */
  async saveSecret(secret: unknown): Promise<OnboardingResponse> {
    saveClientSecret(this.opts.ledgerDir, secret);
    return this.get();
  }

  /** Boot.onboarding: enabled from the file now; the count from the last evaluation (null before the first). */
  boot(): OnboardingBoot {
    const enabled = readOnboarding().data?.steps !== false;
    const remaining = enabled ? (this.last ? this.last.remaining : null) : 0;
    return { enabled, remaining, show: enabled && !readLedger(this.opts.ledgerDir).dismissedAt && (remaining ?? 0) > 0 };
  }

  /** Something a step reads changed (a clone or download finished, a sign-in, a role change): evaluate again in the background, for open pages too. */
  refresh(force = false): Promise<void> {
    return this.get(force).then((r) => this.onChange?.(r), () => {});
  }

  /** The boot payload's count soon after startup, from what's cached: no `claude mcp list` (connections stay checking). */
  async warm(): Promise<OnboardingStep[]> {
    return (await this.get(false, true)).steps;
  }
}
