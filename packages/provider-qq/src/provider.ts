import {
  APP_ERROR_CODES,
  AppError,
  playlistSchema,
  type AuthOptions,
  type AuthResult,
  type MusicProvider,
  type Playlist,
  type PlaylistInput,
  type TaskContext,
  type Track,
  type ValidationResult,
} from '@playlist-exporter/contracts';
import {
  createPaginationGuard,
  fetchWithRetry,
} from '@playlist-exporter/core';
import { parseQqPlaylistInput } from './input.js';
import { normalizeQqTracks } from './normalize.js';
import {
  qqPlaylistDetailResponseSchema,
  type QqCd,
} from './schemas.js';

const ORIGIN = 'https://i.y.qq.com';
const ENDPOINT = '/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg';
const REFERER = 'https://y.qq.com/';

export interface QqProviderOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

interface ResolvedOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxEntries: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const positiveInteger = (value: unknown, name: string, maximum?: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 ||
      (maximum !== undefined && value > maximum)) {
    throw new RangeError(`${name} must be a positive integer${maximum === undefined ? '' : ` <= ${maximum}`}`);
  }
  return value;
};
const nonnegative = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
  return value;
};
const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    const reason = signal.reason;
    throw reason instanceof DOMException && reason.name === 'AbortError' ? reason : abortError();
  }
};
const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' :
    typeof error === 'object' && error !== null && 'name' in error &&
    (error as { name?: unknown }).name === 'AbortError';
class InvalidJsonPayload extends Error {}

const invalidInput = (): AppError => new AppError({
  code: 'INVALID_PLAYLIST_INPUT',
  message: '无法识别该 QQ 音乐歌单链接',
});
const schemaError = (endpoint: string, path?: PropertyKey[]): AppError => new AppError({
  code: 'PROVIDER_SCHEMA_DRIFT',
  message: 'QQ 音乐返回的数据格式已发生变化',
  technicalDetails: {
    endpoint,
    ...(path === undefined || path.length === 0 ? {} : { schemaPath: path.map(String).join('.') }),
  },
});
const statusError = (endpoint: string, status: number): AppError => new AppError({
  code: 'PROVIDER_HTTP_ERROR',
  message: status === 404 ? '未找到该歌单' : 'QQ 音乐暂时无法读取该歌单',
  technicalDetails: { endpoint, status },
});
/**
 * Business errors for invalid or nonexistent disstids. Upstream reports them
 * with HTTP 200; both envelope code -1 (probe, 2026-09-05) and code 10 (live
 * re-verification with a nonexistent ID) have been observed for this class.
 */
const PLAYLIST_NOT_FOUND_CODES = new Set([-1, 10]);
const playlistNotFoundError = (endpoint: string, code: number): AppError => new AppError({
  code: 'PROVIDER_HTTP_ERROR',
  message: '未找到该 QQ 音乐歌单，请确认链接或歌单 ID',
  technicalDetails: { endpoint, code },
});
/** Business error for `msg: "invalid referer"`: the referer header was rejected. */
const refererError = (endpoint: string, msg: string): AppError => new AppError({
  code: 'PROVIDER_HTTP_ERROR',
  message: 'QQ 音乐请求来源校验失败，请稍后重试',
  technicalDetails: { endpoint, msg },
});
const businessError = (endpoint: string, code: number): AppError => new AppError({
  code: 'PROVIDER_HTTP_ERROR',
  message: 'QQ 音乐暂时无法读取该歌单',
  technicalDetails: { endpoint, code },
});
const safeRequestError = (endpoint: string, error: unknown): AppError => {
  if (isAbortError(error)) throw error;
  if (error instanceof InvalidJsonPayload) return schemaError(endpoint);
  const timedOut = error instanceof AppError && error.code === APP_ERROR_CODES.HTTP_TIMEOUT;
  return new AppError({
    code: timedOut ? APP_ERROR_CODES.HTTP_TIMEOUT : APP_ERROR_CODES.NETWORK_ERROR,
    message: timedOut
      ? 'QQ 音乐请求超时，请稍后重试'
      : '网络请求失败，请检查网络连接后重试',
    technicalDetails: { endpoint },
  });
};

const resolveOptions = (input: QqProviderOptions): ResolvedOptions => ({
  // Probe-verified: song_num up to 1000 is fully honored; 500 is the default
  // for a payload-size/latency balance.
  pageSize: positiveInteger(input.pageSize ?? 500, 'pageSize', 1000),
  maxPages: positiveInteger(input.maxPages ?? 1000, 'maxPages'),
  maxEntries: positiveInteger(input.maxEntries ?? 100_000, 'maxEntries'),
  maxAttempts: positiveInteger(input.maxAttempts ?? 3, 'maxAttempts'),
  baseDelayMs: nonnegative(input.baseDelayMs ?? 500, 'baseDelayMs'),
  maxDelayMs: nonnegative(input.maxDelayMs ?? 30_000, 'maxDelayMs'),
});

/** Legacy endpoints may answer with a GBK body despite utf8=1. */
const parseJsonBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/gb2312|gbk/i.test(contentType)) return response.json();
  const bytes = await response.arrayBuffer();
  return JSON.parse(new TextDecoder('gbk').decode(bytes));
};

/** Parses the comma-joined `songids` manifest into the declared songid order. */
const parseSongIdSequence = (value: string): number[] => {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  return trimmed.split(',').map((part) => Number(part.trim()));
};

interface FetchedPages {
  readonly playlistId: string;
  readonly title: string;
  readonly total: number;
  readonly tracks: Track[];
  readonly entries: number;
  readonly complete: boolean;
}

export class QqProvider implements MusicProvider {
  public readonly id = 'qq-music' as const;
  private readonly options: ResolvedOptions;

  public constructor(options: QqProviderOptions = {}) {
    this.options = resolveOptions(options);
  }

  public async validateInput(input: PlaylistInput): Promise<ValidationResult> {
    try {
      parseQqPlaylistInput(input);
      return { valid: true };
    } catch {
      return { valid: false, message: '请输入有效的 QQ 音乐歌单链接或歌单 ID' };
    }
  }

  public async authenticate(_options: AuthOptions): Promise<AuthResult> {
    return {
      authenticated: false,
      warnings: ['公开歌单无需登录；私人歌单登录尚未支持'],
    };
  }

  public async logout(): Promise<void> {
    // This anonymous provider stores no credential state.
  }

  public async fetchPlaylist(input: PlaylistInput, context: TaskContext): Promise<Playlist> {
    throwIfAborted(context.signal);
    const playlistId = parseQqPlaylistInput(input).playlistId;
    const fetched = await this.fetchAllPages(playlistId, context);
    const missing = fetched.tracks.filter(track => track.availability !== 'available').length;
    const warnings = missing === 0 ? [] : [`${missing} 首歌曲详情缺失，已保留占位`];
    if (!fetched.complete) {
      warnings.push(`歌单声明 ${fetched.total} 首，实际读取到 ${fetched.entries} 首，结果不完整`);
    }
    return playlistSchema.parse({
      id: fetched.playlistId,
      name: fetched.title,
      source: 'qq-music',
      total: fetched.total,
      tracks: fetched.tracks,
      complete: fetched.complete,
      warnings,
    });
  }

  public async fetchAllTracks(playlistId: string, context: TaskContext): Promise<Track[]> {
    const parsed = parseQqPlaylistInput({ value: playlistId });
    const fetched = await this.fetchAllPages(parsed.playlistId, context);
    if (!fetched.complete) {
      throw new AppError({
        code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
        message: '歌单曲目数量不完整，请稍后重试',
        technicalDetails: {
          declaredTotal: fetched.total,
          receivedTracks: fetched.entries,
        },
      });
    }
    return fetched.tracks;
  }

  private assertWithinBudgets(total: number): void {
    const requiredPages = Math.ceil(total / this.options.pageSize);
    if (total <= this.options.maxEntries && requiredPages <= this.options.maxPages) return;
    throw new AppError({
      code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
      message: '歌单大小超过当前安全读取上限',
      technicalDetails: {
        total,
        requiredPages,
        maxEntries: this.options.maxEntries,
        maxPages: this.options.maxPages,
      },
    });
  }

  /**
   * Anti-truncation sentinel: each paged response carries the full ordered
   * `songids` manifest. Whenever it is present, the accumulated songid
   * sequence of the read must match it exactly, and its length must equal the
   * declared songnum; any divergence aborts the export instead of exporting
   * corrupted data. When it is absent, completeness falls back to the
   * count-based short-page policy.
   */
  private assertSongIdsConsistent(
    declaredSongIds: string | undefined,
    received: readonly number[],
    total: number,
  ): void {
    if (declaredSongIds === undefined) return;
    const declared = parseSongIdSequence(declaredSongIds);
    if (declared.length !== total) {
      throw new AppError({
        code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
        message: '歌单完整性校验未通过，已停止导出以避免错误数据',
        technicalDetails: {
          reason: 'songids-length-mismatch',
          declaredSongIds: declared.length,
          songnum: total,
        },
      });
    }
    if (declared.length !== received.length) {
      throw new AppError({
        code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
        message: '歌单完整性校验未通过，已停止导出以避免错误数据',
        technicalDetails: {
          reason: 'songids-order-mismatch',
          declaredSongIds: declared.length,
          receivedSongIds: received.length,
        },
      });
    }
    for (let index = 0; index < declared.length; index += 1) {
      if (declared[index] !== received[index]) {
        throw new AppError({
          code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
          message: '歌单完整性校验未通过，已停止导出以避免错误数据',
          technicalDetails: {
            reason: 'songids-order-mismatch',
            index,
            expectedSongId: declared[index],
            receivedSongId: received[index],
          },
        });
      }
    }
  }

  /**
   * Pages the playlist with client-maintained song_begin/song_num cursors
   * (the upstream clamps echoed cursors, so echoes are never trusted). The
   * declared songnum must stay consistent between pages; a page that fails to
   * advance the cursor while a remainder is declared is reported by the
   * pagination guard as stalled; a short page that ends before songnum yields
   * an honest complete=false snapshot instead of a fabricated success.
   */
  private async fetchAllPages(playlistId: string, context: TaskContext): Promise<FetchedPages> {
    const guard = createPaginationGuard({
      maxPages: this.options.maxPages,
      maxEntries: this.options.maxEntries,
      allowedTerminalPolicies: ['short-page'],
    });
    const tracks: Track[] = [];
    const receivedSongIds: number[] = [];
    let declaredSongIds: string | undefined;
    let title: string | undefined;
    let offset = 0;
    let total = 0;
    let exhausted = false;
    for (;;) {
      throwIfAborted(context.signal);
      guard.beforePage({ requestKey: `song_begin:${offset}`, requestedSize: this.options.pageSize });
      const page = await this.fetchPage(playlistId, offset, context);
      throwIfAborted(context.signal);
      if (offset === 0) {
        title = page.dissname;
        total = page.songnum;
        this.assertWithinBudgets(total);
      }
      declaredSongIds ??= page.songids ?? undefined;
      const items = page.songlist;
      const nextOffset = offset + items.length;
      const moreDeclared = nextOffset < page.songnum;
      // A continuation key is only claimed when the next page will actually be
      // requested; stopping early must leave the guard free to report the
      // shortfall via the short-page terminal policy.
      const willContinue = moreDeclared && items.length === this.options.pageSize;
      guard.recordPage({
        rawItemCount: items.length,
        expectedTotal: page.songnum,
        nextRequestKey: willContinue ? `song_begin:${nextOffset}` : null,
      });
      for (const entry of items) {
        if (entry !== null && entry.songid !== undefined && entry.songid !== null) {
          receivedSongIds.push(Number(entry.songid));
        }
      }
      tracks.push(...normalizeQqTracks(items, offset));
      context.onProgress?.({
        phase: 'fetching',
        completed: nextOffset,
        total: page.songnum,
        message: `已读取 ${nextOffset}/${page.songnum} 首`,
      });
      if (!moreDeclared) {
        exhausted = true;
        break;
      }
      if (items.length === 0) {
        // A declared remainder with zero progress: declaring the identical
        // repeat makes the guard report the stalled cursor instead of
        // looping forever.
        guard.beforePage({ requestKey: `song_begin:${nextOffset}`, requestedSize: this.options.pageSize });
      }
      if (items.length < this.options.pageSize) break;
      offset = nextOffset;
    }
    this.assertSongIdsConsistent(declaredSongIds, receivedSongIds, total);
    const snapshot = exhausted
      ? guard.finish({ kind: 'expected-total', expectedTotal: total })
      : guard.finish({ kind: 'short-page' });
    if (title === undefined) throw schemaError(ENDPOINT, ['cdlist', 'dissname']);
    return {
      playlistId,
      title,
      total,
      tracks,
      entries: snapshot.entries,
      complete: snapshot.complete,
    };
  }

  private async fetchPage(playlistId: string, songBegin: number, context: TaskContext): Promise<QqCd> {
    const url = new URL(ENDPOINT, ORIGIN);
    url.searchParams.set('type', '1');
    url.searchParams.set('format', 'json');
    url.searchParams.set('utf8', '1');
    url.searchParams.set('disstid', playlistId);
    url.searchParams.set('song_begin', String(songBegin));
    url.searchParams.set('song_num', String(this.options.pageSize));
    const raw = await this.requestJson(context, url);
    const parsed = qqPlaylistDetailResponseSchema.safeParse(raw);
    if (!parsed.success) throw schemaError(ENDPOINT, parsed.error.issues[0]?.path);
    const envelope = parsed.data;
    // Business failures are detected after parsing, outside the retry loop,
    // so they are never retried.
    if (envelope.code !== 0 && PLAYLIST_NOT_FOUND_CODES.has(envelope.code)) {
      throw playlistNotFoundError(ENDPOINT, envelope.code);
    }
    if (envelope.msg?.trim().toLowerCase() === 'invalid referer') {
      throw refererError(ENDPOINT, envelope.msg);
    }
    if (envelope.code !== 0) throw businessError(ENDPOINT, envelope.code);
    if (envelope.cdlist === undefined || envelope.cdlist === null || envelope.cdlist.length === 0) {
      throw schemaError(ENDPOINT, ['cdlist']);
    }
    return envelope.cdlist[0];
  }

  private async requestJson(context: TaskContext, url: URL): Promise<unknown> {
    throwIfAborted(context.signal);
    let raw: unknown;
    let response: Response;
    try {
      response = await fetchWithRetry(
        async ({ signal }) => {
          const attemptResponse = await context.http.request(url, {
            method: 'GET',
            redirect: 'error',
            headers: {
              accept: 'application/json',
              referer: REFERER,
            },
            signal,
          });
          throwIfAborted(signal);
          if (attemptResponse.ok) {
            try {
              raw = await parseJsonBody(attemptResponse);
              throwIfAborted(signal);
            } catch (error) {
              if (isAbortError(error) || error instanceof TypeError) throw error;
              throw new InvalidJsonPayload();
            }
          }
          return attemptResponse;
        },
        {
          signal: context.signal,
          maxAttempts: this.options.maxAttempts,
          baseDelayMs: this.options.baseDelayMs,
          maxDelayMs: this.options.maxDelayMs,
        },
      );
    } catch (error) {
      throw safeRequestError(ENDPOINT, error);
    }
    throwIfAborted(context.signal);
    if (!response.ok) throw statusError(ENDPOINT, response.status);
    return raw;
  }
}
