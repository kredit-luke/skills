import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { compact } from '../core/palette';

export interface BarSeries { key: string; label: string; color: string }
export interface LineSeries { key: string; label: string; color: string; points: { t: number; v: number }[] }

/**
 * Stacked bar chart in plain SVG. `values[i][s]` is series s on bar i. Hover a bar
 * for its breakdown. Scales to its container's width.
 */
@Component({
  selector: 'dash-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart" (mouseleave)="hover.set(-1)">
      <svg [attr.height]="H" [attr.viewBox]="'0 0 ' + width() + ' ' + H" role="img" [attr.aria-label]="ariaLabel()">
        @for (g of grid(); track g.y) {
          <line [attr.x1]="PAD_L" [attr.x2]="width() - 4" [attr.y1]="g.y" [attr.y2]="g.y" class="grid" />
          <text [attr.x]="PAD_L - 6" [attr.y]="g.y + 3" class="axis" text-anchor="end">{{ g.label }}</text>
        }
        @for (b of bars(); track b.i) {
          <g (mouseenter)="hover.set(b.i)">
            <rect [attr.x]="b.x - 1" y="0" [attr.width]="b.w + 2" [attr.height]="H - PAD_B" class="hit" [class.on]="hover() === b.i" />
            @for (s of b.segs; track s.key) {
              <rect [attr.x]="b.x" [attr.y]="s.y" [attr.width]="b.w" [attr.height]="s.h" [attr.fill]="s.color" rx="1.5" />
            }
            @if (b.showLabel) { <text [attr.x]="b.x + b.w / 2" [attr.y]="H - 6" class="axis" text-anchor="middle">{{ b.label }}</text> }
          </g>
        }
      </svg>
      @if (tip(); as t) {
        <div class="tip" [style.left.%]="t.left">
          <b>{{ t.label }}</b>
          @for (r of t.rows; track r.label) { <div><i [style.background]="r.color"></i>{{ r.label }} <span>{{ fmt(r.v) }}</span></div> }
          @if (t.rows.length > 1) { <div class="tot">Total <span>{{ fmt(t.total) }}</span></div> }
        </div>
      }
    </div>
  `,
  styleUrl: './charts.scss',
})
export class BarChartComponent {
  readonly labels = input.required<string[]>();
  readonly series = input.required<BarSeries[]>();
  readonly values = input.required<number[][]>();
  /** Show every nth x label (default: fit ~12). */
  readonly labelEvery = input<number>(0);
  readonly format = input<(n: number) => string>(compact);
  readonly ariaLabel = input('Bar chart');
  readonly hover = signal(-1);

  readonly width = measuredWidth();
  readonly H = 220;
  readonly PAD_L = 44;
  readonly PAD_B = 20;

  private readonly max = computed(() => niceMax(Math.max(0, ...this.values().map((row) => row.reduce((a, b) => a + (b || 0), 0)))));
  readonly grid = computed(() => {
    const m = this.max();
    const plotH = this.H - this.PAD_B - 8;
    return [0, 0.5, 1].map((f) => ({ y: 8 + plotH * (1 - f), label: this.format()(m * f) }));
  });
  readonly bars = computed(() => {
    const n = this.labels().length || 1;
    const plotW = this.width() - this.PAD_L - 8;
    const slot = plotW / n;
    const w = Math.max(2, slot * 0.72);
    const plotH = this.H - this.PAD_B - 8;
    const every = this.labelEvery() || Math.max(1, Math.ceil(n / 12));
    return this.labels().map((label, i) => {
      let y = 8 + plotH;
      const segs = this.series().map((s, si) => {
        const v = this.values()[i]?.[si] || 0;
        const h = this.max() ? (v / this.max()) * plotH : 0;
        y -= h;
        return { key: s.key, color: s.color, y, h };
      });
      return { i, label, x: this.PAD_L + slot * i + (slot - w) / 2, w, segs, showLabel: i % every === 0 || i === n - 1 };
    });
  });
  readonly tip = computed(() => {
    const i = this.hover();
    if (i < 0 || i >= this.labels().length) return null;
    const row = this.values()[i] || [];
    const rows = this.series().map((s, si) => ({ label: s.label, color: s.color, v: row[si] || 0 })).filter((r) => r.v).reverse();
    const total = rows.reduce((a, r) => a + r.v, 0);
    const left = Math.min(78, Math.max(2, ((this.PAD_L + ((this.width() - this.PAD_L) / this.labels().length) * (i + 0.5)) / this.width()) * 100 - 10));
    return { label: this.labels()[i], rows: rows.length ? rows : [{ label: 'Nothing', color: 'transparent', v: 0 }], total, left };
  });
  fmt(n: number): string { return this.format()(n); }
}

/** Multi-series line chart over time (ms), 0–yMax, with optional threshold line. */
@Component({
  selector: 'dash-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart">
      <svg [attr.height]="H" [attr.viewBox]="'0 0 ' + width() + ' ' + H" role="img" [attr.aria-label]="ariaLabel()">
        @for (g of grid(); track g.y) {
          <line [attr.x1]="PAD_L" [attr.x2]="width() - 4" [attr.y1]="g.y" [attr.y2]="g.y" class="grid" />
          <text [attr.x]="PAD_L - 6" [attr.y]="g.y + 3" class="axis" text-anchor="end">{{ g.label }}</text>
        }
        @if (thresholdY() !== null) {
          <line [attr.x1]="PAD_L" [attr.x2]="width() - 4" [attr.y1]="thresholdY()" [attr.y2]="thresholdY()" class="threshold" />
          <text [attr.x]="width() - 6" [attr.y]="thresholdY()! - 4" class="axis thr" text-anchor="end">{{ thresholdLabel() }}</text>
        }
        @for (s of paths(); track s.key) {
          <path [attr.d]="s.d" [attr.stroke]="s.color" class="line" />
          @for (p of s.dots; track $index) { <circle [attr.cx]="p.x" [attr.cy]="p.y" r="2.4" [attr.fill]="s.color"><title>{{ s.label }}: {{ p.v }}{{ unit() }} · {{ p.when }}</title></circle> }
        }
        @for (x of xTicks(); track x.x) { <text [attr.x]="x.x" [attr.y]="H - 6" class="axis" text-anchor="middle">{{ x.label }}</text> }
      </svg>
    </div>
  `,
  styleUrl: './charts.scss',
})
export class LineChartComponent {
  readonly series = input.required<LineSeries[]>();
  readonly yMax = input(100);
  readonly unit = input('%');
  readonly threshold = input<number | null>(null);
  readonly thresholdLabel = input('');
  readonly from = input.required<number>();
  readonly to = input.required<number>();
  readonly ariaLabel = input('Line chart');

  readonly width = measuredWidth();
  readonly H = 200;
  readonly PAD_L = 44;
  readonly PAD_B = 20;

  private x(t: number): number { return this.PAD_L + ((t - this.from()) / Math.max(1, this.to() - this.from())) * (this.width() - this.PAD_L - 8); }
  private y(v: number): number { return 8 + (1 - Math.min(v, this.yMax()) / this.yMax()) * (this.H - this.PAD_B - 8); }

  readonly grid = computed(() => [0, 0.5, 1].map((f) => ({ y: this.y(this.yMax() * f), label: Math.round(this.yMax() * f) + this.unit() })));
  readonly thresholdY = computed(() => (this.threshold() == null ? null : this.y(this.threshold()!)));
  readonly paths = computed(() => this.series().map((s) => {
    const pts = s.points.filter((p) => p.t >= this.from() && p.t <= this.to()).sort((a, b) => a.t - b.t);
    // Step line: a reading holds until the next one.
    let d = '';
    pts.forEach((p, i) => {
      const x = this.x(p.t), y = this.y(p.v);
      d += i === 0 ? `M${x},${y}` : `H${x}V${y}`;
    });
    if (pts.length) d += `H${this.x(Math.min(this.to(), Date.now()))}`;
    return {
      key: s.key, label: s.label, color: s.color, d,
      dots: pts.map((p) => ({ x: this.x(p.t), y: this.y(p.v), v: p.v, when: new Date(p.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })),
    };
  }));
  readonly xTicks = computed(() => {
    const out: { x: number; label: string }[] = [];
    const day = 86400000;
    const start = new Date(this.from());
    start.setHours(0, 0, 0, 0);
    const n = Math.round((this.to() - this.from()) / day);
    const step = Math.max(1, Math.ceil(n / 8));
    for (let t = start.getTime() + day, i = 0; t <= this.to(); t += day, i++) {
      if (i % step === 0) out.push({ x: this.x(t), label: new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) });
    }
    return out;
  });
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/**
 * The host element's width in px, kept current with a ResizeObserver, so charts
 * draw at real size (fixed height, readable text) instead of scaling a fixed viewBox.
 */
function measuredWidth() {
  const el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  const w = signal(720);
  let ro: ResizeObserver | null = null;
  afterNextRender(() => {
    const set = () => { const px = Math.round(el.clientWidth); if (px > 100 && px !== w()) w.set(px); };
    set();
    ro = new ResizeObserver(set);
    ro.observe(el);
  });
  inject(DestroyRef).onDestroy(() => ro?.disconnect());
  return w;
}
