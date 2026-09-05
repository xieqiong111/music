import { posix as pathPosix } from 'node:path';
import { isIP } from 'node:net';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /**
   * 持久化数据目录（容器内为卷挂载点）：账号 auth.json 与会话 sessions.json
   * 位于其下。默认 /data，可由 DATA_DIR 注入（本地裸跑建议显式设置）。
   */
  readonly dataDir: string;
  /** 本地音乐库索引文件，位于 dataDir 下（跟随卷持久化）。 */
  readonly localLibraryDataFile: string;
  readonly appleDeveloperToken: string | undefined;
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

const validateDataDir = (raw: string | undefined): string => {
  if (raw === undefined || raw.trim() === '') return '/data';
  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    throw configError('DATA_DIR', '格式无效');
  }
  return raw;
};

/**
 * Apple Music BYO developer token (Preview). The value only ever lives in the
 * process and is forwarded exclusively as the Authorization request header to
 * api.music.apple.com; it must never be logged or echoed into errors. A
 * blank/whitespace value means "not configured" so stray empty env exports do
 * not half-enable the provider; a real value is returned untrimmed.
 */
const validateAppleDeveloperToken = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(raw) || Buffer.byteLength(raw, 'utf8') > 8192) {
    throw configError('APPLE_DEVELOPER_TOKEN', '格式无效');
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
      url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw configError('ALLOWED_ORIGINS', '必须只包含完整 HTTP(S) origin');
  }
  // Return the canonical origin (URL drops default ports 80/443 and
  // normalizes scheme/host case) so entries such as `http://127.0.0.1:80`,
  // `http://127.0.0.1` and `HTTP://Example.COM:4319/` collapse onto the exact
  // form browsers send in the Origin header.
  return url.origin;
};

const defaultOrigins = (host: string, port: number): string[] => {
  if (!isLoopbackHost(host)) return [];
  const formatted = isIP(host) === 6 || host.includes(':') ? `[${host}]` : host;
  const values = [`http://${formatted}:${port}`];
  if (host.startsWith('127.')) values.push(`http://localhost:${port}`);
  // Route through parseOrigin so default ports (80/443) yield canonical
  // origins instead of e.g. `http://127.0.0.1:80`.
  return [...new Set(values.map(parseOrigin))];
};

const parseOrigins = (raw: string | undefined, host: string, port: number): string[] => {
  if (raw === undefined) return defaultOrigins(host, port);
  const candidates = raw.split(',');
  if (candidates.length === 0 || candidates.some(value => value === '')) {
    throw configError('ALLOWED_ORIGINS', '不能为空');
  }
  return [...new Set(candidates.map(parseOrigin))];
};

export const loadServerConfig = (
  env: Environment = process.env,
  warn: (message: string) => void = () => undefined,
): ServerConfig => {
  const host = validateHost(env.HOST);
  const port = parseInteger(env, 'PORT', 4319, 65_535);
  // 鉴权已改为用户名密码登录（/data/auth.json）：ACCESS_TOKEN 彻底废弃。
  // 环境里若仍残留该变量则直接忽略，只给出一条迁移警告，保证旧部署平滑升级。
  if (env.ACCESS_TOKEN !== undefined && env.ACCESS_TOKEN !== '') {
    warn('检测到已废弃的 ACCESS_TOKEN，已忽略');
  }
  return {
    host,
    port,
    dataDir: validateDataDir(env.DATA_DIR),
    localLibraryDataFile: pathPosix.join(validateDataDir(env.DATA_DIR), 'local-library.json'),
    appleDeveloperToken: validateAppleDeveloperToken(env.APPLE_DEVELOPER_TOKEN),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS, host, port),
    maxBodyBytes: parseInteger(env, 'MAX_BODY_BYTES', 1_048_576, 1_048_576),
    maxConcurrentJobs: parseInteger(env, 'MAX_CONCURRENT_JOBS', 2),
    maxQueuedJobs: parseInteger(env, 'MAX_QUEUED_JOBS', 100),
    jobTtlMs: parseInteger(env, 'JOB_TTL_MS', 900_000),
  };
};
