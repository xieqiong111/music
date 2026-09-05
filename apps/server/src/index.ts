import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { AppError, type MusicProvider, type ProviderId } from '@playlist-exporter/contracts';
import { createHttpTransport } from '@playlist-exporter/core';
import { AppleProvider } from '@playlist-exporter/provider-apple';
import { NeteaseProvider } from '@playlist-exporter/provider-netease';
import { QqProvider } from '@playlist-exporter/provider-qq';
import { createServerApp, type LocalDuplicateFilter, type ServerLogEvent } from './app.js';
import { createLocalLibraryRouter, createLocalLibraryService, type LocalLibraryService } from './local-library.js';
import { createAuthStore } from './auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createJobRegistry, type JobRegistry } from './jobs.js';

// Outbound egress is pinned to the exact metadata endpoints each registered
// provider uses: QQ playlist reads only ever target i.y.qq.com (verified by
// outputs/research/2026-09-05-qq-public-api-probe.md); Apple Music BYO
// developer-token catalog reads target api.music.apple.com only.
// u.y.qq.com / c.y.qq.com are not used by this project and stay blocked.
const ALLOWED_EGRESS_HOSTS = new Set([
  'music.163.com',
  'y.music.163.com',
  '163cn.tv',
  'i.y.qq.com',
  'api.music.apple.com',
]);

const egressError = (): AppError => new AppError({
  code: 'EGRESS_NOT_ALLOWED',
  message: '已阻止不安全的上游请求',
});

export const createRestrictedFetch = (fetchImpl: typeof fetch = globalThis.fetch): typeof fetch =>
  async (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      throw egressError();
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
        url.port !== '' || !ALLOWED_EGRESS_HOSTS.has(url.hostname.toLowerCase())) {
      throw egressError();
    }
    return fetchImpl(input, { ...init, redirect: init?.redirect ?? 'error' });
  };

export interface StartServerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly serveImpl?: typeof serve;
  readonly logger?: (event: ServerLogEvent) => void;
  /** 启动警告/提示通道（废弃变量警告、默认账号提示等），默认写入 stderr。 */
  readonly warn?: (message: string) => void;
  /**
   * 可选的本地去重管道（预留给本地音乐库联调）：传入后 export 路由在
   * excludeLocalDuplicates 选项开启时用它过滤歌单；不传即现状行为。
   */
  readonly filterLocalDuplicates?: LocalDuplicateFilter;
}

export interface ServerRuntime {
  readonly config: ServerConfig;
  readonly server: ServerType;
  readonly jobs: JobRegistry;
  readonly app: ReturnType<typeof createServerApp>;
}

const defaultLogger = (event: ServerLogEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

// Optional PWA static hosting: unset/empty WEB_DIST keeps the server API-only.
// A configured value must resolve to an existing directory before any socket opens.
export const resolveWebDistRoot = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const root = resolve(raw);
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new Error(`WEB_DIST 目录不存在: ${root}`);
  }
  if (!stats.isDirectory()) throw new Error(`WEB_DIST 不是目录: ${root}`);
  return root;
};

export const startServer = (options: StartServerOptions = {}): ServerRuntime => {
  const warn = options.warn ?? ((message: string): void => {
    process.stderr.write(`${message}\n`);
  });
  // Configuration must be fully validated before any socket can be created.
  const env = options.env ?? process.env;
  const config = loadServerConfig(env, warn);
  // 账号与会话持久化（/data/auth.json、/data/sessions.json）；首次启动自动
  // 创建默认账号 admin/admin 并提示修改。任何写盘失败都在开端口前快速失败。
  const auth = createAuthStore({ dataDir: config.dataDir, notify: warn });
  const webDistRoot = resolveWebDistRoot(env.WEB_DIST);
  const restrictedFetch = createRestrictedFetch(options.fetchImpl ?? globalThis.fetch);
  const http = createHttpTransport({
    fetchImpl: restrictedFetch,
    timeoutMs: 15_000,
    minIntervalMs: 250,
    maxResponseBytes: 8 * 1024 * 1024,
  });
  const jobs = createJobRegistry({
    maxConcurrent: config.maxConcurrentJobs,
    maxQueued: config.maxQueuedJobs,
    terminalTtlMs: config.jobTtlMs,
  });
  // Apple Music (Preview) is only registered when the operator configured the
  // BYO developer token; without it, inspect requests for `apple-music` fall
  // through to the existing 422 UNSUPPORTED_PROVIDER response.
  const appleDeveloperToken = config.appleDeveloperToken;
  const providers = new Map<ProviderId, MusicProvider>([
    ['netease', new NeteaseProvider()],
    ['qq-music', new QqProvider()],
    ...(appleDeveloperToken === undefined ? [] : [[
      'apple-music',
      new AppleProvider(() => appleDeveloperToken),
    ] as [ProviderId, MusicProvider]]),
  ]);
  // 本地音乐库:服务异步初始化(加载 /data/local-library.json 并对已有 root
  // 自动重扫),期间库端点 404、去重过滤按"未启用"处理;就绪后把子路由直接
  // 挂到主 app 上(Hono 支持运行期追加路由,仍受先注册的会话中间件覆盖)。
  // 过滤闭包按调用时读取变量,保证初始化完成后导出路由立即生效。
  let localLibrary: LocalLibraryService | undefined;
  const filterLocalDuplicates: LocalDuplicateFilter = playlist => {
    if (localLibrary === undefined) return { playlist, excluded: 0 };
    return localLibrary.filterDuplicates(playlist);
  };
  const app = createServerApp({
    config,
    providers,
    http,
    jobs,
    auth,
    logger: options.logger ?? defaultLogger,
    webDistRoot,
    filterLocalDuplicates: options.filterLocalDuplicates ?? filterLocalDuplicates,
  });
  void createLocalLibraryService({ dataFile: config.localLibraryDataFile })
    .then(service => {
      localLibrary = service;
      app.route('/api/local-library', createLocalLibraryRouter(service));
    })
    .catch((error: unknown) => {
      warn(`本地音乐库初始化失败,该功能不可用: ${error instanceof Error ? error.message : String(error)}`);
    });
  const server = (options.serveImpl ?? serve)({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
  server.once('close', () => jobs.close());
  return { config, server, jobs, app };
};

const isMainModule = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  try {
    const runtime = startServer();
    const shutdown = (): void => {
      runtime.server.close(() => {
        runtime.jobs.close();
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务启动失败';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export { createServerApp } from './app.js';
export { createAuthStore } from './auth.js';
export { loadServerConfig } from './config.js';
export { createJobRegistry } from './jobs.js';
