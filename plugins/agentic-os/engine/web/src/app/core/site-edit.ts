import type { LaunchOptions } from './launch.service';

/**
 * "Make edits" for a site whose source is in the workspace (a marketing site,
 * docs sites, internal tools). Other people push to these repos too, so
 * the run starts by getting the latest main, but never at the cost of someone's
 * uncommitted work or a feature branch.
 */
export function siteEditPrompt(repo: string, page?: string): string {
  return [
    `Working in repo ${repo}${page ? ` (page ${page})` : ''}.`,
    `First get the latest work from everyone else: in ${repo}, run git status. If it's on main with no local changes, pull the latest main (git pull --ff-only origin main). If it has local changes or is on another branch, stop and ask me how to proceed before pulling.`,
    '',
    'Then make these changes: ',
  ].join('\n');
}

/** Launch-dialog options for a site edit; the user finishes the prompt. */
export function siteEditLaunch(repo: string, name: string, page?: string): LaunchOptions {
  return { title: 'Make edits · ' + name, workspace: 'main', focusPrompt: true, prompt: siteEditPrompt(repo, page) };
}
