/**
 * The team's roles, edited from the People page: workspace.json `roles`, committed like the
 * roster (people.json). A role is who someone is and how Claude answers them (its output
 * style); its access (full, or read: the reader profile) is only the default for people with
 * that role, which the People page or a person's own Settings can change per person.
 *
 *   "roles": { "operations": { "label": "Operations", "description": "...", "profile": "reader", "outputStyle": "Business" } }
 *
 * Only label, description, profile and outputStyle are edited here; anything else a role has
 * (hiddenPages, hiddenSkills) is kept as it is. A role someone in the roster is assigned
 * can't be removed until they're given another.
 */

import fs from "node:fs";
import path from "node:path";
import { cliError, notInstalled, parseJson, type Runner } from "./cli.ts";

export interface RoleRow {
  id: string;
  label: string;
  description: string;
  /** The access it gives by default. */
  access: "full" | "read";
  outputStyle: string | null;
}
export interface RoleEdit { label: string; description?: string; access?: "full" | "read"; outputStyle?: string | null }
export interface RolesStatus { file: string; uncommitted: boolean; changes: string[] }

/** Claude Code's own output styles, besides the team's .claude/output-styles/*.md. */
const BUILT_IN_STYLES = ["Explanatory", "Learning"];
const ROLE_ID = /^[a-z0-9][\w-]*$/i;
const STYLE_NAME = /^[\p{L}\p{N} _.:-]{1,80}$/u;
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** "Customer Success" → "customer-success" */
export function roleId(label: string): string {
  return label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "role";
}

export class Roles {
  readonly file: string;
  readonly rel: string;
  private readonly root: string;
  private readonly run: Runner;

  constructor(workspaceRoot: string, configDir: string, run: Runner) {
    this.root = workspaceRoot;
    this.file = path.join(configDir, "workspace.json");
    this.rel = path.relative(workspaceRoot, this.file).split(path.sep).join("/");
    this.run = run;
  }

  private read(): any {
    let text = "";
    try { text = fs.readFileSync(this.file, "utf-8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
    const data = parseJson(text.replace(/^﻿/, ""), this.rel);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw httpError(500, `${this.rel} isn't a JSON object.`);
    return data;
  }

  private write(data: any) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    try { fs.renameSync(tmp, this.file); } catch { fs.copyFileSync(tmp, this.file); fs.unlinkSync(tmp); }
  }

  list(): RoleRow[] { return rows(this.read().roles); }

  /** The team's output styles (.claude/output-styles/*.md, by their `name:`, else the file name) and Claude Code's own. */
  styles(): string[] {
    const dir = path.join(this.root, ".claude", "output-styles");
    const team: string[] = [];
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch {}
    for (const f of files) {
      let name = f.replace(/\.md$/, "");
      try { name = (/^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, f), "utf-8").split(/^---\s*$/m)[1] || "") || [])[1]?.trim().replace(/^["']|["']$/g, "") || name; } catch {}
      team.push(name);
    }
    return [...new Set([...team.sort(), ...BUILT_IN_STYLES])];
  }

  /** Add a role (no `id`) or change one. Returns its id. */
  save(id: string | null, edit: RoleEdit): string {
    const label = String(edit.label || "").trim();
    if (!label) throw httpError(400, "A role needs a name.");
    if (label.length > 60) throw httpError(400, "That name is too long.");
    const style = edit.outputStyle ? String(edit.outputStyle).trim() : null;
    if (style && !STYLE_NAME.test(style)) throw httpError(400, "That output style name has characters it can't have.");
    if (edit.access && edit.access !== "full" && edit.access !== "read") throw httpError(400, 'access is "full" or "read".');
    const data = this.read();
    const roles: Record<string, any> = data.roles && typeof data.roles === "object" && !Array.isArray(data.roles) ? data.roles : {};
    let key = id;
    if (key) {
      if (!roles[key]) throw httpError(404, `There's no role "${key}".`);
    } else {
      const base = roleId(label);
      key = base;
      for (let i = 2; roles[key]; i++) key = `${base}-${i}`;
      if (!ROLE_ID.test(key)) throw httpError(400, "Pick a name with a letter or digit in it.");
    }
    const was = roles[key] || {};
    const next: any = { ...was, label };
    if (edit.description !== undefined) { const d = String(edit.description || "").trim(); if (d) next.description = d; else delete next.description; }
    if (edit.access !== undefined) { if (edit.access === "read") next.profile = "reader"; else delete next.profile; }
    if (edit.outputStyle !== undefined) { if (style) next.outputStyle = style; else delete next.outputStyle; }
    data.roles = { ...roles, [key]: next };
    this.write(data);
    return key;
  }

  /** Remove a role; `assigned` are the roster's people who have it (they must get another first). */
  remove(id: string, assigned: string[]) {
    const data = this.read();
    if (!data.roles || !data.roles[id]) throw httpError(404, `There's no role "${id}".`);
    if (assigned.length) throw httpError(409, `${assigned.join(", ")} ${assigned.length === 1 ? "has" : "have"} this role: give them another first.`);
    if (Object.keys(data.roles).length === 1) throw httpError(409, "That's the last role. Without roles, everyone gets the built-in Developer and Reader.");
    const { [id]: _gone, ...rest } = data.roles;
    data.roles = rest;
    this.write(data);
  }

  private git(args: string[], timeout = 30_000) { return this.run("git", ["-C", this.root, ...args], { timeout }); }

  async status(): Promise<RolesStatus> {
    const st = await this.git(["status", "--porcelain", "--", this.rel]);
    if (notInstalled(st)) throw httpError(502, "git isn't installed.");
    if (!st.ok) throw cliError(`Checking ${this.rel} with git`, st);
    if (!st.stdout.trim()) return { file: this.rel, uncommitted: false, changes: [] };
    const head = await this.git(["show", `HEAD:${this.rel}`]);
    let before: any = {};
    if (head.ok) { try { before = parseJson(head.stdout, `${this.rel} (committed)`); } catch {} }
    return { file: this.rel, uncommitted: true, changes: describeRoles(before, this.read()) };
  }

  /** Commit workspace.json alone. Pushing stays with the engineer. */
  async commit(): Promise<RolesStatus> {
    const { uncommitted, changes } = await this.status();
    if (!uncommitted) return this.status();
    const subject = changes.length === 1 ? `chore(roles): ${changes[0].charAt(0).toLowerCase()}${changes[0].slice(1)}` : `chore(roles): update the team's roles (${changes.length} changes)`;
    const body = changes.length > 1 ? changes.map((c) => `- ${c}`).join("\n") : "";
    const r = await this.git(["commit", "--only", "-m", subject, ...(body ? ["-m", body] : []), "--", this.rel], 60_000);
    if (!r.ok) throw cliError(`Committing ${this.rel}`, r, /user\.email|user\.name|identity/i.test(r.stderr) ? "set git config user.name and user.email" : undefined);
    return this.status();
  }
}

function rows(raw: unknown): RoleRow[] {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : {};
  return Object.entries(src).filter(([id, r]) => ROLE_ID.test(id) && r && typeof r === "object").map(([id, r]) => ({
    id,
    label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : id,
    description: typeof r.description === "string" ? r.description : "",
    access: r.profile === "reader" ? "read" : "full",
    outputStyle: typeof r.outputStyle === "string" && r.outputStyle.trim() ? r.outputStyle.trim() : null,
  }));
}

/** One line per role added, removed or changed since `before`; other edits to the file in one line. */
export function describeRoles(before: any, after: any): string[] {
  const was = new Map(rows(before?.roles).map((r) => [r.id, r]));
  const now = new Map(rows(after?.roles).map((r) => [r.id, r]));
  const out: string[] = [];
  for (const [id, r] of now) {
    const w = was.get(id);
    if (!w) out.push(`Added the ${r.label} role (${r.access === "read" ? "read-only" : "full"} access${r.outputStyle ? `, ${r.outputStyle} style` : ""})`);
    else if (JSON.stringify(w) !== JSON.stringify(r)) {
      const what = [w.label !== r.label && `renamed to ${r.label}`, w.access !== r.access && `${r.access === "read" ? "read-only" : "full"} access by default`, w.outputStyle !== r.outputStyle && (r.outputStyle ? `${r.outputStyle} style` : "Claude's default style"), w.description !== r.description && "new description"].filter(Boolean);
      out.push(`Changed the ${w.label} role: ${what.join(", ")}`);
    }
  }
  for (const [id, w] of was) if (!now.has(id)) out.push(`Removed the ${w.label} role`);
  const { roles: _a, ...restBefore } = before || {};
  const { roles: _b, ...restAfter } = after || {};
  if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) out.push("Other changes to workspace.json");
  return out.length ? out : ["Updated workspace.json"];
}
