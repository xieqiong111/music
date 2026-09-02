import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_CODES,
  AppError,
  playlistSchema,
  trackSchema,
} from '../src/index.js';
import type { MusicProvider } from '../src/index.js';

describe('contracts public API', () => {
  it('exports the public schemas, AppError, and stable incomplete-pagination code', () => {
    expect(trackSchema).toBeDefined();
    expect(playlistSchema).toBeDefined();
    expect(AppError).toBeDefined();
    expect(APP_ERROR_CODES.INCOMPLETE_PAGINATION).toBe('INCOMPLETE_PAGINATION');
  });

  it('keeps fetchAllTracks typed as a promise of normalized tracks', () => {
    type FetchAllTracksResult = Awaited<ReturnType<MusicProvider['fetchAllTracks']>>;
    const normalizedTracks: FetchAllTracksResult = [];

    expect(normalizedTracks).toEqual([]);
  });
});
