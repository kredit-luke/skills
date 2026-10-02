/**
 * Atlassian Cloud requests that work with both kinds of API token. A classic token is accepted
 * at the site (https://acme.atlassian.net/rest/...). A scoped token is refused there and only
 * works through the API gateway: https://api.atlassian.com/ex/<jira|confluence>/<cloudId>/...
 * So a request goes to the site first; if the site refuses the key (401/403), it's retried once
 * through the gateway, and a key that works there keeps using it.
 *
 * Also: forgetting the saved keys (Disconnect Atlassian).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

export type AtlassianProduct = "jira" | "confluence";

/** An HTTP failure with its status, so a refused key can be told apart from other errors. */
export interface StatusError extends Error { status?: number }

const cloudIds = new Map<string, Promise<string>>();
/** product + key hash → the gateway worked for this key (the site refused it). */
const viaGateway = new Set<string>();

/** The site's cloud id, from its public tenant_info endpoint (no key needed). */
export function cloudIdFor(site: string): Promise<string> {
  let p = cloudIds.get(site);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const req = https.get(`https://${site}/_edge/tenant_info`, { timeout: 15000 }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try { const id = JSON.parse(out).cloudId; if (typeof id === "string" && /^[\w-]+$/.test(id)) return resolve(id); } catch {}
          reject(new Error(`Couldn't find ${site}'s cloud id (HTTP ${res.statusCode}).`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("Looking up the Atlassian cloud id timed out")));
      req.on("error", reject);
    });
    p.catch(() => cloudIds.delete(site)); // try again next time
    cloudIds.set(site, p);
  }
  return p;
}

export const gatewayUrl = (product: AtlassianProduct, cloudId: string, pathAndQuery: string) =>
  `https://api.atlassian.com/ex/${product}/${cloudId}${pathAndQuery}`;

/**
 * Send a request to the site, or through the gateway for a scoped token. `send` makes the request
 * for a full URL and rejects with a StatusError on failure.
 */
export async function atlassianRequest<T>(
  product: AtlassianProduct, site: string, cred: string, pathAndQuery: string, send: (url: string) => Promise<T>,
  lookupCloudId: (site: string) => Promise<string> = cloudIdFor,
): Promise<T> {
  const k = `${product}:${crypto.createHash("sha256").update(cred).digest("hex")}`;
  if (viaGateway.has(k)) return send(gatewayUrl(product, await lookupCloudId(site), pathAndQuery));
  try {
    return await send(`https://${site}${pathAndQuery}`);
  } catch (e) {
    const status = (e as StatusError).status;
    if (status !== 401 && status !== 403) throw e;
    let url: string;
    try { url = gatewayUrl(product, await lookupCloudId(site), pathAndQuery); } catch { throw e; }
    const out = await send(url);
    viaGateway.add(k);
    return out;
  }
}

/** Delete a saved key file. Already gone is fine; any other failure is reported, never passed off as removed. */
export function removeKeyFile(file: string): void {
  try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

/**
 * Forget the Atlassian keys the dashboard saved for its Issues and Docs pages. Both go, since each
 * page falls back to the other's key. Returns the env vars that still supply a key: only the
 * person can unset those.
 */
export function forgetAtlassianKeys(ledgerDir: string): { envKeys: string[] } {
  for (const f of ["jira-api-token", "confluence-api-token"]) removeKeyFile(path.join(ledgerDir, f));
  const envKeys = [["JIRA_EMAIL", "JIRA_API_TOKEN"], ["CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN"]]
    .filter(([e, t]) => process.env[e] && process.env[t]).map(([, t]) => t);
  return { envKeys };
}
