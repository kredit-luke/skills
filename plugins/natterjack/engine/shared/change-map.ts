/**
 * A change map a run made: the multirepo change-map skill's self-contained page, written to the run's
 * outputs as <name>.change-map.html (a subfolder is fine). The run page lists these in its Map tab, and
 * the server's change-map route serves only these: one rule for both.
 */
export const CHANGE_MAP_RE = /^(?:[^/]+\/)*[^/]+\.change-map\.html$/i;
