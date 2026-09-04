import { describe, expect, it, vi } from 'vitest';
import type {
  HttpTransport,
  MusicProvider,
  Playlist,
  TaskContext,
} from '@playlist-exporter/contracts';
import { createServerApp, type ServerLogEvent } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { createJobRegistry } from '../src/jobs.js';

const origin = 'http://127.0.0.1:4319';
const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  host: '127.0.0.1',
  port: 4319,
  accessToken: undefined,
  allowedOrigins: [origin],
  maxBodyBytes: 1_048_576,
  maxConcurrentJobs: 2,
  maxQueuedJobs: 10,
  jobTtlMs: 60_000,
  ...overrides,
});

const result: Playlist = {
  id: '42',
  name: '测试歌单 🎵',
  source: 'netease',
  total: 1,
  tracks: [{
    title: '歌一',
    artists: ['歌手甲', '歌手乙'],
    source: 'netease',
    availability: 'available',
    position: 0,
    warnings: [],
  }],
  complete: true,
  warnings: [],
};

const provider = (fetchPlaylist?: MusicProvider['fetchPlaylist']): MusicProvider => ({
  id: 'netease',
  validateInput: vi.fn(async input => ({
    valid: /^\d+$/u.test(input.value),
    ...(/^\d+$/u.test(input.value) ? {} : { message: '请输入有效歌单 ID' }),
  })),
  authenticate: vi.fn(async () => ({ authenticated: false })),
  fetchPlaylist: fetchPlaylist ?? vi.fn(async (_input, context) => {
    context.onProgress?.({ phase: 'fetching', completed: 1, total: 1 });
    return result;
  }),
  fetchAllTracks: vi.fn(async () => result.tracks),
  logout: vi.fn(async () => undefined),
});

const noNetwork: HttpTransport = {
  async request() { throw new Error('real network disabled in API test'); },
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const createFixture = (options: {
  config?: ServerConfig;
  provider?: MusicProvider;
  logger?: (event: ServerLogEvent) => void;
} = {}) => {
  const selectedConfig = options.config ?? config();
  const jobs = createJobRegistry({
    maxConcurrent: selectedConfig.maxConcurrentJobs,
    maxQueued: selectedConfig.maxQueuedJobs,
    terminalTtlMs: selectedConfig.jobTtlMs,
    idFactory: () => 'job-1',
  });
  const selectedProvider = options.provider ?? provider();
  const app = createServerApp({
    config: selectedConfig,
    providers: new Map([['netease', selectedProvider]]),
    http: noNetwork,
    jobs,
    logger: options.logger,
    requestIdFactory: () => 'request-1',
  });
  return { app, jobs, provider: selectedProvider };
};

const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  origin,
  ...extra,
});

describe('local NAS API', () => {
  it('keeps healthz public and minimal', async () => {
    const { app, jobs } = createFixture({
      config: config({ accessToken: 'secret' }),
    });
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    jobs.close();
  });

  it('requires configured bearer auth and an exact origin for mutations', async () => {
    const { app, jobs } = createFixture({ config: config({ accessToken: 'secret' }) });
    const body = JSON.stringify({ provider: 'netease', input: { value: '42' } });

    const missing = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders(), body,
    });
    expect(missing.status).toBe(401);
    expect(JSON.stringify(await missing.json())).not.toContain('secret');

    const foreign = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ origin: 'https://evil.example', authorization: 'Bearer secret' }),
      body,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    const absentOrigin = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body,
    });
    expect(absentOrigin.status).toBe(403);

    const allowed = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ authorization: 'Bearer secret' }),
      body,
    });
    expect(allowed.status).toBe(202);
    jobs.close();
  });

  it('supports strict preflight without wildcard or credentials', async () => {
    const { app, jobs } = createFixture({ config: config({ accessToken: 'secret' }) });
    const response = await app.request('/api/playlists/inspect', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toContain('Origin');
    jobs.close();
  });

  it('runs inspect to completion and exports exact UTF-8 bytes from the stored job', async () => {
    const { app, jobs } = createFixture();
    const accepted = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('location')).toBe('/api/jobs/job-1');
    expect(await accepted.json()).toMatchObject({ jobId: 'job-1' });
    await flush();

    const inspected = await app.request('/api/jobs/job-1');
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({
      jobId: 'job-1', status: 'completed', result: { id: '42', total: 1 },
    });

    const exported = await app.request('/api/exports', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        jobId: 'job-1',
        options: { format: 'txt', date: '2026-09-04', generatedAt: '2026-09-04T00:00:00.000Z' },
      }),
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toBe('text/plain;charset=utf-8');
    expect(exported.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(exported.headers.get('cache-control')).toBe('no-store');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(await exported.arrayBuffer()))
      .toBe('歌一 - 歌手甲、歌手乙\n');
    jobs.close();
  });

  it('enforces the 1 MiB body limit before parsing or provider work', async () => {
    const selected = provider();
    const { app, jobs } = createFixture({ provider: selected });
    const response = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders(),
      body: 'x'.repeat(1_048_577),
    });
    expect(response.status).toBe(413);
    expect(selected.validateInput).not.toHaveBeenCalled();
    jobs.close();
  });

  it('rejects malformed requests without echoing their body', async () => {
    const { app, jobs } = createFixture();
    const malformed = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders(), body: '{"token":"should-not-escape"',
    });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).not.toContain('should-not-escape');

    const invalid = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'netease', input: { value: 'not-an-id' }, extra: true }),
    });
    expect(invalid.status).toBe(400);
    jobs.close();
  });

  it('cancels an active job and does not expose its input', async () => {
    let runningContext!: TaskContext;
    const never = new Promise<Playlist>(() => undefined);
    const selected = provider(vi.fn(async (_input, context) => {
      runningContext = context;
      return never;
    }));
    const { app, jobs } = createFixture({ provider: selected });
    await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    const cancelled = await app.request('/api/jobs/job-1', {
      method: 'DELETE', headers: { origin },
    });
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ jobId: 'job-1', status: 'cancelled' });
    expect(runningContext.signal.aborted).toBe(true);
    expect(JSON.stringify(jobs.get('job-1'))).not.toContain('42');
    jobs.close();
  });

  it('returns safe failed-job errors and allowlisted structured logs', async () => {
    const logs: ServerLogEvent[] = [];
    const selected = provider(vi.fn(async () => {
      throw new Error('Authorization: Bearer should-not-escape');
    }));
    const { app, jobs } = createFixture({ provider: selected, logger: event => logs.push(event) });
    await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    await flush();
    const response = await app.request('/api/jobs/job-1');
    const text = await response.text();
    expect(text).not.toContain('should-not-escape');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'TASK_FAILED' } });
    for (const event of logs) {
      expect(Object.keys(event).sort()).toEqual(['requestId', 'status']);
    }
    jobs.close();
  });
});
