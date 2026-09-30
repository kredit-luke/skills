/** What a published snapshot is made of: uploaded last, so it never names a file that isn't there yet. */

export const MANIFEST = "snapshot-manifest.json";

export interface ManifestEntry { file: string; sha: string; size: number; builtAt: string }
export interface Manifest {
  version: 1;
  builtAt: string;
  /** One .tar.gz per repo (repos.json name → entry). */
  repos: Record<string, ManifestEntry>;
  /** The workspace root itself as a .zip, for the first download by hand. */
  workspace: ManifestEntry | null;
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
  return { version: 1, builtAt: String(data.builtAt || ""), repos, workspace: entry(data.workspace) };
}
