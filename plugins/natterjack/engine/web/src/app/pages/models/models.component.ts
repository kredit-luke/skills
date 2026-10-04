import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import type { InstalledModel, ModelEndpoint, ModelFit, ModelPull, RecommendedModel } from '../../../../../shared/api';
import { ApiService } from '../../core/api.service';
import { DataService } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { copyText } from '../../core/util';
import { PageHeaderComponent } from '../../shared/page-header.component';

const FIT_TAG: Record<ModelFit, string> = { gpu: 'good', partial: 'amber', cpu: 'amber', 'too-big': 'bad', 'no-disk': 'bad' };

const ENDPOINT_EXAMPLE = `{
  "endpoints": [{
    "id": "gpu", "label": "Team GPU",
    "baseUrl": "https://llm.example.com",
    "token": "\${TEAM_LLM_TOKEN}",
    "models": [{ "id": "qwen3.8:27b", "label": "Qwen3.8 27B", "tools": true }]
  }]
}`;

/**
 * Models: open models runs can use instead of Claude's. On this computer with Ollama (the
 * recommended list with whether each fits, downloads with progress, what's downloaded and
 * the disk it takes), or hosted by the team (models.json endpoints: reach, token). Each one
 * that can call tools shows up in Ask and Run's Model select as "Local · …" or "<endpoint> · …".
 */
@Component({
  selector: 'dash-models',
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './models.component.scss',
  template: `
    @let m = data.models();
    <dash-page-header eyebrow="Agents" title="Models" [sub]="sub()">
      <button class="btn sm" (click)="refresh()" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Refresh' }}</button>
    </dash-page-header>

    @if (!m) { <div class="empty">Checking…</div> }
    @else {
      @if (m.error) { <div class="warn-note">{{ m.error }}</div> }

      @if (!m.hosted) {
        <div class="panel">
          <div class="panel-h"><h2>This computer</h2></div>
          <div class="facts">
            <div class="fact">
              <div class="k">GPU</div>
              @if (m.hardware.gpus.length) {
                @for (g of m.hardware.gpus; track g.name) { <div class="v">{{ g.name }}@if (g.vramGb) { <span class="dim"> · {{ g.vramGb }} GB{{ g.unified ? ' (shared with RAM)' : '' }}</span> }</div> }
              } @else { <div class="v dim">None found: models run on the CPU (slowly)</div> }
            </div>
            <div class="fact"><div class="k">Memory</div><div class="v">{{ m.hardware.memoryGb }} GB <span class="dim">· {{ m.hardware.freeMemoryGb }} GB free</span></div></div>
            <div class="fact wide">
              <div class="k">Disk where models go</div>
              @if (m.modelsDir; as d) {
                <div class="v">{{ d.freeGb }} GB free of {{ d.totalGb }} GB <span class="dim">· models use {{ m.usedGb }} GB</span></div>
                <div class="disk" [title]="'Downloaded models: ' + m.usedGb + ' GB; other files: ' + other(d) + ' GB; free: ' + d.freeGb + ' GB'">
                  <i class="mine" [style.width.%]="pct(m.usedGb, d.totalGb)"></i><i class="rest" [style.width.%]="pct(other(d), d.totalGb)"></i>
                </div>
                <div class="path">{{ d.path }}</div>
              } @else { <div class="v dim">{{ m.ollama.where === 'elsewhere' ? 'Wherever Ollama runs (not this computer\'s apps)' : 'Unknown' }}</div> }
            </div>
          </div>
          <div class="runtime" [class.ok]="m.ollama.running">
            @if (m.ollama.running && !m.ollama.messagesApi) {
              <span class="tag amber">Ollama {{ m.ollama.version }}{{ whereText() }}: update needed</span>
              <span>This version doesn't have the Anthropic-compatible API Claude Code talks to, so runs can't use local models yet. Updating keeps your downloaded models.@if (m.ollama.where === 'wsl') { It runs in WSL, so the update asks for your Linux password. }@if (m.ollama.where === 'elsewhere') { It runs outside this computer's apps (a container or another machine): update it there. }</span>
              @if (m.ollama.where !== 'elsewhere') { <button class="btn primary sm" [disabled]="installing()" (click)="installOllama(true)" title="Opens a terminal running the update, so you can see and approve any prompts">Update Ollama</button> }
            } @else if (m.ollama.running) {
              <span class="tag good">Ollama {{ m.ollama.version }}{{ whereText() }}</span>
              <span>Running at <code>{{ m.ollama.base }}</code>. Downloaded models get a {{ ctxK(m.contextLength) }} context window for runs (Claude Code's own instructions need about 20k).</span>
            } @else if (m.ollama.installed) {
              <span class="tag amber">Ollama stopped</span>
              <span>Ollama is installed but not running. Start the Ollama app, or run <code (click)="copy('ollama serve')" title="Click to copy">ollama serve</code>, then Refresh.</span>
            } @else {
              <span class="tag">No Ollama</span>
              <span>Local models run in <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, a free app that downloads and serves open models.</span>
              <button class="btn primary sm" [disabled]="installing()" (click)="installOllama(false)" title="Opens a terminal running the installer, so you can see and approve any prompts">Install Ollama</button>
            }
          </div>
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Recommended</h2><span class="ty">Good open models for code. Sizes are downloads; "fits" is a rough guide for this computer.</span></div>
          <table class="tbl">
            <tr><th>Model</th><th class="num">Size</th><th class="num">Context</th><th>Tool calling</th><th>On this computer</th><th></th></tr>
            @for (r of m.recommended; track r.tag) {
              <tr [class.off]="!r.tools">
                <td>
                  <div class="nm">{{ r.label }} <span class="dim">{{ r.params }}</span></div>
                  <div class="tagname">{{ r.tag }}</div>
                  <div class="good-for">{{ r.goodFor }}@if (r.notes) { <span class="note"> {{ r.notes }}</span> }</div>
                </td>
                <td class="num">{{ r.diskGb }} GB</td>
                <td class="num">{{ ctxK(r.context) }}</td>
                <td>@if (r.tools) { <span class="yes">✓ Yes</span> } @else { <span class="no" title="Claude Code works through tools (read, search, edit), so runs can't use this model">✕ No</span> }</td>
                <td><span class="tag" [class]="'tag ' + fitTag(r.fit)">{{ r.fitLabel }}</span></td>
                <td class="act">
                  @if (pullOf(r.tag); as p) {
                    <div class="prog"><div class="meter"><i [style.width.%]="progress(p)"></i></div><span class="dim">{{ pullText(p) }}</span></div>
                    <button class="btn ghost sm" (click)="cancel(p.tag)">Cancel</button>
                  } @else if (r.installed) {
                    <span class="yes">Downloaded</span>
                  } @else {
                    <button class="btn sm" [disabled]="!m.ollama.running || r.fit === 'no-disk'" [title]="!m.ollama.running ? 'Start Ollama first' : r.fit === 'too-big' ? 'Probably too big to run well here; you can still download it' : 'Download ' + r.diskGb + ' GB'" (click)="pull(r.tag)">Download</button>
                  }
                </td>
              </tr>
            }
          </table>
          @for (p of otherPulls(); track p.tag) {
            <div class="other-pull">
              <span class="tagname">{{ p.tag }}</span>
              @if (p.error) { <span class="no">{{ p.error }}</span> <button class="btn ghost sm" (click)="pull(p.tag)">Try again</button> }
              @else if (!p.done) { <div class="prog"><div class="meter"><i [style.width.%]="progress(p)"></i></div><span class="dim">{{ pullText(p) }}</span></div> <button class="btn ghost sm" (click)="cancel(p.tag)">Cancel</button> }
            </div>
          }
          @if (m.ollama.running) {
            <form class="another" (submit)="$event.preventDefault(); pull(tagInput.value); tagInput.value = ''">
              <input #tagInput type="text" placeholder="Another model from ollama.com/library, e.g. granite4.1:3b" aria-label="Ollama model name" spellcheck="false" autocomplete="off">
              <button class="btn sm" type="submit">Download</button>
            </form>
          }
        </div>

        <div class="panel">
          <div class="panel-h"><h2>Downloaded @if (m.installed.length) { <span class="n">{{ m.installed.length }}</span> }</h2><span class="ty">{{ m.usedGb }} GB on disk</span></div>
          @if (!m.installed.length) {
            <div class="empty">{{ m.ollama.running ? 'Nothing downloaded yet. Pick one above.' : 'Start Ollama to see what\\'s downloaded.' }}</div>
          }
          @for (i of m.installed; track i.name) {
            <div class="row">
              <div class="main">
                <div class="nm">{{ i.label }} <span class="dim">{{ i.params || '' }}{{ i.quantization ? ' · ' + i.quantization : '' }}</span></div>
                <div class="tagname">{{ i.name }}</div>
                <div class="good-for">
                  @if (i.problem) { <span [class]="i.preparable ? 'amber-t' : 'no'">{{ i.problem }}</span> }
                  @else if (!m.ollama.messagesApi) { <span class="amber-t">Update Ollama (above) before runs can use it.</span> }
                  @else { <span class="yes">✓ Ready:</span> pick <b>{{ routeLabel(i) }}</b> as the model in Ask or Run ({{ ctxK(i.context) }} context). }
                </div>
              </div>
              <div class="side">
                <span class="ver">{{ i.sizeGb }} GB</span>
                @if (i.preparable) { <button class="btn primary sm" [disabled]="working() === i.name" (click)="prepare(i)">Prepare for runs</button> }
                <button class="btn danger sm" [disabled]="working() === i.name" (click)="remove(i)">Delete</button>
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="warn-note">This dashboard is hosted, so it can't run models itself. It can use the team's hosted models below.</div>
      }

      <div class="panel">
        <div class="panel-h"><h2>Team models @if (m.endpoints.length) { <span class="n">{{ m.endpoints.length }}</span> }</h2><span class="ty">Bigger models the team hosts, from models.json</span></div>
        @if (!m.endpoints.length) {
          <div class="help">
            <p>A team can host a larger open model on its own infrastructure (Ollama or vLLM on a GPU server, often behind LiteLLM for sign-in) and list it in <code>.claude/dashboard/models.json</code>. Everyone then sees it in the Model select. The server must speak Anthropic's Messages API (all three do).</p>
            <pre class="example" (click)="copy(example)" title="Click to copy">{{ example }}</pre>
            <p class="dim">Tokens stay out of the file: <code>{{ '\${VAR}' }}</code> reads an environment variable, or each person saves theirs here.</p>
          </div>
        }
        @for (e of m.endpoints; track e.id) {
          <div class="endpoint">
            <div class="ep-h">
              <div>
                <div class="nm">{{ e.label }}</div>
                <div class="tagname">{{ e.baseUrl }}</div>
              </div>
              <div class="side">
                @if (e.test; as t) {
                  @if (t.ok) { <span class="tag good">Reachable · {{ t.ms }} ms</span> } @else { <span class="tag bad" [title]="t.error || ''">{{ t.error }}</span> }
                }
                <button class="btn sm" [disabled]="working() === e.id" (click)="test(e)">{{ working() === e.id ? 'Testing…' : 'Test' }}</button>
              </div>
            </div>
            <div class="token">
              @switch (e.tokenSource) {
                @case ('env') { <span class="yes">✓</span> Token from <code>{{ e.tokenVar }}</code> }
                @case ('saved') { <span class="yes">✓</span> Token saved on this computer <button class="btn ghost sm" (click)="saveToken(e, '')">Forget</button> }
                @case ('config') { <span class="amber-t">The token is written in models.json; better as <code>{{ '\${VAR}' }}</code>.</span> }
                @default {
                  @if (e.needsToken) {
                    <form (submit)="$event.preventDefault(); saveToken(e, tok.value); tok.value = ''">
                      <span class="amber-t">Needs a token</span>@if (e.tokenVar) { <span class="dim"> (set {{ e.tokenVar }}, or save one here)</span> }
                      <input #tok type="password" placeholder="Token" aria-label="Token for {{ e.label }}" autocomplete="off">
                      <button class="btn sm" type="submit">Save</button>
                    </form>
                  } @else { <span class="dim">No token</span> }
                }
              }
            </div>
            @if (e.models.length) {
              <ul class="ep-models">
                @for (x of e.models; track x.id) {
                  <li><span>{{ x.label }}</span> <span class="tagname">{{ x.id }}</span>
                    @if (x.tools === false) { <span class="no">✕ no tool calling</span> } @else if (x.tools === null) { <span class="dim">tool calling unknown</span> } @else { <span class="yes">✓ tools</span> }
                  </li>
                }
              </ul>
            } @else if (e.discovered) {
              <div class="dim pad">No models listed: Test asks the endpoint for its list.</div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class ModelsComponent implements OnInit {
  readonly data = inject(DataService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly busy = signal(false);
  readonly installing = signal(false);
  /** The model or endpoint an action is running on. */
  readonly working = signal<string | null>(null);
  readonly example = ENDPOINT_EXAMPLE;

  readonly sub = computed(() => 'Open models runs can use instead of Claude\'s: free ones on this computer, or bigger ones your team hosts. Each one that can call tools appears in the Model select in Ask and Run. Claude\'s own models keep using your Claude sign-in.');
  /** Downloads of models that aren't in the recommended list (typed in). */
  readonly otherPulls = computed(() => {
    const m = this.data.models();
    if (!m) return [];
    const rec = new Set(m.recommended.map((r) => r.tag));
    return m.pulls.filter((p) => !rec.has(p.tag) && (!p.done || p.error));
  });

  /** " · in WSL" for a Windows computer whose Ollama runs in WSL. */
  readonly whereText = computed(() => {
    const w = this.data.models()?.ollama.where;
    return w === 'wsl' ? ' · in WSL' : w === 'elsewhere' ? ' · elsewhere' : '';
  });

  ngOnInit(): void { this.data.loadModels(true); }

  async refresh(): Promise<void> {
    this.busy.set(true);
    await this.data.loadModels(true);
    this.busy.set(false);
  }

  fitTag(f: ModelFit): string { return FIT_TAG[f]; }
  ctxK(n: number): string { return n >= 1048576 ? Math.round(n / 1048576) + 'M' : Math.round(n / 1024) + 'k'; }
  pct(part: number, total: number): number { return total ? Math.min(100, (part / total) * 100) : 0; }
  other(d: { freeGb: number; totalGb: number }): number { return Math.max(0, Math.round((d.totalGb - d.freeGb - (this.data.models()?.usedGb || 0)) * 10) / 10); }
  routeLabel(i: InstalledModel): string { return 'Local · ' + i.label; }

  /** A recommended model's download in progress (or failed), if any. */
  pullOf(tag: string): ModelPull | null {
    const p = this.data.models()?.pulls.find((x) => x.tag === tag);
    return p && !p.done ? p : null;
  }
  progress(p: ModelPull): number { return p.total ? (p.completed / p.total) * 100 : 0; }
  pullText(p: ModelPull): string {
    if (!p.total) return p.status || 'starting';
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    return p.completed >= p.total ? p.status : `${gb(p.completed)} of ${gb(p.total)} GB`;
  }

  async copy(text: string): Promise<void> { if (await copyText(text)) this.toast.show('Copied'); }

  async installOllama(update: boolean): Promise<void> {
    this.installing.set(true);
    try {
      const r = await this.api.post<{ opened: boolean; command: string }>('/api/models/install-ollama', { update });
      if (r.opened) this.toast.show('Opened a terminal running: ' + r.command + '. Refresh when it finishes.');
      else { await copyText(r.command); this.toast.error('Couldn\'t open a terminal; copied the command instead.'); }
    } catch (e) { this.toast.error((e as Error).message); }
    finally { setTimeout(() => this.installing.set(false), 3000); }
  }

  async pull(tag: string): Promise<void> {
    tag = tag.trim();
    if (!tag) return;
    try {
      await this.api.post('/api/models/pull', { name: tag });
      this.toast.show('Downloading ' + tag + '…');
      await this.data.loadModels();
    } catch (e) { this.toast.error((e as Error).message); }
  }

  async cancel(tag: string): Promise<void> {
    try { await this.api.post('/api/models/cancel', { name: tag }); } catch (e) { this.toast.error((e as Error).message); }
  }

  async prepare(i: InstalledModel): Promise<void> {
    await this.act(i.name, '/api/models/prepare', { name: i.name }, i.label + ' is ready for runs');
  }

  async remove(i: InstalledModel): Promise<void> {
    if (!confirm(`Delete ${i.name}? It frees ${i.sizeGb} GB; you can download it again later.`)) return;
    await this.act(i.name, '/api/models/delete', { name: i.name }, 'Deleted ' + i.name);
  }

  async test(e: ModelEndpoint): Promise<void> {
    this.working.set(e.id);
    try {
      const t = await this.api.post<ModelEndpoint['test']>('/api/models/test', { id: e.id });
      if (t?.ok) this.toast.show(`${e.label} answered in ${t.ms} ms`);
      await this.data.loadModels();
    } catch (err) { this.toast.error((err as Error).message); }
    finally { this.working.set(null); }
  }

  async saveToken(e: ModelEndpoint, token: string): Promise<void> {
    if (!token.trim() && e.tokenSource !== 'saved') return;
    await this.act(e.id, '/api/models/token', { id: e.id, token }, token ? 'Token saved on this computer' : 'Token forgotten');
  }

  private async act(key: string, url: string, body: unknown, done: string): Promise<void> {
    this.working.set(key);
    try {
      await this.api.post(url, body);
      this.toast.show(done);
      await this.data.loadModels(true);
    } catch (e) { this.toast.error((e as Error).message); }
    finally { this.working.set(null); }
  }
}
