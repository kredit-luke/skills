/**
 * Link tokens: how a person's own computer reaches their hosted dashboard without a
 * browser (Remote control). The hosted dashboard makes one (Settings › Linked computers),
 * shows it once and keeps only its hash; the person pastes it into their local dashboard,
 * which sends it as `Authorization: Bearer <token>` on /api/remote/* requests.
 *
 * The token carries its owner's email so the router can find their dashboard without a
 * login (the login proxy lets /api/remote/* through unsigned-in: there's no browser to
 * sign in). That email is only a routing hint: the dashboard it reaches checks the token
 * against its own hashes and its owner, so a token naming someone else gets nowhere.
 * The company's other gates (a client certificate at the ingress, say) still apply.
 *
 *   njl1.<base64url(email)>.<id>.<secret>
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LINK_TOKEN_VERSION = "njl1";
/** Only these paths take a link token, and only a link token gets into them. */
export const REMOTE_PREFIX = "/api/remote/";
const MAX_LINKS = 10;
const LABEL_MAX = 60;
/** lastUsedAt is written at most this often (every request of a live link would be a write). */
const TOUCH_EVERY_MS = 60_000;

/** shared/api.ts RemoteLink, written out here: the router imports this file without shared/. */
export interface LinkInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}
interface StoredLink extends LinkInfo { email: string; hash: string }

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** A link token's parts, or null when it isn't one. */
export function parseLinkToken(token: string | null | undefined): { email: string; id: string; secret: string } | null {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 4 || parts[0] !== LINK_TOKEN_VERSION) return null;
  let email = "";
  try { email = Buffer.from(parts[1], "base64url").toString("utf-8").trim().toLowerCase(); } catch { return null; }
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !/^[0-9a-f]{8}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{40,}$/.test(parts[3])) return null;
  return { email, id: parts[2], secret: parts[3] };
}

/** The link token on a request to a remote path (Authorization: Bearer …), else null. */
export function linkTokenOf(url: string | undefined, headers: Record<string, string | string[] | undefined>): string | null {
  if (!String(url || "").startsWith(REMOTE_PREFIX)) return null;
  const auth = headers.authorization;
  const m = String(Array.isArray(auth) ? auth[0] : auth || "").match(/^Bearer\s+(\S+)$/i);
  return m && parseLinkToken(m[1]) ? m[1] : null;
}

/** The hosted dashboard's links (<ledger>/remote-links.json): made, checked, revoked. */
export class LinkTokens {
  private file: string;
  private now: () => number;
  constructor(ledgerDir: string, now: () => number = Date.now) {
    this.file = path.join(ledgerDir, "remote-links.json");
    this.now = now;
  }

  private read(): StoredLink[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return Array.isArray(data.links) ? data.links : [];
    } catch {
      return [];
    }
  }

  private write(links: StoredLink[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ links }, null, 2), { mode: 0o600 });
  }

  list(): LinkInfo[] {
    return this.read().map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  /** A new link for `email` (this dashboard's owner): the token, shown once, and the link. */
  create(email: string, label: string): { token: string; link: LinkInfo } {
    const owner = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(owner)) throw Object.assign(new Error("This dashboard doesn't know its owner's email, so it can't make a link."), { status: 400 });
    label = String(label || "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || "My computer";
    const links = this.read();
    if (links.length >= MAX_LINKS) throw Object.assign(new Error(`Up to ${MAX_LINKS} computers can be linked. Remove one first.`), { status: 409 });
    let id: string;
    do { id = crypto.randomBytes(4).toString("hex"); } while (links.some((l) => l.id === id));
    const secret = b64url(crypto.randomBytes(32));
    const token = [LINK_TOKEN_VERSION, b64url(owner), id, secret].join(".");
    const link: StoredLink = { id, label, email: owner, hash: sha256(secret), createdAt: new Date(this.now()).toISOString(), lastUsedAt: null };
    this.write([...links, link]);
    return { token, link: { id, label, createdAt: link.createdAt, lastUsedAt: null } };
  }

  /** The link a token belongs to, if it's one of ours, for `owner`, and not revoked; null otherwise. */
  verify(token: string | null | undefined, owner: string | null): LinkInfo | null {
    const t = parseLinkToken(token);
    if (!t) return null;
    const links = this.read();
    const link = links.find((l) => l.id === t.id);
    if (!link || link.email !== t.email || (owner && link.email !== owner.toLowerCase())) return null;
    const a = Buffer.from(link.hash, "hex"), b = Buffer.from(sha256(t.secret), "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const last = link.lastUsedAt ? Date.parse(link.lastUsedAt) : 0;
    if (this.now() - last > TOUCH_EVERY_MS) {
      link.lastUsedAt = new Date(this.now()).toISOString();
      try { this.write(links); } catch {}
    }
    return { id: link.id, label: link.label, createdAt: link.createdAt, lastUsedAt: link.lastUsedAt };
  }

  /** Remove a link: its token stops working at once. False when there's no such link. */
  revoke(id: string): boolean {
    const links = this.read();
    const left = links.filter((l) => l.id !== id);
    if (left.length === links.length) return false;
    this.write(left);
    return true;
  }
}
