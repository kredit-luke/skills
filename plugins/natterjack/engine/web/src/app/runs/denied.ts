import type { DeniedConnection } from '../../../../shared/api';

/** What a person calls a refused server: "claude.ai Slack" → "Slack", "plugin:postman:postman" → "postman". */
export function deniedLabel(d: Pick<DeniedConnection, 'name'>): string {
  return d.name.replace(/^claude\.ai\s+/i, '').replace(/^plugin:[^:]+:/i, '') || d.name;
}
