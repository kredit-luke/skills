import { defineConfig } from 'vitest/config';

// Unit tests for the web app's pure functions (transcript tree, markdown). No DOM, no Angular TestBed.
export default defineConfig({
  test: {
    include: ['web/src/**/*.spec.ts'],
    environment: 'node',
  },
});
