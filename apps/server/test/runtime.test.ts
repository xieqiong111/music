import { describe, expect, it, vi } from 'vitest';
import { createRestrictedFetch, startServer } from '../src/index.js';

describe('server runtime boundary', () => {
  it('rejects unsafe bind config before calling serve', () => {
    const serve = vi.fn();
    expect(() => startServer({ env: { HOST: '0.0.0.0' }, serveImpl: serve as never }))
      .toThrow(/ACCESS_TOKEN/);
    expect(serve).not.toHaveBeenCalled();
  });

  it('allows only fixed HTTPS provider hosts through the runtime fetch boundary', async () => {
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    const restricted = createRestrictedFetch(upstream as typeof fetch);

    await expect(restricted('https://music.163.com/api/v6/playlist/detail'))
      .resolves.toMatchObject({ status: 200 });
    await expect(restricted('https://163cn.tv/abc', { redirect: 'manual' }))
      .resolves.toMatchObject({ status: 200 });
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    for (const url of [
      'http://music.163.com/api/v6/playlist/detail',
      'https://evil.example/api',
      'https://music.163.com.evil.example/api',
      'https://user:pass@music.163.com/api',
      'https://music.163.com:8443/api',
    ]) {
      await expect(restricted(url)).rejects.toMatchObject({
        code: 'EGRESS_NOT_ALLOWED',
      });
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
