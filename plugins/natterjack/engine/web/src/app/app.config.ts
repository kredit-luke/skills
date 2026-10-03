import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { TitleStrategy, provideRouter, withComponentInputBinding, withNavigationErrorHandler } from '@angular/router';
import { routes } from './app.routes';
import { isChunkLoadError, shouldReload } from './core/chunk-reload';
import { WorkspaceTitleStrategy } from './core/title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withNavigationErrorHandler((e) => {
      // A page's code from an older build (the dashboard was rebuilt while this tab was open): load it afresh.
      if (isChunkLoadError(e.error) && shouldReload(e.url, sessionStorage)) location.assign(e.url);
    })),
    { provide: TitleStrategy, useExisting: WorkspaceTitleStrategy },
  ],
};
