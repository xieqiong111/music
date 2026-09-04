import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { AppError, type ProviderId } from '@playlist-exporter/contracts';
import { createHttpTransport } from '@playlist-exporter/core';
import { NeteaseProvider } from '@playlist-exporter/provider-netease';
import { createServerApp, type ServerLogEvent } from './app.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createJobRegistry, type JobRegistry } from './jobs.js';

const ALLOWED_EGRESS_HOSTS = new Set(['music.163.com', 'y.music.163.com', '163cn.tv']);

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

export const startServer = (options: StartServerOptions = {}): ServerRuntime => {
  // Configuration must be fully validated before any socket can be created.
  const config = loadServerConfig(options.env ?? process.env);
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
  const providers = new Map<ProviderId, NeteaseProvider>([
    ['netease', new NeteaseProvider()],
  ]);
  const app = createServerApp({
    config,
    providers,
    http,
    jobs,
    logger: options.logger ?? defaultLogger,
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
export { loadServerConfig } from './config.js';
export { createJobRegistry } from './jobs.js';
