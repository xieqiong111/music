import { randomUUID } from 'node:crypto';
import {
  providerIdSchema,
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
import { hasValidBearer, isAllowedOrigin } from './auth.js';
import type { ServerConfig } from './config.js';
import type { JobRegistry } from './jobs.js';

interface Variables {
  requestId: string;
  errorCode: string | undefined;
}

type AppContext = Context<{ Variables: Variables }>;

export interface ServerLogEvent {
  readonly requestId: string;
  readonly status: number;
}

export interface ServerAppDependencies {
  readonly config: ServerConfig;
  readonly providers: ReadonlyMap<ProviderId, MusicProvider>;
  readonly http: HttpTransport;
  readonly jobs: JobRegistry;
  readonly logger?: (event: ServerLogEvent) => void;
  readonly requestIdFactory?: () => string;
  readonly webDistRoot?: string;
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
}).strict();

const exportSchema = z.object({
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  options: exportOptionsSchema,
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
    if (!hasValidBearer(context.req.header('authorization'), dependencies.config.accessToken)) {
      return errorResponse(context, 401, 'AUTH_REQUIRED', '需要有效的访问令牌');
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

    let artifact;
    try {
      artifact = exportPlaylist(playlist, body.value.options as ExportOptions);
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
        ...(requestOrigin === undefined ? {} : {
          'access-control-allow-origin': requestOrigin,
          'vary': 'Origin',
        }),
        'access-control-expose-headers': 'Content-Disposition',
      },
    });
  });

  if (dependencies.webDistRoot !== undefined) {
    registerWebDist(app, dependencies.webDistRoot);
  }

  app.notFound(context => errorResponse(context, 404, 'NOT_FOUND', '未找到该接口'));
  app.onError((_error, context) =>
    errorResponse(context, 500, 'INTERNAL_ERROR', '服务暂时不可用'));

  return app;
};
