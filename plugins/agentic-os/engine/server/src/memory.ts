/**
 * Claude Code's auto-memory for this workspace:
 * ~/.claude/projects/<workspace path, non-alphanumerics as "-">/memory/*.md,
 * indexed by MEMORY.md (one line per file, loaded into every session).
 *
 * Read-only apart from delete: memories are written by Claude during sessions.
 * Each file gets a staleness check, since a memory that names a file or folder
 * that's gone is exactly the kind that misleads a future session.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const INDEX = "MEMORY.md";
const FILE_RE = /^[\w.-]+\.md$/;

class Memory {
  root: any;
  dir: any;
  _trackedCache: any;

  constructor(workspaceRoot) {
    this.root = workspaceRoot;
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    this.dir = path.join(base, "projects", workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  }

  /** Every memory file, parsed, with staleness notes. */
  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => FILE_RE.test(f) && f !== INDEX); } catch {
      return { dir: this.dir, exists: false, memories: [], orphanIndexLines: [] };
    }
    const index = this._index();
    const memories = files.map((file) => {
      const full = path.join(this.dir, file);
      const text = fs.readFileSync(full, "utf-8");
      const st = fs.statSync(full);
      const { fm, body } = frontmatter(text);
      return {
        issues: [] as string[],
        file,
        name: fm.name || file.replace(/\.md$/, ""),
        description: fm.description || "",
        type: fm.type || "",
        body,
        updatedAt: st.mtime.toISOString(),
        bytes: st.size,
        indexed: index.some((l) => l.includes(`(${file})`)),
      };
    });
    // Unresolved [[links]] aren't flagged: they're allowed, as notes of memories worth writing later.
    for (const m of memories) {
      m.issues = [];
      if (!m.indexed) m.issues.push("Not listed in MEMORY.md, so sessions never see it.");
      for (const ref of this._missingPaths(m.body)) m.issues.push(`Mentions \`${ref}\`, which no longer exists in the workspace.`);
    }
    const orphanIndexLines = index.filter((l) => {
      const m = /\]\(([^)]+\.md)\)/.exec(l);
      return m && !files.includes(m[1]);
    });
    memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { dir: this.dir, exists: true, memories, orphanIndexLines };
  }

  /** Delete one memory file and its MEMORY.md line. */
  remove(file) {
    if (!FILE_RE.test(String(file)) || file === INDEX) throw new Error("Invalid memory file name.");
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) throw new Error(`${file} doesn't exist.`);
    fs.unlinkSync(full);
    const indexFile = path.join(this.dir, INDEX);
    try {
      const text = fs.readFileSync(indexFile, "utf-8");
      const kept = text.split("\n").filter((l) => !l.includes(`(${file})`));
      fs.writeFileSync(indexFile, kept.join("\n"));
    } catch {}
    return { ok: true, file };
  }

  _index() {
    try {
      return fs.readFileSync(path.join(this.dir, INDEX), "utf-8").split(/\r?\n/).filter((l) => l.trim().startsWith("-"));
    } catch {
      return [];
    }
  }

  /**
   * Backticked things that look like workspace paths (`API/docs/x.md`,
   * `Core.Cli/Program.cs`, `.claude/skills/foo/`) that match no file on
   * disk and no tracked file in any repo (a path may be written relative to a
   * repo's src/ or deeper, so tracked files are matched by suffix).
   * Skipped: placeholders, URLs, worktrees (transient) and build output.
   */
  _missingPaths(body) {
    const out = new Set();
    for (const m of body.matchAll(/`([^`\s]+)`/g)) {
      const ref = m[1].replace(/[),.:;]+$/, "");
      if (!/[\\/]/.test(ref) || /[<>*{}$%|]|^https?:|^\/\/|^-|:\/\/|@|^\.\.\./.test(ref)) continue;
      if (!/^[~.\w]/.test(ref)) continue;
      // "<workspace>/repo/..." is written from the workspace's parent.
      const rel = ref.replace(/^\.\//, "").replace(/\\/g, "/").replace(new RegExp(`^${escapeRe(path.basename(this.root))}/`), "");
      if (/^worktrees\/|(^|\/)(obj|bin|node_modules|dist|\.vite|\.angular)(\/|$)/.test(rel)) continue;
      // Only judge things that look like files or folders, not "A/B testing" or "read/write".
      const looksLikePath = /\.[a-z0-9]{1,6}\/?$/i.test(rel) || rel.endsWith("/") || rel.startsWith(".") || rel.startsWith("~") ||
        fs.existsSync(path.join(this.root, rel.split("/")[0]));
      if (!looksLikePath) continue;
      if (rel.startsWith("~/")) { if (!fs.existsSync(path.join(os.homedir(), rel.slice(2)))) out.add(ref); continue; }
      if (fs.existsSync(path.join(this.root, rel))) continue;
      // Untracked but real (generated or gitignored) inside a repo, e.g. a build's output folder.
      if (this._repos().some((d) => fs.existsSync(path.join(this.root, d, rel)))) continue;
      const r = rel.replace(/\/$/, "");
      const tracked = this._tracked();
      if (!tracked.includes(`/${r}\n`) && !tracked.includes(`/${r}/`)) out.add(ref);
    }
    return [...out];
  }

  /** "\n/<repo>/<path>" for every tracked file in the workspace and its repos; cached 10 min. */
  _tracked() {
    if (this._trackedCache && Date.now() - this._trackedCache.at < 10 * 60000) return this._trackedCache.text;
    const lines = [];
    const add = (dir, prefix) => {
      try {
        const outp = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf-8", timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        for (const f of outp.split("\n")) if (f) lines.push(`/${prefix}${f}`);
      } catch {}
    };
    add(this.root, "");
    for (const d of this._repos()) add(path.join(this.root, d), `${d}/`);
    const text = "\n" + lines.join("\n") + "\n";
    this._trackedCache = { at: Date.now(), text };
    return text;
  }

  /** Top-level repo folders (those with a .git). */
  _repos() {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "worktrees" && fs.existsSync(path.join(this.root, e.name, ".git")))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal YAML frontmatter: top-level scalars plus the nested metadata.type. */
function frontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (!kv || !kv[2]) continue;
    const key = kv[1];
    if (fm[key] === undefined) fm[key] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: text.slice(m[0].length) };
}

export { Memory, frontmatter };
