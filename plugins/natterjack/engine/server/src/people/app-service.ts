/**
 * People's dashboards on Azure App Service, through the engineer's own `az`: one Web App
 * per person in a resource group, deployed from the team's copy of
 * templates/hosted/app-service-person.bicep. The same shape the router's App Service backend
 * reads (router/src/backends.ts): each app names its person in the natterjack-owner tag.
 *
 * Each person's deployment is the template plus parameters: hosting.json's
 * platform.parameters, their profile's parameters (its plan), and theirs (appName, email,
 * their role if they were given one, their area keys as Key Vault references). The hash of
 * template and parameters goes in the natterjack-applied tag, so the page can tell who
 * needs an update. Preview is `az deployment group what-if`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppServicePlatform, HostingConfig } from "./config.ts";
import type { Dashboard, Person, Platform, Rendered } from "./platform.ts";
import { cliError, notInstalled, parseJson, runReading, type Runner } from "./cli.ts";

export interface WebAppDashboard extends Dashboard { host: string | null; share: string | null; storageAccount: string | null }

/** The person's deployment: what `az deployment group create` gets. */
interface Deployment { appName: string; parameters: Record<string, unknown> }

/** natterjack-owner; or, for one set up by hand before the People page, owner on a hosted-workspace-dashboard. */
export function ownerOf(tags: Record<string, string>): string | null {
  const t = Object.fromEntries(Object.entries(tags || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const owner = t["natterjack-owner"] || (t.purpose === "hosted-workspace-dashboard" ? t.owner : "");
  return owner ? owner.trim().toLowerCase() : null;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Template parameters that name a resource that must already exist: [parameter, resource type, label]. */
const REFERENCED: [string, string, string][] = [
  ["plan", "microsoft.web/serverfarms", "App Service plan"],
  ["storageAccount", "microsoft.storage/storageaccounts", "Storage account"],
  ["registry", "microsoft.containerregistry/registries", "Container registry"],
  ["keyVault", "microsoft.keyvault/vaults", "Key Vault"],
];

export class AppService implements Platform {
  readonly dataLabel = "file share";
  private readonly cfg: HostingConfig;
  private readonly p: AppServicePlatform;
  private readonly run: Runner;

  constructor(cfg: HostingConfig, run: Runner) { this.cfg = cfg; this.p = cfg.platform as AppServicePlatform; this.run = run; }

  get where(): string { return `resource group ${this.p.resourceGroup}`; }

  private scope(): string[] {
    return ["--resource-group", this.p.resourceGroup, ...(this.p.subscription ? ["--subscription", this.p.subscription] : [])];
  }

  /** A change: runs once. Reads go through azRead, which retries a dropped connection. */
  private az(what: string, args: string[], timeout = 120_000): Promise<string> { return this.azCall(what, args, timeout, false); }
  private azRead(what: string, args: string[], timeout = 120_000): Promise<string> { return this.azCall(what, args, timeout, true); }

  private async azCall(what: string, args: string[], timeout: number, reading: boolean): Promise<string> {
    const full = [...args, "--only-show-errors"];
    const r = reading ? await runReading(this.run, "az", full, { timeout }) : await this.run("az", full, { timeout });
    if (notInstalled(r)) throw Object.assign(new Error("The Azure CLI (az) isn't installed."), { status: 502, fix: "install it, then run: az login" });
    if (!r.ok) throw cliError(what, r, /az login|AADSTS|expired|refresh token|Please run/i.test(r.stderr) ? "run: az login" : undefined);
    return r.stdout;
  }

  async list(): Promise<Map<string, Dashboard>> {
    const out = await this.azRead("Listing Web Apps", ["webapp", "list", ...this.scope(), "--query", "[].{name:name, state:state, host:defaultHostName, tags:tags}", "-o", "json"]);
    const byEmail = new Map<string, Dashboard>();
    for (const s of parseJson(out, "az webapp list") || []) {
      const owner = ownerOf(s.tags || {});
      if (!owner) continue;
      const tags = Object.fromEntries(Object.entries<string>(s.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const d: WebAppDashboard = {
        owner, name: s.name,
        slug: tags["natterjack-person"] || this.slugFromName(s.name),
        running: s.state === "Running",
        // az doesn't say whether the container answers yet; Running is as close as it gets.
        ready: s.state === "Running",
        profile: tags["natterjack-profile"] || null,
        applied: tags["natterjack-applied"] || null,
        host: s.host || null,
        share: tags["natterjack-share"] || s.name,
        storageAccount: tags["natterjack-storage"] || null,
      };
      byEmail.set(owner, d);
    }
    return byEmail;
  }

  /** "dash-luke" → "luke" when appName is "dash-{person}". */
  private slugFromName(name: string): string | null {
    const [before, after] = this.p.appName.split("{person}");
    if (name.startsWith(before) && name.endsWith(after) && name.length > before.length + after.length) return name.slice(before.length, name.length - after.length);
    return null;
  }

  async render(person: Person, existing: Dashboard | null): Promise<Rendered> {
    let template: string;
    try { template = fs.readFileSync(this.p.template, "utf-8"); }
    catch { throw Object.assign(new Error(`The template ${this.p.template} isn't there.`), { status: 400, fix: 'copy templates/hosted/app-service-person.bicep into the workspace and point "platform.template" at it' }); }
    const appName = existing?.name || this.p.appName.replace("{person}", person.slug);
    const areaSettings = person.profile.areas
      .map((a) => this.cfg.areas[a])
      .filter((a) => a && a.env)
      .map((a) => ({ name: a.env!, secretName: a.secret }));
    const parameters: Record<string, unknown> = {
      ...this.p.parameters,
      ...person.profile.parameters,
      appName,
      person: person.slug,
      email: person.email,
      profile: person.profile.id,
      maxConcurrentRuns: person.profile.maxConcurrentRuns || 0,
      // Only when assigned: a team's older copy of the template has no role (or access) parameter.
      ...(person.role ? { role: person.role } : {}),
      ...(person.access ? { access: person.access } : {}),
      areaSettings,
    };
    const hash = crypto.createHash("sha256").update(template).update(JSON.stringify(sortKeys(parameters))).digest("hex").slice(0, 12);
    parameters.applied = hash;
    const deployment: Deployment = { appName, parameters };
    return { objects: [deployment], hash };
  }

  /**
   * Everything the template refers to must exist first. what-if doesn't check `existing`
   * resources, so without this a missing Key Vault passes the preview and the deployment
   * fails halfway, after it has already changed the Web App.
   */
  private async preflight(parameters: Record<string, unknown>): Promise<void> {
    const out = await this.azRead("Checking the resource group", ["resource", "list", ...this.scope(), "--query", "[].{name:name, type:type}", "-o", "json"]);
    const have = new Set((parseJson(out, "az resource list") || []).map((r: any) => `${String(r.type).toLowerCase()}/${String(r.name).toLowerCase()}`));
    const missing = REFERENCED
      .filter(([param]) => typeof parameters[param] === "string" && parameters[param])
      .filter(([param, type]) => !have.has(`${type}/${String(parameters[param]).toLowerCase()}`))
      .map(([param, , label]) => `${label} "${parameters[param]}" (${param})`);
    if (missing.length) {
      throw Object.assign(new Error(`Not in resource group ${this.p.resourceGroup} yet: ${missing.join(", ")}. Nothing was changed.`), { status: 400, fix: 'create it first (hosting.md, "Azure App Service"), or fix the name in hosting.json platform.parameters' });
    }
  }

  async apply(r: Rendered, dryRun: boolean): Promise<string> {
    const { appName, parameters } = r.objects[0] as Deployment;
    await this.preflight(parameters);
    const file = path.join(os.tmpdir(), `natterjack-${appName}-${process.pid}-${Date.now()}.parameters.json`);
    fs.writeFileSync(file, JSON.stringify({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
      contentVersion: "1.0.0.0",
      parameters: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { value: v }])),
    }, null, 2));
    try {
      const common = [...this.scope(), "--name", `natterjack-${appName}`.slice(0, 64), "--template-file", this.p.template, "--parameters", `@${file}`];
      if (dryRun) {
        const out = await this.azRead("Checking the change (what-if)", ["deployment", "group", "what-if", ...common, "--result-format", "FullResourcePayloads", "--no-prompt"], 300_000);
        return out.replace(ANSI, "").trim();
      }
      const out = await this.az("Deploying", ["deployment", "group", "create", ...common, "--query", "properties.provisioningState", "-o", "tsv"], 600_000);
      return `Deployment ${out.trim() || "done"}: ${appName}`;
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  }

  async start(d: Dashboard): Promise<string> {
    await this.az("Starting", ["webapp", "start", ...this.scope(), "--name", d.name]);
    return `Started ${d.name}.`;
  }

  async stop(d: Dashboard): Promise<string> {
    await this.az("Stopping", ["webapp", "stop", ...this.scope(), "--name", d.name]);
    return `Stopped ${d.name}.`;
  }

  /**
   * The Web App (its plan stays), and its file share unless kept. The share is deleted from the
   * account the app was deployed with (its natterjack-storage tag), since a profile can pick
   * another one. An app without the tag (set up by hand, or before the tag) only falls back to
   * the platform's account when no profile overrides it; otherwise we can't know which it is.
   */
  async remove(dash: Dashboard, keepShare: boolean, dryRun: boolean): Promise<string> {
    const d = dash as WebAppDashboard;
    const fallback = typeof this.p.parameters.storageAccount === "string" && !this.cfg.profiles.some((p) => "storageAccount" in (p.parameters || {}))
      ? this.p.parameters.storageAccount : null;
    const account = d.storageAccount || fallback;
    if (!keepShare && !account) throw Object.assign(new Error(`Can't tell which storage account holds ${d.name}'s file share (it has no natterjack-storage tag). Nothing was changed.`), { status: 400, fix: 'keep the data and delete the share by hand, or update their dashboard first so it gets the tag' });
    const what = [`Web App ${d.name}`, ...(keepShare ? [] : [`file share ${d.share} in ${account}`])];
    if (dryRun) return `Would delete: ${what.join(", ")}. The App Service plan stays.`;
    await this.az("Removing the Web App", ["webapp", "delete", ...this.scope(), "--name", d.name, "--keep-empty-plan"]);
    if (!keepShare) await this.az("Deleting the file share", ["storage", "share-rm", "delete", ...this.scope(), "--storage-account", account!, "--name", d.share!, "--yes"]);
    return `Deleted ${what.join(" and ")}.`;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as any)[k])]));
  return v;
}
