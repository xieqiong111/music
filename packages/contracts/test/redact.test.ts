import { describe, expect, it } from 'vitest';
import { redactSensitive, redactUrl } from '../src/index.js';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

describe('redactSensitive', () => {
  it('redacts exact credential-key variants recursively without mutation and is idempotent', () => {
    const input = {
      Authorization: 'bearer-secret',
      Cookie: 'cookie-secret',
      'Set-Cookie': 'set-cookie-secret',
      'Music User Token': 'music-secret',
      access_token: 'access-secret',
      'refresh-token': 'refresh-secret',
      idToken: 'id-secret',
      'api-key': 'api-secret',
      private_key: 'private-secret',
      nested: [{ safe: 'keep', pageKey: 'offset:0', token: 'nested-secret' }],
      status: 429,
    };
    const before = structuredClone(input);

    const result = redactSensitive(input) as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    for (const secret of [
      'bearer-secret', 'cookie-secret', 'set-cookie-secret', 'music-secret',
      'access-secret', 'refresh-secret', 'id-secret', 'api-secret',
      'private-secret', 'nested-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.Authorization).toBe(REDACTED);
    expect(result.nested).toEqual([{ safe: 'keep', pageKey: 'offset:0', token: REDACTED }]);
    expect(result.status).toBe(429);
    expect(input).toEqual(before);
    expect(redactSensitive(result)).toEqual(result);
  });

  it('redacts every URL query value and removes fragments while preserving route shape', () => {
    const url = new URL(
      'https://example.test/path?playlist=42&token=secret&offset=0#frag',
    );
    const original = url.toString();

    const result = redactUrl(url);
    const parsed = new URL(result);

    expect(typeof result).toBe('string');
    expect(parsed.pathname).toBe('/path');
    expect(parsed.hash).toBe('');
    expect([...parsed.searchParams.keys()]).toEqual(['playlist', 'token', 'offset']);
    expect([...parsed.searchParams.values()]).toEqual([REDACTED, REDACTED, REDACTED]);
    expect(result).not.toContain('secret');
    expect(url.toString()).toBe(original);
    expect(redactSensitive({ requestUrl: url })).toEqual({ requestUrl: result });
  });

  it('makes cycles and Error properties JSON-safe without leaking credentials', () => {
    const source: Record<string, unknown> = {
      safe: 'ok',
      Authorization: 'cycle-secret',
      list: [{ Cookie: 'cookie-secret' }],
      error: Object.assign(new Error('boom'), { Cookie: 'error-secret' }),
    };
    source.self = source;

    const result = redactSensitive(source) as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect(result).not.toBe(source);
    expect(result.self).toBe(CIRCULAR);
    expect(serialized).toContain('boom');
    expect(serialized).not.toContain('cycle-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('error-secret');
    expect(source.self).toBe(source);
  });

  it('preserves safe primitives and non-sensitive page keys', () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive({ pageKey: 'offset:1000', safe: true })).toEqual({
      pageKey: 'offset:1000',
      safe: true,
    });
  });
});
