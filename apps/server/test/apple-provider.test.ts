import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { createRestrictedFetch, startServer } from '../src/index.js';

// Synthetic placeholder only: it never looks like a real Apple JWT.
const APPLE_TOKEN = 'test-developer-token';
const PLAYLIST_INPUT = 'https://music.apple.com/us/playlist/synth/pl.u-synth01';

// startServer always wires a server object; the stub records nothing and
// opens no socket.
const stubServe = (() => ({ once: () => undefined })) as unknown as typeof serve;

const ORIGIN = 'http://127.0.0.1:4319';

// 认证存储指向临时目录，避免测试触碰真实的 /data。
const dataDirs: string[] = [];
afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'playlist-exporter-apple-data-'));
  dataDirs.push(dir);
  return dir;
};

// 默认账号 admin/admin 在 startServer 时自动创建；登录换回会话 Cookie。
const loginCookie = async (
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
): Promise<string> => {
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'admin', duration: '12h' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
};

const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  origin: ORIGIN,
  ...extra,
});

const song = (n: number): unknown => ({
  id: `144000000${n}`,
  type: 'songs',
  attributes: {
    name: `歌曲 ${n}`,
    artistName: `歌手甲 ${n}`,
    albumName: `专辑 ${n}`,
    previewUrl: `https://audio.example/preview-${n}.m4a`,
  },
});
const applePlaylistPage = (options: { trackCount?: number; next?: string } = {}): unknown => ({
  data: [{
    id: 'pl.u-synth01',
    type: 'playlists',
    attributes: {
      name: '合成歌单',
      playlistType: 'user',
      ...(options.trackCount === undefined ? {} : { trackCount: options.trackCount }),
    },
    relationships: {
      tracks: {
        href: 'https://api.music.apple.com/v1/catalog/us/playlists/pl.u-synth01/tracks',
        ...(options.next === undefined ? {} : { next: options.next }),
        data: [song(1), song(2)],
      },
    },
  }],
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 400 && !predicate(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

describe('apple-music provider wiring (Preview)', () => {
  it('registers apple-music only when APPLE_DEVELOPER_TOKEN is configured', () => {
    const serveStub = vi.fn(() => ({ once: () => undefined }) as unknown as ServerType);
    const withToken = startServer({
      env: { APPLE_DEVELOPER_TOKEN: APPLE_TOKEN, DATA_DIR: tempDataDir() },
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      serveImpl: serveStub,
      logger: () => undefined,
    });
    expect(withToken.config.appleDeveloperToken).toBe(APPLE_TOKEN);
    expect(withToken.app.request).toBeTypeOf('function');
    withToken.jobs.close();

    const withoutToken = startServer({
      env: { DATA_DIR: tempDataDir() },
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      serveImpl: serveStub,
      logger: () => undefined,
    });
    expect(withoutToken.config.appleDeveloperToken).toBeUndefined();
    withoutToken.jobs.close();
    expect(serveStub).toHaveBeenCalledTimes(2);
  });

  it('serves an apple-music inspect end-to-end through the restricted egress boundary', async () => {
    const seenAuthHeaders: string[] = [];
    const seenUrls: string[] = [];
    const runtime = startServer({
      env: { APPLE_DEVELOPER_TOKEN: APPLE_TOKEN, DATA_DIR: tempDataDir() },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        seenUrls.push(url);
        seenAuthHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify(applePlaylistPage({ trackCount: 2 })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      serveImpl: stubServe,
      logger: () => undefined,
    });
    const cookie = await loginCookie(runtime.app);

    const accepted = await runtime.app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'apple-music', input: { value: PLAYLIST_INPUT } }),
    });
    expect(accepted.status).toBe(202);
    const jobId = accepted.headers.get('location')?.split('/').pop() ?? '';
    await waitUntil(() => runtime.jobs.get(jobId)?.status !== undefined &&
      ['completed', 'failed'].includes(runtime.jobs.get(jobId)?.status ?? ''));

    const job = runtime.jobs.get(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.result).toMatchObject({
      id: 'pl.u-synth01',
      name: '合成歌单',
      source: 'apple-music',
      total: 2,
      complete: true,
    });
    expect(seenUrls).toEqual([
      'https://api.music.apple.com/v1/catalog/us/playlists/pl.u-synth01?limit=100',
    ]);
    expect(seenAuthHeaders).toEqual([`Bearer ${APPLE_TOKEN}`]);
    // The token must not leak into any job payload, result, or error field.
    expect(JSON.stringify(job)).not.toContain(APPLE_TOKEN);
    expect(JSON.stringify(job?.result)).not.toContain('previewUrl');
    runtime.jobs.close();
  });

  it('keeps apple-music unsupported (422) without a configured token', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    const runtime = startServer({
      env: { DATA_DIR: tempDataDir() },
      fetchImpl: upstream as unknown as typeof fetch,
      serveImpl: stubServe,
      logger: () => undefined,
    });
    const cookie = await loginCookie(runtime.app);
    const response = await runtime.app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'apple-music', input: { value: PLAYLIST_INPUT } }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    expect(upstream).not.toHaveBeenCalled();
    runtime.jobs.close();
  });

  it('fails an apple-music job with AUTH_REQUIRED on a rejected token and leaks nothing', async () => {
    const logs: string[] = [];
    const runtime = startServer({
      env: { APPLE_DEVELOPER_TOKEN: APPLE_TOKEN, DATA_DIR: tempDataDir() },
      fetchImpl: (async () => new Response(
        JSON.stringify({ errorMessage: 'must-not-escape' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
      serveImpl: stubServe,
      logger: event => logs.push(JSON.stringify(event)),
    });
    const cookie = await loginCookie(runtime.app);
    const accepted = await runtime.app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'apple-music', input: { value: PLAYLIST_INPUT } }),
    });
    expect(accepted.status).toBe(202);
    const jobId = accepted.headers.get('location')?.split('/').pop() ?? '';
    await waitUntil(() => runtime.jobs.get(jobId)?.status === 'failed');

    const job = runtime.jobs.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(job?.error?.message).toContain('开发者令牌无效或已过期');
    const serialized = JSON.stringify(job);
    expect(serialized).not.toContain(APPLE_TOKEN);
    expect(serialized).not.toContain('must-not-escape');
    for (const line of logs) expect(line).not.toContain(APPLE_TOKEN);
    runtime.jobs.close();
  });

  it('allows api.music.apple.com through the runtime fetch boundary and still blocks other hosts', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    const restricted = createRestrictedFetch(upstream as unknown as typeof fetch);

    await expect(restricted(
      'https://api.music.apple.com/v1/catalog/us/playlists/pl.u-synth01?limit=100',
    )).resolves.toMatchObject({ status: 200 });
    for (const url of [
      'http://api.music.apple.com/v1/catalog/us/playlists/pl.u-synth01',
      'https://api.music.apple.com.evil.example/v1/catalog/us/playlists/x',
      'https://user:pass@api.music.apple.com/v1/catalog/us/playlists/x',
      'https://api.music.apple.com:8443/v1/catalog/us/playlists/x',
    ]) {
      await expect(restricted(url)).rejects.toMatchObject({ code: 'EGRESS_NOT_ALLOWED' });
    }
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
