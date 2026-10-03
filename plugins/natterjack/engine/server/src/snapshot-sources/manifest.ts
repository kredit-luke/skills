/** What a published snapshot is made of: uploaded last, so it never names a file that isn't there yet. */

import { safeEngineDir } from "../workspace-root.ts";

export const MANIFEST = "snapshot-manifest.json";

export interface ManifestEntry { file: string; sha: string; size: number; builtAt: string }
/** The built UI, and the engine folder it was built in (relative to the workspace; older manifests have none: dashboard). */
export interface UiEntry extends ManifestEntry { dir?: string }
export interface Manifest {
  version: 1;
  builtAt: string;
  /** One .tar.gz per repo (repos.json name → entry). */
  repos: Record<string, ManifestEntry>;
  /** The workspace root itself as a .zip, for the first download by hand or by the installer. */
  workspace: ManifestEntry | null;
  /** The dashboard's built UI for that workspace commit (<engine>/dist), so a download needs no npm or build. */
  ui?: UiEntry | null;
  /** The Windows setup script, with this source filled in. */
  installer?: ManifestEntry | null;
}

/** A manifest from the wire, checked; null when it isn't one. */
export function parseManifest(data: any): Manifest | null {
  if (!data || data.version !== 1 || !data.repos || typeof data.repos !== "object") return null;
  const entry = (e: any): ManifestEntry | null =>
    e && typeof e.file === "string" && /^[\w.-]+$/.test(e.file) && typeof e.sha === "string"
      ? { file: e.file, sha: e.sha, size: Number(e.size) || 0, builtAt: String(e.builtAt || data.builtAt || "") }
      : null;
  const repos: Record<string, ManifestEntry> = {};
  for (const [name, e] of Object.entries(data.repos)) { const x = entry(e); if (x) repos[name] = x; }
  const ui: UiEntry | null = entry(data.ui);
  const uiDir = ui && safeEngineDir(data.ui.dir);
  if (ui && uiDir) ui.dir = uiDir;
  return { version: 1, builtAt: String(data.builtAt || ""), repos, workspace: entry(data.workspace), ui, installer: entry(data.installer) };
}
