import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home/home.component').then((m) => m.HomeComponent), title: 'Home' },
  { path: 'setup', loadComponent: () => import('./pages/setup/setup.component').then((m) => m.SetupComponent), title: 'Get started' },
  { path: 'standup', loadComponent: () => import('./pages/standup/standup.component').then((m) => m.StandupComponent), title: 'My updates' },
  { path: 'links', loadComponent: () => import('./pages/links/links.component').then((m) => m.LinksComponent), title: 'Links' },
  { path: 'knowledge', loadComponent: () => import('./pages/docs/docs.component').then((m) => m.DocsComponent), title: 'Knowledge' },
  { path: 'knowledge/:site', loadComponent: () => import('./pages/docs/docs.component').then((m) => m.DocsComponent), title: 'Knowledge' },
  { path: 'docs', redirectTo: 'knowledge' }, // the page's old name, in bookmarks and link tiles
  { path: 'docs/:site', redirectTo: 'knowledge/:site' },
  { path: 'infrastructure', loadComponent: () => import('./pages/infrastructure/infrastructure.component').then((m) => m.InfrastructureComponent), title: 'Infrastructure' },
  { path: 'reference', redirectTo: 'infrastructure' }, // the page's old name, in bookmarks and link tiles
  { path: 'ask', loadComponent: () => import('./pages/ask/ask.component').then((m) => m.AskComponent), title: 'Ask' },
  // Send to hosted's other end (a hosted dashboard; opened by the person's own dashboard).
  { path: 'import-run', loadComponent: () => import('./pages/import-run/import-run.component').then((m) => m.ImportRunComponent), title: 'Move a run here' },
  { path: 'runs', loadComponent: () => import('./pages/runs/runs.component').then((m) => m.RunsComponent), title: 'Activity' },
  { path: 'runs/:id', loadComponent: () => import('./pages/runs/runs.component').then((m) => m.RunsComponent), title: 'Activity' },
  { path: 'factory', loadComponent: () => import('./pages/factory/factory.component').then((m) => m.FactoryComponent), title: 'Factory' },
  { path: 'factory/settings', loadComponent: () => import('./pages/factory/factory-settings.component').then((m) => m.FactorySettingsComponent), title: 'Factory policy' },
  { path: 'reviews', loadComponent: () => import('./pages/reviews/reviews.component').then((m) => m.ReviewsComponent), title: 'Reviews' },
  { path: 'usage', loadComponent: () => import('./pages/usage/usage.component').then((m) => m.UsageComponent), title: 'Usage' },
  { path: 'issues', loadComponent: () => import('./pages/issues/issues.component').then((m) => m.IssuesComponent), title: 'Issues' },
  { path: 'meetings', loadComponent: () => import('./pages/meetings/meetings.component').then((m) => m.MeetingsComponent), title: 'Meetings' },
  { path: 'apps', loadComponent: () => import('./pages/apps/apps.component').then((m) => m.AppsComponent), title: 'Apps' },
  { path: 'workspaces', loadComponent: () => import('./pages/workspaces/workspaces.component').then((m) => m.WorkspacesComponent), title: 'Workspaces' },
  { path: 'people', loadComponent: () => import('./pages/people/people.component').then((m) => m.PeopleComponent), title: 'People' },
  { path: 'repos', loadComponent: () => import('./pages/repos/repos.component').then((m) => m.ReposComponent), title: 'Repos' },
  { path: 'skills', loadComponent: () => import('./pages/skills/skills.component').then((m) => m.SkillsComponent), title: 'Skills' },
  {
    path: 'explore', loadComponent: () => import('./pages/explore/explore.component').then((m) => m.ExploreComponent), title: 'Explore',
    // Guard on every ?path= change too, so switching files can't drop unsaved edits.
    runGuardsAndResolvers: 'pathParamsOrQueryParamsChange',
    canDeactivate: [(c: { canLeave(): boolean }) => c.canLeave()],
  },
  { path: 'models', loadComponent: () => import('./pages/models/models.component').then((m) => m.ModelsComponent), title: 'Models' },
  { path: 'connections', loadComponent: () => import('./pages/connections/connections.component').then((m) => m.ConnectionsComponent), title: 'Connections' },
  { path: 'memory', loadComponent: () => import('./pages/memory/memory.component').then((m) => m.MemoryComponent), title: 'Memory' },
  { path: 'machine', loadComponent: () => import('./pages/machine/machine.component').then((m) => m.MachineComponent), title: 'Machine' },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then((m) => m.SettingsComponent), title: 'Settings' },
  { path: '**', redirectTo: '' },
];
