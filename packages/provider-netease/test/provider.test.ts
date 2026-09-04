import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_CODES,
  AppError,
  type HttpTransport,
  type TaskContext,
} from '@playlist-exporter/contracts';
import { NeteaseProvider } from '../src/provider.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'));
const response = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const context = (http: HttpTransport, signal = new AbortController().signal): TaskContext => ({
  http,
  signal,
});

describe('NeteaseProvider', () => {
  it('restores source order, retains duplicate IDs, and maps all artists', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http: HttpTransport = {
      async request(input, init) {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes('/api/v6/playlist/detail')) return response(fixture('playlist-detail'));
        return response(fixture('tracks-page-1'));
      },
    };
    const playlist = await new NeteaseProvider().fetchPlaylist({ value: '42' }, context(http));

    expect(playlist).toMatchObject({
      id: '42',
      name: '测试歌单 🎵',
      creator: '测试用户',
      source: 'netease',
      total: 3,
      complete: true,
    });
    expect(playlist.tracks.map(track => [track.trackId, track.title, track.position])).toEqual([
      ['101', '第一首', 0],
      ['102', '第二首', 1],
      ['101', '第一首', 2],
    ]);
    expect(playlist.tracks[1]?.artists).toEqual(['歌手乙', '歌手丙']);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://music.163.com/api/v3/song/detail');
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(String(calls[1]?.init?.body)).toContain('%22id%22');
  });

  it('fetches 1001 entries in two bounded batches and preserves every position', async () => {
    const trackIds = Array.from({ length: 1001 }, (_, index) => ({ id: index + 1 }));
    const batchSizes: number[] = [];
    const progress: Array<[number | undefined, number | undefined]> = [];
    const http: HttpTransport = {
      async request(input, init) {
        const url = String(input);
        if (url.includes('/api/v6/playlist/detail')) {
          return response({
            code: 200,
            playlist: { id: 99, name: '大型歌单', trackCount: 1001, trackIds },
          });
        }
        const ids = JSON.parse(new URLSearchParams(String(init?.body)).get('c') ?? '[]') as Array<{ id: number }>;
        batchSizes.push(ids.length);
        if (ids.length === 1) return response(fixture('tracks-page-2'));
        return response({
          code: 200,
          songs: [...ids].reverse().map(({ id }) => ({
            id,
            name: `歌曲 ${id}`,
            ar: [{ name: `歌手 ${id}` }],
            al: { name: `专辑 ${id}` },
          })),
        });
      },
    };
    const playlist = await new NeteaseProvider().fetchPlaylist({ value: '99' }, {
      ...context(http),
      onProgress: update => progress.push([update.completed, update.total]),
    });

    expect(batchSizes).toEqual([1000, 1]);
    expect(progress).toEqual([[1000, 1001], [1001, 1001]]);
    expect(playlist.tracks).toHaveLength(1001);
    expect(playlist.tracks[0]).toMatchObject({ trackId: '1', position: 0 });
    expect(playlist.tracks[1000]).toMatchObject({
      trackId: '1001',
      title: '第 1001 首',
      artists: ['末页歌手'],
      position: 1000,
    });
  });

  it('fetchAllTracks returns the same complete source-ordered track list', async () => {
    const http: HttpTransport = {
      async request(input) {
        return String(input).includes('/playlist/detail')
          ? response(fixture('playlist-detail'))
          : response(fixture('tracks-page-1'));
      },
    };
    const tracks = await new NeteaseProvider().fetchAllTracks('42', context(http));
    expect(tracks.map(track => track.trackId)).toEqual(['101', '102', '101']);
  });

  it('supports empty playlists without making a song-detail request', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response({
          code: 200,
          playlist: { id: 7, name: '空歌单', trackCount: 0, trackIds: [] },
        });
      },
    };
    const playlist = await new NeteaseProvider().fetchPlaylist({ value: '7' }, context(http));
    expect(playlist.tracks).toEqual([]);
    expect(playlist.total).toBe(0);
    expect(playlist.complete).toBe(true);
    expect(calls).toBe(1);
  });

  it('rejects an over-budget total before requesting any song-detail page', async () => {
    let songCalls = 0;
    const http: HttpTransport = {
      async request(input) {
        if (String(input).includes('/playlist/detail')) {
          return response(fixture('playlist-detail'));
        }
        songCalls += 1;
        return response(fixture('tracks-page-1'));
      },
    };
    const provider = new NeteaseProvider({ maxEntries: 2 });
    await expect(provider.fetchPlaylist({ value: '42' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(songCalls).toBe(0);
  });

  it('rejects an over-budget page count before requesting song details', async () => {
    let songCalls = 0;
    const http: HttpTransport = {
      async request(input) {
        if (String(input).includes('/playlist/detail')) {
          return response(fixture('playlist-detail'));
        }
        songCalls += 1;
        return response(fixture('tracks-page-1'));
      },
    };
    const provider = new NeteaseProvider({ pageSize: 1, maxPages: 2 });
    await expect(provider.fetchPlaylist({ value: '42' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(songCalls).toBe(0);
  });

  it('creates an explicit placeholder for missing song detail', async () => {
    const http: HttpTransport = {
      async request(input) {
        return String(input).includes('/playlist/detail')
          ? response(fixture('playlist-detail'))
          : response({ code: 200, songs: (fixture('tracks-page-1') as { songs: unknown[] }).songs.slice(0, 1) });
      },
    };
    const playlist = await new NeteaseProvider().fetchPlaylist({ value: '42' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      availability: 'removed',
      trackId: '101',
      position: 0,
    });
    expect(playlist.tracks[0]?.warnings.join(' ')).toContain('缺失');
  });

  it('marks missing artist metadata instead of silently dropping the track', async () => {
    const http: HttpTransport = {
      async request(input) {
        return String(input).includes('/playlist/detail')
          ? response({
              code: 200,
              playlist: { id: 8, name: '缺失歌手', trackCount: 1, trackIds: [{ id: 201 }] },
            })
          : response({
              code: 200,
              songs: [{ id: 201, name: '仍需保留', ar: [], al: { name: '专辑' } }],
            });
      },
    };
    const playlist = await new NeteaseProvider().fetchPlaylist({ value: '8' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '仍需保留',
      artists: ['[unknown artist]'],
      availability: 'available',
    });
    expect(playlist.tracks[0]?.warnings).toContain('歌手信息缺失');
  });

  it('keeps a song with a missing title using an explicit marker', async () => {
    const http: HttpTransport = {
      async request(input) {
        return String(input).includes('/playlist/detail')
          ? response({
              code: 200,
              playlist: { id: 9, name: '缺失标题', trackCount: 1, trackIds: [{ id: 301 }] },
            })
          : response({ code: 200, songs: [{ id: 301, ar: [{ name: '歌手' }], al: null }] });
      },
    };
    const playlist = await new NeteaseProvider().fetchPlaylist({ value: '9' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['歌手'],
      trackId: '301',
    });
    expect(playlist.tracks[0]?.warnings).toContain('歌曲名缺失');
  });

  it('retries a 429 response and respects cancellation wiring', async () => {
    let songAttempts = 0;
    const http: HttpTransport = {
      async request(input) {
        if (String(input).includes('/playlist/detail')) return response(fixture('playlist-detail'));
        songAttempts += 1;
        return songAttempts === 1
          ? response({ code: 429 }, 429, { 'Retry-After': '0' })
          : response(fixture('tracks-page-1'));
      },
    };
    const provider = new NeteaseProvider({ baseDelayMs: 0, maxDelayMs: 0 });
    await expect(provider.fetchPlaylist({ value: '42' }, context(http))).resolves.toMatchObject({
      complete: true,
    });
    expect(songAttempts).toBe(2);

    const cancelled = new AbortController();
    cancelled.abort(new DOMException('stop', 'AbortError'));
    let calls = 0;
    const neverCalled: HttpTransport = {
      async request() { calls += 1; return response({}); },
    };
    await expect(provider.fetchPlaylist({ value: '42' }, context(neverCalled, cancelled.signal)))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('stops after an in-flight request when the transport resolves despite cancellation', async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    let songCalls = 0;
    let markStarted!: () => void;
    let releaseSong!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const http: HttpTransport = {
      async request(input) {
        if (String(input).includes('/playlist/detail')) {
          return response({
            code: 200,
            playlist: {
              id: 10,
              name: '取消测试',
              trackCount: 3,
              trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }],
            },
          });
        }
        songCalls += 1;
        if (songCalls > 1) return response({ code: 200, songs: [] });
        markStarted();
        return new Promise<Response>(resolve => {
          releaseSong = () => resolve(response({
            code: 200,
            songs: [{ id: 1, name: '不应完成', ar: [{ name: '歌手' }], al: null }],
          }));
        });
      },
    };
    const pending = new NeteaseProvider({ pageSize: 1 }).fetchPlaylist(
      { value: '10' },
      {
        ...context(http, controller.signal),
        onProgress: update => {
          if (update.completed !== undefined) progress.push(update.completed);
        },
      },
    );
    await started;
    controller.abort(new DOMException('stop', 'AbortError'));
    releaseSong();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(songCalls).toBe(1);
    expect(progress).toEqual([]);
  });

  it('retries a response-body network interruption and redacts unknown transport errors', async () => {
    let attempts = 0;
    const interrupted: HttpTransport = {
      async request(input) {
        attempts += 1;
        if (attempts === 1) {
          const broken = response(fixture('playlist-detail'));
          Object.defineProperty(broken, 'json', {
            value: async () => { throw new TypeError('body stream interrupted'); },
          });
          return broken;
        }
        if (String(input).includes('/playlist/detail')) return response(fixture('playlist-detail'));
        return response(fixture('tracks-page-1'));
      },
    };
    await expect(new NeteaseProvider({
      baseDelayMs: 0,
      maxDelayMs: 0,
    }).fetchPlaylist({ value: '42' }, context(interrupted))).resolves.toMatchObject({ complete: true });
    expect(attempts).toBe(3);

    const unsafe: HttpTransport = {
      async request() { throw new Error('Authorization: Bearer should-not-escape'); },
    };
    const error = await new NeteaseProvider()
      .fetchPlaylist({ value: '42' }, context(unsafe))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.NETWORK_ERROR);
    expect(JSON.stringify(error)).not.toContain('should-not-escape');
    expect((error as Error).message).not.toContain('should-not-escape');
  });

  it.each([401, 403, 404])('maps HTTP %s without exposing a response body', async (status) => {
    const http: HttpTransport = {
      async request() { return response({ credential: 'must-not-escape' }, status); },
    };
    const error = await new NeteaseProvider()
      .fetchPlaylist({ value: '42' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect(JSON.stringify(error)).not.toContain('must-not-escape');
    if (status === 404) expect((error as Error).message).toContain('未找到');
  });

  it('rejects mismatched totals, non-2xx responses, and schema drift without leaking payloads', async () => {
    const mismatched: HttpTransport = {
      async request() {
        return response({
          code: 200,
          playlist: { id: 1, name: 'mismatch', trackCount: 2, trackIds: [{ id: 1 }] },
        });
      },
    };
    await expect(new NeteaseProvider().fetchPlaylist({ value: '1' }, context(mismatched)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });

    const forbidden: HttpTransport = { async request() { return response({ secret: 'do-not-log' }, 403); } };
    const statusError = await new NeteaseProvider()
      .fetchPlaylist({ value: '1' }, context(forbidden))
      .catch((error: unknown) => error);
    expect(statusError).toBeInstanceOf(AppError);
    expect((statusError as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect(JSON.stringify(statusError)).not.toContain('do-not-log');

    const drift: HttpTransport = { async request() { return response(fixture('schema-drift')); } };
    const schemaError = await new NeteaseProvider()
      .fetchPlaylist({ value: '1' }, context(drift))
      .catch((error: unknown) => error);
    expect(schemaError).toBeInstanceOf(AppError);
    expect((schemaError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');
    expect((schemaError as AppError).technicalDetails).toMatchObject({
      endpoint: '/api/v6/playlist/detail',
    });
  });

  it('bounds short-link redirects and rejects a redirect to a private or foreign target', async () => {
    const safeCalls: string[] = [];
    const safe: HttpTransport = {
      async request(input) {
        const url = String(input);
        safeCalls.push(url);
        if (url === 'https://163cn.tv/abc') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://music.163.com/playlist?id=42' },
          });
        }
        if (url.includes('/playlist/detail')) return response(fixture('playlist-detail'));
        return response(fixture('tracks-page-1'));
      },
    };
    await expect(new NeteaseProvider().fetchPlaylist({
      value: 'https://163cn.tv/abc',
    }, context(safe))).resolves.toMatchObject({ id: '42', complete: true });
    expect(safeCalls[0]).toBe('https://163cn.tv/abc');

    for (const location of [
      'http://127.0.0.1/admin',
      'https://evil.example/playlist?id=42',
      'https://user:pass@music.163.com/playlist?id=42',
    ]) {
      const unsafe: HttpTransport = {
        async request() {
          return new Response(null, { status: 302, headers: { location } });
        },
      };
      await expect(new NeteaseProvider().fetchPlaylist({
        value: 'https://163cn.tv/abc',
      }, context(unsafe))).rejects.toMatchObject({ code: 'INVALID_PLAYLIST_INPUT' });
    }
  });

  it('rejects a short-link redirect chain after the configured maximum', async () => {
    let redirects = 0;
    const looping: HttpTransport = {
      async request() {
        redirects += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `https://163cn.tv/hop${redirects}` },
        });
      },
    };
    await expect(new NeteaseProvider({ maxRedirects: 3 }).fetchPlaylist({
      value: 'https://163cn.tv/start',
    }, context(looping))).rejects.toMatchObject({ code: 'INVALID_PLAYLIST_INPUT' });
    expect(redirects).toBe(3);
  });

  it('retries rate limits and transient network errors while resolving a short link', async () => {
    let attempts = 0;
    const flaky: HttpTransport = {
      async request(input) {
        const url = String(input);
        if (url.startsWith('https://163cn.tv/')) {
          attempts += 1;
          if (attempts === 1) return response({ code: 429 }, 429, { 'Retry-After': '0' });
          if (attempts === 2) throw new TypeError('temporary network failure');
          return new Response(null, {
            status: 302,
            headers: { location: 'https://music.163.com/playlist?id=42' },
          });
        }
        if (url.includes('/playlist/detail')) return response(fixture('playlist-detail'));
        return response(fixture('tracks-page-1'));
      },
    };

    await expect(new NeteaseProvider({
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    }).fetchPlaylist({
      value: 'https://163cn.tv/flaky',
    }, context(flaky))).resolves.toMatchObject({ id: '42', complete: true });
    expect(attempts).toBe(3);
  });

  it('validates input and keeps anonymous authentication explicit', async () => {
    const provider = new NeteaseProvider();
    await expect(provider.validateInput({ value: 'https://music.163.com/playlist?id=42' }))
      .resolves.toEqual({ valid: true });
    await expect(provider.validateInput({ value: 'https://evil.example/playlist?id=42' }))
      .resolves.toMatchObject({ valid: false });
    await expect(provider.authenticate({})).resolves.toMatchObject({
      authenticated: false,
      warnings: [expect.stringContaining('公开歌单')],
    });
    await expect(provider.logout()).resolves.toBeUndefined();
  });
});
