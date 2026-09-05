import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadServerConfig } from '../src/config.js';

describe('server config', () => {
  it('uses secure loopback defaults', () => {
    expect(loadServerConfig({})).toEqual({
      host: '127.0.0.1',
      port: 4319,
      accessToken: undefined,
      appleDeveloperToken: undefined,
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

  it('leaves the Apple developer token unconfigured by default', () => {
    expect(loadServerConfig({}).appleDeveloperToken).toBeUndefined();
  });

  it.each(['', '   ', '\t'])(
    'treats a blank APPLE_DEVELOPER_TOKEN as unconfigured (%s)',
    token => expect(loadServerConfig({ APPLE_DEVELOPER_TOKEN: token }).appleDeveloperToken)
      .toBeUndefined(),
  );

  it('accepts an APPLE_DEVELOPER_TOKEN up to 8192 bytes without trimming it', () => {
    expect(loadServerConfig({ APPLE_DEVELOPER_TOKEN: 'a'.repeat(8192) }).appleDeveloperToken)
      .toHaveLength(8192);
    expect(loadServerConfig({ APPLE_DEVELOPER_TOKEN: '  padded  ' }).appleDeveloperToken)
      .toBe('  padded  ');
    expect(() => loadServerConfig({ APPLE_DEVELOPER_TOKEN: 'a'.repeat(8193) }))
      .toThrow(/APPLE_DEVELOPER_TOKEN/);
  });

  it.each(['line\nbreak', 'tab\tvalue', 'nul\u0000byte', 'del\u007fbyte'])(
    'rejects an APPLE_DEVELOPER_TOKEN with control characters (%s)',
    token => expect(() => loadServerConfig({ APPLE_DEVELOPER_TOKEN: token }))
      .toThrow(/APPLE_DEVELOPER_TOKEN/),
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

describe('server config origin canonicalization', () => {
  // Mirrors docker-compose.yml: the container always receives an explicit
  // ALLOWED_ORIGINS derived from the host PORT plus a synthetic token.
  const composeEnv = (port: string): Record<string, string> => ({
    HOST: '0.0.0.0',
    ACCESS_TOKEN: 'synthetic-token',
    PORT: port,
    ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
  });

  it.each(['4319', '4567', '80'])(
    'accepts the docker-compose derived whitelist for PORT=%s',
    port => expect(() => loadServerConfig(composeEnv(port))).not.toThrow(),
  );

  it('keeps explicit non-default ports verbatim in the whitelist', () => {
    expect(loadServerConfig(composeEnv('4319')).allowedOrigins)
      .toEqual(['http://127.0.0.1:4319', 'http://localhost:4319']);
    expect(loadServerConfig(composeEnv('4567')).allowedOrigins)
      .toEqual(['http://127.0.0.1:4567', 'http://localhost:4567']);
  });

  it('canonicalizes default-port 80 origins to the browser Origin form', () => {
    expect(loadServerConfig(composeEnv('80')).allowedOrigins)
      .toEqual(['http://127.0.0.1', 'http://localhost']);
    expect(loadServerConfig({ PORT: '80' }).allowedOrigins)
      .toEqual(['http://127.0.0.1', 'http://localhost']);
  });

  it('dedupes origins that canonicalize to the same value', () => {
    expect(loadServerConfig({
      ALLOWED_ORIGINS: 'http://127.0.0.1:80,http://127.0.0.1',
    }).allowedOrigins).toEqual(['http://127.0.0.1']);
  });

  it('normalizes case, default ports and trailing slashes in explicit origins', () => {
    expect(loadServerConfig({
      ALLOWED_ORIGINS: 'HTTP://Example.COM:4319/,https://Nas.Example:443',
    }).allowedOrigins).toEqual(['http://example.com:4319', 'https://nas.example']);
  });

  it.each([
    ['the wildcard', '*', /ALLOWED_ORIGINS 包含无效来源/u],
    ['the null origin', 'null', /ALLOWED_ORIGINS 包含无效来源/u],
    ['an empty entry', '', /ALLOWED_ORIGINS 不能为空/u],
    ['a path', 'http://x/a', /ALLOWED_ORIGINS 必须只包含完整 HTTP\(S\) origin/u],
    ['userinfo', 'https://user:pass@nas.example', /ALLOWED_ORIGINS 必须只包含完整 HTTP\(S\) origin/u],
    ['a non-http scheme', 'ftp://files.example', /ALLOWED_ORIGINS 必须只包含完整 HTTP\(S\) origin/u],
  ])('still rejects %s', (_label, origin, pattern) => {
    expect(() => loadServerConfig({ ALLOWED_ORIGINS: origin })).toThrow(pattern);
  });

  it('derives no default origins for a non-loopback host', () => {
    expect(loadServerConfig({ HOST: '0.0.0.0', ACCESS_TOKEN: 'secret' }).allowedOrigins)
      .toEqual([]);
  });
});
