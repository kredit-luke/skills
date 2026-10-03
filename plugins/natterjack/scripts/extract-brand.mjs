#!/usr/bin/env node
/**
 * Find the team's design system and turn it into the dashboard's brand folder.
 *
 *   node extract-brand.mjs <workspace>                         list candidates (JSON)
 *   node extract-brand.mjs <workspace> --apply <n|path> [--logo <file>] [--favicon <file>] [--dry]
 *
 * Candidates, best first: token bundles (design-system / tokens folders, *.tokens.json),
 * stylesheets with a big :root block of custom properties (a marketing or brand site's
 * usually beats a product app's), SCSS variable files, Tailwind themes. Each lists the
 * colors, fonts and radii it defines, plus logos and favicons found nearby.
 *
 * --apply copies the chosen stylesheet(s) verbatim into .claude/dashboard/brand/
 * (SCSS / Tailwind / JSON values are written out as plain CSS variables instead),
 * writes a DRAFT brand/theme.css that maps them onto the dashboard's token contract
 * (<engine>/web/public/ds/tokens.css), copies the logo and favicon, sets
 * workspace.json "brand", and prints a WCAG contrast check. The mapping is a
 * best guess from variable names: Claude should read theme.css, fix anything the
 * report flags, and show the user a screenshot.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEngineFolder } from "./lib.mjs";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "bin", "obj", "vendor", "target", ".next", ".nuxt", ".angular", "coverage", "worktrees", ".claude", "dashboard", "natterjack"]);
const read = (f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } };

function walk(dir, test, depth = 6, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // The engine (dashboard/, natterjack/ or wherever engine.json says) has its own tokens, not the team's.
    if (e.isDirectory()) { if (depth > 0 && !SKIP.has(e.name) && !e.name.startsWith(".") && !isEngineFolder(p)) walk(p, test, depth - 1, out); }
    else if (test(e.name, p)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ color math

export function parseColor(v) {
  if (!v) return null;
  v = String(v).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(v);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  const named = { white: [255, 255, 255], black: [0, 0, 0] };
  return named[v] || null;
}
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
export const hex = (c) => "#" + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("").toUpperCase();
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
function luminance(c) {
  const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const saturation = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx === 0 ? 0 : (mx - mn) / mx; };

// ------------------------------------------------------------------ token sources

/** { name: value } custom properties from every :root / html block in a CSS text. */
function cssVars(text) {
  const vars = {};
  // Strip comments first, so a :root block right after one still matches.
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of clean.matchAll(/(?<![\w-])(?::root|html)\s*(?:,\s*[\w:.\[\]="'-]+\s*)*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  }
  return vars;
}
function scssVars(text) {
  const vars = {};
  for (const m of text.matchAll(/^\s*\$([\w-]+)\s*:\s*([^;]+?)\s*(?:!default)?\s*;/gm)) vars[m[1]] = m[2].trim();
  return vars;
}
/** Tailwind: string colors inside theme / theme.extend (regex, no eval). */
function tailwindVars(text) {
  const vars = {};
  const colors = /colors\s*:\s*\{([\s\S]*?)\n\s{2,6}\}/.exec(text);
  if (colors) {
    let group = null;
    for (const line of colors[1].split(/\r?\n/)) {
      const open = /^\s*['"]?([\w-]+)['"]?\s*:\s*\{/.exec(line);
      if (open) { group = open[1]; continue; }
      if (/^\s*\}/.test(line)) { group = null; continue; }
      const kv = /^\s*['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/.exec(line);
      if (kv) vars[group ? `${group}-${kv[1]}` : kv[1]] = kv[2];
    }
  }
  const fonts = /fontFamily\s*:\s*\{([\s\S]*?)\}/.exec(text);
  if (fonts) for (const m of fonts[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[\s*['"]([^'"]+)['"]/g)) vars[`font-${m[1]}`] = `"${m[2]}", sans-serif`;
  return vars;
}
/** Design-token JSON ({ color: { primary: { value: "#..." } } } and the W3C $value form). */
function tokenJsonVars(text) {
  const vars = {};
  let data;
  try { data = JSON.parse(text); } catch { return vars; }
  const visit = (node, trail) => {
    if (!node || typeof node !== "object") return;
    const v = node.$value ?? node.value;
    if (typeof v === "string" || typeof v === "number") { vars[trail.join("-")] = String(v); return; }
    for (const [k, child] of Object.entries(node)) if (!k.startsWith("$")) visit(child, [...trail, k]);
  };
  visit(data, []);
  return vars;
}

/** A stylesheet that only declares tokens (:root / html variables, @import, @font-face): safe to load into the dashboard. */
export function tokensOnly(text) {
  const rest = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import[^;]+;/g, "")
    .replace(/@font-face\s*\{[^}]*\}/g, "")
    .replace(/(?::root|html)(?![\w-])[^{]*\{[^}]*\}/g, "")
    .replace(/@media[^{]*\{\s*\}/g, "");
  return !/\{/.test(rest);
}

/** Resolve var(--x) chains within one set of variables. */
function resolved(vars, value, depth = 0) {
  const m = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(String(value || "").trim());
  if (!m || depth > 8) return value;
  return vars[m[1]] !== undefined ? resolved(vars, vars[m[1]], depth + 1) : m[2] || value;
}

function summarize(vars) {
  const colors = [], fonts = [], radii = [];
  for (const [k, v] of Object.entries(vars)) {
    const r = resolved(vars, v);
    if (parseColor(r)) colors.push(k);
    else if (/font|family|typeface/i.test(k) && /[a-z]/i.test(r) && !/^\d/.test(r)) fonts.push(k);
    else if (/radius|rounded/i.test(k)) radii.push(k);
  }
  return { colors, fonts, radii };
}

function googleFonts(files) {
  const out = new Set();
  for (const f of files) {
    for (const m of (read(f) || "").matchAll(/fonts\.googleapis\.com\/css2?\?([^"')\s]+)/g)) {
      for (const [, fam] of decodeURIComponent(m[1].replace(/&amp;/g, "&")).matchAll(/(?:^|&)family=([^&]+)/g)) out.add(fam.split(":")[0].replace(/\+/g, " "));
    }
  }
  return [...out];
}

function logosNear(root, dir) {
  const imgs = walk(dir, (n) => /\.(svg|png|webp)$/i.test(n) && /logo|brand|wordmark|mark/i.test(n), 5);
  const score = (p) => (/white|light|inverse|reverse|negative|mono/i.test(path.basename(p)) ? 3 : 0) + (/\.svg$/i.test(p) ? 1 : 0) - p.split(path.sep).length * 0.01;
  const favicons = walk(dir, (n) => /^(favicon|apple-touch-icon|icon)[\w.-]*\.(ico|png|svg)$/i.test(n), 5);
  return {
    logos: imgs.sort((a, b) => score(b) - score(a)).slice(0, 6).map((p) => path.relative(root, p).split(path.sep).join("/")),
    favicons: favicons.slice(0, 4).map((p) => path.relative(root, p).split(path.sep).join("/")),
  };
}

/** A bundler's hashed output (styles-4DKUHBMG.css, main.3f9a1c2b.css): compiled, not a source of tokens. */
export function isHashedBuild(file) {
  return /[.-](?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,20}\.css$/.test(path.basename(file));
}

// Variables that belong to a library (diff2html, Material, Bootstrap, Tailwind, AG Grid, ...),
// not the brand: a compiled bundle full of them otherwise outranks the real tokens.
const VENDOR_VAR = /^(d2h|mat|mdc|bs|tw|ag|swiper|fa|ion|chakra|mantine|cm|hljs|shiki|toastify|plyr|pico|ck|tox|ql)-/;
export function withoutVendorVars(vars) {
  return Object.fromEntries(Object.entries(vars).filter(([k]) => !VENDOR_VAR.test(k)));
}

/** Ranked design-system candidates in a workspace. */
export function brandCandidates(root) {
  root = path.resolve(root);
  const out = [];
  const add = (file, kind, rawVars, bonus, why) => {
    if (isHashedBuild(file)) return;
    const vars = withoutVendorVars(rawVars);
    const s = summarize(vars);
    if (s.colors.length < 4) return;
    const relFile = path.relative(root, file).split(path.sep).join("/");
    const repo = relFile.split("/")[0];
    let score = s.colors.length + s.fonts.length * 3 + s.radii.length + bonus;
    if (/design|tokens?|(^|\/)_?ds(\/|$)|brand|theme|style-?guide/i.test(relFile)) score += 25;
    if (/marketing|site|www|landing|web-?site|homepage/i.test(repo)) score += 15;
    out.push({ file: relFile, kind, score, why, colors: s.colors.length, fonts: s.fonts.length, radii: s.radii.length, sampleColors: s.colors.slice(0, 10).map((k) => `${k}: ${resolved(vars, vars[k])}`), repo });
  };
  // A folder of token stylesheets (tokens/, ds/, design-system/) is one candidate: all its files.
  const bundled = new Set();
  const cssFiles = walk(root, (n) => /\.css$/i.test(n) && !/\.min\.css$/i.test(n));
  for (const f of cssFiles) {
    const dir = path.dirname(f);
    if (bundled.has(dir) || !/(^|[\\/])(_?ds|tokens?|design-?system[\w-]*)$/i.test(dir)) continue;
    bundled.add(dir);
    // Only files that just declare tokens: a base/reset or component sheet in the same folder
    // would restyle the dashboard's own elements.
    const files = cssFiles.filter((g) => path.dirname(g) === dir && tokensOnly(read(g) || "")).sort();
    if (!files.length) continue;
    const vars = Object.assign({}, ...files.map((g) => cssVars(read(g) || "")));
    add(files[0], "css", vars, 15 + files.length, `token stylesheets (${files.map((g) => path.basename(g)).join(", ")})`);
    if (out.length && out[out.length - 1].file === path.relative(root, files[0]).split(path.sep).join("/")) {
      out[out.length - 1].bundle = files.map((g) => path.relative(root, g).split(path.sep).join("/"));
    }
  }
  for (const f of cssFiles) {
    if (bundled.has(path.dirname(f))) continue;
    const text = read(f) || "";
    if (!text.includes("--")) continue;
    add(f, "css", cssVars(text), 0, ":root custom properties");
  }
  for (const f of walk(root, (n) => /^_?(variables|vars|tokens|theme|colors|colours|palette|settings)\.scss$/i.test(n))) add(f, "scss", scssVars(read(f) || ""), -5, "SCSS variables");
  for (const f of walk(root, (n) => /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(n), 3)) add(f, "tailwind", tailwindVars(read(f) || ""), 5, "Tailwind theme");
  for (const f of walk(root, (n) => /(^tokens|\.tokens)\.json$/i.test(n))) add(f, "tokens-json", tokenJsonVars(read(f) || ""), 20, "design-token JSON");
  out.sort((a, b) => b.score - a.score);
  // Logos/fonts next to each candidate's repo.
  for (const c of out.slice(0, 8)) {
    Object.assign(c, logosNear(root, path.join(root, c.repo === c.file ? "." : c.repo)));
    const sibling = walk(path.join(root, c.repo), (n) => /\.(css|html)$/i.test(n), 4).slice(0, 60);
    c.googleFonts = googleFonts([path.join(root, c.file), ...sibling]);
  }
  return out;
}

// ------------------------------------------------------------------ mapping onto the contract

const PICK = {
  paper: [/^(color-)?(paper|bg|background|page-?bg|bg-?page|canvas|surface-?page|base-?100|white)$/i, /(paper|background|bg)(?!.*(dark|inverse))/i],
  "paper-2": [/(paper|bg|background|surface)-?(2|alt|subtle|muted|secondary|100|50)$/i],
  ink: [/^(color-)?(ink|text|fg|foreground|body|text-?primary|base-?content|gray-?900|slate-?900|neutral-?900)$/i, /(ink|text|foreground)(?!.*(muted|soft|light|inverse|on))/i],
  "ink-soft": [/(ink|text|fg)-?(soft|muted|secondary|subtle)$/i, /(gray|slate|neutral)-?(600|700)$/i],
  "ink-faint": [/(ink|text|fg)-?(faint|tertiary|disabled|placeholder)$/i, /(gray|slate|neutral)-?(400|500)$/i],
  line: [/^(color-)?(line|border|divider|stroke|hairline)$/i, /(border|line|divider)(?!.*(dark|strong))/i],
  "brand-900": [/(brand|primary|navy|indigo|blue)-?(900|950|darkest|deep)$/i, /(brand|primary)-?(dark|darker)$/i],
  "brand-800": [/^(color-)?(brand|primary)(-?(default|base|main|500|600|700|800))?$/i, /(navy|indigo|primary|brand)-?800$/i],
  "brand-700": [/(brand|primary|navy|indigo|blue)-?(600|700|light)$/i, /^(color-)?link$/i],
  "brand-line": [/(brand|primary|navy|indigo|dark)-?(line|border)$/i, /^border-?dark$/i],
  "on-brand": [/^(text-)?on-?(brand|primary|navy|dark|inverse)$/i],
  "on-brand-soft": [/^(text-)?on-?(brand|primary|navy|dark|inverse)-?(soft|muted|secondary)$/i],
  ok: [/(success|positive|green|ok|valid)(-?(500|600|default|base))?$/i],
  risk: [/(danger|error|risk|red|destructive|negative|critical)(-?(500|600|default|base))?$/i],
  warn: [/(warning|warn|amber|yellow|caution)(-?(500|600|default|base))?$/i],
  "font-body": [/font-?(body|sans|base|text|primary|family-?base)$/i, /^font(-?family)?$/i],
  "font-display": [/font-?(display|heading|headline|title|serif)$/i],
  "font-mono": [/font-?(mono|code|monospace)$/i],
  r: [/^(radius|r|rounded|border-?radius)(-?(md|base|default))?$/i],
  "r-sm": [/(radius|rounded|r)-?(sm|small)$/i],
  "r-lg": [/(radius|rounded|r)-?(lg|large|xl)$/i],
};

export function mapToContract(vars) {
  const chosen = {};
  const used = new Set();
  for (const [token, patterns] of Object.entries(PICK)) {
    const isColor = !/^(font-|r$|r-)/.test(token);
    for (const re of patterns) {
      const name = Object.keys(vars).find((k) => re.test(k) && !used.has(k) && (isColor ? !!parseColor(resolved(vars, vars[k])) : !parseColor(resolved(vars, vars[k]))));
      if (name) { chosen[token] = name; used.add(name); break; }
    }
  }
  // Status colors not named as such (e.g. a green called "--accent"): pick by hue.
  const hue = (c) => { const [r, g, b] = c.map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return -1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  for (const [token, lo, hi] of [["ok", 95, 165], ["risk", 345, 375], ["warn", 25, 55]]) {
    if (chosen[token]) continue;
    const cand = Object.keys(vars).map((k) => [k, parseColor(resolved(vars, vars[k]))])
      .filter(([k, c]) => c && !used.has(k) && !/soft|light|bg|tint|surface|50$|100$|200$|300$/i.test(k) && saturation(c) > 0.45)
      .filter(([, c]) => { const h = hue(c); return h >= lo % 360 && h <= hi % 360 || (hi > 360 && (h >= lo || h <= hi - 360)); })
      // ok is the bright dot color (its dark text shade is derived); red/amber: the most saturated.
      .sort((a, b) => (token === "ok" ? luminance(b[1]) - luminance(a[1]) : saturation(b[1]) - saturation(a[1])))[0];
    if (cand) { chosen[token] = cand[0]; used.add(cand[0]); }
  }
  // No brand color by name: the most saturated dark-ish color.
  if (!chosen["brand-800"]) {
    const cand = Object.keys(vars).map((k) => [k, parseColor(resolved(vars, vars[k]))]).filter(([, c]) => c && saturation(c) > 0.35 && luminance(c) < 0.3)
      .sort((a, b) => saturation(b[1]) - saturation(a[1]))[0];
    if (cand) chosen["brand-800"] = cand[0];
  }
  return chosen;
}

/** The theme.css body and a contrast report, for a chosen mapping. `ref(name)` writes the value. */
export function themeCss(vars, chosen, ref) {
  const lines = [];
  const val = (token) => (chosen[token] ? parseColor(resolved(vars, vars[chosen[token]])) : null);
  const derived = {};
  const brand = val("brand-800");
  if (brand) {
    if (!chosen["brand-900"]) derived["brand-900"] = hex(mix(brand, [0, 0, 0], 0.45));
    if (!chosen["brand-700"]) derived["brand-700"] = hex(mix(brand, [255, 255, 255], 0.15));
    const dark = chosen["brand-900"] ? val("brand-900") : parseColor(derived["brand-900"]);
    derived["brand-line"] = hex(mix(dark, [255, 255, 255], 0.14));
    derived["on-brand"] = luminance(dark) < 0.4 ? "#F8FAFC" : "#0F172A";
    derived["on-brand-soft"] = hex(mix(dark, parseColor(derived["on-brand"]), 0.62));
  }
  const ok = val("ok");
  if (ok) {
    // Readable on white (WCAG AA): darken until it passes.
    let strong = ok;
    for (let t = 0.05; contrast(strong, [255, 255, 255]) < 4.5 && t < 0.9; t += 0.05) strong = mix(ok, [0, 0, 0], t);
    derived["ok-strong"] = hex(strong);
    derived["ok-soft"] = hex(mix(ok, [255, 255, 255], 0.88));
  }
  for (const token of Object.keys(PICK)) {
    // Same name as the contract's token: the imported file already sets it (and
    // `--x: var(--x)` would be a cycle, which CSS treats as invalid).
    if (chosen[token] === token && ref(token) === `var(--${token})`) continue;
    if (chosen[token]) lines.push(`  --${token}: ${ref(chosen[token])};`);
    else if (derived[token]) lines.push(`  --${token}: ${derived[token]}; /* derived */`);
  }
  for (const token of ["brand-line", "on-brand", "on-brand-soft", "ok-strong", "ok-soft"]) {
    if (derived[token] && !lines.some((l) => l.includes(`--${token}:`))) lines.push(`  --${token}: ${derived[token]}; /* derived */`);
  }

  const color = (token) => val(token) || parseColor(derived[token]);
  const checks = [];
  const check = (label, fg, bg, min) => {
    if (!fg || !bg) return checks.push({ label, ratio: null, ok: null, note: "not set: the neutral default applies" });
    const r = contrast(fg, bg);
    checks.push({ label, ratio: Math.round(r * 100) / 100, ok: r >= min, min });
  };
  const white = [255, 255, 255];
  check("text (ink) on page (paper)", color("ink"), color("paper") || parseColor("#F8FAFC"), 4.5);
  check("muted text on page", color("ink-soft"), color("paper") || parseColor("#F8FAFC"), 4.5);
  check("sidebar text (on-brand) on sidebar (brand-900)", color("on-brand"), color("brand-900"), 4.5);
  check("button text (white) on primary (brand-800)", white, color("brand-800"), 4.5);
  check("ok-strong text on white", color("ok-strong"), white, 4.5);
  check("risk text on white", color("risk"), white, 4.5);
  const unmapped = Object.keys(PICK).filter((t) => !chosen[t] && !derived[t]);
  return { body: lines.join("\n"), checks, unmapped };
}

// ------------------------------------------------------------------ apply

function apply(root, pick, opts) {
  const cands = brandCandidates(root);
  const cand = /^\d+$/.test(pick) ? cands[Number(pick)] : cands.find((c) => c.file === pick) || (fs.existsSync(path.resolve(root, pick)) ? { file: path.relative(root, path.resolve(root, pick)).split(path.sep).join("/"), kind: /\.scss$/.test(pick) ? "scss" : /tailwind/.test(pick) ? "tailwind" : /\.json$/.test(pick) ? "tokens-json" : "css", logos: [], favicons: [], googleFonts: [] } : null);
  if (!cand) { console.error(`No candidate "${pick}". Run without --apply to list them.`); process.exit(1); }
  const src = path.join(root, cand.file);
  const text = read(src) || "";
  const brandDir = path.join(root, ".claude", "dashboard", "brand");
  const files = [];
  let vars, imports = [], ref;

  if (cand.kind === "css") {
    const bundle = (cand.bundle || [cand.file]).map((f) => path.join(root, f));
    vars = Object.assign({}, ...bundle.map((f) => cssVars(read(f) || "")));
    // Copy them verbatim (fonts first: web-font @imports must lead), plus relative files they @import.
    bundle.sort((a, b) => (/font/i.test(path.basename(b)) ? 1 : 0) - (/font/i.test(path.basename(a)) ? 1 : 0));
    const toCopy = [...bundle];
    for (const m of text.matchAll(/@import\s+(?:url\()?["']([^"')]+)["']\)?/g)) {
      if (!/^https?:/.test(m[1])) {
        const p = path.resolve(path.dirname(src), m[1]);
        if (fs.existsSync(p)) { toCopy.push(p); Object.assign(vars, cssVars(read(p) || ""), vars); }
      }
    }
    const tokenFiles = toCopy.filter((p) => tokensOnly(read(p) || ""));
    if (tokenFiles.length === toCopy.length) {
      // Pure token files: copy them verbatim.
      for (const p of toCopy) files.push({ from: p, to: path.join(brandDir, path.basename(p)) });
      imports = bundle.map((f) => path.basename(f));
    } else {
      // A site's own stylesheet also styles body, links, buttons…: never load that into the
      // dashboard. Take only its variables, into a tokens file of our own.
      const lines = Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join("\n");
      files.push({ text: `/* Variables extracted from ${cand.file} (the rest of that stylesheet styles the site, not the dashboard). */\n:root {\n${lines}\n}\n`, to: path.join(brandDir, "brand-tokens.css") });
      imports = ["brand-tokens.css"];
    }
    ref = (name) => `var(--${name})`;
  } else {
    vars = cand.kind === "scss" ? scssVars(text) : cand.kind === "tailwind" ? tailwindVars(text) : tokenJsonVars(text);
    // SCSS $vars can reference each other; resolve simple ones.
    for (const k of Object.keys(vars)) { const m = /^\$([\w-]+)$/.exec(vars[k]); if (m && vars[m[1]]) vars[k] = vars[m[1]]; }
    ref = (name) => resolved(vars, vars[name]);
  }

  const chosen = mapToContract(vars);
  const { body, checks, unmapped } = themeCss(vars, chosen, ref);
  // Web fonts the source site loads from Google Fonts (icon fonts aside).
  const google = (cand.googleFonts || []).filter((f) => !/icon|symbol/i.test(f));
  const fonts = google.length
    ? `@import url("https://fonts.googleapis.com/css2?${google.map((f) => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700;800`).join("&")}&display=swap");\n`
    : "";
  // Fonts the mapping uses that nothing here loads: say so rather than silently falling back.
  const SYSTEM = /^(system-ui|-apple-system|ui-\w+|sans-serif|serif|monospace|arial|helvetica|georgia|times|segoe ui|roboto|menlo|consolas|courier)/i;
  const unloaded = ["font-body", "font-display", "font-mono"].map((t) => chosen[t] && String(resolved(vars, vars[chosen[t]]) || "").split(",")[0].replace(/["']/g, "").trim())
    .filter((f) => f && !SYSTEM.test(f) && !google.includes(f));
  const fontNote = unloaded.length
    ? `/* Fonts used below but not loaded here: ${[...new Set(unloaded)].join(", ")}. Add a Google Fonts @import above, or copy the font files into brand/ and @font-face them; otherwise the next font in each stack shows. */\n`
    : "";
  const theme = `/* ============================================================
   Brand for the workspace dashboard (served at /ds/theme.css).
   Source: ${cand.file} (${cand.why || cand.kind}).
   DRAFT from extract-brand.mjs: the token names below are the dashboard's
   contract (web/public/ds/tokens.css in the engine); values were matched by
   variable name. Check them, then fix anything the contrast report flagged.
   Tokens not set here keep their neutral default.
   @import must come before any rule.
   ============================================================ */
${fonts}${imports.map((f) => `@import url("${f}");`).join("\n")}
${fontNote}
:root {
${body}
}
`;

  const logo = opts.logo || (cand.logos || [])[0] || null;
  const favicon = opts.favicon || (cand.favicons || [])[0] || null;
  const report = { source: cand.file, kind: cand.kind, mapped: chosen, unmapped, contrast: checks, logo, favicon, wrote: [] };
  if (opts.dry) { report.themeCss = theme; console.log(JSON.stringify(report, null, 2)); return; }

  fs.mkdirSync(brandDir, { recursive: true });
  for (const f of files) { if (f.text) fs.writeFileSync(f.to, f.text); else fs.copyFileSync(f.from, f.to); report.wrote.push(path.relative(root, f.to)); }
  fs.writeFileSync(path.join(brandDir, "theme.css"), theme);
  report.wrote.push(path.relative(root, path.join(brandDir, "theme.css")));
  const brandCfg = {};
  for (const [key, file] of [["logo", logo], ["favicon", favicon]]) {
    if (!file) continue;
    const from = path.resolve(root, file);
    if (!fs.existsSync(from)) continue;
    const name = `${key}${path.extname(from).toLowerCase()}`;
    fs.copyFileSync(from, path.join(brandDir, name));
    brandCfg[key] = name;
    report.wrote.push(path.relative(root, path.join(brandDir, name)));
  }
  const wsFile = path.join(root, ".claude", "dashboard", "workspace.json");
  let ws = {};
  try { ws = JSON.parse(fs.readFileSync(wsFile, "utf-8")); } catch {}
  ws.brand = { ...(ws.brand || {}), ...brandCfg };
  fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2) + "\n");
  report.wrote.push(path.relative(root, wsFile) + " (brand)");
  console.log(JSON.stringify(report, null, 2));
}

// ------------------------------------------------------------------ main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((a) => !a.startsWith("--")) || process.cwd());
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i !== -1 ? args[i + 1] : undefined; };
  if (args.includes("--apply")) apply(root, opt("apply"), { logo: opt("logo"), favicon: opt("favicon"), dry: args.includes("--dry") });
  else console.log(JSON.stringify(brandCandidates(root), null, 2));
}
