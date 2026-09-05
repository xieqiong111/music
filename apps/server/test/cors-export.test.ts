import { describe, expect, it } from 'vitest';
import type {
  HttpTransport,
  MusicProvider,
  Playlist,
} from '@playlist-exporter/contracts';
import { createServerApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { createJobRegistry, type TimerHandle } from '../src/jobs.js';

// The UI runs on a different port than the API, so these requests exercise the
// genuine cross-origin path instead of the same-origin Vite proxy.
const serverOrigin = 'http://127.0.0.1:4319';
const uiOrigin = 'http://127.0.0.1:5219';
const accessToken = 'local-export-token';

const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  host: '127.0.0.1',
  port: 4319,
  accessToken,
  allowedOrigins: [serverOrigin, uiOrigin],
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

const provider = (): MusicProvider => ({
  id: 'netease',
  validateInput: async input => ({
    valid: /^\d+$/u.test(input.value),
    ...(/^\d+$/u.test(input.value) ? {} : { message: '请输入有效歌单 ID' }),
  }),
  authenticate: async () => ({ authenticated: false }),
  fetchPlaylist: async () => result,
  fetchAllTracks: async () => result.tracks,
  logout: async () => undefined,
});

const noNetwork: HttpTransport = {
  async request() { throw new Error('real network disabled in CORS export test'); },
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

interface FakeTimer {
  readonly callback: () => void;
  readonly at: number;
}

// Deterministic clock shared with the job registry; no real timers exist and
// nothing in these tests waits on wall-clock time.
const fakeClock = (start: number) => {
  const clock = { now: start };
  let timers: FakeTimer[] = [];
  const setTimer = (callback: () => void, delayMs: number): FakeTimer => {
    const timer: FakeTimer = { callback, at: clock.now + delayMs };
    timers = [...timers, timer];
    return timer;
  };
  const clearTimer = (handle: TimerHandle): void => {
    timers = timers.filter(timer => timer !== handle);
  };
  return { clock, setTimer, clearTimer };
};

const createFixture = (
  options: { jobTtlMs?: number; clock?: ReturnType<typeof fakeClock> } = {},
): { app: ReturnType<typeof createServerApp>; jobs: ReturnType<typeof createJobRegistry> } => {
  const selectedConfig = config({ jobTtlMs: options.jobTtlMs ?? 60_000 });
  const injectedClock = options.clock;
  const jobs = createJobRegistry({
    maxConcurrent: selectedConfig.maxConcurrentJobs,
    maxQueued: selectedConfig.maxQueuedJobs,
    terminalTtlMs: selectedConfig.jobTtlMs,
    idFactory: () => 'job-1',
    // With an injected clock the registry uses it for every decision; the
    // expiry callbacks are captured but never fired because the tests advance
    // the clock explicitly instead.
    ...(injectedClock === undefined ? {} : {
      now: () => injectedClock.clock.now,
      setTimer: injectedClock.setTimer,
      clearTimer: injectedClock.clearTimer,
    }),
  });
  const app = createServerApp({
    config: selectedConfig,
    providers: new Map([['netease', provider()]]),
    http: noNetwork,
    jobs,
    requestIdFactory: () => 'request-1',
  });
  return { app, jobs };
};

const authorizedHeaders = (origin: string): Record<string, string> => ({
  'content-type': 'application/json',
  origin,
  authorization: `Bearer ${accessToken}`,
});

const exportJob = async (
  app: ReturnType<typeof createServerApp>,
  origin: string,
): Promise<Response> => app.request('/api/exports', {
  method: 'POST',
  headers: authorizedHeaders(origin),
  body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt' } }),
});

const inspectToCompletion = async (
  app: ReturnType<typeof createServerApp>,
  origin: string,
): Promise<void> => {
  const accepted = await app.request('/api/playlists/inspect', {
    method: 'POST',
    headers: authorizedHeaders(origin),
    body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
  });
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get('location')).toBe('/api/jobs/job-1');
  await flush();
};

describe('export response CORS contract', () => {
  it('exposes content-disposition with the validated origin on cross-origin exports', async () => {
    const { app, jobs } = createFixture();
    await inspectToCompletion(app, uiOrigin);

    const preflight = await app.request('/api/playlists/inspect', {
      method: 'OPTIONS',
      headers: {
        origin: uiOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(uiOrigin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect(preflight.headers.get('vary')).toContain('Origin');

    const exported = await exportJob(app, uiOrigin);
    expect(exported.status).toBe(200);
    // The actual response must agree with the preflight and repeat the exact
    // validated origin, never a wildcard.
    expect(exported.headers.get('access-control-allow-origin')).toBe(uiOrigin);
    expect(exported.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(exported.headers.get('vary')).toContain('Origin');
    const exposed = exported.headers.get('access-control-expose-headers') ?? '';
    expect(exposed.toLowerCase().split(',').map(value => value.trim()))
      .toContain('content-disposition');
    expect(exposed).not.toContain('*');
    expect(exported.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(exported.headers.get('cache-control')).toBe('no-store');
    jobs.close();
  });

  it('keeps same-origin exports working with identical bytes', async () => {
    const { app, jobs } = createFixture();
    await inspectToCompletion(app, serverOrigin);
    const exported = await app.request('/api/exports', {
      method: 'POST',
      headers: authorizedHeaders(serverOrigin),
      body: JSON.stringify({
        jobId: 'job-1',
        options: { format: 'txt', date: '2026-09-04', generatedAt: '2026-09-04T00:00:00.000Z' },
      }),
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('access-control-allow-origin')).toBe(serverOrigin);
    expect(exported.headers.get('access-control-expose-headers')).toBe('Content-Disposition');
    expect(exported.headers.get('content-type')).toBe('text/plain;charset=utf-8');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(await exported.arrayBuffer()))
      .toBe('歌一 - 歌手甲、歌手乙\n');
    jobs.close();
  });

  it('never returns an export response for foreign origins or invalid tokens', async () => {
    const { app, jobs } = createFixture();
    await inspectToCompletion(app, uiOrigin);

    const foreign = await app.request('/api/exports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt' } }),
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect(foreign.headers.get('access-control-expose-headers')).toBeNull();

    const unauthorized = await app.request('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: uiOrigin },
      body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt' } }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-expose-headers')).toBeNull();
    expect(JSON.stringify(await unauthorized.json())).not.toContain(accessToken);

    const wrong = await app.request('/api/exports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: uiOrigin,
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt' } }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('access-control-expose-headers')).toBeNull();
    jobs.close();
  });
});

describe('export across the job ttl boundary', () => {
  it('serves the first export before the boundary and none after it', async () => {
    const clock = fakeClock(1_000);
    const { app, jobs } = createFixture({ jobTtlMs: 500, clock });
    await inspectToCompletion(app, uiOrigin);

    clock.clock.now = 1_200;
    const first = await exportJob(app, uiOrigin);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(first.headers.get('access-control-expose-headers')).toBe('Content-Disposition');

    clock.clock.now = 1_499;
    const inspected = await app.request('/api/jobs/job-1', {
      headers: { origin: uiOrigin, authorization: `Bearer ${accessToken}` },
    });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ jobId: 'job-1', status: 'completed' });

    // At the boundary the job is gone: the second export must not produce a
    // file and reports the job as not found.
    clock.clock.now = 1_500;
    const second = await exportJob(app, uiOrigin);
    expect(second.status).toBe(404);
    expect(await second.json()).toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect(second.headers.get('content-disposition')).toBeNull();
    expect(second.headers.get('access-control-expose-headers')).toBeNull();

    clock.clock.now = 1_501;
    const third = await exportJob(app, uiOrigin);
    expect(third.status).toBe(404);
    expect(await third.json()).toMatchObject({ code: 'JOB_NOT_FOUND' });
    jobs.close();
  });
});
