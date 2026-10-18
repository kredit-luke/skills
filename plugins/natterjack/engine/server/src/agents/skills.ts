/**
 * Workspace skills for agents that don't load Claude Code's: a prompt that starts with
 * `/name args` (Issues' `/implement TICKET`, a preset, a slash typed in Ask) becomes the
 * skill's instructions (.claude/skills/<name>/SKILL.md, or a .claude/commands/<name>.md
 * command) with the arguments filled in, so Copilot and Codex follow the same playbook.
 * `/plugin:name args` does the same with a skill of a Claude Code plugin enabled for the
 * workspace (plugin-skills.ts). Anything that isn't a known skill passes through.
 */

import fs from "node:fs";
import path from "node:path";
import { pluginSkillDirs } from "../plugin-skills.ts";

const SLASH = /^\/([\w.-]+(?::[\w.-]+)?)(?:[ \t]+([\s\S]*))?$/;

function readCaseInsensitive(dir: string, name: string): string | null {
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  if (!hit) return null;
  try { return fs.readFileSync(path.join(dir, hit), "utf-8"); } catch { return null; }
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A plugin skill (`plugin:name`, by folder or frontmatter name) of the plugins enabled for `root`. */
function findPluginSkill(root: string, plugin: string, name: string): { text: string; rel: string } | null {
  const lc = (s: string) => s.toLowerCase();
  for (const { plugin: p, dir } of pluginSkillDirs(root)) {
    if (lc(p) !== lc(plugin)) continue;
    const text = readCaseInsensitive(dir, "SKILL.md");
    if (text == null) continue;
    const fmName = /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(FRONTMATTER.exec(text)?.[1] || "")?.[1];
    if (lc(path.basename(dir)) === lc(name) || (fmName && lc(fmName) === lc(name))) {
      return { text, rel: path.join(dir, "SKILL.md").split(path.sep).join("/") };
    }
  }
  return null;
}

/**
 * The skill (or command) file for a name: { text, rel } or null. A workspace skill comes from
 * the run's folder; a `plugin:name` one from the plugins enabled for `root`, the main
 * workspace (a plugin installed for a project is recorded against it, not a worktree).
 */
export function findSkill(cwd: string, name: string, root: string = cwd): { text: string; rel: string } | null {
  const colon = name.indexOf(":");
  if (colon >= 0) return findPluginSkill(root, name.slice(0, colon), name.slice(colon + 1));
  const skillsDir = path.join(cwd, ".claude", "skills");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(skillsDir); } catch {}
  const dir = dirs.find((d) => d.toLowerCase() === name.toLowerCase());
  if (dir) {
    const text = readCaseInsensitive(path.join(skillsDir, dir), "SKILL.md");
    if (text != null) return { text, rel: `.claude/skills/${dir}/SKILL.md` };
  }
  const cmd = readCaseInsensitive(path.join(cwd, ".claude", "commands"), `${name}.md`);
  return cmd != null ? { text: cmd, rel: `.claude/commands/${name}.md` } : null;
}

/** `/name args` → the skill's instructions with the arguments; anything else unchanged. */
export function expandSlash(prompt: string, cwd: string, root: string = cwd): string {
  const m = SLASH.exec(String(prompt || "").trim());
  if (!m) return prompt;
  const skill = findSkill(cwd, m[1], root);
  if (!skill) return prompt;
  const args = (m[2] || "").trim();
  const body = skill.text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "").trim();
  const filled = body.includes("$ARGUMENTS") ? body.split("$ARGUMENTS").join(args) : body;
  return [
    `Follow the ${m[1].includes(":") ? "" : "workspace's "}"/${m[1]}" skill below (${skill.rel}), as if it had been invoked as \`/${m[1]}${args ? " " + args : ""}\`.`,
    "",
    "<skill>",
    filled,
    "</skill>",
    ...(args && !body.includes("$ARGUMENTS") ? ["", `Arguments: ${args}`] : []),
  ].join("\n");
}
