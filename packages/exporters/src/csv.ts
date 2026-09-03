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

function neutralizeFormula(value: string): string {
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

export function escapeCsvField(value: string): string {
  const safe = neutralizeFormula(value);
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function rowForTrack(track: Track, index: number, options: NormalizedExportOptions): string[] {
  const values = [
    displayTitle(track),
    displayArtists(track),
    ...(options.includeAlbum ? [track.album ?? ''] : []),
    track.trackId ?? '',
    track.source,
    track.availability,
  ];
  return options.includeIndex ? [String(index + 1), ...values] : values;
}

export function renderCsv(tracks: readonly Track[], options: NormalizedExportOptions): string {
  const eol = lineEndingValue(options);
  const columns = [
    ...(options.includeIndex ? ['序号'] : []),
    '歌曲名',
    '歌手',
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
