import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadServerConfig } from '../src/config.js';

describe('server config', () => {
  it('uses secure loopback defaults', () => {
    expect(loadServerConfig({})).toEqual({
      host: '127.0.0.1',
      port: 4319,
      accessToken: undefined,
      allowedOrigins: ['http://127.0.0.1:4319', 'http://localhost:4319'],
      maxBodyBytes: 1_048_576,
      maxConcurrentJobs: 2,
      maxQueuedJobs: 100,
      jobTtlMs: 900_000,
    });
  });

  it.each(['127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1'])(
    'recognizes numeric loopback %s',
    host => expect(isLoopbackHost(host)).toBe(true),
  );

  it.each(['0.0.0.0', '::', 'localhost', '192.168.1.20', 'example.com'])(
    'requires a token for non-loopback host %s',
    host => expect(() => loadServerConfig({ HOST: host })).toThrow(/ACCESS_TOKEN/),
  );

  it('accepts non-loopback only with a token and never trims it', () => {
    expect(loadServerConfig({ HOST: '0.0.0.0', ACCESS_TOKEN: '  secret  ' }))
      .toMatchObject({ host: '0.0.0.0', accessToken: '  secret  ' });
  });

  it.each(['', '0', '-1', '65536', '1.5', 'abc', ' 4319'])(
    'rejects invalid PORT %s',
    port => expect(() => loadServerConfig({ PORT: port })).toThrow(/PORT/),
  );

  it.each(['', ' ', 'line\nbreak', 'tab\tvalue'])(
    'rejects an unsafe configured token',
    token => expect(() => loadServerConfig({ ACCESS_TOKEN: token })).toThrow(/ACCESS_TOKEN/),
  );

  it('allows lowering but never raising the 1 MiB request-body ceiling', () => {
    expect(loadServerConfig({ MAX_BODY_BYTES: '1024' }).maxBodyBytes).toBe(1024);
    expect(() => loadServerConfig({ MAX_BODY_BYTES: '1048577' }))
      .toThrow(/MAX_BODY_BYTES/);
  });

  it('parses and validates exact allowed origins', () => {
    expect(loadServerConfig({
      ALLOWED_ORIGINS: 'https://nas.example,http://192.168.1.10:4319',
    }).allowedOrigins).toEqual(['https://nas.example', 'http://192.168.1.10:4319']);
    for (const origin of [
      '*',
      'null',
      'https://user:pass@nas.example',
      'https://nas.example/path',
      'https://nas.example?x=1',
    ]) {
      expect(() => loadServerConfig({ ALLOWED_ORIGINS: origin })).toThrow(/ALLOWED_ORIGINS/);
    }
  });
});
