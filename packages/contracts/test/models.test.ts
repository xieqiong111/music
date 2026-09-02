import { describe, expect, it } from 'vitest';
import { playlistSchema, trackSchema } from '../src/index.js';

const validTrack = {
  title: '同一首歌',
  artists: ['歌手'],
  source: 'netease' as const,
  availability: 'available' as const,
  position: 0,
  warnings: [],
};

describe('trackSchema', () => {
  it('rejects a track without a title and reports the title issue', () => {
    const result = trackSchema.safeParse({
      artists: ['A'],
      source: 'netease',
      availability: 'available',
      position: 0,
      warnings: [],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('expected a missing title to fail validation');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['title'] })]),
    );
  });

  it('accepts unicode and duplicate artist names without normalization loss', () => {
    const value = trackSchema.parse({
      title: '夜に駆ける 🌙',
      artists: ['YOASOBI', 'YOASOBI'],
      source: 'netease',
      position: 0,
      availability: 'available',
      warnings: [],
    });
    expect(value.artists).toEqual(['YOASOBI', 'YOASOBI']);
  });

  it('rejects missing and blank artist names', () => {
    expect(trackSchema.safeParse({ ...validTrack, artists: [] }).success).toBe(false);
    expect(trackSchema.safeParse({ ...validTrack, artists: ['   '] }).success).toBe(false);
  });

  it('preserves unavailable and removed tracks with an explicit unknown-artist marker and warnings', () => {
    for (const availability of ['unavailable', 'removed'] as const) {
      const value = trackSchema.parse({
        ...validTrack,
        artists: ['[unknown artist]'],
        availability,
        warnings: ['artist metadata unavailable'],
      });

      expect(value.availability).toBe(availability);
      expect(value.artists).toEqual(['[unknown artist]']);
      expect(value.warnings).toEqual(['artist metadata unavailable']);
    }
  });
});

describe('playlistSchema', () => {
  it('accepts a complete empty playlist', () => {
    const value = playlistSchema.parse({
      id: 'empty',
      name: '空歌单',
      source: 'netease',
      total: 0,
      tracks: [],
      complete: true,
      warnings: [],
    });

    expect(value.complete).toBe(true);
    expect(value.tracks).toEqual([]);
  });

  it('accepts a complete playlist when track count matches total', () => {
    const value = playlistSchema.parse({
      id: 'playlist-1',
      name: '歌单',
      source: 'netease',
      total: 1,
      tracks: [validTrack],
      complete: true,
      warnings: [],
    });

    expect(value.tracks).toHaveLength(value.total);
  });

  it('rejects a complete playlist when track count differs from total', () => {
    const result = playlistSchema.safeParse({
      id: 'playlist-1',
      name: '不完整歌单',
      source: 'netease',
      total: 2,
      tracks: [validTrack],
      complete: true,
      warnings: [],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('expected an inconsistent complete playlist to fail validation');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['tracks'] })]),
    );
  });

  it('preserves an explicitly partial playlist', () => {
    const value = playlistSchema.parse({
      id: 'playlist-1',
      name: '部分歌单',
      source: 'netease',
      total: 2,
      tracks: [validTrack],
      complete: false,
      warnings: ['pagination stopped by user'],
    });

    expect(value.complete).toBe(false);
    expect(value.warnings).toEqual(['pagination stopped by user']);
  });
});
