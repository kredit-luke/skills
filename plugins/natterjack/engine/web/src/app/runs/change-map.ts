import type { RunOutput } from '../../../../shared/api';
import { CHANGE_MAP_RE } from '../../../../shared/change-map';

const SUFFIX = /\.change-map\.html$/i;

/** A run's change maps (the files the server's change-map route serves), newest first. */
export function changeMaps(outputs: RunOutput[]): RunOutput[] {
  return outputs.filter((o) => CHANGE_MAP_RE.test(o.name)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** What a person calls a map: "maps/ENG-12.change-map.html" → "ENG-12". */
export function changeMapLabel(name: string): string {
  return (name.split('/').pop() || name).replace(SUFFIX, '');
}

/**
 * Where the Map tab frames it: the server's sandboxed change-map route (never the outputs route,
 * which serves HTML as a download), versioned by its time so a rewrite reloads, in the dashboard's
 * light theme.
 */
export function changeMapUrl(runId: string, map: RunOutput): string {
  const path = map.name.split('/').map(encodeURIComponent).join('/');
  return `/api/runs/${encodeURIComponent(runId)}/change-map/${path}?v=${encodeURIComponent(map.modifiedAt)}#theme=light`;
}
