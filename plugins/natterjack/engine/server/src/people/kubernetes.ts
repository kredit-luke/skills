/**
 * People's dashboards on Kubernetes, through the engineer's own kubectl (context and
 * namespace from hosting.json). The same shape the router's kubernetes backend reads
 * (router/src/backends.ts): one StatefulSet per person, labelled app=natterjack-dashboard,
 * naming them in the natterjack/owner annotation.
 *
 * The template is the team's copy of templates/hosted/kubernetes-person.yaml. No YAML
 * package: kubectl turns it into JSON once (with placeholders for ${PERSON} and ${EMAIL}),
 * and each person's objects are that JSON with their values, their profile's fields
 * (resources, run limit, area Secrets) and their role set on the "dashboard" container.
 * The result's hash goes in the natterjack/applied annotation, so the page can tell who
 * needs an update after the template, a profile, a role or the image changes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { HostingConfig, KubernetesPlatform } from "./config.ts";
import type { Dashboard, Person, Platform, Rendered } from "./platform.ts";
import { cliError, notInstalled, parseJson, parseJsonStream, runReading, type Runner } from "./cli.ts";

export const SELECTOR = "app=natterjack-dashboard";
const PERSON = "__natterjack_person__";
const EMAIL = "__natterjack_email__";

export interface ClusterDashboard extends Dashboard {
  service: string;
  replicas: number;
  claim: string;
}

export class Kubernetes implements Platform {
  readonly dataLabel = "volume";
  private readonly cfg: HostingConfig;
  private readonly p: KubernetesPlatform;
  private readonly run: Runner;
  private template: { mtimeMs: number; objects: any[] } | null = null;

  constructor(cfg: HostingConfig, run: Runner) { this.cfg = cfg; this.p = cfg.platform as KubernetesPlatform; this.run = run; }

  get where(): string { return `${this.p.context || "current kubectl context"}, namespace ${this.p.namespace}`; }

  private args(rest: string[]): string[] {
    return [...(this.p.context ? ["--context", this.p.context] : []), "--namespace", this.p.namespace, ...rest];
  }

  /** `reading`: it changes nothing, so a dropped connection is tried once more (runReading). */
  private async kubectl(what: string, rest: string[], input?: string, reading = false): Promise<string> {
    const opts = { input, timeout: 120_000 };
    const r = reading ? await runReading(this.run, "kubectl", this.args(rest), opts) : await this.run("kubectl", this.args(rest), opts);
    if (notInstalled(r)) throw Object.assign(new Error("kubectl isn't installed."), { status: 502, fix: "install kubectl, then get credentials for the cluster (e.g. gcloud container clusters get-credentials)" });
    if (!r.ok) throw cliError(what, r, /Unauthorized|credentials|token|expired|refresh/i.test(r.stderr) ? "sign in to the cluster again (gcloud auth login / az login / aws sso login)" : undefined);
    return r.stdout;
  }

  /** Every person's dashboard in the namespace, by email. */
  async list(): Promise<Map<string, ClusterDashboard>> {
    const out = await this.kubectl("Listing dashboards", ["get", "statefulsets", "-l", SELECTOR, "-o", "json"], undefined, true);
    const byEmail = new Map<string, ClusterDashboard>();
    for (const s of parseJson(out, "kubectl get statefulsets").items || []) {
      const notes = s.metadata?.annotations || {};
      const owner = String(notes["natterjack/owner"] || notes["agentic-os/owner"] || "").trim().toLowerCase();
      if (!owner) continue;
      const claim = s.spec?.volumeClaimTemplates?.[0]?.metadata?.name || "data";
      byEmail.set(owner, {
        owner,
        name: s.metadata.name,
        service: s.spec?.serviceName || s.metadata.name,
        slug: s.metadata?.labels?.person || s.spec?.template?.metadata?.labels?.person || null,
        replicas: Number(s.spec?.replicas ?? 1),
        running: Number(s.spec?.replicas ?? 1) > 0,
        ready: Number(s.status?.readyReplicas || 0) > 0,
        profile: notes["natterjack/profile"] || null,
        applied: notes["natterjack/applied"] || null,
        claim,
      });
    }
    return byEmail;
  }

  /** The template as JSON objects, with placeholders (re-read when the file changes). */
  private async templateObjects(): Promise<any[]> {
    const file = this.p.template;
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { throw Object.assign(new Error(`The template ${file} isn't there.`), { status: 400, fix: 'copy templates/hosted/kubernetes-person.yaml into the workspace and point "platform.template" at it' }); }
    if (this.template && this.template.mtimeMs === st.mtimeMs) return this.template.objects;
    const yaml = fs.readFileSync(file, "utf-8").replaceAll("${PERSON}", PERSON).replaceAll("${EMAIL}", EMAIL);
    // Client-side only: nothing is sent to the cluster.
    const out = await this.kubectl("Reading the template", ["create", "--dry-run=client", "--validate=false", "-o", "json", "-f", "-"], yaml);
    // One document per object (a List only from older kubectl).
    const objects = parseJsonStream(out, "kubectl create --dry-run").flatMap((d: any) => (d.kind === "List" ? d.items || [] : [d]));
    if (!objects.some((o: any) => o.kind === "StatefulSet")) throw Object.assign(new Error("The template has no StatefulSet."), { status: 400 });
    this.template = { mtimeMs: st.mtimeMs, objects };
    return objects;
  }

  /** This person's objects, profile applied, with the natterjack/applied hash. */
  async render(p: Person, existing: Dashboard | null): Promise<Rendered> {
    const keepReplicas = existing ? (existing as ClusterDashboard).replicas ?? (existing.running ? 1 : 0) : undefined;
    const objects = JSON.parse(JSON.stringify(await this.templateObjects()).replaceAll(PERSON, p.slug).replaceAll(EMAIL, p.email));
    const sts = objects.find((o: any) => o.kind === "StatefulSet");
    for (const o of objects) delete o.metadata?.namespace; // kubectl's --namespace decides
    const notes = (sts.metadata.annotations ||= {});
    notes["natterjack/owner"] = p.email;
    notes["natterjack/profile"] = p.profile.id;
    const pod = sts.spec.template.spec;
    const c = pod.containers.find((x: any) => x.name === "dashboard") || pod.containers[0];
    if (p.profile.memory || p.profile.cpu) {
      c.resources ||= {};
      c.resources.limits = { ...(c.resources.limits || {}), ...(p.profile.memory ? { memory: p.profile.memory } : {}), ...(p.profile.cpu ? { cpu: p.profile.cpu } : {}) };
    }
    c.env = (c.env || []).filter((e: any) => !["DASHBOARD_MAX_CONCURRENT_RUNS", "DASHBOARD_ROLE", "DASHBOARD_ACCESS"].includes(e.name));
    if (p.profile.maxConcurrentRuns) c.env.push({ name: "DASHBOARD_MAX_CONCURRENT_RUNS", value: String(p.profile.maxConcurrentRuns) });
    if (p.role) c.env.push({ name: "DASHBOARD_ROLE", value: p.role });
    if (p.access) c.env.push({ name: "DASHBOARD_ACCESS", value: p.access });
    const secrets = p.profile.areas.map((a) => this.cfg.areas[a]?.secret).filter(Boolean);
    const areaSecrets = new Set(Object.values(this.cfg.areas).map((a) => a.secret));
    c.envFrom = [...(c.envFrom || []).filter((e: any) => !areaSecrets.has(e.secretRef?.name)), ...secrets.map((name) => ({ secretRef: { name } }))];
    // The hash leaves out replicas: starting and stopping isn't a change to apply.
    delete notes["natterjack/applied"];
    const replicas = sts.spec.replicas;
    delete sts.spec.replicas;
    const hash = crypto.createHash("sha256").update(JSON.stringify(objects)).digest("hex").slice(0, 12);
    sts.spec.replicas = keepReplicas ?? replicas ?? 0;
    notes["natterjack/applied"] = hash;
    return { objects, hash };
  }

  /** kubectl apply; dryRun asks the cluster to check it without changing anything. */
  async apply(r: Rendered, dryRun: boolean): Promise<string> {
    const list = JSON.stringify({ apiVersion: "v1", kind: "List", items: r.objects });
    return this.kubectl(dryRun ? "Checking the change" : "Applying", ["apply", ...(dryRun ? ["--dry-run=server"] : []), "-f", "-"], list, dryRun);
  }

  private scale(d: Dashboard, replicas: number): Promise<string> {
    return this.kubectl(replicas ? "Starting" : "Stopping", ["scale", `statefulset/${d.name}`, `--replicas=${replicas}`]);
  }
  start(d: Dashboard) { return this.scale(d, 1); }
  stop(d: Dashboard) { return this.scale(d, 0); }

  /** Their StatefulSet and Service, and their volume unless it's kept. */
  async remove(dash: Dashboard, keepVolume: boolean, dryRun: boolean): Promise<string> {
    const d = dash as ClusterDashboard;
    const what = [`statefulset/${d.name}`, `service/${d.service}`, ...(keepVolume ? [] : [`persistentvolumeclaim/${d.claim}-${d.name}-0`])];
    if (dryRun) return `Would delete: ${what.join(", ")}`;
    return this.kubectl("Removing", ["delete", ...what, "--ignore-not-found"]);
  }
}
