import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, AppError } from '../src/index.js';

describe('AppError', () => {
  it('recursively redacts credential fields in serialized technical details without mutating input', () => {
    const details = {
      status: 502,
      requestId: 'request-123',
      phase: 'fetching',
      authorization: 'Bearer authorization-secret',
      headers: {
        COOKIE: 'session=cookie-secret',
        'Set-Cookie': ['refresh-cookie-secret'],
      },
      nested: [
        {
          'Music-User-Token': 'music-user-secret',
          access_token: 'access-secret',
          'refresh-token': 'refresh-secret',
          idToken: 'id-secret',
          safe: 'keep this diagnostic',
        },
      ],
    };
    const original = structuredClone(details);
    const error = new AppError({
      code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
      message: '歌单遍历未完成',
      technicalDetails: details,
    });

    const serialized = JSON.stringify(error);

    expect(serialized).not.toContain('authorization-secret');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('refresh-cookie-secret');
    expect(serialized).not.toContain('music-user-secret');
    expect(serialized).not.toContain('access-secret');
    expect(serialized).not.toContain('refresh-secret');
    expect(serialized).not.toContain('id-secret');
    expect(serialized).toContain('request-123');
    expect(serialized).toContain('keep this diagnostic');
    expect(error.toJSON().technicalDetails).toMatchObject({
      status: 502,
      requestId: 'request-123',
      phase: 'fetching',
      nested: [{ safe: 'keep this diagnostic' }],
    });
    expect(details).toEqual(original);
  });

  it('serializes cyclic URL diagnostics safely with centralized credential redaction', () => {
    const details: Record<string, unknown> = {
      requestUrl: new URL('https://example.test/path?offset=0&token=url-secret#fragment'),
      'api-key': 'api-secret',
      private_key: 'private-secret',
      pageKey: 'offset:0',
    };
    details.self = details;
    const error = new AppError({
      code: APP_ERROR_CODES.INCOMPLETE_PAGINATION,
      message: '分页未完成',
      technicalDetails: details,
    });

    const serialized = JSON.stringify(error.toJSON());

    expect(serialized).not.toContain('url-secret');
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('fragment');
    expect(serialized).toContain('offset:0');
    expect(serialized).toContain('[Circular]');
  });
});
