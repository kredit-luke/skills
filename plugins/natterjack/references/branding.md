# Branding the dashboard

The dashboard's look comes from CSS custom properties in two layers:

1. `dashboard/web/public/ds/tokens.css` (served at `/ds/tokens.css`): the **contract**, every brand-level token the pages use, with neutral defaults (slate + indigo, system fonts).
2. `.claude/dashboard/brand/theme.css` (served at `/ds/theme.css`, after it): the team's brand. It `@import`s their token files (copied verbatim into `brand/`) and sets contract tokens from them. Anything it doesn't set keeps the neutral default, so a partial mapping still looks fine.

The pages never name a brand color; `styles.scss` maps the contract onto the dashboard's own vocabulary (`--bg`, `--text`, `--green`, `--purple` for primary actions, …). Don't edit the engine's CSS to brand it.

## The contract

| Token | Used for | Must |
|---|---|---|
| `--paper`, `--paper-2`, `--paper-3` | page, raised and deeper surfaces | light |
| `--ink`, `--ink-soft`, `--ink-faint` | text: primary, secondary, captions | ink on paper ≥ 4.5:1, ink-soft ≥ 4.5:1 |
| `--line`, `--line-soft` | borders, dividers | |
| `--link` | links | |
| `--brand-900` | the sidebar background | dark |
| `--brand-800` | primary buttons, selected states | white text on it ≥ 4.5:1 |
| `--brand-700` | accents, secondary emphasis | |
| `--brand-line` | borders on the sidebar | |
| `--on-brand`, `--on-brand-soft` | sidebar text: primary, secondary | on brand-900 ≥ 4.5:1 (soft ≥ 3:1) |
| `--ok`, `--ok-strong`, `--ok-soft` | success: dots/decoration, text on light (≥ 4.5:1 on white), tint | |
| `--risk`, `--warn` | error, warning | risk text on white ≥ 4.5:1 |
| `--font-body`, `--font-display`, `--font-mono` | body, headings, labels/code | |
| `--ls-display` | heading letter-spacing | |
| `--r`, `--r-sm`, `--r-lg`, `--r-pill` | corner radii | |
| `--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`, `--shadow-btn`, `--shadow-btn-hover`, `--ring` | depth, focus ring | |
| `--ease`, `--dur`, `--dur-fast` | motion | |

## Choosing the source

`extract-brand.mjs <workspace>` ranks candidates. In order of preference:
1. **A design-system bundle**: a folder of token stylesheets (`tokens/`, `ds/`, `design-system/`) or design-token JSON. Only files that just declare variables are taken (a reset or component sheet would restyle the dashboard).
2. **The brand / marketing site's stylesheet** with a `:root` block of custom properties. Prefer it over a product app's: product apps often carry a framework theme (Material, Bootstrap) that isn't the brand.
3. SCSS variables, a Tailwind theme (values are written out as plain CSS variables, since there's nothing to import).

Show the user the top 2-3 (file, colors/fonts counts, a few sample colors) when it isn't obvious. No candidate at all: skip branding (the neutral theme is fine), but still ask for a logo.

## Applying and checking

`extract-brand.mjs <workspace> --apply <n> [--logo <file>] [--favicon <file>]` copies the files, writes a draft `theme.css`, copies the logo and favicon into `brand/`, sets `workspace.json` `brand`, and prints a contrast report. Then:

- **Read theme.css.** Mappings are by variable name, with a hue fallback for success/error/warning. Check each line makes sense (a "brand" that's actually a background tint, a mono font mapped to body…). Values marked `/* derived */` were computed (sidebar border and text from the brand's darkest shade, `ok-strong` darkened until it passes contrast).
- **Every contrast line must pass.** If one fails, map that token to a different source variable, or set a literal value that passes.
- **Fonts**: web fonts load through `@import` at the top of theme.css (Google Fonts URLs are added when the source site uses them). If the brand's fonts are self-hosted, copy the font files into `brand/` and `@font-face` them there.
- **Logo**: the sidebar is dark (`--brand-900`), so use the light/white/inverse version; SVG or PNG around 24px tall displays well. No light version? Ask the user for one, or leave `logo` unset (the workspace name shows as text in the brand font).
- Look at it: Home, a Run, Links, Machine. Reload is enough after editing brand files.
