import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home/home.component').then((m) => m.HomeComponent), title: 'Home' },
  { path: 'links', loadComponent: () => import('./pages/links/links.component').then((m) => m.LinksComponent), title: 'Links' },
  { path: 'docs', loadComponent: () => import('./pages/docs/docs.component').then((m) => m.DocsComponent), title: 'Docs' },
  { path: 'docs/:site', loadComponent: () => import('./pages/docs/docs.component').then((m) => m.DocsComponent), title: 'Docs' },
  { path: 'reference', loadComponent: () => import('./pages/reference/reference.component').then((m) => m.ReferenceComponent), title: 'Reference' },
  { path: 'ask', loadComponent: () => import('./pages/ask/ask.component').then((m) => m.AskComponent), title: 'Ask' },
  { path: 'runs', loadComponent: () => import('./pages/runs/runs.component').then((m) => m.RunsComponent), title: 'Activity' },
  { path: 'runs/:id', loadComponent: () => import('./pages/runs/runs.component').then((m) => m.RunsComponent), title: 'Activity' },
  { path: 'usage', loadComponent: () => import('./pages/usage/usage.component').then((m) => m.UsageComponent), title: 'Usage' },
  { path: 'issues', loadComponent: () => import('./pages/issues/issues.component').then((m) => m.IssuesComponent), title: 'Issues' },
  { path: 'apps', loadComponent: () => import('./pages/apps/apps.component').then((m) => m.AppsComponent), title: 'Apps' },
  { path: 'workspaces', loadComponent: () => import('./pages/workspaces/workspaces.component').then((m) => m.WorkspacesComponent), title: 'Workspaces' },
  { path: 'repos', loadComponent: () => import('./pages/repos/repos.component').then((m) => m.ReposComponent), title: 'Repos' },
  { path: 'skills', loadComponent: () => import('./pages/skills/skills.component').then((m) => m.SkillsComponent), title: 'Skills' },
  {
    path: 'explore', loadComponent: () => import('./pages/explore/explore.component').then((m) => m.ExploreComponent), title: 'Explore',
    // Guard on every ?path= change too, so switching files can't drop unsaved edits.
    runGuardsAndResolvers: 'pathParamsOrQueryParamsChange',
    canDeactivate: [(c: { canLeave(): boolean }) => c.canLeave()],
  },
  { path: 'memory', loadComponent: () => import('./pages/memory/memory.component').then((m) => m.MemoryComponent), title: 'Memory' },
  { path: 'machine', loadComponent: () => import('./pages/machine/machine.component').then((m) => m.MachineComponent), title: 'Machine' },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then((m) => m.SettingsComponent), title: 'Settings' },
  { path: '**', redirectTo: '' },
];
