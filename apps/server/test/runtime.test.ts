import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRestrictedFetch, startServer } from '../src/index.js';

describe('server runtime boundary', () => {
  it('rejects unsafe bind config before calling serve', () => {
    const serve = vi.fn();
    expect(() => startServer({ env: { PORT: 'not-a-port' }, serveImpl: serve as never }))
      .toThrow(/PORT/);
    expect(serve).not.toHaveBeenCalled();
  });

  it('ignores the deprecated ACCESS_TOKEN and bootstraps the default account', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'playlist-exporter-runtime-'));
    try {
      const serve = vi.fn(() => ({ once: vi.fn() }) as never);
      const warnings: string[] = [];
      const runtime = startServer({
        env: {
          ACCESS_TOKEN: 'legacy-token-should-be-ignored',
          DATA_DIR: dataDir,
        },
        serveImpl: serve,
        warn: message => warnings.push(message),
      });
      expect(serve).toHaveBeenCalledOnce();
      // 废弃令牌被忽略（仅警告，不进入配置），首次启动自动创建默认账号。
      expect(warnings).toContain('检测到已废弃的 ACCESS_TOKEN，已忽略');
      expect(warnings).toContain('已创建默认账号 admin/admin，请尽快修改');
      expect(JSON.stringify(runtime.config)).not.toContain('legacy-token-should-be-ignored');
      const persisted = JSON.parse(readFileSync(join(dataDir, 'auth.json'), 'utf8')) as {
        users: { username: string }[];
      };
      expect(persisted.users).toHaveLength(1);
      expect(persisted.users[0]).toMatchObject({ username: 'admin' });
      runtime.jobs.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows only fixed HTTPS provider hosts through the runtime fetch boundary', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    const restricted = createRestrictedFetch(upstream as typeof fetch);

    await expect(restricted('https://music.163.com/api/v6/playlist/detail'))
      .resolves.toMatchObject({ status: 200 });
    await expect(restricted('https://163cn.tv/abc', { redirect: 'manual' }))
      .resolves.toMatchObject({ status: 200 });
    await expect(restricted(
      'https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?disstid=7729596131',
    )).resolves.toMatchObject({ status: 200 });
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    for (const url of [
      'http://music.163.com/api/v6/playlist/detail',
      'https://evil.example/api',
      'https://music.163.com.evil.example/api',
      'https://user:pass@music.163.com/api',
      'https://music.163.com:8443/api',
      // Only the probed QQ endpoint host is allowed; sibling QQ hosts stay blocked.
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_iids_df.fcg',
    ]) {
      await expect(restricted(url)).rejects.toMatchObject({
        code: 'EGRESS_NOT_ALLOWED',
      });
    }
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
