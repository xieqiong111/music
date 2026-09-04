import { defineConfig } from '@playwright/test';
import process from 'node:process';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    headless: true,
    // Service-worker behavior is covered by src/sw.test.ts; blocking workers
    // keeps network mocking deterministic in every test context.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4321 --strictPort',
    url: 'http://127.0.0.1:4321',
    // Never reuse a leaked server on CI: a stale preview would serve an
    // outdated bundle and silently invalidate the run.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
