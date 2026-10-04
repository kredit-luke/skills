/**
 * Workspace skills for agents that don't load Claude Code's: a prompt that starts with
 * `/name args` (Issues' `/implement TICKET`, a preset, a slash typed in Ask) becomes the
 * skill's instructions (.claude/skills/<name>/SKILL.md, or a .claude/commands/<name>.md
 * command) with the arguments filled in, so Copilot and Codex follow the same playbook.
 * Plugin skills (`plugin:name`) and anything that isn't a workspace skill pass through.
 */

import fs from "node:fs";
import path from "node:path";

const SLASH = /^\/([\w.-]+)(?:[ \t]+([\s\S]*))?$/;

function readCaseInsensitive(dir: string, name: string): string | null {
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const hit = entries.find((e) => e.toLowerCase() === name.toLowerCase());
  if (!hit) return null;
  try { return fs.readFileSync(path.join(dir, hit), "utf-8"); } catch { return null; }
}

/** The skill (or command) file for a name, from the run's folder: { text, rel } or null. */
export function findSkill(cwd: string, name: string): { text: string; rel: string } | null {
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
export function expandSlash(prompt: string, cwd: string): string {
  const m = SLASH.exec(String(prompt || "").trim());
  if (!m) return prompt;
  const skill = findSkill(cwd, m[1]);
  if (!skill) return prompt;
  const args = (m[2] || "").trim();
  const body = skill.text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "").trim();
  const filled = body.includes("$ARGUMENTS") ? body.split("$ARGUMENTS").join(args) : body;
  return [
    `Follow the workspace's "/${m[1]}" skill below (${skill.rel}), as if it had been invoked as \`/${m[1]}${args ? " " + args : ""}\`.`,
    "",
    "<skill>",
    filled,
    "</skill>",
    ...(args && !body.includes("$ARGUMENTS") ? ["", `Arguments: ${args}`] : []),
  ].join("\n");
}
