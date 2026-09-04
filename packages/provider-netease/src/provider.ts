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
import { isNeteaseRedirectHost, parseNeteasePlaylistInput } from './input.js';
import { normalizeNeteaseTracks } from './normalize.js';
import {
  neteasePlaylistDetailResponseSchema,
  neteaseSongDetailResponseSchema,
  type NeteasePlaylistDetailResponse,
  type NeteaseSongDetailResponse,
  type NeteaseTrackId,
} from './schemas.js';

const ORIGIN = 'https://music.163.com';
const DETAIL_PATH = '/api/v6/playlist/detail';
const SONG_PATH = '/api/v3/song/detail';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface NeteaseProviderOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxRedirects?: number;
}

interface ResolvedOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxEntries: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRedirects: number;
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
  message: '无法识别该网易云音乐歌单链接',
});
const schemaError = (endpoint: string, path?: PropertyKey[]): AppError => new AppError({
  code: 'PROVIDER_SCHEMA_DRIFT',
  message: '网易云音乐返回的数据格式已发生变化',
  technicalDetails: {
    endpoint,
    ...(path === undefined || path.length === 0 ? {} : { schemaPath: path.map(String).join('.') }),
  },
});
const statusError = (endpoint: string, status: number): AppError => new AppError({
  code: 'PROVIDER_HTTP_ERROR',
  message: status === 404 ? '未找到该歌单' : '网易云音乐暂时无法读取该歌单',
  technicalDetails: { endpoint, status },
});
const safeRequestError = (endpoint: string, error: unknown): AppError => {
  if (isAbortError(error)) throw error;
  if (error instanceof InvalidJsonPayload) return schemaError(endpoint);
  const timedOut = error instanceof AppError && error.code === APP_ERROR_CODES.HTTP_TIMEOUT;
  return new AppError({
    code: timedOut ? APP_ERROR_CODES.HTTP_TIMEOUT : APP_ERROR_CODES.NETWORK_ERROR,
    message: timedOut
      ? '网易云音乐请求超时，请稍后重试'
      : '网络请求失败，请检查网络连接后重试',
    technicalDetails: { endpoint },
  });
};

const resolveOptions = (input: NeteaseProviderOptions): ResolvedOptions => ({
  pageSize: positiveInteger(input.pageSize ?? 1000, 'pageSize', 1000),
  maxPages: positiveInteger(input.maxPages ?? 1000, 'maxPages'),
  maxEntries: positiveInteger(input.maxEntries ?? 100_000, 'maxEntries'),
  maxAttempts: positiveInteger(input.maxAttempts ?? 3, 'maxAttempts'),
  baseDelayMs: nonnegative(input.baseDelayMs ?? 500, 'baseDelayMs'),
  maxDelayMs: nonnegative(input.maxDelayMs ?? 30_000, 'maxDelayMs'),
  maxRedirects: positiveInteger(input.maxRedirects ?? 3, 'maxRedirects', 3),
});

export class NeteaseProvider implements MusicProvider {
  public readonly id = 'netease' as const;
  private readonly options: ResolvedOptions;

  public constructor(options: NeteaseProviderOptions = {}) {
    this.options = resolveOptions(options);
  }

  public async validateInput(input: PlaylistInput): Promise<ValidationResult> {
    try {
      parseNeteasePlaylistInput(input);
      return { valid: true };
    } catch {
      return { valid: false, message: '请输入有效的网易云音乐歌单链接或歌单 ID' };
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
    const playlistId = await this.resolvePlaylistId(input, context);
    const detail = await this.fetchDetail(playlistId, context);
    const declaredTotal = detail.playlist.trackCount;
    const orderedIds = detail.playlist.trackIds;
    if (declaredTotal !== orderedIds.length) {
      throw new AppError({
        code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
        message: '歌单曲目数量不完整，请稍后重试',
        technicalDetails: {
          declaredTotal,
          receivedTrackIds: orderedIds.length,
        },
      });
    }
    this.assertWithinBudgets(orderedIds.length);

    const tracks = await this.fetchTracks(orderedIds, context);
    const missing = tracks.filter(track => track.availability !== 'available').length;
    return playlistSchema.parse({
      id: String(detail.playlist.id),
      name: detail.playlist.name,
      ...(detail.playlist.creator?.nickname === undefined
        ? {}
        : { creator: detail.playlist.creator.nickname }),
      source: 'netease',
      total: orderedIds.length,
      tracks,
      complete: true,
      warnings: missing === 0 ? [] : [`${missing} 首歌曲详情缺失，已保留占位`],
    });
  }

  public async fetchAllTracks(playlistId: string, context: TaskContext): Promise<Track[]> {
    const parsed = parseNeteasePlaylistInput({ value: playlistId });
    if (parsed.kind !== 'playlist-id') throw invalidInput();
    const detail = await this.fetchDetail(parsed.playlistId, context);
    if (detail.playlist.trackCount !== detail.playlist.trackIds.length) {
      throw new AppError({
        code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
        message: '歌单曲目数量不完整，请稍后重试',
        technicalDetails: {
          declaredTotal: detail.playlist.trackCount,
          receivedTrackIds: detail.playlist.trackIds.length,
        },
      });
    }
    this.assertWithinBudgets(detail.playlist.trackIds.length);
    return this.fetchTracks(detail.playlist.trackIds, context);
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

  private async resolvePlaylistId(input: PlaylistInput, context: TaskContext): Promise<string> {
    let parsed = parseNeteasePlaylistInput(input);
    if (parsed.kind === 'playlist-id') return parsed.playlistId;
    let current = new URL(parsed.url);

    for (let hop = 0; hop < this.options.maxRedirects; hop += 1) {
      throwIfAborted(context.signal);
      let response: Response;
      try {
        response = await fetchWithRetry(
          ({ signal }) => context.http.request(current, {
            method: 'GET',
            redirect: 'manual',
            signal,
          }),
          {
            maxAttempts: this.options.maxAttempts,
            baseDelayMs: this.options.baseDelayMs,
            maxDelayMs: this.options.maxDelayMs,
            signal: context.signal,
          },
        );
      } catch (error) {
        throw safeRequestError('short-link', error);
      }
      throwIfAborted(context.signal);
      if (!REDIRECT_STATUSES.has(response.status)) throw invalidInput();
      const location = response.headers.get('location');
      if (location === null) throw invalidInput();
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw invalidInput();
      }
      if (!isNeteaseRedirectHost(next)) throw invalidInput();
      parsed = parseNeteasePlaylistInput({ value: next.toString() });
      if (parsed.kind === 'playlist-id') return parsed.playlistId;
      current = new URL(parsed.url);
    }
    throw invalidInput();
  }

  private async requestJson(
    context: TaskContext,
    endpoint: string,
    input: string | URL,
    init: RequestInit,
  ): Promise<unknown> {
    throwIfAborted(context.signal);
    let raw: unknown;
    let response: Response;
    try {
      response = await fetchWithRetry(
        async ({ signal }) => {
          const attemptResponse = await context.http.request(input, { ...init, signal });
          throwIfAborted(signal);
          if (attemptResponse.ok) {
            try {
              raw = await attemptResponse.json();
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
      throw safeRequestError(endpoint, error);
    }
    throwIfAborted(context.signal);
    if (!response.ok) throw statusError(endpoint, response.status);
    return raw;
  }

  private async fetchDetail(
    playlistId: string,
    context: TaskContext,
  ): Promise<NeteasePlaylistDetailResponse> {
    const url = new URL(DETAIL_PATH, ORIGIN);
    url.searchParams.set('id', playlistId);
    url.searchParams.set('n', '100000');
    url.searchParams.set('s', '8');
    const raw = await this.requestJson(context, DETAIL_PATH, url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        referer: `${ORIGIN}/`,
      },
    });
    const parsed = neteasePlaylistDetailResponseSchema.safeParse(raw);
    if (!parsed.success) throw schemaError(DETAIL_PATH, parsed.error.issues[0]?.path);
    if (parsed.data.code !== 200) throw statusError(DETAIL_PATH, parsed.data.code);
    return parsed.data;
  }

  private async fetchSongPage(
    ids: readonly NeteaseTrackId[],
    context: TaskContext,
  ): Promise<NeteaseSongDetailResponse> {
    const body = new URLSearchParams({
      c: JSON.stringify(ids.map(({ id }) => ({ id }))),
    }).toString();
    const raw = await this.requestJson(context, SONG_PATH, new URL(SONG_PATH, ORIGIN), {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        referer: `${ORIGIN}/`,
      },
      body,
    });
    const parsed = neteaseSongDetailResponseSchema.safeParse(raw);
    if (!parsed.success) throw schemaError(SONG_PATH, parsed.error.issues[0]?.path);
    if (parsed.data.code !== 200) throw statusError(SONG_PATH, parsed.data.code);
    return parsed.data;
  }

  private async fetchTracks(
    orderedIds: readonly NeteaseTrackId[],
    context: TaskContext,
  ): Promise<Track[]> {
    const guard = createPaginationGuard({
      maxPages: this.options.maxPages,
      maxEntries: this.options.maxEntries,
    });
    if (orderedIds.length === 0) {
      guard.finish({ kind: 'expected-total', expectedTotal: 0 });
      guard.assertComplete();
      return [];
    }

    const tracks: Track[] = [];
    for (let offset = 0; offset < orderedIds.length; offset += this.options.pageSize) {
      throwIfAborted(context.signal);
      const pageIds = orderedIds.slice(offset, offset + this.options.pageSize);
      guard.beforePage({ requestKey: `offset:${offset}`, requestedSize: this.options.pageSize });
      const page = await this.fetchSongPage(pageIds, context);
      throwIfAborted(context.signal);
      tracks.push(...normalizeNeteaseTracks(pageIds, page.songs, offset));
      const nextOffset = offset + pageIds.length;
      guard.recordPage({
        rawItemCount: pageIds.length,
        expectedTotal: orderedIds.length,
        nextRequestKey: nextOffset < orderedIds.length ? `offset:${nextOffset}` : null,
      });
      context.onProgress?.({
        phase: 'fetching',
        completed: nextOffset,
        total: orderedIds.length,
        message: `已读取 ${nextOffset}/${orderedIds.length} 首`,
      });
    }
    guard.finish({ kind: 'expected-total', expectedTotal: orderedIds.length });
    guard.assertComplete();
    return tracks;
  }
}
