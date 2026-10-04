/**
 * The Knowledge page's server side: notes from every Markdown source (a repo folder, or
 * a store's local copy), with links, backlinks, tags and freshness; and for stores, the
 * sync with the bucket and the edits people make from the page.
 *
 * A store's local copy lives in the ledger (never committed):
 *   <ledger>/knowledge/<key>/files/…     the notes, as in the bucket
 *   <ledger>/knowledge/<key>/state.json  what was synced: name → ETag, size, last change
 *   <ledger>/knowledge/<key>/INDEX.md    one line per note, for Claude to find its way
 * Runs that "Use" a store get --add-dir on that folder and a note saying what's there;
 * Claude sessions in the workspace terminal can be given it too (additionalDirectories).
 * The copy is read-only for Claude: the next sync overwrites changes made to it, so
 * edits go through the page (save → bucket, guarded by ETag → copy).
 */

import fs from "node:fs";
import path from "node:path";
import { docAreas, docSources, notesDirOf, storeDir, type AreaDef, type DocSiteDef } from "../docs.ts";
import { editSettings } from "../profile.ts";
import { NotesIndex, freshness, setFrontmatter, type Note } from "./notes.ts";
import { createStore, safeName, StoreConflict, type KnowledgeStore, type StoreObject } from "./store.ts";

const SYNC_EVERY_MS = 5 * 60_000;
/** Synced from a store: notes and the files they embed. */
const SYNCED = /\.(md|png|jpe?g|gif|webp|svg|pdf)$/i;
const MAX_SYNC_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

export interface SyncState {
  syncedAt: string | null;
  error: string | null;
  objects: Record<string, { etag: string; size: number; updatedAt: string | null }>;
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

export class Knowledge {
  private readonly root: string;
  private readonly ledgerDir: string;
  private stores = new Map<string, { sig: string; store: KnowledgeStore }>();
  private indexes = new Map<string, NotesIndex>();
  private syncing = new Map<string, Promise<SyncState>>();

  constructor(root: string, ledgerDir: string) {
    this.root = root;
    this.ledgerDir = ledgerDir;
  }

  // ---------------------------------------------------------------- sources

  source(key: unknown): DocSiteDef {
    const s = docSources().sources.find((x) => x.key === String(key || ""));
    if (!s) throw httpError(404, `No knowledge source ${String(key || "")}`);
    return s;
  }

  private storeSource(key: unknown): DocSiteDef {
    const s = this.source(key);
    if (s.kind !== "store") throw httpError(400, `${s.name} isn't a store: it's edited in its repo.`);
    return s;
  }

  store(s: DocSiteDef): KnowledgeStore {
    const sig = JSON.stringify(s.store);
    const hit = this.stores.get(s.key);
    if (hit && hit.sig === sig) return hit.store;
    const store = createStore(s.store!, s, this.ledgerDir);
    this.stores.set(s.key, { sig, store });
    return store;
  }

  private stateFile(key: string) { return path.join(storeDir(key), "state.json"); }

  readState(key: string): SyncState {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile(key), "utf-8"));
      return { syncedAt: j.syncedAt || null, error: j.error || null, objects: j.objects && typeof j.objects === "object" ? j.objects : {} };
    } catch { return { syncedAt: null, error: null, objects: {} }; }
  }

  private writeState(key: string, st: SyncState) {
    fs.mkdirSync(storeDir(key), { recursive: true });
    const tmp = `${this.stateFile(key)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, this.stateFile(key));
  }

  /** A store's connection and sync state, for its card and header. */
  storeStatus(key: unknown) {
    const s = this.storeSource(key);
    const store = this.store(s);
    const { source: keySource, ...st } = store.status();
    const state = this.readState(s.key);
    return {
      source: s.key, label: store.label, ...st, keySource, help: st.connected ? null : store.connectHelp(),
      syncedAt: state.syncedAt, syncing: this.syncing.has(s.key), error: state.error,
      files: Object.keys(state.objects).length, dir: storeDir(s.key), claudeAccess: this.claudeAccessOn(s.key),
    };
  }

  async connect(key: unknown, secret: string) {
    const s = this.storeSource(key);
    await this.store(s).connect(secret);
    await this.sync(s.key, true).catch(() => {});
    return this.storeStatus(s.key);
  }

  disconnect(key: unknown) {
    const s = this.storeSource(key);
    this.store(s).disconnect();
    return this.storeStatus(s.key);
  }

  // ---------------------------------------------------------------- sync

  /** Sync now if it's been a while (or force); one at a time per store. A store that isn't connected is left alone. */
  sync(key: string, force = false): Promise<SyncState> {
    const s = this.storeSource(key);
    const running = this.syncing.get(s.key);
    if (running) return running;
    const state = this.readState(s.key);
    if (!force && state.syncedAt && Date.now() - Date.parse(state.syncedAt) < SYNC_EVERY_MS) return Promise.resolve(state);
    const store = this.store(s);
    if (!store.status().connected) return Promise.resolve(state);
    const p = this.pull(s.key, store).finally(() => this.syncing.delete(s.key));
    this.syncing.set(s.key, p);
    return p;
  }

  /** Download what changed in the bucket, drop what's gone, and rewrite INDEX.md. */
  private async pull(key: string, store: KnowledgeStore): Promise<SyncState> {
    const prev = this.readState(key);
    const files = path.join(storeDir(key), "files");
    let remote: StoreObject[];
    try {
      remote = (await store.list()).filter((o) => SYNCED.test(o.name) && o.size <= MAX_SYNC_BYTES && !o.name.split("/").some((p) => p.startsWith(".")));
    } catch (e) {
      const st = { ...prev, error: e.message };
      this.writeState(key, st);
      throw e;
    }
    const objects: SyncState["objects"] = {};
    let error: string | null = null;
    for (const o of remote) {
      let name: string;
      try { name = safeName(o.name); } catch { continue; }
      const dest = path.join(files, ...name.split("/"));
      const had = prev.objects[name];
      if (had && had.etag === o.etag && fs.existsSync(dest)) { objects[name] = had; continue; }
      try {
        const { body, etag } = await store.get(name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
        objects[name] = { etag: etag || o.etag, size: body.length, updatedAt: o.updatedAt };
      } catch (e) {
        error = `${name}: ${e.message}`;
        if (had) objects[name] = had;
      }
    }
    // Gone from the bucket: remove our copy (only files we synced, never anything else).
    for (const name of Object.keys(prev.objects)) {
      if (objects[name]) continue;
      try { fs.unlinkSync(path.join(files, ...name.split("/"))); } catch {}
    }
    removeEmptyDirs(files);
    const st: SyncState = { syncedAt: new Date().toISOString(), error, objects };
    this.writeState(key, st);
    this.writeIndex(key);
    return st;
  }

  /** INDEX.md next to the copy: one line per note, so Claude knows what exists without opening everything. */
  private writeIndex(key: string) {
    const s = this.source(key);
    const area = docAreas().find((a) => a.key === s.area);
    const notes = this.notes(key);
    const lines = [
      `# ${s.name}${area ? ` (${area.label})` : ""}`,
      "",
      `The team's notes from ${s.name}, synced from its storage. The notes are under files/, by path. Read-only here: changes made to these files are overwritten by the next sync; people edit them on the dashboard's Knowledge page.`,
      "",
      ...notes.map((n) => `- files/${n.rel}: ${n.title}${n.owner ? ` (owner: ${n.owner})` : ""}${n.tags.length ? ` [${n.tags.map((t) => "#" + t).join(" ")}]` : ""}${n.summary ? ` — ${n.summary}` : ""}`),
      "",
    ];
    fs.writeFileSync(path.join(storeDir(key), "INDEX.md"), lines.join("\n"));
  }

  // ---------------------------------------------------------------- notes

  /** Every note of a Markdown source, linked, with times from the bucket for a store. */
  notes(key: unknown): Note[] {
    const s = this.source(key);
    const dir = notesDirOf(this.root, s);
    if (!dir || s.kind === "external") return [];
    let idx = this.indexes.get(s.key);
    if (!idx || idx.dir !== dir) { idx = new NotesIndex(dir); this.indexes.set(s.key, idx); }
    if (s.kind !== "store") return idx.notes();
    const times = Object.fromEntries(Object.entries(this.readState(s.key).objects).map(([n, o]) => [n, o.updatedAt]));
    return idx.notes(times);
  }

  /** Notes with their freshness against the source's area. */
  notesWithFreshness(key: unknown, now = Date.now()) {
    const s = this.source(key);
    const area = docAreas().find((a) => a.key === s.area) || null;
    return this.notes(s.key).map((n) => ({ ...n, ...freshness(n, area?.reviewEvery || null, now) }));
  }

  /** How many notes are past review, per source (for the area cards and Home). */
  staleCounts(now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    const areas = new Map(docAreas().map((a) => [a.key, a]));
    for (const s of docSources().sources) {
      const every = s.area ? areas.get(s.area)?.reviewEvery : null;
      if (!every || (s.kind !== "notes" && s.kind !== "store")) continue;
      try { out[s.key] = this.notes(s.key).filter((n) => freshness(n, every, now).stale).length; } catch {}
    }
    return out;
  }

  /** One note's text, and (for a store) the ETag a save must match. */
  read(key: unknown, rel: unknown): { rel: string; text: string; etag: string | null; editable: boolean; file: string } {
    const s = this.source(key);
    const dir = notesDirOf(this.root, s);
    if (!dir) throw httpError(400, `${s.name} has no notes here.`);
    const name = safeName(String(rel || ""));
    if (!/\.md$/i.test(name)) throw httpError(400, "Only Markdown notes.");
    const file = path.join(dir, ...name.split("/"));
    let text: string;
    try { text = fs.readFileSync(file, "utf-8"); } catch { throw httpError(404, `${name} isn't in ${s.name}.`); }
    const etag = s.kind === "store" ? this.readState(s.key).objects[name]?.etag || null : null;
    return { rel: name, text, etag, editable: s.kind === "store", file };
  }

  /** An image a note embeds (for the page to show), or null. Only images, inside the source's folder. */
  imageFile(key: unknown, rel: unknown): { file: string; type: string } | null {
    const s = this.source(key);
    const dir = notesDirOf(this.root, s);
    if (!dir) return null;
    let name: string;
    try { name = safeName(String(rel || "")); } catch { return null; }
    const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
    const file = path.join(dir, ...name.split("/"));
    return type && fs.existsSync(file) ? { file, type } : null;
  }

  /** Save a note to the bucket (etag null = a new note), then update the copy. Someone else's newer save → 409. */
  async save(key: unknown, rel: unknown, text: unknown, etag: unknown): Promise<{ rel: string; etag: string }> {
    const s = this.storeSource(key);
    const name = noteName(rel);
    const body = Buffer.from(String(text ?? ""), "utf-8");
    if (body.length > 2 * 1024 * 1024) throw httpError(400, "That note is over 2 MB.");
    const store = this.store(s);
    let newTag: string;
    try {
      newTag = await store.put(name, body, etag ? { ifMatch: String(etag) } : { ifNoneMatch: true });
    } catch (e) {
      if (e instanceof StoreConflict) throw httpError(409, etag ? e.message : `There's already a note called ${name}.`);
      throw e;
    }
    this.recordLocal(s.key, name, body, newTag);
    return { rel: name, etag: newTag };
  }

  async remove(key: unknown, rel: unknown, etag: unknown): Promise<void> {
    const s = this.storeSource(key);
    const name = noteName(rel);
    try { await this.store(s).remove(name, etag ? String(etag) : undefined); }
    catch (e) { if (e instanceof StoreConflict) throw httpError(409, e.message); throw e; }
    const st = this.readState(s.key);
    delete st.objects[name];
    this.writeState(s.key, st);
    try { fs.unlinkSync(path.join(storeDir(s.key), "files", ...name.split("/"))); } catch {}
    removeEmptyDirs(path.join(storeDir(s.key), "files"));
    this.writeIndex(s.key);
  }

  /** Rename = write the new name (must be free) and delete the old one (must be unchanged). */
  async rename(key: unknown, from: unknown, to: unknown, etag: unknown): Promise<{ rel: string; etag: string }> {
    const s = this.storeSource(key);
    const src = noteName(from), dst = noteName(to);
    if (src === dst) throw httpError(400, "That's the same name.");
    const { text } = this.read(s.key, src);
    const saved = await this.save(s.key, dst, text, null);
    await this.remove(s.key, src, etag);
    return saved;
  }

  /** Set `reviewed: <today>` in a note's frontmatter: through the bucket for a store, on disk for a repo folder. */
  async markReviewed(key: unknown, rel: unknown, today = new Date().toISOString().slice(0, 10)) {
    const s = this.source(key);
    const cur = this.read(s.key, rel);
    const next = setFrontmatter(cur.text, "reviewed", today);
    if (s.kind === "store") return this.save(s.key, cur.rel, next, cur.etag);
    fs.writeFileSync(cur.file, next);
    return { rel: cur.rel, etag: null };
  }

  private recordLocal(key: string, name: string, body: Buffer, etag: string) {
    const dest = path.join(storeDir(key), "files", ...name.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    const st = this.readState(key);
    st.objects[name] = { etag, size: body.length, updatedAt: new Date().toISOString() };
    this.writeState(key, st);
    this.writeIndex(key);
  }

  // ---------------------------------------------------------------- Claude

  /** For a run that should use these store sources: the folders to add and what to tell Claude. */
  runAccess(keys: string[]): { addDirs: string[]; note: string | null } {
    const addDirs: string[] = [], notes: string[] = [];
    for (const key of keys) {
      const s = this.source(key);
      if (s.kind !== "store") continue;
      const dir = storeDir(s.key);
      if (!fs.existsSync(path.join(dir, "files"))) continue;
      addDirs.push(dir);
      notes.push(`The team's knowledge "${s.name}" is in ${dir}: INDEX.md lists every note (title, owner, tags, summary); the notes are under files/. Search and read them for anything about the business, and cite the files you used. They're a read-only copy: don't edit them (changes are overwritten). To change a note, say what should change and the person will edit it on the Knowledge page.`);
    }
    return { addDirs, note: notes.length ? notes.join("\n\n") : null };
  }

  private claudeAccessOn(key: string): boolean {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.root, ".claude", "settings.local.json"), "utf-8"));
      const dirs: string[] = Array.isArray(s?.permissions?.additionalDirectories) ? s.permissions.additionalDirectories : [];
      return dirs.includes(storeDir(key));
    } catch { return false; }
  }

  /** Let this person's Claude sessions in the workspace read a store's copy (permissions.additionalDirectories). */
  setClaudeAccess(key: unknown, on: boolean) {
    const s = this.storeSource(key);
    const dir = storeDir(s.key);
    editSettings(this.root, (settings) => {
      const perms = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
      const dirs: string[] = Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories.filter((d: unknown) => typeof d === "string") : [];
      if (on === dirs.includes(dir)) return { changed: false, result: null };
      const next = on ? [...dirs, dir] : dirs.filter((d) => d !== dir);
      settings.permissions = { ...perms, additionalDirectories: next };
      if (!next.length) delete settings.permissions.additionalDirectories;
      if (!Object.keys(settings.permissions).length) delete settings.permissions;
      return { changed: true, result: null };
    }, "giving Claude access to knowledge");
    return this.storeStatus(s.key);
  }

  areas(): AreaDef[] { return docAreas(); }
}

/** A note's name: a safe relative path ending in .md (added if missing). */
export function noteName(rel: unknown): string {
  let n = String(rel || "").trim();
  if (n && !/\.md$/i.test(n)) n += ".md";
  return safeName(n);
}

function removeEmptyDirs(dir: string) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) {
    const d = path.join(dir, e.name);
    removeEmptyDirs(d);
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {}
  }
}

export { StoreConflict };
