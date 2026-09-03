import type { Track } from '@playlist-exporter/contracts';
import type { NormalizedExportOptions } from './options.js';
import { lineEndingValue } from './options.js';

const UNKNOWN_TITLE = '[unknown title]';
const UNKNOWN_ARTIST = '[unknown artist]';

function displayTitle(track: Track): string {
  const title = track.title.trim().length > 0 ? track.title : UNKNOWN_TITLE;
  switch (track.availability) {
    case 'removed':
      return `${title} [已下架]`;
    case 'unavailable':
      return `${title} [地区不可用]`;
    case 'unknown':
      return `${title} [可用性未知]`;
    case 'available':
      return title;
  }
}

function displayArtists(track: Track): string {
  const artists = track.artists.filter((artist) => artist.trim().length > 0);
  return artists.length > 0 ? artists.join('、') : UNKNOWN_ARTIST;
}

export function renderTxt(tracks: readonly Track[], options: NormalizedExportOptions): string {
  const eol = lineEndingValue(options);
  const lines = tracks.map((track, index) => {
    const title = displayTitle(track);
    const artists = displayArtists(track);
    const main = options.order === 'artist-title'
      ? `${artists} - ${title}`
      : `${title} - ${artists}`;
    const withAlbum = options.includeAlbum && track.album?.trim()
      ? `${main} - ${track.album}`
      : main;
    return options.includeIndex ? `${index + 1}. ${withAlbum}` : withAlbum;
  });

  return lines.length === 0 ? '' : `${lines.join(eol)}${eol}`;
}
