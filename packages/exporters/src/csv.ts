import type { Track } from '@playlist-exporter/contracts';
import type { NormalizedExportOptions } from './options.js';
import { lineEndingValue } from './options.js';

export const CSV_COLUMNS = ['歌曲名', '歌手', 'ID', '来源', '可用性'] as const;

function displayTitle(track: Track): string {
  return track.title.trim().length > 0 ? track.title : '[unknown title]';
}

function displayArtists(track: Track): string {
  const artists = track.artists.filter((artist) => artist.trim().length > 0);
  return artists.length > 0 ? artists.join('、') : '[unknown artist]';
}

function displayOptional(value: string | undefined, marker: string): string {
  return value !== undefined && value.trim().length > 0 ? value : marker;
}

function displayAvailability(track: Track): string {
  switch (track.availability) {
    case 'removed':
      return '[已下架]';
    case 'unavailable':
      return '[地区不可用]';
    case 'unknown':
      return '[可用性未知]';
    case 'available':
      return 'available';
  }
}

function neutralizeFormula(value: string): string {
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

export function escapeCsvField(value: string): string {
  const safe = neutralizeFormula(value);
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function rowForTrack(track: Track, index: number, options: NormalizedExportOptions): string[] {
  const values = [
    ...(options.order === 'artist-title'
      ? [displayArtists(track), displayTitle(track)]
      : [displayTitle(track), displayArtists(track)]),
    ...(options.includeAlbum ? [displayOptional(track.album, '[专辑缺失]')] : []),
    displayOptional(track.trackId, '[ID缺失]'),
    track.source,
    displayAvailability(track),
  ];
  return options.includeIndex ? [String(index + 1), ...values] : values;
}

export function renderCsv(tracks: readonly Track[], options: NormalizedExportOptions): string {
  const eol = lineEndingValue(options);
  const columns = [
    ...(options.includeIndex ? ['序号'] : []),
    ...(options.order === 'artist-title' ? ['歌手', '歌曲名'] : ['歌曲名', '歌手']),
    ...(options.includeAlbum ? ['专辑'] : []),
    'ID',
    '来源',
    '可用性',
  ];
  const rows = [
    columns,
    ...tracks.map((track, index) => rowForTrack(track, index, options)),
  ];
  return `${rows.map((row) => row.map(escapeCsvField).join(',')).join(eol)}${eol}`;
}
