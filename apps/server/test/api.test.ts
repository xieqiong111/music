import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type {
  HttpTransport,
  MusicProvider,
  Playlist,
  ProviderId,
  TaskContext,
} from '@playlist-exporter/contracts';
import {
  createServerApp,
  type LocalDuplicateFilter,
  type ServerLogEvent,
} from '../src/app.js';
import { createAuthStore, type AuthStore } from '../src/auth.js';
import type { ServerConfig } from '../src/config.js';
import { createJobRegistry } from '../src/jobs.js';

const origin = 'http://127.0.0.1:4319';
const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  host: '127.0.0.1',
  port: 4319,
  dataDir: '/data',
  allowedOrigins: [origin],
  maxBodyBytes: 1_048_576,
  maxConcurrentJobs: 2,
  maxQueuedJobs: 10,
  jobTtlMs: 60_000,
  ...overrides,
});

const result: Playlist = {
  id: '42',
  name: '测试歌单 🎵',
  source: 'netease',
  total: 1,
  tracks: [{
    title: '歌一',
    artists: ['歌手甲', '歌手乙'],
    source: 'netease',
    availability: 'available',
    position: 0,
    warnings: [],
  }],
  complete: true,
  warnings: [],
};

const provider = (fetchPlaylist?: MusicProvider['fetchPlaylist']): MusicProvider => ({
  id: 'netease',
  validateInput: vi.fn(async input => ({
    valid: /^\d+$/u.test(input.value),
    ...(/^\d+$/u.test(input.value) ? {} : { message: '请输入有效歌单 ID' }),
  })),
  authenticate: vi.fn(async () => ({ authenticated: false })),
  fetchPlaylist: fetchPlaylist ?? vi.fn(async (_input, context) => {
    context.onProgress?.({ phase: 'fetching', completed: 1, total: 1 });
    return result;
  }),
  fetchAllTracks: vi.fn(async () => result.tracks),
  logout: vi.fn(async () => undefined),
});

const noNetwork: HttpTransport = {
  async request() { throw new Error('real network disabled in API test'); },
};

// 曲目指纹排除(excludeTrackKeys)专用歌单:原始值刻意包含大小写/多余空格/
// 乱序歌手与空歌手列表,用于验证服务端按冻结公式归一化后命中。
const fingerprintPlaylist: Playlist = {
  id: '42',
  name: '指纹排除歌单',
  source: 'netease',
  total: 4,
  tracks: [
    {
      title: 'Starlight',
      artists: ['Aimer'],
      source: 'netease',
      availability: 'available',
      position: 0,
      warnings: [],
    },
    {
      title: '  Night  RUN  ',
      artists: ['B', 'A'],
      source: 'netease',
      availability: 'available',
      position: 1,
      warnings: [],
    },
    {
      title: '孤勇者',
      artists: ['陈奕迅'],
      source: 'netease',
      availability: 'available',
      position: 2,
      warnings: [],
    },
    {
      title: 'NoArtist',
      artists: [],
      source: 'netease',
      availability: 'available',
      position: 3,
      warnings: [],
    },
  ],
  complete: true,
  warnings: [],
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const tempAuthDir = (label: string): string =>
  mkdtempSync(join(tmpdir(), `playlist-exporter-api-${label}-`));

// 大多数用例只读共享账号目录（admin/admin），个别用例（改凭据/过期）自建目录。
const sharedAuthDir = tempAuthDir('shared');
afterAll(() => rmSync(sharedAuthDir, { recursive: true, force: true }));

const createFixture = (options: {
  config?: ServerConfig;
  provider?: MusicProvider;
  providers?: ReadonlyMap<ProviderId, MusicProvider>;
  logger?: (event: ServerLogEvent) => void;
  auth?: AuthStore;
  filterLocalDuplicates?: LocalDuplicateFilter;
} = {}) => {
  const selectedConfig = options.config ?? config();
  const jobs = createJobRegistry({
    maxConcurrent: selectedConfig.maxConcurrentJobs,
    maxQueued: selectedConfig.maxQueuedJobs,
    terminalTtlMs: selectedConfig.jobTtlMs,
    idFactory: () => 'job-1',
  });
  const selectedProvider = options.provider ?? provider();
  const auth = options.auth ?? createAuthStore({ dataDir: sharedAuthDir });
  const app = createServerApp({
    config: selectedConfig,
    providers: options.providers ?? new Map([['netease', selectedProvider]]),
    http: noNetwork,
    jobs,
    auth,
    logger: options.logger,
    requestIdFactory: () => 'request-1',
    ...(options.filterLocalDuplicates === undefined
      ? {}
      : { filterLocalDuplicates: options.filterLocalDuplicates }),
  });
  return { app, jobs, provider: selectedProvider, auth };
};

const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  origin,
  ...extra,
});

const login = async (
  app: ReturnType<typeof createServerApp>,
  body: Record<string, unknown> = { username: 'admin', password: 'admin', duration: '7d' },
): Promise<Response> => app.request('/api/auth/login', {
  method: 'POST',
  headers: jsonHeaders(),
  body: JSON.stringify(body),
});

const loginCookie = async (
  app: ReturnType<typeof createServerApp>,
): Promise<string> => {
  const response = await login(app);
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  expect(cookie.startsWith('pe_session=')).toBe(true);
  return cookie;
};

// 建立"已完成任务 = fingerprintPlaylist"的夹具,并返回带会话 Cookie 的导出函数。
const fingerprintFixture = async (
  fixtureOptions: { filterLocalDuplicates?: LocalDuplicateFilter } = {},
) => {
  const { app, jobs } = createFixture({
    provider: provider(vi.fn(async () => fingerprintPlaylist)),
    ...fixtureOptions,
  });
  const cookie = await loginCookie(app);
  await app.request('/api/playlists/inspect', {
    method: 'POST', headers: jsonHeaders({ cookie }),
    body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
  });
  await flush();
  const exportOptions = async (options: Record<string, unknown>): Promise<Response> =>
    app.request('/api/exports', {
      method: 'POST', headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ jobId: 'job-1', options }),
    });
  return { app, jobs, exportOptions };
};

describe('local NAS API', () => {
  it('keeps healthz public and minimal', async () => {
    const { app, jobs } = createFixture();
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    jobs.close();
  });

  it('requires a login session cookie and an exact origin for mutations', async () => {
    const { app, jobs } = createFixture();
    const body = JSON.stringify({ provider: 'netease', input: { value: '42' } });

    const missing = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders(), body,
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: 'AUTH_REQUIRED', message: '请先登录' });

    // 无效会话 Cookie 同样被拒。
    const invalid = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie: 'pe_session=deadbeef' }), body,
    });
    expect(invalid.status).toBe(401);

    // 非法 Origin：即使携带有效会话也 403，且不回显允许来源。
    const cookie = await loginCookie(app);
    const foreign = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ origin: 'https://evil.example', cookie }),
      body,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    // 变更类请求缺失 Origin 头同样 403（现状语义保持）。
    const absentOrigin = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body,
    });
    expect(absentOrigin.status).toBe(403);

    const allowed = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body,
    });
    expect(allowed.status).toBe(202);
    jobs.close();
  });

  it('exposes the four auth endpoints with the documented contract', async () => {
    const { app, jobs } = createFixture();

    // 未登录 status。
    const anonymous = await app.request('/api/auth/status', { headers: { origin } });
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ authenticated: false });

    // 登录成功：Set-Cookie + 会话状态可见。
    const success = await login(app);
    expect(success.status).toBe(200);
    expect(success.headers.get('set-cookie')).toMatch(
      /^pe_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/u,
    );
    expect(await success.json()).toMatchObject({ authenticated: true, username: 'admin' });
    const cookie = success.headers.get('set-cookie')!.split(';', 1)[0];

    const status = await app.request('/api/auth/status', { headers: { cookie, origin } });
    expect(await status.json()).toEqual({ authenticated: true, username: 'admin' });

    // 登录失败：用户名或密码不正确（不区分用户名与密码错误）。
    const wrongPassword = await login(app, { username: 'admin', password: 'nope', duration: '7d' });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toMatchObject({
      code: 'AUTH_REQUIRED',
      message: '用户名或密码不正确',
    });
    const wrongUser = await login(app, { username: 'nobody', password: 'admin', duration: '7d' });
    expect(wrongUser.status).toBe(401);

    // duration 非法 → 400。
    for (const duration of ['1h', 'forever2', '', 42]) {
      const invalid = await login(app, { username: 'admin', password: 'admin', duration });
      expect(invalid.status, String(duration)).toBe(400);
    }

    // 登出：总是 200，服务端会话删除 + Cookie 清除。
    const logout = await app.request('/api/auth/logout', {
      method: 'POST', headers: jsonHeaders({ cookie }),
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    const afterLogout = await app.request('/api/auth/status', { headers: { cookie, origin } });
    expect(await afterLogout.json()).toEqual({ authenticated: false });

    // 无 Cookie 登出也总是 200。
    const bare = await app.request('/api/auth/logout', { method: 'POST', headers: jsonHeaders() });
    expect(bare.status).toBe(200);
    jobs.close();
  });

  it('updates credentials: wrong current password, validation and session invalidation', async () => {
    const dataDir = tempAuthDir('credentials');
    try {
      const { app, jobs } = createFixture({ auth: createAuthStore({ dataDir }) });

      // 建立两个会话：修改凭据后除当前会话外全部失效。
      const first = await loginCookie(app);
      const second = await loginCookie(app);

      // 未登录 → 401。
      const anonymous = await app.request('/api/auth/credentials', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ currentPassword: 'admin', password: 'new-secret-1' }),
      });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: 'AUTH_REQUIRED' });

      const post = (cookie: string, body: Record<string, unknown>): RequestInit => ({
        method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify(body),
      });

      // currentPassword 错误 → 401。
      const wrongCurrent = await app.request('/api/auth/credentials',
        post(first, { currentPassword: 'wrong!', password: 'new-secret-1' }));
      expect(wrongCurrent.status).toBe(401);
      expect(await wrongCurrent.json()).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: '当前密码不正确',
      });

      // 校验规则：至少改一项、用户名非空 ≤64、密码 ≥6。
      for (const [body, message] of [
        [{ currentPassword: 'admin' }, '至少修改用户名或密码之一'],
        [{ currentPassword: 'admin', username: '  ' }, '用户名不能为空'],
        [{ currentPassword: 'admin', username: '长'.repeat(65) }, '用户名长度不能超过 64 个字符'],
        [{ currentPassword: 'admin', password: '短5个' }, '新密码至少需要 6 个字符'],
        [{ currentPassword: 'admin', username: 'admin' }, '至少修改用户名或密码之一'],
      ] as const) {
        const invalid = await app.request('/api/auth/credentials', post(first, body));
        expect(invalid.status, JSON.stringify(body)).toBe(400);
        expect(await invalid.json()).toMatchObject({ code: 'INVALID_REQUEST', message });
      }

      // 成功改名改密：当前会话保留（用户名跟随更新），另一个会话失效。
      const updated = await app.request('/api/auth/credentials', post(first, {
        currentPassword: 'admin',
        username: ' Keeper ',
        password: 'new-secret-1',
      }));
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({ authenticated: true, username: 'Keeper' });

      const keptStatus = await app.request('/api/auth/status', { headers: { cookie: first, origin } });
      expect(await keptStatus.json()).toEqual({ authenticated: true, username: 'Keeper' });
      const revoked = await app.request('/api/playlists/inspect', {
        method: 'POST', headers: jsonHeaders({ cookie: second }),
        body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
      });
      expect(revoked.status).toBe(401);

      // 新凭据生效：旧密码 401，新密码 200。
      const oldPassword = await login(app, { username: 'Keeper', password: 'admin', duration: '7d' });
      expect(oldPassword.status).toBe(401);
      const relogin = await login(app, { username: 'Keeper', password: 'new-secret-1', duration: '7d' });
      expect(relogin.status).toBe(200);

      // 与新的 AuthStore 实例（模拟重启）共享同一数据目录：新凭据仍生效。
      const restarted = createAuthStore({ dataDir });
      expect(await restarted.verifyCredentials('Keeper', 'new-secret-1')).toBe(true);
      expect(await restarted.verifyCredentials('admin', 'admin')).toBe(false);
      jobs.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('expires sessions lazily with an injectable clock', async () => {
    const dataDir = tempAuthDir('expiry');
    try {
      let now = 1_000_000;
      const auth = createAuthStore({ dataDir, now: () => now });
      const { app, jobs } = createFixture({ auth });

      const response = await login(app, { username: 'admin', password: 'admin', duration: '12h' });
      const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
      const token = cookie.slice('pe_session='.length);

      // 12h 内有效。
      now += 12 * 3_600_000 - 1;
      const before = await app.request('/api/playlists/inspect', {
        method: 'POST', headers: jsonHeaders({ cookie }),
        body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
      });
      expect(before.status).toBe(202);
      jobs.close();

      // 过期后：状态查询为未登录，受保护请求 401，且读取路径惰性删除并落盘。
      now += 1;
      const expired = await app.request('/api/auth/status', { headers: { cookie, origin } });
      expect(await expired.json()).toEqual({ authenticated: false });
      const denied = await app.request('/api/playlists/inspect', {
        method: 'POST', headers: jsonHeaders({ cookie }),
        body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
      });
      expect(denied.status).toBe(401);
      const persisted = readFileSync(auth.sessionsFilePath, 'utf8');
      expect(persisted).not.toContain(token);
      expect(persisted).toBe('{\n  "sessions": []\n}\n');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('supports strict preflight without wildcard or credentials', async () => {
    const { app, jobs } = createFixture();
    const response = await app.request('/api/playlists/inspect', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toContain('Origin');
    jobs.close();
  });

  it('runs inspect to completion and exports exact UTF-8 bytes from the stored job', async () => {
    const { app, jobs } = createFixture();
    const cookie = await loginCookie(app);
    const accepted = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('location')).toBe('/api/jobs/job-1');
    expect(await accepted.json()).toMatchObject({ jobId: 'job-1' });
    await flush();

    const inspected = await app.request('/api/jobs/job-1', { headers: { origin, cookie } });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({
      jobId: 'job-1', status: 'completed', result: { id: '42', total: 1 },
    });

    const exported = await app.request('/api/exports', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({
        jobId: 'job-1',
        options: { format: 'txt', date: '2026-09-04', generatedAt: '2026-09-04T00:00:00.000Z' },
      }),
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toBe('text/plain;charset=utf-8');
    expect(exported.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(exported.headers.get('cache-control')).toBe('no-store');
    expect(exported.headers.get('x-excluded-local-count')).toBeNull();
    expect(new TextDecoder('utf-8', { fatal: true }).decode(await exported.arrayBuffer()))
      .toBe('歌一 - 歌手甲、歌手乙\n');
    jobs.close();
  });

  it('runs the optional local-duplicate filter pipeline only when wired and enabled', async () => {
    const filteredPlaylist: Playlist = { ...result, tracks: [], total: 0 };
    const duplicateFilter = vi.fn((playlist: Playlist) => ({
      playlist: filteredPlaylist,
      excluded: 1,
    }));
    const { app, jobs } = createFixture({ filterLocalDuplicates: duplicateFilter });
    const cookie = await loginCookie(app);
    await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    await flush();

    // 选项开启：使用过滤后的歌单导出并回传被剔除数量。
    const filtered = await app.request('/api/exports', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt', excludeLocalDuplicates: true } }),
    });
    expect(filtered.status).toBe(200);
    expect(duplicateFilter).toHaveBeenCalledTimes(1);
    expect(filtered.headers.get('x-excluded-local-count')).toBe('1');
    expect(await filtered.text()).toBe('');

    // 选项缺省：完全现状行为，不触发过滤、无剔除头。
    const untouched = await app.request('/api/exports', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt' } }),
    });
    expect(untouched.status).toBe(200);
    expect(untouched.headers.get('x-excluded-local-count')).toBeNull();
    expect(await untouched.text()).toBe('歌一 - 歌手甲、歌手乙\n');
    expect(duplicateFilter).toHaveBeenCalledTimes(1);

    // 选项为 false：同样不过滤。
    const disabled = await app.request('/api/exports', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({
        jobId: 'job-1',
        options: { format: 'txt', excludeLocalDuplicates: false },
      }),
    });
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get('x-excluded-local-count')).toBeNull();
    expect(duplicateFilter).toHaveBeenCalledTimes(1);
    jobs.close();
  });

  it('keeps exports unfiltered when the dependency is not injected', async () => {
    const { app, jobs } = createFixture();
    const cookie = await loginCookie(app);
    await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    await flush();
    const exported = await app.request('/api/exports', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ jobId: 'job-1', options: { format: 'txt', excludeLocalDuplicates: true } }),
    });
    // 依赖未注入：选项被忽略，导出原始歌单，无剔除头。
    expect(exported.status).toBe(200);
    expect(exported.headers.get('x-excluded-local-count')).toBeNull();
    expect(await exported.text()).toBe('歌一 - 歌手甲、歌手乙\n');
    jobs.close();
  });

  it('runs inspect against a registered qq-music provider and keeps apple-music unsupported', async () => {
    const qq = { ...provider(), id: 'qq-music' as const };
    const { app, jobs } = createFixture({
      providers: new Map<ProviderId, MusicProvider>([
        ['netease', provider()],
        ['qq-music', qq],
      ]),
    });
    const cookie = await loginCookie(app);

    const accepted = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'qq-music', input: { value: '7729596131' } }),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('location')).toBe('/api/jobs/job-1');
    await flush();
    expect(qq.validateInput).toHaveBeenCalled();
    expect(qq.fetchPlaylist).toHaveBeenCalled();

    const unsupported = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'apple-music', input: { value: '42' } }),
    });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ code: 'UNSUPPORTED_PROVIDER' });
    jobs.close();
  });

  it('enforces the 1 MiB body limit before parsing or provider work', async () => {
    const selected = provider();
    const { app, jobs } = createFixture({ provider: selected });
    const cookie = await loginCookie(app);
    const response = await app.request('/api/playlists/inspect', {
      method: 'POST',
      headers: jsonHeaders({ cookie }),
      body: 'x'.repeat(1_048_577),
    });
    expect(response.status).toBe(413);
    expect(selected.validateInput).not.toHaveBeenCalled();
    jobs.close();
  });

  it('rejects malformed requests without echoing their body', async () => {
    const { app, jobs } = createFixture();
    const cookie = await loginCookie(app);
    const malformed = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie }), body: '{"token":"should-not-escape"',
    });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).not.toContain('should-not-escape');

    const invalid = await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'netease', input: { value: 'not-an-id' }, extra: true }),
    });
    expect(invalid.status).toBe(400);
    jobs.close();
  });

  it('cancels an active job and does not expose its input', async () => {
    let runningContext!: TaskContext;
    const never = new Promise<Playlist>(() => undefined);
    const selected = provider(vi.fn(async (_input, context) => {
      runningContext = context;
      return never;
    }));
    const { app, jobs } = createFixture({ provider: selected });
    const cookie = await loginCookie(app);
    await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    const cancelled = await app.request('/api/jobs/job-1', {
      method: 'DELETE', headers: { origin, cookie },
    });
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ jobId: 'job-1', status: 'cancelled' });
    expect(runningContext.signal.aborted).toBe(true);
    // The snapshot must not expose the submitted playlist input. (A raw
    // `not.toContain('42')` was flaky: ISO timestamps can contain "42".)
    const snapshot = JSON.stringify(jobs.get('job-1'));
    expect(snapshot).not.toContain('"input"');
    expect(snapshot).not.toContain('"value"');
    jobs.close();
  });

  it('returns safe failed-job errors and allowlisted structured logs', async () => {
    const logs: ServerLogEvent[] = [];
    const selected = provider(vi.fn(async () => {
      throw new Error('Authorization: Bearer should-not-escape');
    }));
    const { app, jobs } = createFixture({ provider: selected, logger: event => logs.push(event) });
    const cookie = await loginCookie(app);
    await app.request('/api/playlists/inspect', {
      method: 'POST', headers: jsonHeaders({ cookie }),
      body: JSON.stringify({ provider: 'netease', input: { value: '42' } }),
    });
    await flush();
    const response = await app.request('/api/jobs/job-1', { headers: { origin, cookie } });
    const text = await response.text();
    expect(text).not.toContain('should-not-escape');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'TASK_FAILED' } });
    for (const event of logs) {
      expect(Object.keys(event).sort()).toEqual(['requestId', 'status']);
    }
    jobs.close();
  });

  it('excludes tracks matching excludeTrackKeys fingerprints and reranks positions and total', async () => {
    const { jobs, exportOptions } = await fingerprintFixture();
    const response = await exportOptions({
      format: 'json',
      date: '2026-09-04',
      generatedAt: '2026-09-04T00:00:00.000Z',
      excludeTrackKeys: ['t|starlight|aimer'],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-excluded-track-count')).toBe('1');
    expect(response.headers.get('x-track-count')).toBe('3');
    const envelope = await response.json();
    expect(envelope.exportedTrackCount).toBe(3);
    expect(envelope.playlist.total).toBe(3);
    expect(envelope.playlist.complete).toBe(true);
    expect(envelope.playlist.tracks.map((t: { title: string; position: number }) => [t.title, t.position]))
      .toEqual([
        ['  Night  RUN  ', 0],
        ['孤勇者', 1],
        ['NoArtist', 2],
      ]);
    expect(envelope.playlist.warnings).toContain('已按本机音乐库排除 1 首重复曲目');
    jobs.close();
  });

  it('hits keys after normalize (case/spacing/artist order) and misses non-normalized keys', async () => {
    const { jobs, exportOptions } = await fingerprintFixture();
    // 曲目原始值 '  Night  RUN  '/['B','A'];按冻结公式归一化(含歌手排序)后命中。
    const normalized = await exportOptions({
      format: 'json',
      excludeTrackKeys: ['t|night run|a;b'],
    });
    expect(normalized.status).toBe(200);
    expect(normalized.headers.get('x-excluded-track-count')).toBe('1');
    const envelope = await normalized.json();
    expect(envelope.tracks.map((t: { title: string }) => t.title))
      .toEqual(['Starlight', '孤勇者', 'NoArtist']);

    // 服务端不归一化 key 本身:未按冻结公式归一化的 key(大小写/空格/歌手顺序原样)不命中。
    const raw = await exportOptions({
      format: 'json',
      excludeTrackKeys: ['t|  Night  RUN  |B;A'],
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('x-excluded-track-count')).toBe('0');
    expect((await raw.json()).exportedTrackCount).toBe(4);
    jobs.close();
  });

  it('matches the empty-artists fingerprint t|title|', async () => {
    const { jobs, exportOptions } = await fingerprintFixture();
    const response = await exportOptions({ format: 'json', excludeTrackKeys: ['t|noartist|'] });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-excluded-track-count')).toBe('1');
    const envelope = await response.json();
    expect(envelope.tracks.map((t: { title: string }) => t.title))
      .toEqual(['Starlight', '  Night  RUN  ', '孤勇者']);
    jobs.close();
  });

  it('rejects invalid excludeTrackKeys with 400 INVALID_EXPORT_OPTIONS', async () => {
    const { jobs, exportOptions } = await fingerprintFixture();
    for (const keys of [
      [''], // 空字符串项
      ['k'.repeat(201)], // 超过 200 字符
      Array.from({ length: 5001 }, (_, index) => `k${index}`), // 超过 5000 项
    ]) {
      const response = await exportOptions({ format: 'txt', excludeTrackKeys: keys });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'INVALID_EXPORT_OPTIONS',
        message: expect.stringContaining('排除曲目指纹'),
      });
    }

    // 边界:恰好 200 字符 / 恰好 5000 项 / 空数组均合法;选项存在即便剔除 0 首也输出头。
    const boundary200 = await exportOptions({
      format: 'txt',
      excludeTrackKeys: [`t|${'a'.repeat(197)}`],
    });
    expect(boundary200.status).toBe(200);
    expect(boundary200.headers.get('x-excluded-track-count')).toBe('0');
    const boundary5000 = await exportOptions({
      format: 'txt',
      excludeTrackKeys: Array.from({ length: 5000 }, (_, index) => `k${index}`),
    });
    expect(boundary5000.status).toBe(200);
    expect(boundary5000.headers.get('x-excluded-track-count')).toBe('0');
    jobs.close();
  });

  it('applies excludeLocalDuplicates and excludeTrackKeys as a union with independent counts', async () => {
    const duplicateFilter = vi.fn((playlist: Playlist) => {
      const kept = playlist.tracks.filter(track => track.title !== '孤勇者');
      return {
        playlist: {
          ...playlist,
          total: kept.length,
          tracks: kept.map((track, position) => ({ ...track, position })),
          warnings: [
            ...playlist.warnings,
            `已按本地音乐库排除 ${playlist.tracks.length - kept.length} 首重复曲目`,
          ],
        },
        excluded: playlist.tracks.length - kept.length,
      };
    });
    const { jobs, exportOptions } = await fingerprintFixture({ filterLocalDuplicates: duplicateFilter });
    const response = await exportOptions({
      format: 'json',
      excludeLocalDuplicates: true,
      excludeTrackKeys: ['t|noartist|'],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-excluded-local-count')).toBe('1');
    expect(response.headers.get('x-excluded-track-count')).toBe('1');
    expect(response.headers.get('x-track-count')).toBe('2');
    const envelope = await response.json();
    expect(envelope.exportedTrackCount).toBe(2);
    expect(envelope.playlist.total).toBe(2);
    expect(envelope.playlist.complete).toBe(true);
    expect(envelope.tracks.map((t: { title: string }) => t.title))
      .toEqual(['Starlight', '  Night  RUN  ']);
    expect(envelope.playlist.warnings).toContain('已按本地音乐库排除 1 首重复曲目');
    expect(envelope.playlist.warnings).toContain('已按本机音乐库排除 1 首重复曲目');
    jobs.close();
  });

  it('keeps current behavior when excludeTrackKeys is absent (no header, unfiltered output)', async () => {
    const { jobs, exportOptions } = await fingerprintFixture();
    const response = await exportOptions({ format: 'txt', date: '2026-09-04' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-excluded-track-count')).toBeNull();
    expect(new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()))
      .toBe('Starlight - Aimer\n  Night  RUN   - B、A\n孤勇者 - 陈奕迅\nNoArtist - [unknown artist]\n');
    jobs.close();
  });
});
