import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServerApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { startServer } from '../src/index.js';
import { createJobRegistry } from '../src/jobs.js';

const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  host: '127.0.0.1',
  port: 4319,
  accessToken: undefined,
  allowedOrigins: ['http://127.0.0.1:4319'],
  maxBodyBytes: 1_048_576,
  maxConcurrentJobs: 1,
  maxQueuedJobs: 10,
  jobTtlMs: 60_000,
  ...overrides,
});

const INDEX_MARKUP = '<!doctype html><html lang="zh-CN"><body>歌单导出 PWA</body></html>';
const SECRET_MARKUP = 'TOP_SECRET_OUTSIDE_WEB_ROOT';

interface Fixture {
  readonly webRoot: string;
  readonly outsideFile: string;
  dispose: () => void;
}

const createWebDistFixture = (): Fixture => {
  const base = mkdtempSync(join(tmpdir(), 'playlist-exporter-web-'));
  const webRoot = join(base, 'dist');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  mkdirSync(join(webRoot, 'icons'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), INDEX_MARKUP);
  writeFileSync(join(webRoot, 'manifest.webmanifest'), '{"name":"歌单导出"}');
  writeFileSync(join(webRoot, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(webRoot, 'assets', 'app-Bq1a2c3d4.js'), 'export const app = "hashed";');
  writeFileSync(join(webRoot, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(base, 'secret.txt'), SECRET_MARKUP);
  return {
    webRoot,
    outsideFile: join(base, 'secret.txt'),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
};

const createApp = (overrides: Partial<ServerConfig> = {}, webDistRoot?: string) => {
  const selectedConfig = config(overrides);
  const jobs = createJobRegistry({
    maxConcurrent: selectedConfig.maxConcurrentJobs,
    maxQueued: selectedConfig.maxQueuedJobs,
    terminalTtlMs: selectedConfig.jobTtlMs,
  });
  const app = createServerApp({
    config: selectedConfig,
    providers: new Map(),
    http: {
      async request() {
        throw new Error('network disabled in static test');
      },
    },
    jobs,
    webDistRoot,
  });
  return { app, jobs };
};

describe('WEB_DIST static hosting', () => {
  it('keeps GET / as a JSON 404 when WEB_DIST is not configured', async () => {
    const { app, jobs } = createApp();
    const response = await app.request('/');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
    jobs.close();
  });

  it('serves index.html at / with no-cache and nosniff', async () => {
    const fixture = createWebDistFixture();
    try {
      const { app, jobs } = createApp({}, fixture.webRoot);
      const response = await app.request('/');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).toBe(INDEX_MARKUP);

      const direct = await app.request('/index.html');
      expect(direct.status).toBe(200);
      expect(direct.headers.get('cache-control')).toBe('no-cache');
      jobs.close();
    } finally {
      fixture.dispose();
    }
  });

  it('serves hashed assets immutable, the manifest, icons and the service worker', async () => {
    const fixture = createWebDistFixture();
    try {
      const { app, jobs } = createApp({}, fixture.webRoot);

      const asset = await app.request('/assets/app-Bq1a2c3d4.js');
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await asset.text()).toContain('hashed');

      const manifest = await app.request('/manifest.webmanifest');
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get('content-type')).toContain('manifest+json');
      expect(await manifest.text()).toContain('歌单导出');

      const icon = await app.request('/icons/icon-192.png');
      expect(icon.status).toBe(200);
      expect(icon.headers.get('content-type')).toBe('image/png');

      const serviceWorker = await app.request('/sw.js');
      expect(serviceWorker.status).toBe(200);
      expect(serviceWorker.headers.get('cache-control')).toBe('no-cache');
      jobs.close();
    } finally {
      fixture.dispose();
    }
  });

  it('never serves files outside WEB_DIST, including encoded traversal', async () => {
    const fixture = createWebDistFixture();
    try {
      const { app, jobs } = createApp({}, fixture.webRoot);
      for (const path of [
        '/assets/../secret.txt',
        '/assets/..%2Fsecret.txt',
        '/assets/%2e%2e/secret.txt',
        '/assets/..\\secret.txt',
        '/icons/../../../../../../etc/passwd',
      ]) {
        const response = await app.request(path);
        expect(response.status, path).toBe(404);
        expect(await response.text(), path).not.toContain(SECRET_MARKUP);
      }
      const missing = await app.request('/assets/nope-0000.js');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND' });
      jobs.close();
    } finally {
      fixture.dispose();
    }
  });

  it('does not intercept /healthz or /api/* when WEB_DIST is configured', async () => {
    const fixture = createWebDistFixture();
    try {
      const { app, jobs } = createApp({ accessToken: 'static-secret' }, fixture.webRoot);
      const health = await app.request('/healthz');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const api = await app.request('/api/jobs/job-1');
      expect(api.status).toBe(401);
      expect(await api.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
      jobs.close();
    } finally {
      fixture.dispose();
    }
  });

  it('wires WEB_DIST from the environment at startup and fails fast on bad paths', async () => {
    const fixture = createWebDistFixture();
    try {
      const serve = vi.fn(() => ({ once: vi.fn() }) as never);
      const runtime = startServer({ env: { WEB_DIST: fixture.webRoot }, serveImpl: serve });
      expect(serve).toHaveBeenCalledOnce();
      const response = await runtime.app.request('/');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX_MARKUP);
      runtime.jobs.close();

      expect(() => startServer({
        env: { WEB_DIST: join(fixture.outsideFile, 'missing-child') },
        serveImpl: serve,
      })).toThrow(/WEB_DIST/);
    } finally {
      fixture.dispose();
    }
  });
});
