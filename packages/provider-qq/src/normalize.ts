import { trackSchema, type Track } from '@playlist-exporter/contracts';
import type { QqSong, QqSonglistEntry } from './schemas.js';

const UNKNOWN_TITLE = '[unknown title]';
const UNKNOWN_ARTIST = '[unknown artist]';
const text = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
};

// trackId prefers the stable string mids; the numeric songid is only a fallback.
const trackIdOf = (song: QqSong): string | undefined => {
  const songmid = text(song.songmid);
  if (songmid !== undefined) return songmid;
  const strMediaMid = text(song.strMediaMid);
  if (strMediaMid !== undefined) return strMediaMid;
  return typeof song.songid === 'number' || typeof song.songid === 'string'
    ? String(song.songid)
    : undefined;
};

/**
 * Maps raw songlist entries to normalized Tracks. Source order is preserved
 * exactly (positions are offset + array index), duplicates are kept, and
 * deduplication is deliberately not performed at the fetch layer. Null
 * entries become explicit removed placeholders, mirroring how the netease
 * provider handles missing song details.
 *
 * Availability is NOT inferred from `pay.payplay` / `switch`: the probe found
 * no evidence tying them to "removed/region-locked" tracks (payplay=1 merely
 * means paid), so any present entry is reported as available.
 */
export const normalizeQqTracks = (
  entries: readonly QqSonglistEntry[],
  positionOffset = 0,
): Track[] =>
  entries.map((entry, index) => {
    const position = positionOffset + index;
    if (entry === null) {
      return trackSchema.parse({
        title: UNKNOWN_TITLE,
        artists: [UNKNOWN_ARTIST],
        source: 'qq-music',
        availability: 'removed',
        position,
        warnings: ['歌曲详情缺失，可能已下架或地区不可用'],
      });
    }

    const warnings: string[] = [];
    const title = text(entry.songname) ?? UNKNOWN_TITLE;
    if (title === UNKNOWN_TITLE) warnings.push('歌曲名缺失');
    const artists = entry.singer.map(artist => text(artist.name)).filter(
      (artist): artist is string => artist !== undefined,
    );
    if (artists.length === 0) {
      artists.push(UNKNOWN_ARTIST);
      warnings.push('歌手信息缺失');
    }
    const album = text(entry.albumname);
    const trackId = trackIdOf(entry);
    return trackSchema.parse({
      title,
      artists,
      ...(album === undefined ? {} : { album }),
      ...(trackId === undefined ? {} : { trackId }),
      source: 'qq-music',
      availability: 'available',
      position,
      warnings,
    });
  });
