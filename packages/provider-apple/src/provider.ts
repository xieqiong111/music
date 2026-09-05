import {
  APP_ERROR_CODES,
  AppError,
  isAppError,
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
import {
  parseApplePlaylistInput,
  type ParsedApplePlaylistInput,
} from './input.js';
import { normalizeAppleTracks } from './normalize.js';
import {
  appleCatalogPlaylistResponseSchema,
  appleCatalogTracksResponseSchema,
  type AppleCatalogEntry,
} from './schemas.js';

const API_ORIGIN = 'https://api.music.apple.com';
const API_HOST = 'api.music.apple.com';
// Endpoint labels for structured diagnostics. Labels are static templates so
// neither playlist ids nor any credential material can leak into errors.
const PLAYLIST_ENDPOINT = '/v1/catalog/{storefront}/playlists/{id}';
const TRACKS_ENDPOINT = '/v1/catalog/{storefront}/playlists/{id}/tracks';

export interface AppleProviderOptions {
  /** Storefront assumed for bare playlist IDs (default `us`). */
  readonly defaultStorefront?: string;
  /** `limit` of the first playlist request (MusicKit caps it at 100). */
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

interface ResolvedOptions {
  readonly defaultStorefront: string;
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

const schemaError = (endpoint: string, path?: PropertyKey[]): AppError => new AppError({
  code: 'PROVIDER_SCHEMA_DRIFT',
  message: 'Apple Music 返回的数据格式已发生变化',
  technicalDetails: {
    endpoint,
    ...(path === undefined || path.length === 0 ? {} : { schemaPath: path.map(String).join('.') }),
  },
});
const playlistNotFoundError = (endpoint: string): AppError => new AppError({
  code: 'PROVIDER_HTTP_ERROR',
  message: '未找到该 Apple Music 歌单，请确认链接或歌单 ID',
  technicalDetails: { endpoint },
});
/**
 * HTTP status mapping. 401 maps to the AUTH_REQUIRED semantics shared with the
 * server API: the developer token is operator-supplied and is NEVER refreshed,
 * retried, or "upgraded" automatically — the export simply fails.
 */
const statusError = (endpoint: string, status: number): AppError => {
  if (status === 401) {
    return new AppError({
      code: 'AUTH_REQUIRED',
      message: '开发者令牌无效或已过期，请检查服务器配置',
      technicalDetails: { endpoint, status },
    });
  }
  if (status === 403) {
    return new AppError({
      code: 'PROVIDER_HTTP_ERROR',
      message: '没有权限读取该 Apple Music 歌单',
      technicalDetails: { endpoint, status },
    });
  }
  if (status === 404) {
    return playlistNotFoundError(endpoint);
  }
  return new AppError({
    code: 'PROVIDER_HTTP_ERROR',
    message: 'Apple Music 暂时无法读取该歌单',
    technicalDetails: { endpoint, status },
  });
};
const safeRequestError = (endpoint: string, error: unknown): AppError => {
  if (isAbortError(error)) throw error;
  if (error instanceof InvalidJsonPayload) return schemaError(endpoint);
  const timedOut = error instanceof AppError && error.code === APP_ERROR_CODES.HTTP_TIMEOUT;
  return new AppError({
    code: timedOut ? APP_ERROR_CODES.HTTP_TIMEOUT : APP_ERROR_CODES.NETWORK_ERROR,
    message: timedOut
      ? 'Apple Music 请求超时，请稍后重试'
      : '网络请求失败，请检查网络连接后重试',
    technicalDetails: { endpoint },
  });
};

const resolveOptions = (input: AppleProviderOptions): ResolvedOptions => {
  const defaultStorefront = input.defaultStorefront ?? 'us';
  if (!/^[a-z]{2}$/u.test(defaultStorefront)) {
    throw new RangeError('defaultStorefront must be a two-letter lowercase storefront');
  }
  return {
    defaultStorefront,
    // MusicKit caps `limit` at 100 for playlist tracks; 100 is the default.
    pageSize: positiveInteger(input.pageSize ?? 100, 'pageSize', 100),
    maxPages: positiveInteger(input.maxPages ?? 1000, 'maxPages'),
    maxEntries: positiveInteger(input.maxEntries ?? 100_000, 'maxEntries'),
    maxAttempts: positiveInteger(input.maxAttempts ?? 3, 'maxAttempts'),
    baseDelayMs: nonnegative(input.baseDelayMs ?? 500, 'baseDelayMs'),
    maxDelayMs: nonnegative(input.maxDelayMs ?? 30_000, 'maxDelayMs'),
  };
};

/**
 * Continuation pages are requested by the `relationships.tracks.next` URL,
 * which Apple may serve as an absolute URL or as a path relative to the API
 * origin (see https://developer.apple.com/documentation/applemusicapi/fetching-resources-by-page).
 * Origin and path are pinned here as defense in depth: a poisoned `next` is
 * resolved against the fixed API origin and must still be an HTTPS URL on
 * api.music.apple.com without userinfo or port, and must point exactly at the
 * tracks path of the current storefront and current playlist — so it cannot
 * pivot the export to another origin, resource, or playlist even when the
 * injected transport lacks an egress filter.
 */
const parseNextUrl = (next: string, tracksPath: string): URL => {
  let url: URL;
  try {
    url = new URL(next, API_ORIGIN);
  } catch {
    throw schemaError(TRACKS_ENDPOINT, ['next']);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.port !== '' || url.hostname.toLowerCase() !== API_HOST ||
      url.pathname !== tracksPath) {
    throw schemaError(TRACKS_ENDPOINT, ['next']);
  }
  return url;
};

/**
 * Pagination request keys use the `offset` query of the next URL when present,
 * falling back to the full next URL. A repeated key therefore means Apple
 * stopped advancing pagination and is reported as stalled by the guard.
 */
const requestKeyForNext = (url: URL): string => {
  const offset = url.searchParams.get('offset');
  return offset !== null && /^\d{1,12}$/u.test(offset) ? `offset:${offset}` : url.toString();
};

interface PlaylistFirstPage {
  readonly title: string;
  readonly trackCount: number | undefined;
  readonly items: readonly AppleCatalogEntry[];
  readonly next: string | undefined;
}
interface TracksPage {
  readonly items: readonly AppleCatalogEntry[];
  readonly next: string | undefined;
}

interface FetchedPages {
  readonly playlistId: string;
  readonly storefront: string;
  readonly title: string;
  readonly total: number;
  readonly tracks: Track[];
  readonly entries: number;
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

export class AppleProvider implements MusicProvider {
  public readonly id = 'apple-music' as const;
  private readonly options: ResolvedOptions;
  private readonly developerTokenProvider: () => string | undefined;

  public constructor(
    developerTokenProvider: () => string | undefined,
    options: AppleProviderOptions = {},
  ) {
    if (typeof developerTokenProvider !== 'function') {
      throw new TypeError('developerTokenProvider must be a function');
    }
    this.developerTokenProvider = developerTokenProvider;
    this.options = resolveOptions(options);
  }

  public async validateInput(input: PlaylistInput): Promise<ValidationResult> {
    try {
      parseApplePlaylistInput(input, { defaultStorefront: this.options.defaultStorefront });
      return { valid: true };
    } catch {
      return { valid: false, message: '请输入有效的 Apple Music 歌单链接或歌单 ID' };
    }
  }

  public async authenticate(_options: AuthOptions): Promise<AuthResult> {
    return {
      authenticated: false,
      warnings: ['公开歌单无需登录；Apple Music 预览仅读取公开目录数据'],
    };
  }

  public async logout(): Promise<void> {
    // The developer token lives only in the server process via the injected
    // provider callback; this provider never stores credential state.
  }

  public async fetchPlaylist(input: PlaylistInput, context: TaskContext): Promise<Playlist> {
    throwIfAborted(context.signal);
    const parsed = parseApplePlaylistInput(input, {
      defaultStorefront: this.options.defaultStorefront,
    });
    const fetched = await this.fetchAllPages(parsed, context);
    return playlistSchema.parse({
      id: fetched.playlistId,
      name: fetched.title,
      source: 'apple-music',
      total: fetched.total,
      tracks: fetched.tracks,
      complete: fetched.complete,
      warnings: fetched.warnings,
    });
  }

  public async fetchAllTracks(playlistId: string, context: TaskContext): Promise<Track[]> {
    const parsed = parseApplePlaylistInput(
      { value: playlistId },
      { defaultStorefront: this.options.defaultStorefront },
    );
    const fetched = await this.fetchAllPages(parsed, context);
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

  private requireDeveloperToken(): string {
    const token = this.developerTokenProvider();
    if (typeof token !== 'string' || token.trim() === '') {
      // The token value itself is never attached to the error, never logged,
      // and never sent anywhere except the Authorization request header.
      throw new AppError({
        code: 'AUTH_REQUIRED',
        message: '缺少 Apple Music 开发者令牌',
      });
    }
    return token;
  }

  /**
   * Pages the playlist via the `relationships.tracks.next` URLs, which may be
   * absolute or relative to the API origin. Termination is proven by the
   * pagination guard: a missing `next` ends the read with the `next-absent`
   * policy; a repeated/non-advancing `next` is reported as stalled; when Apple
   * declares `attributes.trackCount`, it is used as the expected total, and
   * any divergence yields an honest complete=false snapshot instead of a
   * fabricated success.
   */
  private async fetchAllPages(
    parsed: ParsedApplePlaylistInput,
    context: TaskContext,
  ): Promise<FetchedPages> {
    const guard = createPaginationGuard({
      maxPages: this.options.maxPages,
      maxEntries: this.options.maxEntries,
      allowedTerminalPolicies: ['next-absent'],
    });
    // Continuation `next` values must point exactly at this playlist's tracks
    // path; anything else (other storefronts, other playlists, library or
    // foreign resources) is rejected as schema drift by parseNextUrl.
    const tracksPath = `/v1/catalog/${parsed.storefront}/playlists/${encodeURIComponent(parsed.playlistId)}/tracks`;
    const token = this.requireDeveloperToken();
    const tracks: Track[] = [];
    let title: string | undefined;
    let trackCount: number | undefined;
    let entries = 0;
    let nextUrl: URL | undefined;
    let firstPage = true;
    for (;;) {
      throwIfAborted(context.signal);
      const requestKey = firstPage ? 'offset:0' : requestKeyForNext(nextUrl!);
      guard.beforePage({ requestKey, requestedSize: this.options.pageSize });
      let items: readonly AppleCatalogEntry[];
      let next: string | undefined;
      if (firstPage) {
        const page = await this.fetchInitialPlaylistPage(parsed, token, context);
        throwIfAborted(context.signal);
        title = page.title;
        trackCount = page.trackCount;
        if (trackCount !== undefined) this.assertWithinBudgets(trackCount);
        firstPage = false;
        items = page.items;
        next = page.next;
      } else {
        const page = await this.fetchTracksPage(nextUrl!, token, context);
        throwIfAborted(context.signal);
        items = page.items;
        next = page.next;
      }
      const parsedNext = next === undefined ? null : parseNextUrl(next, tracksPath);
      guard.recordPage({
        rawItemCount: items.length,
        expectedTotal: trackCount,
        nextRequestKey: parsedNext === null ? null : requestKeyForNext(parsedNext),
      });
      tracks.push(...normalizeAppleTracks(items, entries));
      entries += items.length;
      context.onProgress?.({
        phase: 'fetching',
        completed: entries,
        ...(trackCount === undefined ? {} : { total: trackCount }),
        message: trackCount === undefined
          ? `已读取 ${entries} 首`
          : `已读取 ${entries}/${trackCount} 首`,
      });
      if (parsedNext === null) break;
      nextUrl = parsedNext;
    }
    const snapshot = guard.finish({ kind: 'next-absent' });
    // The loop always processes the first page before it can break, but the
    // compiler cannot see that; mirror the qq provider's final title check.
    if (title === undefined) throw schemaError(PLAYLIST_ENDPOINT, ['data', 'attributes', 'name']);
    const warnings: string[] = [];
    const nonSong = tracks.filter(track => track.availability === 'unknown').length;
    if (nonSong > 0) warnings.push(`${nonSong} 个非歌曲条目已保留为占位`);
    const missing = tracks.filter(track => track.availability === 'removed').length;
    if (missing > 0) warnings.push(`${missing} 首歌曲详情缺失，已保留占位`);
    if (!snapshot.complete) {
      warnings.push(`歌单声明 ${trackCount} 首，实际读取到 ${snapshot.entries} 首，结果不完整`);
    }
    return {
      playlistId: parsed.playlistId,
      storefront: parsed.storefront,
      title,
      total: trackCount ?? snapshot.entries,
      tracks,
      entries: snapshot.entries,
      complete: snapshot.complete,
      warnings,
    };
  }

  private async fetchInitialPlaylistPage(
    parsed: ParsedApplePlaylistInput,
    token: string,
    context: TaskContext,
  ): Promise<PlaylistFirstPage> {
    const url = new URL(
      `/v1/catalog/${parsed.storefront}/playlists/${encodeURIComponent(parsed.playlistId)}`,
      API_ORIGIN,
    );
    url.searchParams.set('limit', String(this.options.pageSize));
    const raw = await this.requestJson(context, url, PLAYLIST_ENDPOINT, token);
    const result = appleCatalogPlaylistResponseSchema.safeParse(raw);
    if (!result.success) throw schemaError(PLAYLIST_ENDPOINT, result.error.issues[0]?.path);
    const playlist = result.data.data[0];
    if (playlist === undefined) throw playlistNotFoundError(PLAYLIST_ENDPOINT);
    return {
      title: playlist.attributes.name,
      trackCount: playlist.attributes.trackCount ?? undefined,
      // relationships and tracks are required by the schema: a missing or
      // mistyped tracks relationship already failed safeParse as
      // PROVIDER_SCHEMA_DRIFT, so only a real `data` array reaches here.
      items: playlist.relationships.tracks.data,
      next: playlist.relationships.tracks.next ?? undefined,
    };
  }

  private async fetchTracksPage(
    url: URL,
    token: string,
    context: TaskContext,
  ): Promise<TracksPage> {
    const raw = await this.requestJson(context, url, TRACKS_ENDPOINT, token);
    const result = appleCatalogTracksResponseSchema.safeParse(raw);
    if (!result.success) throw schemaError(TRACKS_ENDPOINT, result.error.issues[0]?.path);
    return {
      items: result.data.data,
      next: result.data.next ?? undefined,
    };
  }

  private async requestJson(
    context: TaskContext,
    url: URL,
    endpoint: string,
    token: string,
  ): Promise<unknown> {
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
              // The developer token travels only in this header. It is never
              // placed in URLs, query parameters, logs, or error details.
              authorization: `Bearer ${token}`,
            },
            signal,
          });
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
          // MusicKit rate limits (429, with Retry-After) and transient 5xx /
          // network faults are retried a bounded number of times; 401/403/404
          // are terminal and never retried.
          shouldRetry: ({ response: attempt, error }) =>
            attempt?.status === 429 ||
            (attempt !== undefined && attempt.status >= 500) ||
            error instanceof TypeError ||
            (isAppError(error) && error.code === APP_ERROR_CODES.HTTP_TIMEOUT),
        },
      );
    } catch (error) {
      throw safeRequestError(endpoint, error);
    }
    throwIfAborted(context.signal);
    if (!response.ok) throw statusError(endpoint, response.status);
    return raw;
  }
}
