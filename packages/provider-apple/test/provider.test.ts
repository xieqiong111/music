import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_CODES,
  AppError,
  type HttpTransport,
  type TaskContext,
} from '@playlist-exporter/contracts';
import { AppleProvider } from '../src/provider.js';
import { parseApplePlaylistInput } from '../src/input.js';

// Synthetic placeholder only: it never looks like a real Apple JWT and must
// never be replaced by real credential material in tests.
const TOKEN = 'test-developer-token';

const response = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const context = (http: HttpTransport, signal = new AbortController().signal): TaskContext => ({
  http,
  signal,
});

const song = (n: number): Record<string, unknown> => ({
  id: `144000000${n}`,
  type: 'songs',
  attributes: {
    name: `歌曲 ${n}`,
    artistName: `歌手甲 & 歌手乙 ${n}`,
    albumName: `专辑 ${n}`,
    trackNumber: n,
    durationInMillis: 200_000 + n,
    artwork: { url: 'https://art.example/synth.png' },
    previewUrl: `https://audio.example/preview-${n}.m4a`,
    contentRating: 'explicit',
    playParams: { id: 'must-not-escape' },
  },
});
const playlistPage = (options: {
  songs?: unknown[];
  trackCount?: number;
  next?: string;
  storefront?: string;
  id?: string;
}): unknown => ({
  data: [{
    id: options.id ?? 'pl.u-synth01',
    type: 'playlists',
    attributes: {
      name: '合成歌单',
      curatorName: '不应透出的策展人',
      playlistType: 'user',
      ...(options.trackCount === undefined ? {} : { trackCount: options.trackCount }),
    },
    relationships: {
      tracks: {
        href: `https://api.music.apple.com/v1/catalog/${options.storefront ?? 'us'}` +
          `/playlists/${options.id ?? 'pl.u-synth01'}/tracks`,
        ...(options.next === undefined ? {} : { next: options.next }),
        data: options.songs ?? [],
      },
    },
  }],
  meta: { wrapper: 'must-not-escape' },
});
const tracksPage = (options: { songs: unknown[]; next?: string }): unknown => ({
  data: options.songs,
  ...(options.next === undefined ? {} : { next: options.next }),
  meta: { wrapper: 'must-not-escape' },
});
const nextUrl = (offset: number): string =>
  `https://api.music.apple.com/v1/catalog/us/playlists/pl.u-synth01/tracks` +
  `?offset=${offset}&limit=100`;
const songs = (from: number, to: number): unknown[] =>
  Array.from({ length: to - from + 1 }, (_, index) => song(from + index));

interface Call {
  readonly url: URL;
  readonly init?: RequestInit;
}
const transport = (
  handler: (url: URL) => Response | Promise<Response>,
): { http: HttpTransport; calls: Call[] } => {
  const calls: Call[] = [];
  const http: HttpTransport = {
    async request(input, init) {
      const url = new URL(String(input));
      calls.push({ url, init });
      return handler(url);
    },
  };
  return { http, calls };
};

describe('AppleProvider', () => {
  it('fetches a single 12-track page with exact request shape and no unmodeled leakage', async () => {
    const { http, calls } = transport(() => response(
      playlistPage({ songs: songs(1, 12), trackCount: 12 }),
    ));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));

    expect(playlist).toMatchObject({
      id: 'pl.u-synth01',
      name: '合成歌单',
      source: 'apple-music',
      total: 12,
      complete: true,
    });
    expect(playlist.tracks).toHaveLength(12);
    expect(playlist.tracks.map(track => [track.position, track.trackId])).toEqual(
      Array.from({ length: 12 }, (_, index) => [index, `144000000${index + 1}`]),
    );
    // artistName is one pre-joined string and is never split into artists.
    expect(playlist.tracks[0]?.artists).toEqual(['歌手甲 & 歌手乙 1']);
    const serialized = JSON.stringify(playlist);
    for (const forbidden of [
      'previewUrl', 'preview-', 'art.example', 'contentRating', 'playParams',
      'must-not-escape', 'curatorName', 'playlistType', 'durationInMillis',
      'trackNumber', 'trackCount',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe(
      'https://api.music.apple.com/v1/catalog/us/playlists/pl.u-synth01?limit=100',
    );
    expect(JSON.stringify(calls[0]?.url)).not.toContain(TOKEN);
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('accept')).toBe('application/json');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('pages 251 tracks across three next links with continuous positions', async () => {
    const progress: Array<[number | undefined, number | undefined]> = [];
    const { http, calls } = transport(url => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (offset === 0) {
        return response(playlistPage({
          songs: songs(1, 100), trackCount: 251, next: nextUrl(100),
        }));
      }
      if (offset === 100) return response(tracksPage({ songs: songs(101, 200), next: nextUrl(200) }));
      return response(tracksPage({ songs: songs(201, 251) }));
    });
    const playlist = await new AppleProvider(() => TOKEN).fetchPlaylist(
      { value: 'https://music.apple.com/us/playlist/synth/pl.u-synth01' },
      { ...context(http), onProgress: update => progress.push([update.completed, update.total]) },
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]?.url.toString()).toBe(nextUrl(100));
    expect(calls[2]?.url.toString()).toBe(nextUrl(200));
    expect(progress).toEqual([[100, 251], [200, 251], [251, 251]]);
    expect(playlist.tracks).toHaveLength(251);
    expect(playlist.complete).toBe(true);
    expect(playlist.total).toBe(251);
    expect(playlist.tracks[0]).toMatchObject({ position: 0, trackId: '1440000001' });
    expect(playlist.tracks[250]).toMatchObject({
      position: 250,
      title: '歌曲 251',
      trackId: '144000000251',
    });
  });

  it('reads a missing trackCount as "everything served" and still completes', async () => {
    const { http, calls } = transport(() => response(playlistPage({ songs: songs(1, 3) })));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist).toMatchObject({ total: 3, complete: true });
    expect(playlist.warnings).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('supports an empty playlist with a single request', async () => {
    const { http, calls } = transport(() => response(playlistPage({ songs: [], trackCount: 0 })));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist).toMatchObject({ total: 0, complete: true, tracks: [] });
    expect(calls).toHaveLength(1);
  });

  it('reports a stalled next cursor instead of looping forever', async () => {
    const { http, calls } = transport(url => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (offset === 0) {
        return response(playlistPage({ songs: songs(1, 2), trackCount: 3, next: nextUrl(100) }));
      }
      return response(tracksPage({ songs: songs(3, 3), next: nextUrl(100) }));
    });
    await expect(new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(calls).toHaveLength(2);
  });

  it('returns an honest complete=false snapshot when trackCount overstates the page count', async () => {
    const { http } = transport(() => response(
      playlistPage({ songs: songs(1, 2), trackCount: 5 }),
    ));
    const provider = new AppleProvider(() => TOKEN);
    await expect(provider.fetchPlaylist({ value: 'pl.u-synth01' }, context(http)))
      .resolves.toMatchObject({
        total: 5,
        complete: false,
        warnings: [expect.stringContaining('结果不完整')],
      });
    await expect(provider.fetchAllTracks('pl.u-synth01', context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
  });

  it('aborts with INCOMPLETE_PAGINATION when more tracks arrive than trackCount declares', async () => {
    const { http } = transport(() => response(
      playlistPage({ songs: songs(1, 5), trackCount: 2 }),
    ));
    await expect(new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
  });

  it('rejects totals that change between pages', async () => {
    const { http } = transport(url => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (offset === 0) {
        return response(playlistPage({ songs: songs(1, 2), trackCount: 200, next: nextUrl(100) }));
      }
      return response(tracksPage({ songs: songs(3, 4), next: nextUrl(200) }));
    });
    await expect(new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
  });

  it('bounds a declared total against the entry and page budgets before paging on', async () => {
    const { http, calls } = transport(() => response(
      playlistPage({ songs: songs(1, 3), trackCount: 12 }),
    ));
    const provider = new AppleProvider(() => TOKEN, { maxEntries: 2 });
    await expect(provider.fetchPlaylist({ value: 'pl.u-synth01' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(calls).toHaveLength(1);
  });

  it('caps pageSize at the MusicKit limit of 100', () => {
    expect(() => new AppleProvider(() => TOKEN, { pageSize: 101 })).toThrow(RangeError);
    expect(() => new AppleProvider(() => TOKEN, { pageSize: 100 })).not.toThrow();
  });

  it('keeps non-song entries as placeholders with continuous positions', async () => {
    const musicVideo = {
      id: 'mv-synth-1',
      type: 'music-videos',
      attributes: {
        name: '合成 MV',
        artistName: '歌手甲',
        previewUrl: 'https://audio.example/mv.m4a',
      },
    };
    const { http } = transport(() => response(playlistPage({
      songs: [song(1), musicVideo, song(2)],
      trackCount: 3,
    })));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist.tracks[1]).toMatchObject({
      title: '合成 MV',
      artists: ['歌手甲'],
      trackId: 'mv-synth-1',
      availability: 'unknown',
      position: 1,
    });
    expect(playlist.tracks[1]?.warnings.join(' ')).toContain('非歌曲类型条目');
    expect(playlist.tracks[2]?.position).toBe(2);
    expect(playlist.warnings.join(' ')).toContain('非歌曲条目已保留为占位');
    expect(JSON.stringify(playlist)).not.toContain('mv.m4a');
  });

  it('marks a missing artist instead of dropping the track', async () => {
    const { http } = transport(() => response(playlistPage({
      songs: [{ id: '1440noartist', type: 'songs', attributes: { name: '仍需保留' } }],
      trackCount: 1,
    })));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '仍需保留',
      artists: ['[unknown artist]'],
      trackId: '1440noartist',
      availability: 'available',
    });
    expect(playlist.tracks[0]?.warnings).toContain('歌手信息缺失');
  });

  it('keeps a song with a missing title', async () => {
    const { http } = transport(() => response(playlistPage({
      songs: [{ id: '1440notitle', type: 'songs', attributes: { artistName: '歌手甲' } }],
      trackCount: 1,
    })));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['歌手甲'],
      trackId: '1440notitle',
    });
    expect(playlist.tracks[0]?.warnings).toContain('歌曲名缺失');
  });

  it('creates an explicit removed placeholder for a null entry', async () => {
    const { http } = transport(() => response(playlistPage({
      songs: [null, song(1)],
      trackCount: 2,
    })));
    const playlist = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      availability: 'removed',
      position: 0,
    });
    expect(playlist.warnings.join(' ')).toContain('占位');
  });

  it('maps 401 to AUTH_REQUIRED without retrying, upgrading auth, or leaking the token', async () => {
    const { http, calls } = transport(() => response({ errorMessage: 'must-not-escape' }, 401));
    const error = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('AUTH_REQUIRED');
    expect((error as Error).message).toContain('开发者令牌无效或已过期');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain('must-not-escape');
    expect(calls).toHaveLength(1);
  });

  it.each([403, 404])('maps HTTP %s without exposing a response body', async (status) => {
    const { http } = transport(() => response({ errorMessage: 'must-not-escape' }, status));
    const error = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect(JSON.stringify(error)).not.toContain('must-not-escape');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    if (status === 404) expect((error as Error).message).toContain('未找到');
    if (status === 403) expect((error as Error).message).toContain('权限');
  });

  it('retries a 429 response and honors the Retry-After wiring', async () => {
    let attempts = 0;
    const { http } = transport(() => {
      attempts += 1;
      return attempts === 1
        ? response({ errorMessage: 'rate limited' }, 429, { 'Retry-After': '0' })
        : response(playlistPage({ songs: songs(1, 1), trackCount: 1 }));
    });
    const playlist = await new AppleProvider(() => TOKEN, { baseDelayMs: 0, maxDelayMs: 0 })
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist).toMatchObject({ complete: true });
    expect(attempts).toBe(2);
  });

  it('gives up after bounded 429 attempts', async () => {
    let attempts = 0;
    const { http } = transport(() => {
      attempts += 1;
      return response({}, 429, { 'Retry-After': '0' });
    });
    const error = await new AppleProvider(() => TOKEN, {
      maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0,
    }).fetchPlaylist({ value: 'pl.u-synth01' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect((error as AppError).technicalDetails).toMatchObject({ status: 429 });
    expect(attempts).toBe(2);
  });

  it('retries a transient 5xx response and then succeeds', async () => {
    let attempts = 0;
    const { http } = transport(() => {
      attempts += 1;
      return attempts === 1
        ? response({ errorMessage: 'boom' }, 500)
        : response(playlistPage({ songs: songs(1, 1), trackCount: 1 }));
    });
    const playlist = await new AppleProvider(() => TOKEN, { baseDelayMs: 0, maxDelayMs: 0 })
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http));
    expect(playlist).toMatchObject({ complete: true });
    expect(attempts).toBe(2);
  });

  it('retries transport timeouts and maps exhaustion to HTTP_TIMEOUT', async () => {
    let attempts = 0;
    const { http } = transport(() => {
      attempts += 1;
      throw new AppError({ code: APP_ERROR_CODES.HTTP_TIMEOUT, message: '请求超时' });
    });
    await expect(new AppleProvider(() => TOKEN, {
      maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0,
    }).fetchPlaylist({ value: 'pl.u-synth01' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.HTTP_TIMEOUT });
    expect(attempts).toBe(2);

    const recovering = transport(() => {
      attempts += 1;
      if (attempts === 1) throw new AppError({ code: APP_ERROR_CODES.HTTP_TIMEOUT, message: '请求超时' });
      return response(playlistPage({ songs: songs(1, 1), trackCount: 1 }));
    });
    await expect(new AppleProvider(() => TOKEN, { baseDelayMs: 0, maxDelayMs: 0 })
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(recovering.http)))
      .resolves.toMatchObject({ complete: true });
  });

  it('maps network failures to NETWORK_ERROR and never leaks the token', async () => {
    let attempts = 0;
    const failing: HttpTransport = {
      async request() {
        attempts += 1;
        throw new TypeError('network down');
      },
    };
    const error = await new AppleProvider(() => TOKEN, {
      maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0,
    }).fetchPlaylist({ value: 'pl.u-synth01' }, context(failing))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.NETWORK_ERROR);
    expect(attempts).toBe(2);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain('network down');

    const unsafe: HttpTransport = {
      async request() { throw new Error('Authorization: Bearer should-not-escape'); },
    };
    const redacted = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(unsafe))
      .catch((caught: unknown) => caught);
    expect(redacted).toBeInstanceOf(AppError);
    expect((redacted as AppError).code).toBe(APP_ERROR_CODES.NETWORK_ERROR);
    expect(JSON.stringify(redacted)).not.toContain('should-not-escape');
  });

  it('rejects a missing or blank developer token before any request', async () => {
    for (const token of [undefined, '', '   ']) {
      let calls = 0;
      const http: HttpTransport = {
        async request() {
          calls += 1;
          return response(playlistPage({ songs: [song(1)], trackCount: 1 }));
        },
      };
      const error = await new AppleProvider(() => token)
        .fetchPlaylist({ value: 'pl.u-synth01' }, context(http))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('AUTH_REQUIRED');
      expect((error as Error).message).toBe('缺少 Apple Music 开发者令牌');
      expect(JSON.stringify(error)).not.toContain('token');
      expect(calls).toBe(0);
    }
  });

  it('aborts before any request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response(playlistPage({ songs: [song(1)], trackCount: 1 }));
      },
    };
    await expect(new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http, controller.signal)))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('stops after an in-flight request when the transport resolves despite cancellation', async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    let markStarted!: () => void;
    let releasePage!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const http: HttpTransport = {
      async request() {
        markStarted();
        return new Promise<Response>(resolve => {
          releasePage = () => resolve(response(playlistPage({
            songs: [song(1)], trackCount: 3,
          })));
        });
      },
    };
    const pending = new AppleProvider(() => TOKEN).fetchPlaylist(
      { value: 'pl.u-synth01' },
      {
        ...context(http, controller.signal),
        onProgress: update => {
          if (update.completed !== undefined) progress.push(update.completed);
        },
      },
    );
    await started;
    controller.abort(new DOMException('stop', 'AbortError'));
    releasePage();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([]);
  });

  it('reports schema drift for envelope and malformed-next shapes', async () => {
    const missingData = transport(() => response({ meta: {} }));
    const missingDataError = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(missingData.http))
      .catch((caught: unknown) => caught);
    expect(missingDataError).toBeInstanceOf(AppError);
    expect((missingDataError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');
    expect((missingDataError as AppError).technicalDetails)
      .toMatchObject({ endpoint: PLAYLIST_ENDPOINT_LABEL });

    const missingName = transport(() => response({ data: [{ id: 'x', type: 'playlists' }] }));
    const missingNameError = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(missingName.http))
      .catch((caught: unknown) => caught);
    expect(missingNameError).toBeInstanceOf(AppError);
    expect((missingNameError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');

    const invalidJson = transport(() => response('not-json{{', 200));
    const invalidJsonError = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(invalidJson.http))
      .catch((caught: unknown) => caught);
    expect(invalidJsonError).toBeInstanceOf(AppError);
    expect((invalidJsonError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');

    const foreignNext = transport(() => response(playlistPage({
      songs: songs(1, 2), trackCount: 5, next: 'https://evil.example/tracks?offset=100',
    })));
    const foreignNextError = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(foreignNext.http))
      .catch((caught: unknown) => caught);
    expect(foreignNextError).toBeInstanceOf(AppError);
    expect((foreignNextError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');
    expect((foreignNextError as AppError).technicalDetails).toMatchObject({ schemaPath: 'next' });
  });

  it('maps an empty data envelope to playlist-not-found without retrying', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response({ data: [] });
      },
    };
    const error = await new AppleProvider(() => TOKEN)
      .fetchPlaylist({ value: 'pl.u-synth01' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect((error as Error).message).toContain('未找到该 Apple Music 歌单');
    expect(calls).toBe(1);
  });

  it('uses the storefront of the parsed link in the catalog URL', async () => {
    const { http, calls } = transport(() => response(playlistPage({
      storefront: 'cn', songs: [song(1)], trackCount: 1,
    })));
    await new AppleProvider(() => TOKEN)
      .fetchPlaylist(
        { value: 'https://music.apple.com/cn/playlist/synth/pl.u-synth01' },
        context(http),
      );
    expect(calls[0]?.url.toString())
      .toBe('https://api.music.apple.com/v1/catalog/cn/playlists/pl.u-synth01?limit=100');
  });

  it('mirrors anonymous auth semantics and validates inputs', async () => {
    const provider = new AppleProvider(() => TOKEN);
    await expect(provider.validateInput({ value: 'https://music.apple.com/us/playlist/pl.u-synth01' }))
      .resolves.toEqual({ valid: true });
    await expect(provider.validateInput({ value: 'https://evil.example/playlist/1' }))
      .resolves.toMatchObject({ valid: false, message: expect.stringContaining('Apple Music') });
    await expect(provider.authenticate({})).resolves.toMatchObject({
      authenticated: false,
      warnings: [expect.stringContaining('公开歌单')],
    });
    await expect(provider.logout()).resolves.toBeUndefined();
  });

  it('requires a developer token provider function', () => {
    expect(() => new AppleProvider(undefined as never)).toThrow(TypeError);
    expect(() => new AppleProvider('token' as never)).toThrow(TypeError);
  });

  it('returns complete source-ordered tracks from fetchAllTracks', async () => {
    const { http } = transport(() => response(playlistPage({
      songs: [song(2), song(1), song(2)], trackCount: 3,
    })));
    const tracks = await new AppleProvider(() => TOKEN)
      .fetchAllTracks('pl.u-synth01', context(http));
    expect(tracks.map(track => track.position)).toEqual([0, 1, 2]);
    expect(tracks[0]?.trackId).toBe('1440000002');
    expect(tracks[2]?.trackId).toBe('1440000002');
  });
});

// Kept in sync with the provider constant; the drift tests assert against it.
const PLAYLIST_ENDPOINT_LABEL = '/v1/catalog/{storefront}/playlists/{id}';

describe('parseApplePlaylistInput (provider smoke)', () => {
  it('parses the canonical share link shape', () => {
    expect(parseApplePlaylistInput({ value: 'https://music.apple.com/us/playlist/a/pl.u-synth01' }))
      .toEqual({ kind: 'playlist-ref', storefront: 'us', playlistId: 'pl.u-synth01' });
  });
});
