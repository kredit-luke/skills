import { Injectable, inject, signal } from '@angular/core';
import type { CommandInfo } from '../../../../shared/api';
import { ApiService } from './api.service';

const SOURCE_ORDER: Record<string, number> = { skill: 0, organization: 1, plugin: 2, 'built-in': 3, mcp: 4 };

/**
 * Every slash command Claude Code knows (project + plugin skills, prompt-style
 * built-ins, MCP prompts), fetched lazily from /api/commands.
 */
@Injectable({ providedIn: 'root' })
export class CommandsService {
  private readonly api = inject(ApiService);
  readonly commands = signal<CommandInfo[] | null>(null);
  private loading: Promise<void> | null = null;

  load(force = false): Promise<void> {
    // An empty list (the CLI wasn't ready) is retried on the next focus.
    if (!force && this.commands()?.length) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.api.get<{ commands: CommandInfo[] }>('/api/commands')
        .then((d) => this.commands.set(d.commands || []))
        .catch(() => this.commands.set(null))
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  /** Fetch the list again (after a Claude sign-in, which changes the skills). */
  refresh(): Promise<void> {
    // A request already on its way may be the signed-out one: fetch again once it's done.
    return (this.loading || Promise.resolve()).then(() => this.load(true));
  }

  find(name: string): CommandInfo | undefined {
    return (this.commands() || []).find((c) => c.name === name || (c.aliases || []).includes(name));
  }

  /** Commands matching a partial name, best first. */
  match(q: string, limit = 40): CommandInfo[] {
    const list = this.commands() || [];
    return list
      .map((c) => ({ c, r: rankCommand(c, q.toLowerCase()) }))
      .filter((x) => x.r < 99)
      .sort((a, b) => a.r - b.r || (SOURCE_ORDER[a.c.source] ?? 9) - (SOURCE_ORDER[b.c.source] ?? 9) || a.c.name.localeCompare(b.c.name))
      .slice(0, limit)
      .map((x) => x.c);
  }
}

export function rankCommand(c: CommandInfo, q: string): number {
  if (!q) return 10;
  const names = [c.name].concat(c.aliases || []).map((n) => n.toLowerCase());
  let best = 99;
  for (const n of names) {
    if (n === q) best = Math.min(best, 0);
    else if (n.startsWith(q)) best = Math.min(best, 1);
    // Word start inside the name: "review" matches engineering:code-review.
    else if (n.split(/[:\-_ ]/).some((w) => w.startsWith(q))) best = Math.min(best, 2);
    else if (n.includes(q)) best = Math.min(best, 3);
  }
  if (best === 99 && q.length >= 3 && (c.description || '').toLowerCase().includes(q)) best = 4;
  return best;
}
