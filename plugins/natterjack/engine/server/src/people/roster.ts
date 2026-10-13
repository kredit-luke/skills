/**
 * The roster: .claude/dashboard/people.json, committed with the rest of the workspace
 * config. It's who should have a hosted dashboard, their profile and their role; the
 * cluster stays the truth for whether one is running. No secrets: names, emails, profiles and who set
 * each person up. Git history is its audit log, and a change reaches other engineers once
 * it's committed and pushed (the page commits it; pushing is the engineer's).
 *
 *   { "people": { "ana@acme.com": { "name": "Ana Silva", "slug": "ana", "profile": "member", "role": "finance",
 *                                   "provisionedAt": "...", "provisionedBy": "luke@acme.com" } } }
 *
 * `role` (a workspace.json role, optional) is assigned to them and locked; without it they pick their own.
 */

import fs from "node:fs";
import path from "node:path";
import { cliError, notInstalled, parseJson, type Runner } from "./cli.ts";

export interface RosterPerson {
  name: string;
  slug: string;
  profile: string;
  /** The workspace.json role assigned to them; absent: they pick their own. */
  role?: string;
  provisionedAt: string;
  provisionedBy: string;
  updatedAt?: string;
  updatedBy?: string;
}
export interface RosterDoc { people: Record<string, RosterPerson> }

export interface RosterStatus {
  /** Workspace-relative path, "/"-separated. */
  file: string;
  /** people.json differs from what's committed (or isn't committed yet). */
  uncommitted: boolean;
  /** What changed since the last commit, one line each ("Added ana@acme.com (member)"). */
  changes: string[];
}

export class Roster {
  readonly file: string;
  readonly rel: string;
  private readonly root: string;
  private readonly run: Runner;

  constructor(workspaceRoot: string, configDir: string, run: Runner) {
    this.root = workspaceRoot;
    this.file = path.join(configDir, "people.json");
    this.rel = path.relative(workspaceRoot, this.file).split(path.sep).join("/");
    this.run = run;
  }

  load(): RosterDoc {
    let text: string;
    try { text = fs.readFileSync(this.file, "utf-8"); }
    catch (e) {
      // Only a missing roster is an empty one: reading past any other error could overwrite it.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { people: {} };
      throw Object.assign(new Error(`Couldn't read ${this.rel}: ${(e as Error).message}`), { status: 500 });
    }
    return parse(text, this.rel);
  }

  /** Change it and write it back (atomically). `change` returns false for "nothing to do". */
  update(change: (doc: RosterDoc) => boolean): RosterDoc {
    const doc = this.load();
    if (!change(doc)) return doc;
    const sorted = Object.fromEntries(Object.entries(doc.people).sort(([a], [b]) => a.localeCompare(b)));
    const out = { $comment: "Who has a hosted dashboard, and their profile. Managed from the dashboard's People page (hosting.json says where they run).", people: sorted };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
    try { fs.renameSync(tmp, this.file); } catch { fs.copyFileSync(tmp, this.file); fs.unlinkSync(tmp); }
    return { people: sorted };
  }

  private git(args: string[], timeout = 30_000) {
    return this.run("git", ["-C", this.root, ...args], { timeout });
  }

  /** What's in the last commit, for the "not committed yet" banner. */
  private async committed(): Promise<RosterDoc | null> {
    const r = await this.git(["show", `HEAD:${this.rel}`]);
    if (!r.ok) return null; // not committed yet (or no commits)
    try { return parse(r.stdout, `${this.rel} (committed)`); } catch { return { people: {} }; }
  }

  async status(): Promise<RosterStatus> {
    const st = await this.git(["status", "--porcelain", "--", this.rel]);
    if (notInstalled(st)) throw Object.assign(new Error("git isn't installed."), { status: 502 });
    if (!st.ok) throw cliError(`Checking ${this.rel} with git`, st);
    if (!st.stdout.trim()) return { file: this.rel, uncommitted: false, changes: [] };
    return { file: this.rel, uncommitted: true, changes: describe(await this.committed(), this.load()) };
  }

  /** Commit people.json alone (whatever else is staged stays staged). Pushing is the engineer's. */
  async commit(): Promise<RosterStatus> {
    const { uncommitted, changes } = await this.status();
    if (!uncommitted) return this.status();
    const add = await this.git(["add", "--", this.rel]);
    if (!add.ok) throw cliError(`git add ${this.rel}`, add);
    const subject = changes.length === 1 ? `chore(people): ${lowerFirst(changes[0])}` : `chore(people): update the hosted dashboard roster (${changes.length} changes)`;
    const body = changes.length > 1 ? changes.map((c) => `- ${c}`).join("\n") : "";
    const r = await this.git(["commit", "--only", "-m", subject, ...(body ? ["-m", body] : []), "--", this.rel], 60_000);
    if (!r.ok) throw cliError(`Committing ${this.rel}`, r, /user\.email|user\.name|identity/i.test(r.stderr) ? "set git config user.name and user.email" : undefined);
    return this.status();
  }
}

function parse(text: string, what: string): RosterDoc {
  const raw = parseJson(text, what);
  const people: Record<string, RosterPerson> = {};
  for (const [email, p] of Object.entries<any>(raw?.people || {})) {
    if (email.startsWith("$") || !p || typeof p.slug !== "string") continue;
    people[email.trim().toLowerCase()] = p;
  }
  return { people };
}

/** One line per person who was added, removed, or changed profile or role since `before`. */
export function describe(before: RosterDoc | null, after: RosterDoc): string[] {
  const was = before?.people || {};
  const now = after.people;
  const out: string[] = [];
  for (const [email, p] of Object.entries(now)) {
    if (!was[email]) out.push(`Added ${email} (${p.profile}${p.role ? `, role ${p.role}` : ""})`);
    else {
      if (was[email].profile !== p.profile) out.push(`Changed ${email}'s profile to ${p.profile}`);
      if ((was[email].role || null) !== (p.role || null)) out.push(p.role ? `Changed ${email}'s role to ${p.role}` : `Let ${email} pick their own role`);
    }
  }
  for (const email of Object.keys(was)) if (!now[email]) out.push(`Removed ${email}`);
  return out.length ? out : ["Updated people.json"];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
