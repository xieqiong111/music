import type { Track } from '@playlist-exporter/contracts';

function trackKey(track: Track): string {
  if (track.trackId?.trim()) {
    return `id:${track.source}:${track.trackId}`;
  }
  if (track.isrc?.trim()) {
    return `isrc:${track.source}:${track.isrc}`;
  }
  return [
    'metadata',
    track.source,
    track.title,
    track.artists.join('\u0001'),
    track.album ?? '',
  ].join('\u0000');
}

/** Keeps the first source-order occurrence of each logical track. */
export function dedupeTracks(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  const result: Track[] = [];

  for (const track of tracks) {
    const key = trackKey(track);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(track);
  }

  return result;
}
