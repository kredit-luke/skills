/**
 * The dashboard as an installable app (a progressive web app): /manifest.webmanifest,
 * built per workspace so the installed app carries the team's name, colors and icon.
 * The service worker (web/public/sw.js) and the <link>s in index.html do the rest.
 *
 * Icons: the team's brand/icon-192.png and icon-512.png when it has them, else its SVG
 * favicon, with the neutral PNGs built into the UI (dist/browser/ds/) behind either.
 * Colors: --brand-900 (the sidebar) and --paper from brand/theme.css, else tokens.css.
 */

import fs from "node:fs";
import path from "node:path";

export interface ManifestInput {
  /** The dashboard's title (workspace.json dashboard.title) and the workspace name. */
  title: string;
  name: string;
  /** The team's favicon file in brandDir (workspace.json brand.favicon), or null. */
  favicon: string | null;
  brandDir: string;
  /** The UI's own /ds/ files (tokens.css and the neutral icons). */
  defaultsDir: string;
}

const PNG_SIZES = [192, 512];

/** A CSS custom property's hex color from the first file that sets it. */
export function cssColor(files: string[], prop: string): string | null {
  const re = new RegExp(`${prop}\\s*:\\s*(#[0-9a-f]{3,8})\\b`, "i");
  for (const f of files) {
    let css = "";
    try { css = fs.readFileSync(f, "utf-8"); } catch { continue; }
    const m = re.exec(css);
    if (m) return m[1];
  }
  return null;
}

export function webManifest(input: ManifestInput) {
  const css = [path.join(input.brandDir, "theme.css"), path.join(input.defaultsDir, "tokens.css")];
  const has = (f: string) => { try { return fs.statSync(path.join(input.brandDir, f)).isFile(); } catch { return false; } };
  const png = (size: number) => ({ src: `/ds/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" });
  const teamPngs = PNG_SIZES.every((s) => has(`icon-${s}.png`));
  const svg = !teamPngs && input.favicon && /\.svg$/i.test(input.favicon) && has(input.favicon)
    ? [{ src: `/ds/${input.favicon}`, sizes: "any", type: "image/svg+xml", purpose: "any" }]
    : [];
  const short = input.name || input.title;
  return {
    id: "/",
    name: input.title === "Workspace Dashboard" && input.name ? `${input.name} dashboard` : input.title,
    short_name: short.length > 15 ? short.slice(0, 15).trim() : short,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: cssColor(css, "--brand-900") || "#1E1B4B",
    background_color: cssColor(css, "--paper") || "#F8FAFC",
    icons: [...svg, ...PNG_SIZES.map(png)],
  };
}
