import { trackSchema, type Track } from '@playlist-exporter/contracts';
import type { NeteaseSong, NeteaseTrackId } from './schemas.js';

const UNKNOWN_TITLE = '[unknown title]';
const UNKNOWN_ARTIST = '[unknown artist]';
const text = (value: string | null | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
};

export const normalizeNeteaseTracks = (
  orderedIds: readonly NeteaseTrackId[],
  songs: readonly NeteaseSong[],
  positionOffset = 0,
): Track[] => {
  const byId = new Map<string, NeteaseSong>();
  for (const song of songs) {
    const id = String(song.id);
    if (!byId.has(id)) byId.set(id, song);
  }

  return orderedIds.map(({ id }, index) => {
    const trackId = String(id);
    const song = byId.get(trackId);
    if (song === undefined) {
      return trackSchema.parse({
        title: UNKNOWN_TITLE,
        artists: [UNKNOWN_ARTIST],
        trackId,
        source: 'netease',
        availability: 'removed',
        position: positionOffset + index,
        warnings: ['歌曲详情缺失，可能已下架或地区不可用'],
      });
    }

    const warnings: string[] = [];
    const title = text(song.name) ?? UNKNOWN_TITLE;
    if (title === UNKNOWN_TITLE) warnings.push('歌曲名缺失');
    const artists = song.ar.map(artist => text(artist.name)).filter(
      (artist): artist is string => artist !== undefined,
    );
    if (artists.length === 0) {
      artists.push(UNKNOWN_ARTIST);
      warnings.push('歌手信息缺失');
    }
    const album = text(song.al?.name);
    return trackSchema.parse({
      title,
      artists,
      ...(album === undefined ? {} : { album }),
      trackId,
      source: 'netease',
      availability: 'available',
      position: positionOffset + index,
      warnings,
    });
  });
};
