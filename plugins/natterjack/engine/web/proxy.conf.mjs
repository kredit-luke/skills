// Dev server (npm run dev) proxy: /api and /screenshots go to the dashboard server on its
// configured port (DASHBOARD_PORT, else .claude/dashboard/workspace.json dashboard.port, else 3333).
// The dev server itself listens on angular.json's serve port; keep workspace.json dashboard.devPort
// in step with it, or the server refuses the dev server's requests as cross-origin.
import fs from "node:fs";

function port() {
  const fromEnv = parseInt(process.env.DASHBOARD_PORT || "", 10);
  if (fromEnv > 0) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(new URL("../../.claude/dashboard/workspace.json", import.meta.url), "utf-8"));
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
