import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- Origin 检查（保持既有语义） ----------

export const isAllowedOrigin = (
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean => origin !== undefined && origin !== 'null' && allowedOrigins.includes(origin);

// ---------- 会话 Cookie ----------

export const SESSION_COOKIE_NAME = 'pe_session';

/** 解析请求 Cookie 头中的会话令牌；不存在或为空返回 undefined。 */
export const readSessionCookie = (cookieHeader: string | undefined): string | undefined => {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
};

/**
 * 登录成功后下发的会话 Cookie。部署形态是同源（服务端托管 UI）且普遍为
 * 局域网 HTTP，因此不添加 Secure 属性；HttpOnly + SameSite=Strict 保证
 * 脚本不可读、跨源请求不携带。
 */
export const buildSessionCookie = (token: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;

export const CLEAR_SESSION_COOKIE =
  `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

// ---------- 登录时长选项 ----------

/** 登录时可自选的会话时长；forever 按 10 年实现。 */
export const SESSION_DURATIONS = {
  '12h': 12 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
  forever: 10 * 365 * 24 * 3_600_000,
} as const;

export type SessionDurationId = keyof typeof SESSION_DURATIONS;

// ---------- 口令散列（scrypt N=16384, r=8, p=1, 64 字节） ----------

const SCRYPT_PARAMS: ScryptOptions = { N: 16_384, r: 8, p: 1 };
const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error !== null) reject(error);
      else resolve(derivedKey);
    });
  });

const derivePasswordHash = (password: string, salt: Buffer): Promise<Buffer> =>
  scryptAsync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_PARAMS);

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

// 用户不存在时也执行一次同代价的 scrypt，避免用时序差异枚举用户名。
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0);

// ---------- 存储文件结构 ----------

export interface UserRecord {
  readonly username: string;
  /** 随机盐（hex）。 */
  readonly salt: string;
  /** scrypt 派生密钥（hex），绝不存明文口令。 */
  readonly hash: string;
  readonly createdAt: string;
}

export interface AuthFile {
  readonly users: readonly UserRecord[];
}

export interface SessionRecord {
  /** 会话令牌的 sha256 摘要（hex）；原始令牌只存在于 Cookie 中，不落盘。 */
  readonly tokenHash: string;
  readonly username: string;
  /** ISO 8601 过期时间；读取时惰性删除过期条目。 */
  readonly expiresAt: string;
}

export interface SessionsFile {
  readonly sessions: readonly SessionRecord[];
}

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';
const DEFAULT_ACCOUNT_NOTICE = '已创建默认账号 admin/admin，请尽快修改';

// ---------- 认证存储 ----------

export interface AuthStoreOptions {
  /** 数据目录（容器内为卷挂载点 /data），auth.json 与 sessions.json 位于其下。 */
  readonly dataDir: string;
  /** 可注入时钟（测试用），默认 Date.now。 */
  readonly now?: () => number;
  /** 启动提示通道（如"已创建默认账号"），默认静默。 */
  readonly notify?: (message: string) => void;
}

export interface CreatedSession {
  /** 原始令牌：仅通过 Set-Cookie 下发一次，服务端只持久化其 sha256。 */
  readonly token: string;
  readonly expiresAt: string;
}

export interface SessionInfo {
  readonly username: string;
}

export interface UpdateCredentialsInput {
  readonly currentUsername: string;
  /** 当前已登录会话的原始令牌；修改成功后除它之外的全部会话失效。 */
  readonly currentToken: string;
  readonly newUsername?: string;
  readonly newPassword?: string;
}

export type UpdateCredentialsResult =
  | { readonly ok: true; readonly username: string }
  | { readonly ok: false; readonly reason: 'user-not-found' | 'username-taken' };

export interface AuthStore {
  readonly authFilePath: string;
  readonly sessionsFilePath: string;
  verifyCredentials(username: string, password: string): Promise<boolean>;
  createSession(username: string, durationMs: number): CreatedSession;
  getSession(token: string): SessionInfo | undefined;
  deleteSession(token: string): void;
  updateCredentials(input: UpdateCredentialsInput): Promise<UpdateCredentialsResult>;
}

/**
 * 基于文件的认证存储：
 * - /data/auth.json：用户列表（scrypt 加盐哈希），首次启动自动创建 admin/admin；
 * - /data/sessions.json：服务端会话（tokenHash + username + expiresAt），
 *   重启后登录态保留；过期会话在读取时惰性删除。
 * 写入均为原子操作（临时文件 + rename）。
 */
export const createAuthStore = (options: AuthStoreOptions): AuthStore => {
  const now = options.now ?? Date.now;
  const notify = options.notify ?? (() => undefined);
  const authFilePath = join(options.dataDir, 'auth.json');
  const sessionsFilePath = join(options.dataDir, 'sessions.json');

  try {
    mkdirSync(options.dataDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法创建数据目录 ${options.dataDir}（${message}）`);
  }

  const readJsonFile = <T>(
    path: string,
    missingFallback: T,
    label: string,
  ): T => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return missingFallback;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}不可读: ${path}（${message}）`);
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`${label}损坏，无法安全使用: ${path}`);
    }
  };

  const writeJsonFileAtomic = (path: string, value: unknown): void => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, path);
  };

  // ---------- 用户（账号）存储 ----------

  const parseUsers = (value: unknown): UserRecord[] => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`认证存储损坏，根节点必须是对象: ${authFilePath}`);
    }
    const rawUsers = (value as { users?: unknown }).users;
    if (!Array.isArray(rawUsers)) {
      throw new Error(`认证存储损坏，users 必须是数组: ${authFilePath}`);
    }
    return rawUsers.map(user => {
      if (typeof user !== 'object' || user === null) {
        throw new Error(`认证存储损坏，用户条目必须是对象: ${authFilePath}`);
      }
      const entry = user as Record<string, unknown>;
      if (typeof entry.username !== 'string' ||
          typeof entry.salt !== 'string' ||
          typeof entry.hash !== 'string') {
        throw new Error(`认证存储损坏，用户条目不完整: ${authFilePath}`);
      }
      return {
        username: entry.username,
        salt: entry.salt,
        hash: entry.hash,
        createdAt: typeof entry.createdAt === 'string'
          ? entry.createdAt
          : new Date(now()).toISOString(),
      };
    });
  };
  const users: UserRecord[] = parseUsers(
    readJsonFile<unknown>(authFilePath, { users: [] }, '认证存储'),
  );
  const persistUsers = (): void => writeJsonFileAtomic(authFilePath, { users } satisfies AuthFile);

  // 首次启动（文件不存在或没有用户）：自动创建默认账号 admin/admin。
  if (users.length === 0) {
    const salt = randomBytes(SALT_BYTES).toString('hex');
    const hash = scryptSync(
      DEFAULT_PASSWORD,
      Buffer.from(salt, 'hex'),
      SCRYPT_KEY_LENGTH,
      SCRYPT_PARAMS,
    ).toString('hex');
    users.push({
      username: DEFAULT_USERNAME,
      salt,
      hash,
      createdAt: new Date(now()).toISOString(),
    });
    persistUsers();
    notify(DEFAULT_ACCOUNT_NOTICE);
  }

  const findUser = (username: string): UserRecord | undefined =>
    users.find(user => user.username === username);

  const verifyCredentials = async (username: string, password: string): Promise<boolean> => {
    const user = findUser(username);
    if (user === undefined) {
      // 与真实校验同代价的派生计算，消除"用户是否存在"的时序差异。
      await derivePasswordHash(password, DUMMY_SALT);
      return false;
    }
    const expected = Buffer.from(user.hash, 'hex');
    const candidate = await derivePasswordHash(password, Buffer.from(user.salt, 'hex'));
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  };

  // ---------- 会话存储 ----------

  const loadedSessions: unknown =
    readJsonFile<unknown>(sessionsFilePath, { sessions: [] }, '会话存储');
  const sessions = new Map<string, SessionRecord>();
  if (typeof loadedSessions === 'object' && loadedSessions !== null) {
    const rawSessions = (loadedSessions as { sessions?: unknown }).sessions;
    if (!Array.isArray(rawSessions) && rawSessions !== undefined) {
      throw new Error(`会话存储损坏，sessions 必须是数组: ${sessionsFilePath}`);
    }
    for (const record of rawSessions ?? []) {
      if (typeof record !== 'object' || record === null) {
        throw new Error(`会话存储损坏，会话条目必须是对象: ${sessionsFilePath}`);
      }
      const entry = record as Record<string, unknown>;
      if (typeof entry.tokenHash !== 'string' ||
          typeof entry.username !== 'string' ||
          typeof entry.expiresAt !== 'string') {
        throw new Error(`会话存储损坏，会话条目不完整: ${sessionsFilePath}`);
      }
      sessions.set(entry.tokenHash, {
        tokenHash: entry.tokenHash,
        username: entry.username,
        expiresAt: entry.expiresAt,
      });
    }
  }
  const persistSessions = (): void =>
    writeJsonFileAtomic(sessionsFilePath, { sessions: [...sessions.values()] } satisfies SessionsFile);

  /** 惰性清理：读取路径上顺带删除全部过期会话，有变更才落盘。 */
  const pruneExpiredSessions = (): boolean => {
    const current = now();
    let removed = false;
    for (const [tokenHash, record] of sessions) {
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= current) {
        sessions.delete(tokenHash);
        removed = true;
      }
    }
    if (removed) persistSessions();
    return removed;
  };

  const createSession = (username: string, durationMs: number): CreatedSession => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError('会话时长必须为正数毫秒');
    }
    pruneExpiredSessions();
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(now() + durationMs).toISOString();
    sessions.set(tokenHash, { tokenHash, username, expiresAt });
    persistSessions();
    return { token, expiresAt };
  };

  const getSession = (token: string): SessionInfo | undefined => {
    if (token === '') return undefined;
    pruneExpiredSessions();
    const record = sessions.get(sha256Hex(token));
    return record === undefined ? undefined : { username: record.username };
  };

  const deleteSession = (token: string): void => {
    if (sessions.delete(sha256Hex(token))) persistSessions();
  };

  // ---------- 修改凭据 ----------

  const updateCredentials = async (
    input: UpdateCredentialsInput,
  ): Promise<UpdateCredentialsResult> => {
    const user = findUser(input.currentUsername);
    if (user === undefined) return { ok: false, reason: 'user-not-found' };
    const finalUsername = input.newUsername ?? input.currentUsername;
    if (input.newUsername !== undefined && input.newUsername !== input.currentUsername &&
        findUser(input.newUsername) !== undefined) {
      return { ok: false, reason: 'username-taken' };
    }
    if (input.newPassword !== undefined) {
      // 改口令时同时更换盐，旧哈希彻底作废。
      const salt = randomBytes(SALT_BYTES).toString('hex');
      const hash = (await derivePasswordHash(
        input.newPassword,
        Buffer.from(salt, 'hex'),
      )).toString('hex');
      users[users.indexOf(user)] = {
        username: finalUsername,
        salt,
        hash,
        createdAt: user.createdAt,
      };
    } else {
      users[users.indexOf(user)] = { ...user, username: finalUsername };
    }
    persistUsers();

    // 除当前会话外全部失效；当前会话跟随新用户名。
    const keepTokenHash = sha256Hex(input.currentToken);
    let changed = false;
    for (const tokenHash of sessions.keys()) {
      if (tokenHash !== keepTokenHash) {
        sessions.delete(tokenHash);
        changed = true;
      }
    }
    const kept = sessions.get(keepTokenHash);
    if (kept !== undefined && kept.username !== finalUsername) {
      sessions.set(keepTokenHash, { ...kept, username: finalUsername });
      changed = true;
    }
    if (changed) persistSessions();
    return { ok: true, username: finalUsername };
  };

  return {
    authFilePath,
    sessionsFilePath,
    verifyCredentials,
    createSession,
    getSession,
    deleteSession,
    updateCredentials,
  };
};
