import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAuthStore,
  isAllowedOrigin,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_DURATIONS,
  type AuthFile,
  type SessionsFile,
} from '../src/auth.js';

const tempDir = (label: string): string =>
  mkdtempSync(join(tmpdir(), `playlist-exporter-auth-${label}-`));

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

describe('server access checks', () => {
  it('matches origins exactly and rejects null or prefix lookalikes', () => {
    const allowed = ['https://nas.example', 'http://127.0.0.1:4319'];
    expect(isAllowedOrigin('https://nas.example', allowed)).toBe(true);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('https://nas.example.evil', allowed)).toBe(false);
    expect(isAllowedOrigin('http://nas.example', allowed)).toBe(false);
  });

  it('parses only the pe_session cookie from the header', () => {
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie('')).toBeUndefined();
    expect(readSessionCookie('other=value')).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=abc`)).toBe('abc');
    expect(readSessionCookie(`foo=1; ${SESSION_COOKIE_NAME} = tok`)).toBe('tok');
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=; x=1`)).toBeUndefined();
  });

  it('defines the four documented durations', () => {
    expect(SESSION_DURATIONS['12h']).toBe(12 * HOUR_MS);
    expect(SESSION_DURATIONS['7d']).toBe(7 * DAY_MS);
    expect(SESSION_DURATIONS['30d']).toBe(30 * DAY_MS);
    expect(SESSION_DURATIONS.forever).toBe(10 * YEAR_MS);
  });
});

describe('auth store bootstrap', () => {
  it('creates the default admin/admin account on first start and announces it', async () => {
    const dataDir = tempDir('bootstrap');
    try {
      expect(existsSync(join(dataDir, 'auth.json'))).toBe(false);
      const notices: string[] = [];
      const auth = createAuthStore({ dataDir, notify: message => notices.push(message) });

      expect(notices).toEqual(['已创建默认账号 admin/admin，请尽快修改']);
      const persisted = JSON.parse(readFileSync(auth.authFilePath, 'utf8')) as AuthFile;
      expect(persisted.users).toHaveLength(1);
      const admin = persisted.users[0]!;
      expect(admin.username).toBe('admin');
      expect(admin.salt).toMatch(/^[0-9a-f]{32}$/u);
      // 绝不存明文口令。
      expect(admin.hash).not.toContain('admin');
      expect(await auth.verifyCredentials('admin', 'admin')).toBe(true);
      expect(await auth.verifyCredentials('admin', 'wrong')).toBe(false);
      expect(await auth.verifyCredentials('nobody', 'admin')).toBe(false);

      // 重启（文件已存在）不重复创建、不重复提示。
      const restarted = createAuthStore({ dataDir, notify: message => notices.push(message) });
      expect(notices).toHaveLength(1);
      expect(await restarted.verifyCredentials('admin', 'admin')).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('stores scrypt(N=16384, r=8, p=1, 64-byte) hashes with a random salt', async () => {
    const dataDir = tempDir('scrypt');
    try {
      const auth = createAuthStore({ dataDir });
      const persisted = JSON.parse(readFileSync(auth.authFilePath, 'utf8')) as AuthFile;
      const admin = persisted.users[0]!;

      // 用同样的 scrypt 参数独立重算，验证哈希可验证且参数符合规格。
      const derived = scryptSync('admin', Buffer.from(admin.salt, 'hex'), 64, {
        N: 16_384, r: 8, p: 1,
      }).toString('hex');
      expect(admin.hash).toBe(derived);
      expect(derived).toMatch(/^[0-9a-f]{128}$/u);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects corrupted stores with a Chinese error instead of silent resets', () => {
    const dataDir = tempDir('corrupt');
    try {
      writeFileSync(join(dataDir, 'auth.json'), '{not-json');
      expect(() => createAuthStore({ dataDir })).toThrow(/认证存储损坏/u);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('auth store sessions', () => {
  it('persists sessions across restarts and only stores the sha256 of the token', () => {
    const dataDir = tempDir('restart');
    try {
      // 固定时钟：让过期时间的断言与实现使用同一个 now()，避免毫秒漂移。
      let now = 1_700_000_000_000;
      const first = createAuthStore({ dataDir, now: () => now });
      const { token, expiresAt } = first.createSession('admin', SESSION_DURATIONS['30d']);
      expect(token).toMatch(/^[0-9a-f]{64}$/u);
      expect(expiresAt).toBe(new Date(now + SESSION_DURATIONS['30d']).toISOString());

      // 落盘的是 sha256(token)，不是原值。
      const persisted = JSON.parse(
        readFileSync(first.sessionsFilePath, 'utf8'),
      ) as SessionsFile;
      expect(persisted.sessions).toHaveLength(1);
      expect(persisted.sessions[0]!.tokenHash).toBe(
        createHash('sha256').update(token, 'utf8').digest('hex'),
      );
      expect(persisted.sessions[0]!.username).toBe('admin');
      expect(JSON.stringify(persisted)).not.toContain(token);

      // 重启（新实例 + 时间前进一天）后同一令牌仍有效（登录态保留）。
      now += DAY_MS;
      const restarted = createAuthStore({ dataDir, now: () => now });
      expect(restarted.getSession(token)).toEqual({ username: 'admin' });
      expect(restarted.getSession('f'.repeat(64))).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['12h', SESSION_DURATIONS['12h']],
    ['7d', SESSION_DURATIONS['7d']],
    ['30d', SESSION_DURATIONS['30d']],
    ['forever', SESSION_DURATIONS.forever],
  ] as const)('honors the %s duration with an injectable clock', (label, durationMs) => {
    const dataDir = tempDir('duration');
    try {
      const start = 1_700_000_000_000;
      let now = start;
      const auth = createAuthStore({ dataDir, now: () => now });
      const { token, expiresAt } = auth.createSession('admin', durationMs);
      expect(expiresAt).toBe(new Date(start + durationMs).toISOString());
      expect(auth.getSession(token)).toEqual({ username: 'admin' });

      // 恰好在过期边界之后失效。
      now = start + durationMs + 1;
      expect(auth.getSession(token)).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('lazily deletes expired sessions from disk on read', () => {
    const dataDir = tempDir('lazy');
    try {
      let now = 5_000_000;
      const auth = createAuthStore({ dataDir, now: () => now });
      const expired = auth.createSession('admin', SESSION_DURATIONS['12h']);
      const alive = auth.createSession('admin', SESSION_DURATIONS.forever);

      now += SESSION_DURATIONS['12h'] + 1;
      expect(auth.getSession(expired.token)).toBeUndefined();
      expect(auth.getSession(alive.token)).toEqual({ username: 'admin' });

      // 过期条目已从持久化文件中删除，未过期条目保留。
      const persisted = JSON.parse(readFileSync(auth.sessionsFilePath, 'utf8')) as SessionsFile;
      expect(persisted.sessions).toHaveLength(1);
      expect(persisted.sessions[0]!.tokenHash).toBe(
        createHash('sha256').update(alive.token, 'utf8').digest('hex'),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('deletes the exact session on logout', () => {
    const dataDir = tempDir('logout');
    try {
      const auth = createAuthStore({ dataDir });
      const first = auth.createSession('admin', SESSION_DURATIONS['12h']);
      const second = auth.createSession('admin', SESSION_DURATIONS['12h']);
      auth.deleteSession(first.token);
      expect(auth.getSession(first.token)).toBeUndefined();
      expect(auth.getSession(second.token)).toEqual({ username: 'admin' });
      // 删除不存在的会话是安全的无操作。
      expect(() => auth.deleteSession(first.token)).not.toThrow();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('auth store credential updates', () => {
  it('updates username and password, invalidates other sessions and survives restarts', async () => {
    const dataDir = tempDir('credentials');
    try {
      const auth = createAuthStore({ dataDir });
      const kept = auth.createSession('admin', SESSION_DURATIONS.forever);
      const other = auth.createSession('admin', SESSION_DURATIONS.forever);

      const result = await auth.updateCredentials({
        currentUsername: 'admin',
        currentToken: kept.token,
        newUsername: 'keeper',
        newPassword: 'brand-new-passphrase',
      });
      expect(result).toEqual({ ok: true, username: 'keeper' });

      // 当前会话保留且用户名更新；其他会话全部失效。
      expect(auth.getSession(kept.token)).toEqual({ username: 'keeper' });
      expect(auth.getSession(other.token)).toBeUndefined();

      // 新凭据生效、旧凭据作废，重启后依然如此。
      const restarted = createAuthStore({ dataDir });
      expect(await restarted.verifyCredentials('keeper', 'brand-new-passphrase')).toBe(true);
      expect(await restarted.verifyCredentials('admin', 'admin')).toBe(false);
      expect(restarted.getSession(kept.token)).toEqual({ username: 'keeper' });

      // 换用户名后旧用户名不存在 → user-not-found。
      const stale = await restarted.updateCredentials({
        currentUsername: 'admin',
        currentToken: kept.token,
        newPassword: 'another-passphrase',
      });
      expect(stale).toEqual({ ok: false, reason: 'user-not-found' });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects renaming onto an existing username', async () => {
    const dataDir = tempDir('rename-conflict');
    try {
      const auth = createAuthStore({ dataDir });
      // 人为注入第二个用户以覆盖多用户分支。
      const { users } = JSON.parse(readFileSync(auth.authFilePath, 'utf8')) as AuthFile;
      const second = {
        username: 'root',
        salt: 'ab'.repeat(16),
        hash: 'cd'.repeat(64),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(
        auth.authFilePath,
        `${JSON.stringify({ users: [...users, second] }, null, 2)}\n`,
      );
      const reloaded = createAuthStore({ dataDir });
      const session = reloaded.createSession('admin', SESSION_DURATIONS['12h']);
      const conflict = await reloaded.updateCredentials({
        currentUsername: 'admin',
        currentToken: session.token,
        newUsername: 'root',
      });
      expect(conflict).toEqual({ ok: false, reason: 'username-taken' });
      // 未改名：会话与凭据不受影响。
      expect(reloaded.getSession(session.token)).toEqual({ username: 'admin' });
      expect(await reloaded.verifyCredentials('admin', 'admin')).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rotates the salt when only the password changes', async () => {
    const dataDir = tempDir('password-only');
    try {
      const auth = createAuthStore({ dataDir });
      const before = (JSON.parse(readFileSync(auth.authFilePath, 'utf8')) as AuthFile).users[0]!;
      const session = auth.createSession('admin', SESSION_DURATIONS.forever);
      const result = await auth.updateCredentials({
        currentUsername: 'admin',
        currentToken: session.token,
        newPassword: 'only-password-1',
      });
      expect(result).toEqual({ ok: true, username: 'admin' });
      const after = (JSON.parse(readFileSync(auth.authFilePath, 'utf8')) as AuthFile).users[0]!;
      expect(after.username).toBe('admin');
      expect(after.salt).not.toBe(before.salt);
      expect(after.hash).not.toBe(before.hash);
      expect(await auth.verifyCredentials('admin', 'only-password-1')).toBe(true);
      expect(await auth.verifyCredentials('admin', 'admin')).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
