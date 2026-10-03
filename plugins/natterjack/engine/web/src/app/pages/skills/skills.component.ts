import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { Preset } from '../../../../../shared/api';
import { DataService } from '../../core/data.service';
import { LaunchService } from '../../core/launch.service';
import { SearchService } from '../../core/search.service';
import { dur, pct } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';
import { PageHeaderComponent } from '../../shared/page-header.component';

@Component({
  selector: 'dash-skills',
  imports: [PageHeaderComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './skills.component.scss',
  template: `
    <dash-page-header eyebrow="Skills" title="Skills & presets" sub="Presets are one-click runs with their own model and settings; any project skill can run headless too.">
      <button class="btn sm" (click)="search.open({ source: 'agent', q: 'agent' })" title="Agents are searchable in the palette">Find agents</button>
    </dash-page-header>

    <div class="group-title">Presets</div>
    <div class="presets">
      @for (p of data.deck()?.presets || []; track p.id) {
        <div class="preset">
          <div class="p-h"><span class="ico"><dash-icon [name]="p.icon || 'terminal'" style="width:15px;height:15px" /></span>
            <div class="grow" style="min-width:0"><div class="n">{{ p.label }}</div><div class="m">{{ meta(p) }}</div></div>
            <button class="btn primary sm" (click)="runPreset(p)">Run</button></div>
          @if (p.description) { <div class="d">{{ p.description }}</div> }
          <code class="pr">{{ p.prompt }}</code>
          <div class="st">{{ stats(p.id) }}</div>
        </div>
      } @empty { <div class="empty">{{ data.deck() ? 'No presets in deck.json.' : 'Loading…' }}</div> }
    </div>

    <div class="group-title">Project skills <span class="ty">{{ filtered().length }} of {{ (data.deck()?.skills || []).length }}</span></div>
    <input class="filter" [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Filter skills…" autocomplete="off">
    <div class="panel">
      <div class="panel-b">
        @for (s of filtered(); track s.name) {
          <div class="skill">
            <div class="main">
              <div class="t">/{{ s.name }} @if (s.argumentHint) { <span class="ah">{{ s.argumentHint }}</span> }</div>
              <div class="sub">{{ s.description }}</div>
            </div>
            <button class="btn sm" (click)="runSkill(s.name)">Run</button>
          </div>
        } @empty { <div class="empty">{{ data.deck() ? 'No skills match.' : 'Loading…' }}</div> }
      </div>
      <div class="hint">Runs headless. Skills that ask questions partway through now ask them on the run page, where you can answer; for long interactive work use Continue in terminal.</div>
    </div>
  `,
})
export class SkillsComponent {
  readonly data = inject(DataService);
  readonly search = inject(SearchService);
  private readonly launch = inject(LaunchService);
  readonly q = signal('');
  readonly filtered = computed(() => {
    const q = this.q().toLowerCase().trim();
    const list = this.data.deck()?.skills || [];
    return q ? list.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(q)) : list;
  });

  meta(p: Preset): string { return [p.model || this.launch.model(), p.effort || this.launch.effort(), p.permissionMode].filter(Boolean).join(' · '); }
  stats(id: string): string {
    const st = this.data.stats()[id];
    if (!st || !st.runs) return 'No runs yet';
    return st.runs + ' run' + (st.runs === 1 ? '' : 's') + ' · ' + pct(st.succeeded, st.runs) + ' ok' + (st.rated ? ' · ' + st.good + '/' + st.rated + ' good' : '') + ' · avg ' + dur(st.durationMs / st.runs);
  }
  runPreset(p: Preset): void { this.launch.open({ presetId: p.id }); }
  runSkill(name: string): void { this.launch.open({ prompt: '/' + name + ' ', focusPrompt: true }); }
}
