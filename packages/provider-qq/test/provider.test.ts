import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_CODES,
  AppError,
  type HttpTransport,
  type TaskContext,
} from '@playlist-exporter/contracts';
import { QqProvider } from '../src/provider.js';

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
const song = (n: number): unknown => ({
  songid: 9000000 + n,
  songmid: `00SYNTHETIC${String(n).padStart(4, '0')}`,
  strMediaMid: `00SYNMEDIA${String(n).padStart(4, '0')}`,
  songname: `歌曲 ${n}`,
  singer: [{ id: n, mid: `00SINGER${String(n).padStart(4, '0')}`, name: `歌手 ${n}` }],
  albumname: `专辑 ${n}`,
  albumid: 5000 + n,
  interval: 200,
  pay: { payalbum: 0, paydownload: 1, payinfo: 1, payplay: 0, paytrackmouth: 1, paytrackprice: 0, timefree: 0 },
  switch: 16824361,
});
const fullSongIds = (count: number): string =>
  Array.from({ length: count }, (_, index) => 9000001 + index).join(',');
const pageResponse = (songlist: unknown[], songnum: number, songids?: string): unknown => ({
  code: 0,
  subcode: 0,
  accessed_plaza_cache: 0,
  accessed_favbase: 0,
  login: 'off**',
  cdnum: 1,
  realcdnum: 1,
  cdlist: [{
    disstid: '10000000001',
    dissid: 778112640,
    nick: 'PII昵称不应透出',
    uin: 123456789,
    headurl: 'https://img.example/pii-avatar.png',
    dissname: '大型歌单',
    songnum,
    total_song_num: songnum,
    cur_song_num: songlist.length,
    ...(songids === undefined ? {} : { songids }),
    songlist,
  }],
});
const requestParam = (input: string | URL): { disstid: string; song_begin: number; song_num: number } => {
  const url = new URL(String(input));
  return {
    disstid: url.searchParams.get('disstid') ?? '',
    song_begin: Number(url.searchParams.get('song_begin')),
    song_num: Number(url.searchParams.get('song_num')),
  };
};

// GBK byte table verified against TextDecoder('gbk'); used to synthesize a
// legacy GBK-encoded response body.
const GBK_BYTES: Record<string, number[]> = {
  '测': [0xB2, 0xE2],
  '试': [0xCA, 0xD4],
  '曲': [0xC7, 0xFA],
  '目': [0xC4, 0xBF],
  '一': [0xD2, 0xBB],
  '歌': [0xB8, 0xE8],
  '手': [0xCA, 0xD6],
  '甲': [0xBC, 0xD7],
  '单': [0xB5, 0xA5],
};
const asciiBytes = (value: string): number[] => Array.from(value, (ch) => ch.charCodeAt(0));
const gbkBytes = (value: string): number[] =>
  Array.from(value).flatMap((ch) => GBK_BYTES[ch] ?? [ch.charCodeAt(0)]);

describe('QqProvider', () => {
  it('restores source order, retains duplicate songs, maps all artists, and never leaks PII', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http: HttpTransport = {
      async request(input, init) {
        calls.push({ url: String(input), init });
        return response(fixture('playlist-page-1'));
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '42' }, context(http));

    expect(playlist).toMatchObject({
      id: '42',
      name: '测试歌单 🎵',
      source: 'qq-music',
      total: 3,
      complete: true,
    });
    // The requested id is echoed back, never the response disstid/dissid.
    expect('creator' in playlist).toBe(false);
    // Fixture ids are deliberately non-monotonic (9000003, 9000001, 9000003):
    // positions must follow the source songlist order, never the id order.
    expect(playlist.tracks.map(track => [track.trackId, track.title, track.position])).toEqual([
      ['00SYNTHETIC00AAAA', '第三首', 0],
      ['00SYNTHETIC00BBBB', '第一首', 1],
      ['00SYNTHETIC00AAAA', '第三首', 2],
    ]);
    expect(playlist.tracks[1]?.artists).toEqual(['歌手乙', '歌手丙']);
    const serialized = JSON.stringify(playlist);
    for (const forbidden of [
      'PII昵称不应透出',
      'PII加密标识不应透出',
      '123456789',
      'pii-avatar',
      '778112640',
      '99999999999',
      'encrypt_uin',
      'headurl',
      'nick',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg' +
      '?type=1&format=json&utf8=1&disstid=42&song_begin=0&song_num=500',
    );
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('referer')).toBe('https://y.qq.com/');
    expect(headers.get('accept')).toBe('application/json');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('fetches 1001 entries across three pages and passes the songids sentinel', async () => {
    const batchSizes: number[] = [];
    const progress: Array<[number | undefined, number | undefined]> = [];
    const http: HttpTransport = {
      async request(input) {
        const param = requestParam(input);
        const count = Math.min(param.song_num, 1001 - param.song_begin);
        batchSizes.push(count);
        const songlist = Array.from({ length: count }, (_, index) => song(param.song_begin + index + 1));
        return response(pageResponse(songlist, 1001, fullSongIds(1001)));
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '99' }, {
      ...context(http),
      onProgress: update => progress.push([update.completed, update.total]),
    });

    expect(batchSizes).toEqual([500, 500, 1]);
    expect(progress).toEqual([[500, 1001], [1000, 1001], [1001, 1001]]);
    expect(playlist.tracks).toHaveLength(1001);
    expect(playlist.complete).toBe(true);
    expect(playlist.tracks[0]).toMatchObject({ trackId: '00SYNTHETIC0001', position: 0 });
    expect(playlist.tracks[1000]).toMatchObject({
      trackId: '00SYNTHETIC1001',
      title: '歌曲 1001',
      artists: ['歌手 1001'],
      position: 1000,
    });
  });

  it('fetchAllTracks returns the same complete source-ordered track list', async () => {
    const http: HttpTransport = {
      async request() { return response(fixture('playlist-page-1')); },
    };
    const tracks = await new QqProvider().fetchAllTracks('42', context(http));
    expect(tracks.map(track => track.trackId)).toEqual([
      '00SYNTHETIC00AAAA',
      '00SYNTHETIC00BBBB',
      '00SYNTHETIC00AAAA',
    ]);
  });

  it('supports empty playlists with a null songlist without extra requests', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response({
          code: 0,
          subcode: 0,
          cdlist: [{
            disstid: '7',
            dissname: '空歌单',
            songnum: 0,
            songids: '',
            songlist: null,
          }],
        });
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '7' }, context(http));
    expect(playlist.tracks).toEqual([]);
    expect(playlist.total).toBe(0);
    expect(playlist.complete).toBe(true);
    expect(calls).toBe(1);
  });

  it('rejects an over-budget total before requesting a second page', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response(fixture('playlist-page-1'));
      },
    };
    const provider = new QqProvider({ maxEntries: 2 });
    await expect(provider.fetchPlaylist({ value: '42' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(calls).toBe(1);
  });

  it('rejects an over-budget page count before requesting a second page', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response(fixture('playlist-page-1'));
      },
    };
    const provider = new QqProvider({ pageSize: 1, maxPages: 2 });
    await expect(provider.fetchPlaylist({ value: '42' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(calls).toBe(1);
  });

  it('bounds the page size by the probe-verified endpoint limit', () => {
    expect(() => new QqProvider({ pageSize: 1001 })).toThrow(RangeError);
    expect(() => new QqProvider({ pageSize: 1000 })).not.toThrow();
  });

  it('creates an explicit placeholder for a missing songlist entry', async () => {
    const http: HttpTransport = {
      async request() {
        return response(pageResponse([null, song(1), song(2)], 3));
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '42' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      availability: 'removed',
      position: 0,
    });
    expect(playlist.tracks[0]?.warnings.join(' ')).toContain('缺失');
    expect(playlist.warnings.join(' ')).toContain('占位');
  });

  it('marks missing artist metadata instead of silently dropping the track', async () => {
    const http: HttpTransport = {
      async request() {
        return response(pageResponse(
          [{
            songid: 9000008,
            songmid: '00SYNTHETIC00HHHH',
            songname: '仍需保留',
            singer: [],
            albumname: '专辑',
          }],
          1,
        ));
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '8' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '仍需保留',
      artists: ['[unknown artist]'],
      availability: 'available',
      trackId: '00SYNTHETIC00HHHH',
    });
    expect(playlist.tracks[0]?.warnings).toContain('歌手信息缺失');
  });

  it('keeps a song with a missing title and falls back to the numeric songid', async () => {
    const http: HttpTransport = {
      async request() {
        return response(pageResponse([{ songid: 9000301, singer: [{ name: '歌手' }] }], 1));
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '9' }, context(http));
    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['歌手'],
      trackId: '9000301',
    });
    expect(playlist.tracks[0]?.warnings).toContain('歌曲名缺失');
  });

  it('reports a stalled cursor when a page makes no progress', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response(pageResponse([], 3));
      },
    };
    await expect(new QqProvider().fetchPlaylist({ value: '3' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
    expect(calls).toBe(1);
  });

  it('returns complete=false for an honest shortfall and rejects it from fetchAllTracks', async () => {
    const shortPage = pageResponse([song(1)], 2);
    const http: HttpTransport = {
      async request() { return response(shortPage); },
    };
    await expect(new QqProvider().fetchPlaylist({ value: '1' }, context(http)))
      .resolves.toMatchObject({ complete: false, total: 2 });
    await expect(new QqProvider().fetchAllTracks('1', context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
  });

  it('aborts when the songids sentinel length contradicts songnum', async () => {
    const http: HttpTransport = {
      async request() {
        return response(pageResponse([song(1), song(2)], 3, '9000001,9000002'));
      },
    };
    const error = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
    expect((error as AppError).technicalDetails).toMatchObject({
      reason: 'songids-length-mismatch',
      declaredSongIds: 2,
      songnum: 3,
    });
  });

  it('aborts when the paged songid order diverges from the songids sentinel', async () => {
    const http: HttpTransport = {
      async request() {
        return response(pageResponse([song(2), song(1)], 2, '9000001,9000002'));
      },
    };
    const error = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
    expect((error as AppError).technicalDetails).toMatchObject({
      reason: 'songids-order-mismatch',
      index: 0,
      expectedSongId: 9000001,
      receivedSongId: 9000002,
    });
  });

  it('rejects totals that change between pages', async () => {
    const http: HttpTransport = {
      async request(input) {
        const param = requestParam(input);
        if (param.song_begin === 0) {
          return response(pageResponse(
            Array.from({ length: 100 }, (_, index) => song(index + 1)),
            200,
          ));
        }
        return response(pageResponse(
          Array.from({ length: 99 }, (_, index) => song(index + 1)),
          199,
        ));
      },
    };
    await expect(new QqProvider({ pageSize: 100 }).fetchPlaylist({ value: '2' }, context(http)))
      .rejects.toMatchObject({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION });
  });

  it('retries a 429 response and respects cancellation wiring', async () => {
    let attempts = 0;
    const http: HttpTransport = {
      async request() {
        attempts += 1;
        return attempts === 1
          ? response({ code: 429 }, 429, { 'Retry-After': '0' })
          : response(fixture('playlist-page-1'));
      },
    };
    const provider = new QqProvider({ baseDelayMs: 0, maxDelayMs: 0 });
    await expect(provider.fetchPlaylist({ value: '42' }, context(http))).resolves.toMatchObject({
      complete: true,
    });
    expect(attempts).toBe(2);

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
    let markStarted!: () => void;
    let releasePage!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const http: HttpTransport = {
      async request() {
        markStarted();
        return new Promise<Response>(resolve => {
          releasePage = () => resolve(response(pageResponse(
            [{ songid: 9000001, songmid: '00SYNTHETIC0001', songname: '不应完成', singer: [{ name: '歌手' }] }],
            3,
          )));
        });
      },
    };
    const pending = new QqProvider({ pageSize: 1 }).fetchPlaylist(
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
    releasePage();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([]);
  });

  it('retries a response-body network interruption and redacts unknown transport errors', async () => {
    let attempts = 0;
    const interrupted: HttpTransport = {
      async request() {
        attempts += 1;
        if (attempts === 1) {
          const broken = response(fixture('playlist-page-1'));
          Object.defineProperty(broken, 'json', {
            value: async () => { throw new TypeError('body stream interrupted'); },
          });
          return broken;
        }
        return response(fixture('playlist-page-1'));
      },
    };
    await expect(new QqProvider({
      baseDelayMs: 0,
      maxDelayMs: 0,
    }).fetchPlaylist({ value: '42' }, context(interrupted))).resolves.toMatchObject({ complete: true });
    expect(attempts).toBe(2);

    const unsafe: HttpTransport = {
      async request() { throw new Error('Authorization: Bearer should-not-escape'); },
    };
    const error = await new QqProvider()
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
    const error = await new QqProvider()
      .fetchPlaylist({ value: '42' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect(JSON.stringify(error)).not.toContain('must-not-escape');
    if (status === 404) expect((error as Error).message).toContain('未找到');
  });

  it('maps a -1 envelope to playlist-not-found without retrying', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response({
          code: -1,
          subcode: 0,
          accessed_plaza_cache: 0,
          accessed_favbase: 0,
          login: 'off**',
          cdnum: 0,
          cdlist: [],
          realcdnum: 0,
        });
      },
    };
    const error = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect((error as Error).message).toContain('未找到该 QQ 音乐歌单');
    expect((error as AppError).technicalDetails).toMatchObject({
      endpoint: '/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
      code: -1,
    });
    expect(calls).toBe(1);
  });

  it('maps a live-observed code 10 envelope to playlist-not-found without retrying', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response({
          code: 10,
          subcode: 0,
          accessed_plaza_cache: 0,
          accessed_favbase: 0,
          login: 'off**',
          cdnum: 0,
          cdlist: [],
          realcdnum: 0,
        });
      },
    };
    const error = await new QqProvider()
      .fetchPlaylist({ value: '99999999999' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect((error as Error).message).toContain('未找到该 QQ 音乐歌单');
    expect((error as AppError).technicalDetails).toMatchObject({
      endpoint: '/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
      code: 10,
    });
    expect(calls).toBe(1);
  });

  it('maps an invalid referer envelope without retrying', async () => {
    let calls = 0;
    const http: HttpTransport = {
      async request() {
        calls += 1;
        return response({ code: 0, subcode: 1, msg: 'invalid referer' });
      },
    };
    const error = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(http))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect((error as AppError).technicalDetails).toMatchObject({ msg: 'invalid referer' });
    expect(calls).toBe(1);
  });

  it('rejects non-zero business codes and schema drift without leaking payloads', async () => {
    const businessFailure: HttpTransport = {
      async request() { return response({ code: 500003, subcode: 860100001 }); },
    };
    const businessError = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(businessFailure))
      .catch((error: unknown) => error);
    expect(businessError).toBeInstanceOf(AppError);
    expect((businessError as AppError).code).toBe('PROVIDER_HTTP_ERROR');
    expect((businessError as AppError).technicalDetails).toMatchObject({ code: 500003 });

    const emptyCdlist: HttpTransport = {
      async request() { return response({ code: 0, subcode: 0, cdlist: [] }); },
    };
    const emptyError = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(emptyCdlist))
      .catch((error: unknown) => error);
    expect(emptyError).toBeInstanceOf(AppError);
    expect((emptyError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');
    expect((emptyError as AppError).technicalDetails).toMatchObject({
      endpoint: '/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
      schemaPath: 'cdlist',
    });

    const drift: HttpTransport = {
      async request() { return response(fixture('schema-drift')); },
    };
    const schemaError = await new QqProvider()
      .fetchPlaylist({ value: '1' }, context(drift))
      .catch((error: unknown) => error);
    expect(schemaError).toBeInstanceOf(AppError);
    expect((schemaError as AppError).code).toBe('PROVIDER_SCHEMA_DRIFT');
    expect((schemaError as AppError).technicalDetails).toMatchObject({
      endpoint: '/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
    });
  });

  it('decodes a legacy GBK response via content-type sniffing', async () => {
    const gbkBody = new Uint8Array([
      ...asciiBytes('{"code":0,"subcode":0,"cdlist":[{"disstid":"42","dissname":"'),
      ...gbkBytes('测试歌单'),
      ...asciiBytes('","songnum":1,"songids":"9000001","songlist":[{"songid":9000001,' +
        '"songmid":"00SYNTHETIC00GBK","songname":"'),
      ...gbkBytes('测试曲目一'),
      ...asciiBytes('","singer":[{"name":"'),
      ...gbkBytes('歌手甲'),
      ...asciiBytes('"}],"albumname":"Synth Album"}]}]}'),
    ]);
    const http: HttpTransport = {
      async request() {
        return new Response(gbkBody, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=gb2312' },
        });
      },
    };
    const playlist = await new QqProvider().fetchPlaylist({ value: '42' }, context(http));
    expect(playlist.name).toBe('测试歌单');
    expect(playlist.tracks[0]).toMatchObject({
      title: '测试曲目一',
      artists: ['歌手甲'],
      availability: 'available',
      position: 0,
    });
    expect(playlist.complete).toBe(true);
  });

  it('validates input and keeps anonymous authentication explicit', async () => {
    const provider = new QqProvider();
    await expect(provider.validateInput({ value: 'https://y.qq.com/n/ryqq/playlist/42' }))
      .resolves.toEqual({ valid: true });
    await expect(provider.validateInput({ value: 'https://evil.example/playlist/42' }))
      .resolves.toMatchObject({ valid: false });
    await expect(provider.authenticate({})).resolves.toMatchObject({
      authenticated: false,
      warnings: [expect.stringContaining('公开歌单')],
    });
    await expect(provider.logout()).resolves.toBeUndefined();
  });
});
