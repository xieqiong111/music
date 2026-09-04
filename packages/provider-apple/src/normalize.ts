import { trackSchema, type Track } from '@playlist-exporter/contracts';
import type { AppleCatalogEntry } from './schemas.js';

const UNKNOWN_TITLE = '[unknown title]';
const UNKNOWN_ARTIST = '[unknown artist]';
const text = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
};

/**
 * Maps raw playlist track entries to normalized Tracks. Source order is
 * preserved exactly (positions are offset + array index), duplicates are kept,
 * and deduplication is deliberately not performed at the fetch layer.
 *
 * MusicKit `attributes.artistName` is a single pre-joined string for
 * multi-artist songs; it is kept verbatim as the one-element artist list and
 * is never split, so normalized output always matches the source display.
 */
export const normalizeAppleTracks = (
  entries: readonly AppleCatalogEntry[],
  positionOffset = 0,
): Track[] =>
  entries.map((entry, index) => {
    const position = positionOffset + index;
    if (entry === null) {
      return trackSchema.parse({
        title: UNKNOWN_TITLE,
        artists: [UNKNOWN_ARTIST],
        source: 'apple-music',
        availability: 'removed',
        position,
        warnings: ['歌曲详情缺失，可能已下架或地区不可用'],
      });
    }

    const attributes = entry.attributes;
    const trackId = text(entry.id);
    const entryType = text(entry.type);
    if (entryType !== undefined && entryType !== 'songs') {
      // Non-song catalog entries (e.g. music-videos): kept as an explicit
      // placeholder instead of being dropped, so positions stay continuous.
      return trackSchema.parse({
        title: text(attributes?.name) ?? UNKNOWN_TITLE,
        artists: [text(attributes?.artistName) ?? UNKNOWN_ARTIST],
        ...(trackId === undefined ? {} : { trackId }),
        source: 'apple-music',
        availability: 'unknown',
        position,
        warnings: [`非歌曲类型条目（${entryType.slice(0, 32)}），已保留占位`],
      });
    }

    const warnings: string[] = [];
    const title = text(attributes?.name) ?? UNKNOWN_TITLE;
    if (title === UNKNOWN_TITLE) warnings.push('歌曲名缺失');
    const artistName = text(attributes?.artistName);
    if (artistName === undefined) {
      warnings.push('歌手信息缺失');
    }
    const album = text(attributes?.albumName);
    return trackSchema.parse({
      title,
      artists: [artistName ?? UNKNOWN_ARTIST],
      ...(album === undefined ? {} : { album }),
      ...(trackId === undefined ? {} : { trackId }),
      source: 'apple-music',
      availability: 'available',
      position,
      warnings,
    });
  });
