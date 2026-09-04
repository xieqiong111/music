import { isIP } from 'node:net';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly accessToken: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes: number;
  readonly maxConcurrentJobs: number;
  readonly maxQueuedJobs: number;
  readonly jobTtlMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const configError = (field: string, reason: string): Error =>
  new Error(`${field} ${reason}`);

const parseInteger = (
  env: Environment,
  field: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const raw = env[field];
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw configError(field, '必须是十进制正整数');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configError(field, `必须在 1 到 ${maximum} 之间`);
  }
  return value;
};

const mappedLoopback = (host: string): boolean => {
  const match = host.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  return match !== null && isIP(match[1] ?? '') === 4 && match[1]?.split('.')[0] === '127';
};

export const isLoopbackHost = (host: string): boolean =>
  host === '::1' || mappedLoopback(host) ||
  (isIP(host) === 4 && host.split('.')[0] === '127');

const validateHost = (raw: string | undefined): string => {
  const host = raw ?? '127.0.0.1';
  const numericAddress = isIP(host) !== 0;
  if (host === '' || host.trim() !== host ||
      (!numericAddress && !/^[A-Za-z0-9.-]+$/u.test(host))) {
    throw configError('HOST', '格式无效');
  }
  return host;
};

const validateToken = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === '' || raw.trim() === '' || /[\u0000-\u001f\u007f]/u.test(raw) ||
      Buffer.byteLength(raw, 'utf8') > 4096) {
    throw configError('ACCESS_TOKEN', '格式无效');
  }
  return raw;
};

const parseOrigin = (candidate: string): string => {
  if (candidate === '' || candidate === '*' || candidate === 'null') {
    throw configError('ALLOWED_ORIGINS', '包含无效来源');
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw configError('ALLOWED_ORIGINS', '包含无效来源');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' || url.password !== '' || url.origin !== candidate ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw configError('ALLOWED_ORIGINS', '必须只包含完整 HTTP(S) origin');
  }
  return url.origin;
};

const defaultOrigins = (host: string, port: number): string[] => {
  if (!isLoopbackHost(host)) return [];
  const formatted = isIP(host) === 6 || host.includes(':') ? `[${host}]` : host;
  const values = [`http://${formatted}:${port}`];
  if (host.startsWith('127.')) values.push(`http://localhost:${port}`);
  return values;
};

const parseOrigins = (raw: string | undefined, host: string, port: number): string[] => {
  if (raw === undefined) return defaultOrigins(host, port);
  const candidates = raw.split(',');
  if (candidates.length === 0 || candidates.some(value => value === '')) {
    throw configError('ALLOWED_ORIGINS', '不能为空');
  }
  return [...new Set(candidates.map(parseOrigin))];
};

export const loadServerConfig = (env: Environment = process.env): ServerConfig => {
  const host = validateHost(env.HOST);
  const port = parseInteger(env, 'PORT', 4319, 65_535);
  const accessToken = validateToken(env.ACCESS_TOKEN);
  if (!isLoopbackHost(host) && accessToken === undefined) {
    throw configError('ACCESS_TOKEN', '在非 loopback 监听时必须配置');
  }
  return {
    host,
    port,
    accessToken,
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS, host, port),
    maxBodyBytes: parseInteger(env, 'MAX_BODY_BYTES', 1_048_576, 1_048_576),
    maxConcurrentJobs: parseInteger(env, 'MAX_CONCURRENT_JOBS', 2),
    maxQueuedJobs: parseInteger(env, 'MAX_QUEUED_JOBS', 100),
    jobTtlMs: parseInteger(env, 'JOB_TTL_MS', 900_000),
  };
};
