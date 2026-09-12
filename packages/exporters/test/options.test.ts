import { describe, expect, it } from 'vitest';
import { exportPlaylist } from '../src/index.js';
import { normalizeExportOptions } from '../src/options.js';
import { playlist } from './fixtures.js';

describe('excludeTrackKeys export option', () => {
  it('is passed through normalization without affecting txt/csv/json rendering', () => {
    const normalized = normalizeExportOptions({
      format: 'txt',
      excludeTrackKeys: ['t|starlight|aimer'],
    });
    expect(normalized.excludeTrackKeys).toEqual(['t|starlight|aimer']);
    expect(normalizeExportOptions({ format: 'txt' }).excludeTrackKeys).toBeUndefined();
  });

  it('leaves the rendered artifact identical whether or not the option is set', () => {
    const withKeys = exportPlaylist(playlist, {
      format: 'txt',
      date: '2026-09-03',
      excludeTrackKeys: ['t|歌一|歌手甲;歌手乙'],
    });
    const withoutKeys = exportPlaylist(playlist, { format: 'txt', date: '2026-09-03' });
    expect(withKeys.bytes).toEqual(withoutKeys.bytes);
    expect(withKeys.trackCount).toBe(withoutKeys.trackCount);
    expect(withKeys.trackCount).toBe(playlist.tracks.length);
  });
});
