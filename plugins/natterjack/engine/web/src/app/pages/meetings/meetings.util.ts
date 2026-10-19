import type { ActionItem, Meeting, MeetingDetail, MeetingTicket } from '../../../../../shared/api';

/** Pure helpers for the Meetings page. */

/**
 * The list after another page arrives: newest data wins for a meeting already shown (it stays
 * where it was), new ones are appended. Pages can overlap when a meeting starts mid-scroll.
 */
export function mergePages(shown: Meeting[], page: Meeting[]): Meeting[] {
  const incoming = new Map(page.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: Meeting[] = [];
  for (const m of shown) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(incoming.get(m.id) || m);
  }
  for (const m of page) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayStart(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

/** "Today", "Yesterday", "Mon 13 Oct", or "13 Oct 2025" outside this year (local time). '' for a bad date. */
export function dateLabel(iso: string | null | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (d.getFullYear() !== now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "09:05" (local time). '' for a bad date. */
export function timeLabel(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Open and total action items; null when the tool didn't send any. */
export function actionCounts(items: ActionItem[] | null | undefined): { open: number; total: number } | null {
  if (!items) return null;
  return { open: items.filter((i) => !i.complete).length, total: items.length };
}

/**
 * The summary as one line of plain text for the list: headings dropped, list markers, emphasis,
 * code ticks and link targets stripped, whitespace collapsed, cut at a word near `max`.
 */
export function summaryPreview(md: string | null | undefined, max = 160): string {
  if (!md) return '';
  const text = md.split(/\r?\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').replace(/^\s*>\s?/, ''))
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|\*|~~|`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

/** How many participants weren't listed: a number when the count says, 'more' when it doesn't, null when none were left out. */
export function moreParticipants(d: Pick<MeetingDetail, 'participants' | 'participantsOmitted' | 'participantCount'>): number | 'more' | null {
  if (!d.participantsOmitted) return null;
  const n = d.participantCount - d.participants.length;
  return n > 0 ? n : 'more';
}

/** A failed call that means the stored token is gone or no longer works: show the connect panel again. */
export function isNotConnected(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 401;
}

/** A failed call's HTTP status, when it had one. */
export function statusOf(e: unknown): number | undefined {
  return (e as { status?: number } | null)?.status;
}

/** Only an https: address is opened or linked (a share link from the tool, say). */
export function isHttpsUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https:\/\//i.test(url);
}

/**
 * A list row's tickets: the first `max` to show as links, how many more, every key as text for
 * the tooltip ("Tickets: ENG-1, ENG-2, ENG-3"), and what the "(+N)" says to a screen reader
 * ("2 more tickets: ENG-2, ENG-3"; '' when there are no more).
 */
export interface TicketSummary { shown: MeetingTicket[]; more: number; text: string; moreText: string }

/** The tickets made from a meeting, for its list row; null when there are none. */
export function ticketSummary(tickets: MeetingTicket[] | null | undefined, max = 3): TicketSummary | null {
  if (!tickets?.length) return null;
  const n = Math.max(1, max);
  const shown = tickets.slice(0, n);
  const rest = tickets.slice(n);
  const more = rest.length;
  return {
    shown, more,
    text: 'Tickets: ' + tickets.map((t) => t.key).join(', '),
    moreText: more ? `${more} more ${more === 1 ? 'ticket' : 'tickets'}: ${rest.map((t) => t.key).join(', ')}` : '',
  };
}

/**
 * What the meeting detail's status line says. A refresh in flight says so (Loading when there's
 * nothing shown yet); otherwise it matches what's on screen: the "isn't there any more" panel
 * wins over an error, because the panel is what shows.
 */
export function detailLiveText(s: { refreshing: boolean; missing: boolean; error: string | null; hasDetail: boolean; label: string }): string {
  if (s.refreshing) return s.hasDetail ? 'Refreshing meeting…' : 'Loading meeting…';
  if (s.missing) return `This meeting isn't in ${s.label} any more, or you can't see it.`;
  if (s.error) return s.error;
  return s.hasDetail ? 'Meeting loaded' : 'Loading meeting…';
}
