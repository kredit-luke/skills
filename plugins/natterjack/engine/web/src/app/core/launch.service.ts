import { Injectable, computed, inject, signal } from '@angular/core';
import type { AgentId } from '../../../../shared/api';
import { startAgent, usableAgents } from './agents';
import { DataService } from './data.service';

export interface LaunchOptions {
  presetId?: string | null;
  prompt?: string;
  /** Preset arg values, e.g. { ticket: 'ENG-1' } from the Issues page. */
  prefill?: Record<string, string>;
  /** Preset option checkboxes to pre-tick or untick, by name. */
  options?: Record<string, boolean>;
  workspace?: string;
  /** The agent CLI to run it with (default: the one picked last, else the workspace's). */
  agent?: AgentId;
  model?: string;
  effort?: string;
  title?: string;
  /** Put the cursor at the end of the prompt (Make changes, Ask Claude). */
  focusPrompt?: boolean;
  planMode?: boolean;
  trigger?: string;
  /** Searchable docs sources to tick "Use <source>" for (docs.json keys), and the page the run is about. */
  docSources?: string[];
  docPage?: string;
}

/** Used until deck.json has loaded; the server applies the same when a request names none. */
const FALLBACK = { model: 'opus', effort: 'medium' };

/**
 * Opens the launch dialog, and knows the default model/effort every run starts
 * with: `defaults` in .claude/dashboard/deck.json (Opus / medium). The dialog
 * always opens on it; a change there applies to that run only.
 */
@Injectable({ providedIn: 'root' })
export class LaunchService {
  private readonly data = inject(DataService);
  readonly request = signal<LaunchOptions | null>(null);
  readonly defaults = computed(() => this.data.deck()?.defaults || FALLBACK);
  readonly model = computed(() => this.defaults().model);
  readonly effort = computed(() => this.defaults().effort);
  private readonly remembered = signal<string | null>(readAgent());
  /** The agent a new run starts on: the one picked last in this browser, else deck.json's default, else Claude. */
  readonly agent = computed<AgentId>(() => startAgent(usableAgents(this.data.agents()), this.remembered(), (this.data.deck()?.defaults as any)?.agent || null));

  rememberAgent(id: AgentId): void {
    this.remembered.set(id);
    try { localStorage.setItem('dash.agent', id); } catch {}
  }

  open(opts: LaunchOptions): void {
    this.request.set({ ...opts });
  }

  close(): void {
    this.request.set(null);
  }
}

function readAgent(): string | null {
  try { return localStorage.getItem('dash.agent'); } catch { return null; }
}
