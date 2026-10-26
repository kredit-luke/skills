/** Past this many lines or characters a message is shown folded, with "Show all". */
export const LONG_LINES = 15;
export const LONG_CHARS = 2000;
/** How much of a folded message is rendered: enough to fill the fold, not a whole pasted page. */
export const FOLDED_CHARS = 4000;

/** "340 lines" or "52,000 characters" for a long text; null when it's short enough to show whole. */
export function longTextSize(text: string): string | null {
  const lines = text.split('\n').length;
  if (lines > LONG_LINES) return `${lines.toLocaleString('en-US')} lines`;
  if (text.length > LONG_CHARS) return `${text.length.toLocaleString('en-US')} characters`;
  return null;
}
