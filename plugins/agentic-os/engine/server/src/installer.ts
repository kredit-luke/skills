/**
 * The Windows setup script published with each snapshot (Install-<name>.cmd): the
 * template bin/install-windows.ps1 with this workspace's source filled in, wrapped in
 * a .cmd so it runs with a double-click. Windows won't run a downloaded .ps1 file by
 * default; the .cmd hands its own text to PowerShell with -ExecutionPolicy Bypass, for
 * this one run only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SnapshotConfig } from "./repos.ts";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "install-windows.ps1");
const MARKER = "#>PS";

export interface InstallerConfig {
  /** Shown in the prompts and the desktop shortcut ("Kredit"). */
  name: string;
  /** Default folder under the user's profile. */
  folder: string;
  /** repos.json snapshot (only confluence and http can be downloaded by the script). */
  source: SnapshotConfig;
  sourceLabel: string;
  /** The dashboard's Node floor (package.json engines.node). */
  nodeMin: string;
  /** workspace.json roles, asked for first; none = the reader profile, no question. */
  roles?: InstallerRole[];
}

export interface InstallerRole { id: string; label: string; description: string; profile: string }

/** The roles the installer asks about: the team's, when workspace.json has them. */
export const installerRoles = (ws: { roles: InstallerRole[]; rolesConfigured: boolean }): InstallerRole[] =>
  ws.rolesConfigured ? ws.roles.map(({ id, label, description, profile }) => ({ id, label, description, profile })) : [];

/** The installer's file name for a workspace: Install-<name>.cmd, file-safe. */
export const installerName = (name: string) => `Install-${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace"}.cmd`;

export const canInstallFrom = (source: SnapshotConfig) => source.source === "confluence" || source.source === "http";

/** The .cmd's text: a batch header that runs everything after the marker line as PowerShell. CRLF line endings. */
export function renderInstaller(cfg: InstallerConfig): string {
  const script = fs.readFileSync(TEMPLATE, "utf-8").replace(/\r\n/g, "\n");
  // Only the fields the script uses, and nothing secret: keys are asked for at run time.
  const s = cfg.source;
  const source = s.source === "confluence" ? { source: "confluence", site: String(s.site || ""), pageId: String(s.pageId || "") }
    : { source: "http", baseUrl: String(s.baseUrl || ""), auth: String(s.auth || "none") };
  if (/[^\x20-\x7e]/.test(cfg.name + cfg.folder)) throw new Error("The installer's settings must be plain ASCII (check the workspace name).");
  const roles = (cfg.roles || []).map(({ id, label, description, profile }) => ({ id, label, description, profile }));
  // The script stays ASCII: ConvertFrom-Json turns \uXXXX back into the character (in a role's label, say).
  const json = JSON.stringify({ name: cfg.name, folder: cfg.folder, source, sourceLabel: cfg.sourceLabel, nodeMin: cfg.nodeMin, ...(roles.length ? { roles } : {}) }, null, 2)
    .replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const header = [
    "@echo off",
    `rem ${cfg.name} workspace setup (agentic-os). Double-click to install or update; nothing needs administrator rights.`,
    "setlocal",
    'set "AOS_SELF=%~f0"',
    // The marker is split so this line doesn't match it.
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:AOS_SELF); $i=$s.IndexOf('#'+'>PS'); Invoke-Expression $s.Substring($i + ${MARKER.length})"`,
    "exit /b %errorlevel%",
    MARKER,
  ].join("\n");
  // The line that is only the placeholder (the header comment mentions it too); a function, so "$" in json stays literal.
  const body = script.replace(/^__AOS_CONFIG__$/m, () => json);
  if (!body.includes(json)) throw new Error("The installer template has no __AOS_CONFIG__ line.");
  return (header + "\n" + body).replace(/\n/g, "\r\n");
}
