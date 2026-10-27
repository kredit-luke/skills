import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import type { GuidePoint, ReviewDiff, ReviewGuide, ReviewPrDetail, SecurityReview } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { type HunkGroup, groupHunks, hunkLabel, noHunkLabel, progressKey } from './review-guide.util';

/** The guide's chapters, in reading order; each can be ticked off as read. */
const CHAPTERS = ['intent', 'core', 'consequences', 'supporting', 'risk', 'security', 'questions'] as const;
type Chapter = typeof CHAPTERS[number];

/**
 * Guided review of one pull request: the guide on the left (why it exists, the core change,
 * its consequences, the glue, risks, a security review, what to check) and the diff on the
 * right, grouped by what each hunk is for rather than by file. Links in the guide jump to their
 * hunks. Ticked chapters are kept in this browser per commit, so a long review can be resumed.
 */
@Component({
  selector: 'dash-review-guide',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <button class="btn ghost sm" type="button" (click)="back.emit()">← Back to list</button>
      <div class="ttl">
        <h2>{{ detail()?.title || repo() + '#' + number() }}</h2>
        <div class="sub">
          <span class="mono">{{ repo() }}#{{ number() }}</span>
          @if (detail(); as d) { · {{ d.author || 'unknown' }} · <span class="add">+{{ d.additions }}</span> <span class="del">−{{ d.deletions }}</span> in {{ d.changedFiles }} {{ d.changedFiles === 1 ? 'file' : 'files' }} }
          @if (guide()?.minutes; as m) { · about {{ m }} min to review }
          @if (guide()) { · {{ doneCount() }}/{{ chapters.length }} chapters read }
        </div>
      </div>
      @if (detail(); as d) { <a class="btn sm" [href]="d.url" target="_blank" rel="noopener">Open on GitHub</a> }
    </div>

    <div class="split">
      <aside class="panel guide" aria-label="Guide">
        @if (guideErr()) {
          <div class="pad"><div class="err-note">{{ guideErr() }}</div><button class="btn sm" type="button" (click)="makeGuide(false)">Try again</button></div>
        } @else if (makingGuide()) {
          <div class="pad faint">Reading the pull request and writing the guide… this takes up to a minute.</div>
        } @else if (!guide()) {
          <div class="pad">
            <p>A guide reads the pull request in order: what it's for, the core change, what it affects, the glue, risks and what to check. It's made with Claude (Sonnet) from the PR, its ticket and its diff, and kept for this commit.</p>
            <button class="btn primary sm" type="button" (click)="makeGuide(false)" [disabled]="!diff()">Write the guide</button>
          </div>
        } @else {
          @let g = guide()!;
          <section [class.done]="done()['intent']">
            <h3><input type="checkbox" [checked]="done()['intent']" (change)="tick('intent')" aria-label="Mark Intent as read" />1 · Intent</h3>
            @if (g.ticket; as t) { <p class="tkt"><a [href]="t.url" target="_blank" rel="noopener">{{ t.id }}</a> {{ t.title }}</p> }
            <p>{{ g.intent || 'The guide says nothing about intent.' }}</p>
          </section>
          @for (c of pointChapters; track c.id; let i = $index) {
            <section [class.done]="done()[c.id]">
              <h3><input type="checkbox" [checked]="done()[c.id]" (change)="tick(c.id)" [attr.aria-label]="'Mark ' + c.label + ' as read'" />{{ i + 2 }} · {{ c.label }}</h3>
              @let pts = pointsOf(c.id);
              @if (!pts.length) { <p class="faint">{{ c.empty }}</p> }
              @for (p of pts; track $index) {
                <div class="pt">
                  <b>{{ p.title }}</b>
                  <p>{{ p.text }}</p>
                  @if (p.hunks.length) {
                    <div class="links">@for (h of p.hunks; track h) { <button class="hl" type="button" (click)="jump(h)">{{ label(h) }}</button> }</div>
                  }
                </div>
              }
              @if (c.id === 'risk' && detail(); as d) {
                <p class="checks">Checks: <b [class]="d.checks">{{ d.checks }}</b>@if (d.failingChecks.length) { ({{ d.failingChecks.join(', ') }})}
                  · Review: <b>{{ d.decision ? d.decision.replace('_', ' ').toLowerCase() : 'none yet' }}</b></p>
              }
            </section>
          }
          <section [class.done]="done()['security']">
            <h3><input type="checkbox" [checked]="done()['security']" (change)="tick('security')" aria-label="Mark Security as read" />6 · Security</h3>
            @if (secErr()) { <div class="err-note">{{ secErr() }}</div> }
            @if (makingSec()) { <p class="faint">Reviewing the diff for security problems…</p> }
            @else if (security(); as s) {
              <p>{{ s.summary }}</p>
              @for (f of s.findings; track $index) {
                <div class="pt">
                  <b><span class="sev" [class]="f.severity">{{ f.severity }}</span> {{ f.title }}</b>
                  <p>{{ f.text }}</p>
                  @if (f.hunks.length) { <div class="links">@for (h of f.hunks; track h) { <button class="hl" type="button" (click)="jump(h)">{{ label(h) }}</button> }</div> }
                </div>
              }
              <button class="linkish" type="button" (click)="makeSecurity(true)">Review again</button>
            } @else {
              <p class="faint">An agent reads the diff for injection, auth mistakes, secrets, unsafe input handling and risky dependency changes.</p>
              <button class="btn sm" type="button" (click)="makeSecurity(false)">Run a security review</button>
            }
          </section>
          <section [class.done]="done()['questions']">
            <h3><input type="checkbox" [checked]="done()['questions']" (change)="tick('questions')" aria-label="Mark What to look at as read" />7 · What to look at</h3>
            @if (!g.questions.length) { <p class="faint">No specific questions.</p> }
            <ol>@for (q of g.questions; track $index) { <li>{{ q }}</li> }</ol>
          </section>
          <div class="pad foot"><button class="linkish" type="button" (click)="makeGuide(true)">Write the guide again</button></div>
        }
      </aside>

      <section class="diff" aria-label="Diff">
        @if (diffErr()) { <div class="err-note">{{ diffErr() }}</div> }
        @else if (!diff()) { <div class="panel empty">Loading the diff…</div> }
        @else {
          @if (diff()!.truncated) { <div class="warn-note">This diff is too big to show all of it here. Open it on GitHub for the rest.</div> }
          @for (g of groups(); track g.tag) {
            <details class="grp panel" [open]="g.open">
              <summary><b>{{ g.label }}</b> <span class="faint">{{ g.hunks.length }} {{ g.hunks.length === 1 ? 'hunk' : 'hunks' }}</span></summary>
              @for (p of g.hunks; track p.hunk.id) {
                <div class="hunk" [id]="'hunk-' + p.hunk.id" [class.lit]="lit() === p.hunk.id">
                  <div class="fh"><span class="mono">{{ p.file.path }}</span>@if (p.file.status !== 'modified') { <span class="tag">{{ p.file.status }}</span> }<span class="hh mono">{{ p.hunk.header }}</span></div>
                  <table class="code"><tbody>
                    @for (l of p.hunk.lines; track $index) {
                      <tr [class.ad]="l.t === '+'" [class.rm]="l.t === '-'"><td class="n">{{ l.old ?? '' }}</td><td class="n">{{ l.new ?? '' }}</td><td class="t">{{ l.t === ' ' ? ' ' : l.t }}{{ l.text }}</td></tr>
                    }
                  </tbody></table>
                </div>
              }
            </details>
          }
          @for (f of noHunkFiles(); track f.path) {
            <div class="panel pad faint"><span class="mono">{{ f.oldPath ? f.oldPath + ' → ' + f.path : f.path }}</span>: {{ noHunkLabel(f) }}</div>
          }
        }
      </section>
    </div>
  `,
  styles: [`
    .head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
    .ttl { flex: 1; min-width: 0; }
    h2 { margin: 0; font-size: 17px; line-height: 1.35; overflow-wrap: anywhere; }
    .sub { margin-top: 4px; font-size: 12px; color: var(--ink-faint); }
    .mono { font-family: var(--font-mono); }
    .add { color: var(--green); } .del { color: var(--red); }
    .split { display: grid; grid-template-columns: minmax(300px, 420px) minmax(0, 1fr); gap: 16px; align-items: start; }
    @media (max-width: 1000px) { .split { grid-template-columns: minmax(0, 1fr); } }
    .guide { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto; }
    @media (max-width: 1000px) { .guide { position: static; max-height: none; } }
    .guide section { padding: 12px 16px; border-top: 1px solid var(--line-soft); }
    .guide section:first-child { border-top: 0; }
    .guide section.done { opacity: .6; }
    h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-faint); font-weight: 600; }
    .guide p { margin: 0 0 6px; font-size: 13px; line-height: 1.5; color: var(--ink); }
    .pt { margin: 0 0 10px; }
    .pt b { font-size: 13px; }
    .tkt a { font-family: var(--font-mono); }
    .links { display: flex; flex-wrap: wrap; gap: 6px; }
    .hl { font-family: var(--font-mono); font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--line); background: #fff; color: var(--brand-700); cursor: pointer; }
    .hl:hover { background: var(--paper-2); }
    .sev { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; background: var(--paper-2); }
    .sev.critical, .sev.high { background: var(--red-bg); color: var(--red); }
    .sev.medium { background: var(--yellow-bg); color: var(--yellow); }
    .checks b.failing { color: var(--red); } .checks b.passing { color: var(--green); }
    ol { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.5; }
    .pad { padding: 14px 16px; }
    .pad p { font-size: 13px; line-height: 1.5; margin: 0 0 10px; }
    .foot { border-top: 1px solid var(--line-soft); }
    .faint { color: var(--ink-faint); }
    .diff { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
    .grp > summary { padding: 10px 14px; cursor: pointer; font-size: 13px; }
    .grp > summary .faint { margin-left: 6px; }
    .hunk { border-top: 1px solid var(--line-soft); scroll-margin-top: 12px; }
    .hunk.lit { box-shadow: inset 3px 0 0 var(--brand-700); }
    .fh { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 12px; background: var(--paper-2); font-size: 12px; }
    .hh { color: var(--ink-faint); font-size: 11px; overflow-wrap: anywhere; }
    .code { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; table-layout: fixed; }
    .code td { padding: 0 8px; vertical-align: top; }
    .code .n { width: 44px; text-align: right; color: var(--ink-faint); user-select: none; }
    .code .t { white-space: pre-wrap; overflow-wrap: anywhere; }
    .code tr.ad { background: var(--green-bg); }
    .code tr.rm { background: var(--red-bg); }
  `],
})
export class ReviewGuideComponent {
  private readonly api = inject(ApiService);
  readonly repo = input.required<string>();
  readonly number = input.required<number>();
  readonly back = output<void>();

  readonly chapters = CHAPTERS;
  readonly pointChapters: { id: Chapter & keyof ReviewGuide; label: string; empty: string }[] = [
    { id: 'core', label: 'Core change', empty: 'The guide found no single core change.' },
    { id: 'consequences', label: 'Consequences', empty: 'Nothing beyond the change itself, as far as the diff shows.' },
    { id: 'supporting', label: 'Supporting', empty: 'No glue worth calling out.' },
    { id: 'risk', label: 'Risk & verification', empty: 'No specific risks.' },
  ];

  readonly detail = signal<ReviewPrDetail | null>(null);
  readonly diff = signal<ReviewDiff | null>(null);
  readonly diffErr = signal<string | null>(null);
  readonly guide = signal<ReviewGuide | null>(null);
  readonly guideErr = signal<string | null>(null);
  readonly makingGuide = signal(false);
  readonly security = signal<SecurityReview | null>(null);
  readonly secErr = signal<string | null>(null);
  readonly makingSec = signal(false);
  readonly done = signal<Record<string, boolean>>({});
  readonly lit = signal<string | null>(null);
  private gen = 0;

  readonly groups = computed<HunkGroup[]>(() => groupHunks(this.diff()?.files || [], this.guide()));
  /** Files with no lines to show: binary ones, pure renames, and empty files added or deleted. */
  readonly noHunkFiles = computed(() => (this.diff()?.files || []).filter((f) => f.binary || !f.hunks.length));
  readonly doneCount = computed(() => CHAPTERS.filter((c) => this.done()[c]).length);

  constructor() {
    effect(() => { this.load(this.repo(), this.number()); });
  }

  pointsOf(id: keyof ReviewGuide): GuidePoint[] { return (this.guide()?.[id] as GuidePoint[]) || []; }
  label(id: string): string { return hunkLabel(this.diff()?.files || [], id); }
  noHunkLabel = noHunkLabel;

  private async load(repo: string, n: number): Promise<void> {
    const gen = ++this.gen;
    for (const s of [this.detail, this.diff, this.guide, this.security]) (s as any).set(null);
    this.diffErr.set(null); this.guideErr.set(null); this.secErr.set(null); this.done.set({});
    const q = `repo=${encodeURIComponent(repo)}&number=${n}`;
    this.api.get<ReviewPrDetail>(`/api/reviews/pr?${q}`).then((d) => { if (gen === this.gen) { this.detail.set(d); this.loadProgress(d.sha); } }).catch(() => {});
    this.api.get<ReviewGuide | null>(`/api/reviews/guide?${q}`).then((g) => { if (gen === this.gen && g) this.guide.set(g); }).catch(() => {});
    this.api.get<SecurityReview | null>(`/api/reviews/security?${q}`).then((s) => { if (gen === this.gen && s) this.security.set(s); }).catch(() => {});
    try {
      const d = await this.api.get<ReviewDiff>(`/api/reviews/diff?${q}`);
      if (gen === this.gen) this.diff.set(d);
    } catch (e) { if (gen === this.gen) this.diffErr.set((e as Error).message); }
  }

  async makeGuide(force: boolean): Promise<void> {
    const gen = this.gen;
    this.makingGuide.set(true);
    this.guideErr.set(null);
    try {
      const g = await this.api.post<ReviewGuide>('/api/reviews/guide', { repo: this.repo(), number: this.number(), force });
      if (gen === this.gen) this.guide.set(g);
    } catch (e) { if (gen === this.gen) this.guideErr.set((e as Error).message); }
    finally { if (gen === this.gen) this.makingGuide.set(false); }
  }

  async makeSecurity(force: boolean): Promise<void> {
    const gen = this.gen;
    this.makingSec.set(true);
    this.secErr.set(null);
    try {
      const s = await this.api.post<SecurityReview>('/api/reviews/security', { repo: this.repo(), number: this.number(), force });
      if (gen === this.gen) this.security.set(s);
    } catch (e) { if (gen === this.gen) this.secErr.set((e as Error).message); }
    finally { if (gen === this.gen) this.makingSec.set(false); }
  }

  /** Scroll the diff to a hunk (opening its group) and mark it for a moment. */
  jump(id: string): void {
    const el = document.getElementById('hunk-' + id);
    if (!el) return;
    const grp = el.closest('details');
    if (grp) grp.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.lit.set(id);
    setTimeout(() => { if (this.lit() === id) this.lit.set(null); }, 2500);
  }

  tick(c: string): void {
    this.done.update((d) => ({ ...d, [c]: !d[c] }));
    const sha = this.detail()?.sha;
    if (!sha) return;
    try { localStorage.setItem(progressKey(this.repo(), this.number(), sha), JSON.stringify(this.done())); } catch {}
  }

  private loadProgress(sha: string): void {
    try { this.done.set(JSON.parse(localStorage.getItem(progressKey(this.repo(), this.number(), sha)) || '{}') || {}); } catch { this.done.set({}); }
  }
}
