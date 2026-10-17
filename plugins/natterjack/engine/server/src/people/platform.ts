/**
 * Where people's dashboards run, for the People page: one implementation per platform
 * (kubernetes.ts, app-service.ts), each driving the engineer's own CLI. Everything else on
 * the page (directory, roster, profiles, reconcile) is the same for all of them.
 */

import type { HostingConfig, Profile } from "./config.ts";
import type { Runner } from "./cli.ts";
import { Kubernetes } from "./kubernetes.ts";
import { AppService } from "./app-service.ts";

/** One person's dashboard as the platform has it. */
export interface Dashboard {
  owner: string;
  /** The platform's name for it (StatefulSet, Web App). */
  name: string;
  slug: string | null;
  /** Started (scaled up, or not stopped); `ready` once it answers. */
  running: boolean;
  ready: boolean;
  profile: string | null;
  /** The hash of what was last applied (natterjack/applied). */
  applied: string | null;
}

/**
 * `role`: the workspace role assigned to them (DASHBOARD_ROLE); null leaves it to them.
 * `access`: full or read, assigned over the role's default (DASHBOARD_ACCESS); null = the role's.
 */
export interface Person { email: string; slug: string; profile: Profile; role: string | null; access?: "full" | "read" | null }

/** What would be applied for one person: `objects` for the preview, `hash` for "needs update". */
export interface Rendered { objects: unknown[]; hash: string }

export interface Platform {
  /** Shown on the page: "context x, namespace y", "resource group z". */
  readonly where: string;
  /** What a person keeps between restarts, for the Remove dialog: "volume", "file share". */
  readonly dataLabel: string;
  list(): Promise<Map<string, Dashboard>>;
  /** This person's dashboard as it should be; `existing` keeps what applying mustn't change (its name, running or not). */
  render(p: Person, existing: Dashboard | null): Promise<Rendered>;
  /** Apply it; dryRun asks the platform to check it without changing anything. */
  apply(r: Rendered, dryRun: boolean): Promise<string>;
  start(d: Dashboard): Promise<string>;
  stop(d: Dashboard): Promise<string>;
  /** Remove it, and what it keeps (volume, file share) unless keepData. */
  remove(d: Dashboard, keepData: boolean, dryRun: boolean): Promise<string>;
}

export function makePlatform(cfg: HostingConfig, run: Runner): Platform {
  return cfg.platform.type === "azure-app-service" ? new AppService(cfg, run) : new Kubernetes(cfg, run);
}
