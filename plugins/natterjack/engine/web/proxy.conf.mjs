// Dev server (npm run dev) proxy: /api and /screenshots go to the dashboard server on its
// configured port (DASHBOARD_PORT, else .claude/dashboard/workspace.json dashboard.port, else 3333).
// The dev server itself listens on angular.json's serve port; keep workspace.json dashboard.devPort
// in step with it, or the server refuses the dev server's requests as cross-origin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The nearest folder above the engine with .claude/dashboard/, else its parent (as server/src/workspace-root.ts). */
function workspaceRoot() {
  if (process.env.WORKSPACE_ROOT) return path.resolve(process.env.WORKSPACE_ROOT);
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (let dir = parent; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".claude", "dashboard"))) return dir;
    if (path.dirname(dir) === dir) return parent;
  }
}

function port() {
  const fromEnv = parseInt(process.env.DASHBOARD_PORT || "", 10);
  if (fromEnv > 0) return fromEnv;
  try {
    const file = path.join(workspaceRoot(), ".claude", "dashboard", "workspace.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
    const p = parseInt((cfg.dashboard && cfg.dashboard.port) || "", 10);
    if (p > 0) return p;
  } catch {}
  return 3333;
}

const target = `http://127.0.0.1:${port()}`;
export default {
  "/api": { target, changeOrigin: true },
  "/screenshots": { target, changeOrigin: true },
  "/ds": { target, changeOrigin: true },
};
