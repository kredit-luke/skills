/**
 * hosting.json: how this team runs hosted dashboards, for the People page (an engineer's
 * local dashboard only). Committed; no secrets.
 *
 *   {
 *     "directory": { "type": "google", "domain": "acme.com", "orgUnit": "/Product" },
 *                  { "type": "entra", "domain": "acme.com", "department": "Product" }
 *                  { "type": "manual" }
 *     "platform":  { "type": "kubernetes", "context": "gke_acme_dashboards", "namespace": "dashboards",
 *                    "template": "hosting/kubernetes-person.yaml" },
 *                  { "type": "azure-app-service", "resourceGroup": "dashboard-rg", "template": "hosting/app-service-person.bicep",
 *                    "appName": "dash-{person}", "parameters": { "plan": "dashboard-asp", ... } },
 *     "areas":     { "finance": { "secret": "natterjack-area-finance", "env": "KNOWLEDGE_FINANCE_KEY" } },
 *     "defaultProfile": "member",
 *     "profiles":  { "member": { "name": "Member", "areas": ["company"], "maxConcurrentRuns": 3,
 *                                "memory": "2Gi", "cpu": "1",              Kubernetes: the container's limits
 *                                "parameters": { "plan": "dashboard-asp" } }  App Service: template parameters (its plan) }
 *   }
 *
 * The directory says who could have a dashboard (the whole domain, or one OU); an engineer
 * picks who does on the page, and their profile. An area is a key only some people get
 * (a Knowledge store's KNOWLEDGE_<STORE>_KEY): a Kubernetes Secret mounted with envFrom, or
 * a Key Vault secret an App Service setting named `env` refers to. Who has one is the roster, people.json next to this file (roster.ts).
 */

import path from "node:path";
import { readConfigFile } from "../config.ts";

export interface Profile { id: string; name: string; areas: string[]; memory: string | null; cpu: string | null; maxConcurrentRuns: number | null; parameters: Record<string, unknown> }
export interface DirectoryConfig { type: "google" | "entra" | "manual"; domain: string | null; orgUnit: string | null; department: string | null; adminUnit: string | null; project: string | null }
export interface KubernetesPlatform { type: "kubernetes"; context: string | null; namespace: string; template: string }
export interface AppServicePlatform {
  type: "azure-app-service";
  subscription: string | null;
  resourceGroup: string;
  template: string;
  /** Each person's Web App name, with {person} for their short name. */
  appName: string;
  /** Template parameters for everyone (a profile's `parameters` go on top). */
  parameters: Record<string, unknown>;
}
export type PlatformConfig = KubernetesPlatform | AppServicePlatform;
export interface Area { secret: string; env: string | null }
export interface HostingConfig {
  directory: DirectoryConfig;
  platform: PlatformConfig;
  areas: Record<string, Area>;
  profiles: Profile[];
  defaultProfile: string;
}

const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** hosting.json, checked; `config` is null when it's missing or has problems (listed in `problems`). */
export function readHosting(workspaceRoot: string, dir?: string): { configured: boolean; config: HostingConfig | null; problems: string[] } {
  const { data, error } = readConfigFile("hosting.json", dir);
  if (!data && !error) return { configured: false, config: null, problems: [] };
  if (error) return { configured: true, config: null, problems: [error] };
  const problems = checkHosting(data);
  return { configured: true, config: problems.length ? null : normalise(data, workspaceRoot), problems };
}

export function checkHosting(d: any): string[] {
  const out: string[] = [];
  const at = (s: string) => out.push(`hosting.json: ${s}`);
  const dirType = d?.directory?.type;
  if (!["google", "entra", "manual"].includes(dirType)) at('"directory.type" must be google, entra or manual.');
  else if (dirType !== "manual" && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(d.directory.domain || ""))) at('"directory.domain" is the company\'s email domain, e.g. "acme.com".');
  if (d?.directory?.orgUnit !== undefined && !String(d.directory.orgUnit).startsWith("/")) at('"directory.orgUnit" is an OU path starting with "/", e.g. "/Product".');

  const p = d?.platform || {};
  const appService = p.type === "azure-app-service";
  if (p.type !== "kubernetes" && !appService) at('"platform.type" must be "kubernetes" or "azure-app-service".');
  if (p.type === "kubernetes" && !NAME.test(String(p.namespace || ""))) at('"platform.namespace" is the namespace the dashboards run in.');
  if (appService) {
    if (!/^[-\w._()]{1,90}$/.test(String(p.resourceGroup || ""))) at('"platform.resourceGroup" is the resource group the Web Apps go in.');
    if (p.appName !== undefined && !/^[a-z0-9-]*\{person\}[a-z0-9-]*$/.test(String(p.appName))) at('"platform.appName" is a Web App name with {person} in it, e.g. "dash-{person}".');
    if (p.parameters !== undefined && (typeof p.parameters !== "object" || Array.isArray(p.parameters))) at('"platform.parameters" is an object of template parameters.');
  }
  const tpl = String(p.template || "");
  if (!tpl || path.isAbsolute(tpl) || tpl.split(/[\\/]/).includes("..")) at(`"platform.template" is a workspace path to your copy of ${appService ? "app-service-person.bicep" : "kubernetes-person.yaml"}.`);


  const areas = d?.areas || {};
  for (const [k, a] of Object.entries<any>(areas)) {
    if (!/^[A-Za-z0-9]([-A-Za-z0-9]*[A-Za-z0-9])?$/.test(String(a?.secret || ""))) at(`area "${k}" needs "secret": ${appService ? "the Key Vault secret holding its key" : "the Kubernetes Secret holding its keys"}.`);
    if (appService && !/^[A-Z_][A-Z0-9_]*$/.test(String(a?.env || ""))) at(`area "${k}" needs "env": the setting it becomes, e.g. "KNOWLEDGE_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY".`);
  }

  const profiles = d?.profiles;
  if (!profiles || typeof profiles !== "object" || !Object.keys(profiles).length) at('"profiles" needs at least one profile, e.g. { "member": { "name": "Member" } }.');
  else {
    for (const [id, pr] of Object.entries<any>(profiles)) {
      if (!NAME.test(id)) at(`profile "${id}": ids are lowercase letters, digits and -.`);
      for (const a of pr?.areas || []) if (!areas[a]) at(`profile "${id}" uses area "${a}", which isn't in "areas".`);
      for (const k of ["memory", "cpu"]) if (pr?.[k] !== undefined && !QUANTITY.test(String(pr[k]))) at(`profile "${id}" "${k}" isn't a Kubernetes quantity, e.g. "2Gi" or "500m".`);
      if (pr?.parameters !== undefined && (typeof pr.parameters !== "object" || Array.isArray(pr.parameters))) at(`profile "${id}" "parameters" is an object of template parameters.`);
      const m = pr?.maxConcurrentRuns;
      if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= 10)) at(`profile "${id}" "maxConcurrentRuns" is 1 to 10.`);
    }
    if (d.defaultProfile !== undefined && !profiles[d.defaultProfile]) at(`"defaultProfile" "${d.defaultProfile}" isn't one of the profiles.`);
  }
  return out;
}

function normalise(d: any, workspaceRoot: string): HostingConfig {
  const profiles = Object.entries<any>(d.profiles).map(([id, p]) => ({
    id, name: str(p?.name) || id, areas: Array.isArray(p?.areas) ? p.areas : [],
    memory: str(p?.memory), cpu: str(p?.cpu), maxConcurrentRuns: Number.isInteger(p?.maxConcurrentRuns) ? p.maxConcurrentRuns : null,
    parameters: p?.parameters && typeof p.parameters === "object" ? p.parameters : {},
  }));
  const p = d.platform;
  const template = path.join(workspaceRoot, p.template);
  const platform: PlatformConfig = p.type === "azure-app-service"
    ? { type: "azure-app-service", subscription: str(p.subscription), resourceGroup: p.resourceGroup, template, appName: str(p.appName) || "dash-{person}", parameters: p.parameters || {} }
    : { type: "kubernetes", context: str(p.context), namespace: p.namespace, template };
  const areas: Record<string, Area> = {};
  for (const [k, a] of Object.entries<any>(d.areas || {})) areas[k] = { secret: a.secret, env: str(a.env) };
  return {
    directory: {
      type: d.directory.type, domain: str(d.directory.domain)?.toLowerCase() || null, orgUnit: str(d.directory.orgUnit),
      department: str(d.directory.department), adminUnit: str(d.directory.adminUnit), project: str(d.directory.project),
    },
    platform,
    areas,
    profiles,
    defaultProfile: d.defaultProfile && d.profiles[d.defaultProfile] ? d.defaultProfile : profiles[0].id,
  };
}
