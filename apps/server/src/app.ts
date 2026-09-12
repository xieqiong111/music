import { randomUUID } from 'node:crypto';
import {
  type Playlist,
  excludeTrackKeysSchema,
  providerIdSchema,
  trackKey,
  type HttpTransport,
  type MusicProvider,
  type ProviderId,
} from '@playlist-exporter/contracts';
import { exportPlaylist, type ExportOptions } from '@playlist-exporter/exporters';
import { serveStatic, type ServeStaticOptions } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  buildSessionCookie,
  CLEAR_SESSION_COOKIE,
  isAllowedOrigin,
  readSessionCookie,
  SESSION_DURATIONS,
  type AuthStore,
} from './auth.js';
import type { ServerConfig } from './config.js';
import type { JobRegistry } from './jobs.js';

interface Variables {
  requestId: string;
  errorCode: string | undefined;
  sessionToken: string | undefined;
  sessionUsername: string | undefined;
}

type AppContext = Context<{ Variables: Variables }>;

/** app.ts 内部变量注入类型,供子模块路由(本地音乐库)对齐泛型。 */
export type AppEnv = { Variables: Variables };

export interface ServerLogEvent {
  readonly requestId: string;
  readonly status: number;
}

/**
 * 可选的本地去重管道（预留给本地音乐库联调）：提供方返回"过滤后歌单 + 被剔除数"。
 * 默认不提供 = 完全保持现状行为（不做本地去重过滤）。
 */
export type LocalDuplicateFilter = (playlist: Playlist) => {
  readonly playlist: Playlist;
  readonly excluded: number;
};

export interface ServerAppDependencies {
  readonly config: ServerConfig;
  readonly providers: ReadonlyMap<ProviderId, MusicProvider>;
  readonly http: HttpTransport;
  readonly jobs: JobRegistry;
  readonly auth: AuthStore;
  readonly logger?: (event: ServerLogEvent) => void;
  readonly requestIdFactory?: () => string;
  readonly webDistRoot?: string;
  readonly filterLocalDuplicates?: LocalDuplicateFilter;
  /** 本地音乐库子路由(认证由本 app 的 /api/* 中间件统一覆盖)。 */
  readonly localLibraryRouter?: Hono<{ Variables: Variables }>;
}

const inspectSchema = z.object({
  provider: providerIdSchema,
  input: z.object({ value: z.string().trim().min(1).max(4096) }).strict(),
}).strict();

const exportOptionsSchema = z.object({
  format: z.enum(['txt', 'csv', 'json']),
  includeIndex: z.boolean().optional(),
  order: z.enum(['title-artist', 'artist-title']).optional(),
  includeAlbum: z.boolean().optional(),
  dedupe: z.boolean().optional(),
  lineEnding: z.enum(['lf', 'crlf']).optional(),
  csvBom: z.boolean().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  generatedAt: z.string().datetime({ offset: true }).optional(),
  // 预留给本地音乐库去重：仅在依赖注入了 filterLocalDuplicates 时生效。
  excludeLocalDuplicates: z.boolean().optional(),
  // 曲目指纹排除（本机音乐库）：类型先放宽为数组，逐项 1..200 字符、最多 5000 项的
  // 约束在路由内用 contracts 的 excludeTrackKeysSchema 校验，以便返回专门的
  // 400 INVALID_EXPORT_OPTIONS 中文错误，而非泛化的 INVALID_REQUEST。
  excludeTrackKeys: z.array(z.string()).optional(),
}).strict();

const exportSchema = z.object({
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  options: exportOptionsSchema,
}).strict();

/**
 * 曲目指纹排除管线：按冻结公式（contracts 的 trackKey）对每首曲目计算指纹，
 * 命中 keys 集合则剔除。剔除后重排 position、total 重算（与本地去重管道一致，
 * 保持 complete ⇒ total === tracks.length 不变式），warnings 追加中文提示。
 */
const filterTracksByKeys = (
  playlist: Playlist,
  keys: ReadonlySet<string>,
): { readonly playlist: Playlist; readonly excluded: number } => {
  const kept = playlist.tracks.filter(track => !keys.has(trackKey(track.title, track.artists ?? [])));
  const excluded = playlist.tracks.length - kept.length;
  const tracks = kept.map((track, position) => ({ ...track, position }));
  const warnings = excluded > 0
    ? [...playlist.warnings, `已按本机音乐库排除 ${excluded} 首重复曲目`]
    : [...playlist.warnings];
  return {
    playlist: { ...playlist, total: tracks.length, tracks, warnings },
    excluded,
  };
};

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(4096),
  duration: z.enum(['12h', '7d', '30d', 'forever']),
}).strict();

// username/password 的具体长度规则（≤64 字符 / ≥6 字符）在路由内校验，
// 以便返回语义明确的中文错误信息。
const credentialsSchema = z.object({
  currentPassword: z.string().min(1).max(4096),
  username: z.string().max(1024).optional(),
  password: z.string().max(4096).optional(),
}).strict();

const errorResponse = (
  context: AppContext,
  status: number,
  code: string,
  message: string,
): Response => {
  context.set('errorCode', code);
  return new Response(JSON.stringify({
    code,
    message,
    technicalDetails: { requestId: context.get('requestId') },
  }), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};

const readJson = async <T>(
  context: AppContext,
  schema: z.ZodType<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response }> => {
  const contentType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, response: errorResponse(context, 415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 JSON 格式') };
  }
  let raw: unknown;
  try {
    raw = await context.req.json();
  } catch {
    return { ok: false, response: errorResponse(context, 400, 'INVALID_JSON', '请求 JSON 格式无效') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: errorResponse(context, 400, 'INVALID_REQUEST', '请求内容无效') };
  }
  return { ok: true, value: parsed.data };
};

const encodedFilename = (filename: string): string =>
  encodeURIComponent(filename).replace(/['()*]/gu, character =>
    `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`);

// Same-origin deployment: the server itself hosts the UI, so the browser only
// ever needs cross-origin access for explicitly allowlisted API clients. The
// session travels in a SameSite=Strict cookie that browsers do not attach to
// cross-origin requests, so credentialed cross-origin use is impossible by
// design — Access-Control-Allow-Credentials must stay unset (a cookie-based
// CORS flow would also require it, which we deliberately do not support).
// 'authorization' remains in the preflight allowlist only as a defensive
// leftover for existing tooling; the server itself no longer requires it.
const allowedPreflightHeaders = new Set(['authorization', 'content-type']);
const allowedPreflightMethods = new Set(['GET', 'POST', 'DELETE']);

const ASSET_CACHE = 'public, max-age=31536000, immutable';
const ENTRY_CACHE = 'no-cache';
const ICON_CACHE = 'public, max-age=604800';

const cachedStatic = (
  cacheControl: string,
  options: ServeStaticOptions,
): MiddlewareHandler => {
  const serve = serveStatic(options);
  return async (context, next) => {
    // Must be set before serving so it lands on the finalized response.
    context.header('Cache-Control', cacheControl);
    // serveStatic returns the Response when it serves a file and falls back to
    // next() when it does not; both cases must be propagated to the composer.
    return serve(context, next);
  };
};

const registerWebDist = (app: Hono<{ Variables: Variables }>, root: string): void => {
  app.get('/', cachedStatic(ENTRY_CACHE, { root, index: 'index.html' }));
  app.get('/index.html', cachedStatic(ENTRY_CACHE, { root, path: 'index.html' }));
  app.use('/assets/*', cachedStatic(ASSET_CACHE, { root }));
  app.get('/manifest.webmanifest', cachedStatic(ENTRY_CACHE, { root, path: 'manifest.webmanifest' }));
  app.use('/icons/*', cachedStatic(ICON_CACHE, { root }));
  app.get('/sw.js', cachedStatic(ENTRY_CACHE, { root, path: 'sw.js' }));
};

export const createServerApp = (dependencies: ServerAppDependencies) => {
  const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (context, next) => {
    context.set('requestId', requestIdFactory());
    context.set('errorCode', undefined);
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
    dependencies.logger?.({
      requestId: context.get('requestId'),
      status: context.res.status,
    });
  });

  app.get('/healthz', context => context.json({ status: 'ok' }));

  // 免登录的认证端点：登录、登出与会话状态查询。修改凭据（/api/auth/credentials）
  // 不在此列 —— 它要求已登录会话。
  const PUBLIC_AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status']);

  app.use('/api/*', async (context, next) => {
    const method = context.req.method.toUpperCase();
    const origin = context.req.header('origin');
    if (method === 'OPTIONS') {
      const requestedMethod = context.req.header('access-control-request-method')?.toUpperCase();
      const requestedHeaders = (context.req.header('access-control-request-headers') ?? '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
      if (!isAllowedOrigin(origin, dependencies.config.allowedOrigins) ||
          requestedMethod === undefined || !allowedPreflightMethods.has(requestedMethod) ||
          requestedHeaders.some(header => !allowedPreflightHeaders.has(header))) {
        return errorResponse(context, 403, 'ORIGIN_NOT_ALLOWED', '请求来源不被允许');
      }
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin!,
          'access-control-allow-methods': requestedMethod,
          'access-control-allow-headers': requestedHeaders.join(', '),
          vary: 'Origin',
        },
      });
    }

    const mutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const allowedOrigin = isAllowedOrigin(origin, dependencies.config.allowedOrigins);
    if ((origin !== undefined && !allowedOrigin) || (mutation && !allowedOrigin)) {
      return errorResponse(context, 403, 'ORIGIN_NOT_ALLOWED', '请求来源不被允许');
    }

    // 会话保护：/api/* 全部要求有效会话（公开认证端点除外）。
    if (!PUBLIC_AUTH_PATHS.has(context.req.path)) {
      const token = readSessionCookie(context.req.header('cookie'));
      const session = token === undefined ? undefined : dependencies.auth.getSession(token);
      if (session === undefined) {
        return errorResponse(context, 401, 'AUTH_REQUIRED', '请先登录');
      }
      context.set('sessionToken', token);
      context.set('sessionUsername', session.username);
    }

    if (origin !== undefined) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Vary', 'Origin');
    }
    context.header('Cache-Control', 'no-store');
    await next();
  });

  app.use('/api/*', async (context, next) => {
    const encoding = context.req.header('content-encoding');
    if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
      return errorResponse(context, 415, 'UNSUPPORTED_CONTENT_ENCODING', '不支持压缩请求体');
    }
    await next();
  });

  app.use('/api/*', bodyLimit({
    maxSize: dependencies.config.maxBodyBytes,
    onError: context => errorResponse(
      context as AppContext,
      413,
      'PAYLOAD_TOO_LARGE',
      '请求内容超过 1 MiB 限制',
    ),
  }));

  // ---------- 认证端点 ----------

  app.post('/api/auth/login', async context => {
    const body = await readJson(context, loginSchema);
    if (!body.ok) return body.response;
    const credentialsValid = await dependencies.auth.verifyCredentials(
      body.value.username,
      body.value.password,
    );
    if (!credentialsValid) {
      return errorResponse(context, 401, 'AUTH_REQUIRED', '用户名或密码不正确');
    }
    const durationMs = SESSION_DURATIONS[body.value.duration];
    const { token, expiresAt } = dependencies.auth.createSession(body.value.username, durationMs);
    context.header('Set-Cookie', buildSessionCookie(token, Math.floor(durationMs / 1000)));
    return context.json(
      { authenticated: true, username: body.value.username, expiresAt },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  // 登出总是 200：无 Cookie、会话已过期或已失效都视为登出成功。
  app.post('/api/auth/logout', context => {
    const token = readSessionCookie(context.req.header('cookie'));
    if (token !== undefined) dependencies.auth.deleteSession(token);
    context.header('Set-Cookie', CLEAR_SESSION_COOKIE);
    return context.json({ authenticated: false }, 200, { 'cache-control': 'no-store' });
  });

  app.get('/api/auth/status', context => {
    const token = readSessionCookie(context.req.header('cookie'));
    const session = token === undefined ? undefined : dependencies.auth.getSession(token);
    return context.json(
      session === undefined
        ? { authenticated: false }
        : { authenticated: true, username: session.username },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  app.post('/api/auth/credentials', async context => {
    const currentToken = context.get('sessionToken');
    const currentUsername = context.get('sessionUsername');
    // 中间件已强制本端点需要有效会话，这里仅作防御性兜底。
    if (currentToken === undefined || currentUsername === undefined) {
      return errorResponse(context, 401, 'AUTH_REQUIRED', '请先登录');
    }
    const body = await readJson(context, credentialsSchema);
    if (!body.ok) return body.response;
    const currentPasswordValid = await dependencies.auth.verifyCredentials(
      currentUsername,
      body.value.currentPassword,
    );
    if (!currentPasswordValid) {
      return errorResponse(context, 401, 'AUTH_REQUIRED', '当前密码不正确');
    }
    const nextUsername = body.value.username?.trim();
    const nextPassword = body.value.password;
    if (nextUsername !== undefined && nextUsername === '') {
      return errorResponse(context, 400, 'INVALID_REQUEST', '用户名不能为空');
    }
    if (nextUsername !== undefined && [...nextUsername].length > 64) {
      return errorResponse(context, 400, 'INVALID_REQUEST', '用户名长度不能超过 64 个字符');
    }
    if (nextPassword !== undefined && nextPassword.length < 6) {
      return errorResponse(context, 400, 'INVALID_REQUEST', '新密码至少需要 6 个字符');
    }
    const usernameChanged = nextUsername !== undefined && nextUsername !== currentUsername;
    if (!usernameChanged && nextPassword === undefined) {
      return errorResponse(context, 400, 'INVALID_REQUEST', '至少修改用户名或密码之一');
    }
    const result = await dependencies.auth.updateCredentials({
      currentUsername,
      currentToken,
      ...(usernameChanged ? { newUsername: nextUsername } : {}),
      ...(nextPassword === undefined ? {} : { newPassword: nextPassword }),
    });
    if (!result.ok) {
      return result.reason === 'username-taken'
        ? errorResponse(context, 400, 'INVALID_REQUEST', '该用户名已被占用')
        : errorResponse(context, 401, 'AUTH_REQUIRED', '当前用户不存在');
    }
    return context.json(
      { authenticated: true, username: result.username },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  app.post('/api/playlists/inspect', async context => {
    const body = await readJson(context, inspectSchema);
    if (!body.ok) return body.response;
    const selectedProvider = dependencies.providers.get(body.value.provider);
    if (selectedProvider === undefined) {
      return errorResponse(context, 422, 'UNSUPPORTED_PROVIDER', '当前运行环境不支持该平台');
    }
    let validation;
    try {
      validation = await selectedProvider.validateInput(body.value.input);
    } catch {
      return errorResponse(context, 400, 'INVALID_PLAYLIST_INPUT', '无法识别该歌单输入');
    }
    if (!validation.valid) {
      return errorResponse(
        context,
        400,
        'INVALID_PLAYLIST_INPUT',
        validation.message ?? '无法识别该歌单输入',
      );
    }
    let job;
    try {
      job = dependencies.jobs.submit(body.value.provider, jobContext =>
        selectedProvider.fetchPlaylist(body.value.input, {
          signal: jobContext.signal,
          onProgress: jobContext.onProgress,
          http: dependencies.http,
        }));
    } catch {
      return errorResponse(context, 429, 'QUEUE_FULL', '任务队列已满，请稍后重试');
    }
    context.header('Location', `/api/jobs/${job.jobId}`);
    return context.json({ jobId: job.jobId, status: job.status }, 202);
  });

  app.get('/api/jobs/:id', context => {
    const job = dependencies.jobs.get(context.req.param('id'));
    if (job === undefined) return errorResponse(context, 404, 'JOB_NOT_FOUND', '未找到该任务');
    return context.json(job);
  });

  app.delete('/api/jobs/:id', context => {
    const cancelled = dependencies.jobs.cancel(context.req.param('id'));
    if (cancelled.kind === 'not-found') {
      return errorResponse(context, 404, 'JOB_NOT_FOUND', '未找到该任务');
    }
    if (cancelled.kind === 'terminal') {
      return errorResponse(context, 409, 'JOB_TERMINAL', '任务已经结束，无法取消');
    }
    return context.json({
      jobId: cancelled.job.jobId,
      status: cancelled.job.status,
    }, 202);
  });

  app.post('/api/exports', async context => {
    const body = await readJson(context, exportSchema);
    if (!body.ok) return body.response;
    const job = dependencies.jobs.get(body.value.jobId);
    if (job === undefined) return errorResponse(context, 404, 'JOB_NOT_FOUND', '未找到该任务');
    if (job.status !== 'completed') {
      const code = job.status === 'queued' || job.status === 'running'
        ? 'JOB_NOT_READY'
        : 'JOB_NOT_EXPORTABLE';
      return errorResponse(context, 409, code, '该任务当前无法导出');
    }
    const playlist = dependencies.jobs.getCompletedResult(job.jobId);
    if (playlist === undefined) return errorResponse(context, 409, 'JOB_NOT_EXPORTABLE', '任务结果不可用');
    if (!playlist.complete) {
      return errorResponse(context, 422, 'INCOMPLETE_PLAYLIST', '歌单读取不完整，已阻止导出');
    }

    // 本地去重管道（预留给本地音乐库联调）：仅在依赖注入了 filterLocalDuplicates
    // 且选项 excludeLocalDuplicates=true 时执行；默认（未注入或未开启）完全保持
    // 现状行为，不做任何过滤。
    const { excludeLocalDuplicates, excludeTrackKeys, ...exportOptions } = body.value.options;
    const duplicateFilter = dependencies.filterLocalDuplicates;
    const shouldFilterDuplicates = duplicateFilter !== undefined && excludeLocalDuplicates === true;
    let exportSource = playlist;
    let excludedLocalCount: number | undefined;
    if (shouldFilterDuplicates && duplicateFilter !== undefined) {
      const filtered = duplicateFilter(playlist);
      exportSource = filtered.playlist;
      excludedLocalCount = filtered.excluded;
    }

    // 曲目指纹排除管道（本机音乐库）：前端把本机库条目按冻结公式计算成指纹集合
    // 随导出选项传入，服务端对歌单曲目计算同形指纹并按集合剔除。与本地去重按
    // 顺序串联（并集语义，两者都能生效），剔除计数各自独立统计。
    let excludedTrackCount: number | undefined;
    if (excludeTrackKeys !== undefined) {
      const parsedKeys = excludeTrackKeysSchema.safeParse(excludeTrackKeys);
      if (!parsedKeys.success) {
        return errorResponse(
          context,
          400,
          'INVALID_EXPORT_OPTIONS',
          '排除曲目指纹选项无效：每项需为 1~200 字符的字符串，且最多 5000 项',
        );
      }
      const filtered = filterTracksByKeys(exportSource, new Set(parsedKeys.data));
      exportSource = filtered.playlist;
      excludedTrackCount = filtered.excluded;
    }

    let artifact;
    try {
      artifact = exportPlaylist(exportSource, exportOptions as ExportOptions);
    } catch {
      return errorResponse(context, 400, 'INVALID_EXPORT_OPTIONS', '导出选项无效');
    }
    const bytes = artifact.bytes.buffer.slice(
      artifact.bytes.byteOffset,
      artifact.bytes.byteOffset + artifact.bytes.byteLength,
    ) as ArrayBuffer;
    // This route returns a raw Response, so headers the CORS middleware staged
    // with context.header() are not applied by Hono to it. The origin has
    // already passed the Origin+Bearer checks above, so repeat it here and
    // expose Content-Disposition: without it a real cross-origin browser fetch
    // (unlike the same-origin Vite proxy) cannot read the download filename.
    const requestOrigin = context.req.header('origin');
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': artifact.mimeType,
        'content-disposition': `attachment; filename*=UTF-8''${encodedFilename(artifact.filename)}`,
        'content-length': String(artifact.bytes.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-export-format': artifact.format,
        'x-export-complete': String(artifact.complete),
        'x-track-count': String(artifact.trackCount),
        'x-export-encoding': artifact.encoding,
        'x-export-line-ending': artifact.lineEnding,
        'x-export-bom': String(artifact.bom),
        // 仅在本地去重管道实际执行时返回被剔除的本地曲目数。
        ...(excludedLocalCount === undefined ? {} : {
          'x-excluded-local-count': String(excludedLocalCount),
        }),
        // 仅在请求携带 excludeTrackKeys 选项时输出该头（即便剔除 0 首也输出）。
        ...(excludedTrackCount === undefined ? {} : {
          'x-excluded-track-count': String(excludedTrackCount),
        }),
        ...(requestOrigin === undefined ? {} : {
          'access-control-allow-origin': requestOrigin,
          'vary': 'Origin',
        }),
        'access-control-expose-headers': 'Content-Disposition',
      },
    });
  });

  // 本地音乐库路由:认证已由上方 /api/* 会话中间件统一覆盖,子路由无需自行处理。
  if (dependencies.localLibraryRouter !== undefined) {
    app.route('/api/local-library', dependencies.localLibraryRouter);
  }

  if (dependencies.webDistRoot !== undefined) {
    registerWebDist(app, dependencies.webDistRoot);
  }

  app.notFound(context => errorResponse(context, 404, 'NOT_FOUND', '未找到该接口'));
  app.onError((_error, context) =>
    errorResponse(context, 500, 'INTERNAL_ERROR', '服务暂时不可用'));

  return app;
};
