import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal, linkedSignal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { LaunchRequest, RunMeta, SearchResponse, SearchResult } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { defaultsFor } from '../../core/agents';
import { LaunchService } from '../../core/launch.service';
import { markTerms } from '../../core/markdown';
import { ToastService } from '../../core/toast.service';
import { TrustedHtmlPipe } from '../../core/trusted-html.pipe';
import { askPrompt } from '../../shared/ask-prompt';
import { SlashInputComponent } from '../../shared/slash-input.component';
import { AgentFieldsComponent } from '../../shared/agent-fields.component';
import { AttachComponent } from '../../shared/attach.component';
import { PageHeaderComponent } from '../../shared/page-header.component';
import { RunRowComponent } from '../../shared/run-row.component';

const DOCS_PREF = 'dash.ask.docs';
function readDocsPref(): string[] {
  try { const v = JSON.parse(localStorage.getItem(DOCS_PREF) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

/**
 * Ask: a question box that starts a run, in plan mode (read-only) by default. While
 * you type, a free local search shows the files Claude will be pointed at as starting points.
 */
@Component({
  selector: 'dash-ask',
  imports: [PageHeaderComponent, TrustedHtmlPipe, RunRowComponent, AttachComponent, SlashInputComponent, AgentFieldsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './ask.component.scss',
  template: `
    <dash-page-header eyebrow="Ask" title="Ask about the workspace" sub="Starts a run in the repo with the agent you pick. Plan mode (read-only) is on by default — turn it off below, or later from the run, if it should make changes." />
    <div class="ask-layout">
      <div class="col">
        <form class="panel ask-box" (submit)="$event.preventDefault(); submit()"
          (paste)="att.paste($event)" (dragover)="att.dragOver($event)" (drop)="att.drop($event)">
          <dash-slash-input [multiline]="true" [rows]="5" [value]="q()" (valueChange)="onInput($event)" (keys)="onKey($event)" [autofocus]="true"
            [placeholder]="api.copy('askPlaceholder', 'e.g. How does sign-in work, end to end? Where is the session timeout set?')" />
          <dash-attach #att />
          <div class="ask-opts">
            <label>Workspace
              <select (change)="ws.set($any($event.target).value)">
                @for (w of data.deck()?.workspaces || []; track w.slug) { <option [value]="w.slug" [selected]="w.slug === ws()">{{ w.name }}</option> }
              </select>
            </label>
            <dash-agent-fields [(agent)]="agent" [(modelId)]="model" [(effort)]="effort" />
            <label class="chk"><input type="checkbox" [checked]="useRefs()" (change)="useRefs.set($any($event.target).checked)"> Point it at the matches</label>
            <label class="chk" title="The agent can read and answer but not change anything until this is off.">
              <input type="checkbox" [checked]="planMode()" (change)="planMode.set($any($event.target).checked)"> Plan mode (read-only)
            </label>
            @for (s of docSources(); track s.key) {
              <label class="chk" [title]="'The agent searches ' + s.name + ' through its connector and cites the pages it uses'">
                <input type="checkbox" [checked]="useDocs().has(s.key)" (change)="toggleDocs(s.key, $any($event.target).checked)"> Use {{ s.name }}
              </label>
            }
            <span class="grow"></span>
            <span class="form-err">{{ error() }}</span>
            <button class="btn primary" type="submit" [disabled]="busy() || att.uploading() || !q().trim()">{{ busy() ? 'Starting…' : 'Ask' }}</button>
          </div>
          <div class="hint">Enter to ask · Shift+Enter for a new line. {{ planMode() ? 'Read-only: the agent can look things up but not change anything until you turn plan mode off.' : 'Plan mode is off: this run can make changes right away.' }}</div>
        </form>

        <div class="panel">
          <div class="panel-h"><h2>Starting points</h2><span class="ty">{{ results().length ? 'Top matches from the local search (free, no agent)' : '' }}</span></div>
          <div class="panel-b">
            @for (r of results(); track r.id) {
              <div class="sp-row">
                <span [class]="'src src-' + r.source">{{ r.sourceLabel }}</span>
                <div class="main"><div class="t" [innerHTML]="mark(r.title) | trustedHtml"></div>
                  <div class="s" [innerHTML]="mark(r.section ? '§ ' + r.section : r.snippet) | trustedHtml"></div></div>
              </div>
            } @empty { <div class="empty">{{ q().trim() ? 'No matches; the agent will search on its own.' : 'Type a question to see which docs, skills and memories match.' }}</div> }
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-h"><h2>Recent questions</h2></div>
        <div class="panel-b">
          @for (r of recentAsks(); track r.id) { <dash-run-row [run]="r" /> } @empty { <div class="empty">No questions asked yet.</div> }
        </div>
      </div>
    </div>
  `,
})
export class AskComponent implements OnInit {
  readonly data = inject(DataService);
  readonly api = inject(ApiService);
  private readonly launch = inject(LaunchService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly q = signal('');
  readonly ws = signal('main');
  // Start on the default model/effort (and follow it once deck.json loads); a change is for this question only.
  /** The agent picked last (or the workspace's), on its default model/effort; a change is for this question only. */
  readonly agent = linkedSignal(() => this.launch.agent());
  private readonly agentDefaults = computed(() => defaultsFor((this.data.agents() || []).find((a) => a.id === this.agent()) || null, { model: this.launch.model(), effort: this.launch.effort() }));
  readonly model = linkedSignal(() => this.agentDefaults().model);
  readonly effort = linkedSignal(() => this.agentDefaults().effort);
  readonly useRefs = signal(true);
  readonly planMode = signal(true);
  /** Searchable docs sources (Confluence, …): ticked ones are remembered in this browser. */
  readonly docSources = computed(() => this.data.docSites().filter((s) => s.searchable));
  readonly useDocs = signal<ReadonlySet<string>>(new Set(readDocsPref()));
  readonly search = signal<SearchResponse | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly results = computed<SearchResult[]>(() => (this.search()?.results || []).filter((r) => r.ref).slice(0, 6));
  readonly recentAsks = computed(() => this.data.runs().filter((r) => r.trigger === 'ask').slice(0, 12));
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private readonly att = viewChild<AttachComponent>('att');

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap.get('q');
    if (q) { this.q.set(q); this.runSearch(); }
    if (!this.data.docSites().length) this.data.loadDocs();
  }

  toggleDocs(key: string, on: boolean): void {
    const s = new Set(this.useDocs());
    if (on) s.add(key); else s.delete(key);
    this.useDocs.set(s);
    try { localStorage.setItem(DOCS_PREF, JSON.stringify([...s])); } catch { /* private window */ }
  }

  mark(s: string): string { return markTerms(s, this.search()?.terms); }

  onInput(v: string): void {
    this.q.set(v);
    this.error.set('');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runSearch(), 250);
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); }
  }

  private async runSearch(): Promise<void> {
    const q = this.q().trim();
    const seq = ++this.seq;
    this.router.navigate([], { queryParams: { q: q || null }, replaceUrl: true });
    if (!q) { this.search.set(null); return; }
    try {
      const d = await this.api.get<SearchResponse>('/api/search?limit=12&q=' + encodeURIComponent(q));
      if (seq === this.seq) this.search.set(d);
    } catch { /* search is best-effort */ }
  }

  async submit(): Promise<void> {
    const q = this.q().trim();
    if (!q || this.busy()) return;
    if (this.timer) { clearTimeout(this.timer); await this.runSearch(); }
    const prompt = this.useRefs() ? askPrompt(q, this.search()?.results || []) : q;
    const att = this.att();
    if (att?.uploading()) { this.error.set('Wait for the files to finish uploading.'); return; }
    // No budgetUsd: the server applies a cap only when it's turned on in Settings.
    const body: LaunchRequest = { prompt, workspace: this.ws(), agent: this.agent(), model: this.model(), effort: this.effort() as LaunchRequest['effort'], planMode: this.planMode(), permissionMode: 'auto', trigger: 'ask', attachments: att?.ids() || [] };
    const docs = [...this.useDocs()].filter((k) => this.docSources().some((s) => s.key === k));
    if (docs.length) body.docSources = docs;
    this.busy.set(true);
    try {
      const res = await this.api.post<{ run: RunMeta }>('/api/runs', body);
      att?.clear();
      this.data.upsertRun(res.run);
      this.toast.show('Asked: ' + res.run.label);
      this.router.navigate(['/runs', res.run.id]);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
