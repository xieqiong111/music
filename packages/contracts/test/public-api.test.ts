import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_CODES,
  AppError,
  playlistSchema,
  redactSensitive,
  redactUrl,
  trackSchema,
} from '../src/index.js';
import type { MusicProvider } from '../src/index.js';

describe('contracts public API', () => {
  it('exports the public schemas, AppError, and stable incomplete-pagination code', () => {
    expect(trackSchema).toBeDefined();
    expect(playlistSchema).toBeDefined();
    expect(AppError).toBeDefined();
    expect(APP_ERROR_CODES.INCOMPLETE_PAGINATION).toBe('INCOMPLETE_PAGINATION');
    expect(APP_ERROR_CODES.HTTP_TIMEOUT).toBe('HTTP_TIMEOUT');
    expect(APP_ERROR_CODES.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(APP_ERROR_CODES.RESPONSE_TOO_LARGE).toBe('RESPONSE_TOO_LARGE');
    expect(redactSensitive({ token: 'secret' })).toEqual({ token: '[REDACTED]' });
    expect(redactUrl('https://example.test/?safe=value')).not.toContain('value');
  });

  it('keeps fetchAllTracks typed as a promise of normalized tracks', () => {
    type FetchAllTracksResult = Awaited<ReturnType<MusicProvider['fetchAllTracks']>>;
    const normalizedTracks: FetchAllTracksResult = [];

    expect(normalizedTracks).toEqual([]);
  });
});
