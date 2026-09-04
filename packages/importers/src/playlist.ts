import { playlistSchema, type Playlist, type Track } from '@playlist-exporter/contracts';

/**
 * Shared constants for every local Apple Music file importer.
 *
 * Local file imports always report `source: 'apple-music'` and
 * `complete: true`: the file content is fully available up front, so there is
 * no pagination uncertainty the way there is for online providers.
 */
export const APPLE_MUSIC_SOURCE = 'apple-music' as const;

/**
 * Placeholders follow the contracts convention documented on `trackSchema`:
 * missing metadata is an explicit marker plus a warning, never an empty
 * artist list (which is not a valid normalized Track).
 */
export const UNKNOWN_TITLE = '[unknown title]';
export const UNKNOWN_ARTIST = '[unknown artist]';

export const DEFAULT_PLAYLIST_NAME = '本地导入歌单';

/** Optional context handed to an importer by an upper layer (UI/CLI). */
export interface LocalFileHint {
  /** Original file name; used as a display-name fallback only. */
  readonly filename?: string;
}

/** Truncates diagnostic snippets so error payloads stay small. */
export const truncateForDetails = (value: string, maxLength = 200): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}…(${value.length} 字符)`;

/**
 * Derives a human-facing playlist name from an optional filename hint.
 * Falls back to a stable default when no usable name can be derived.
 */
export const playlistNameFromHint = (hint?: LocalFileHint): string => {
  const filename = hint?.filename?.trim();
  if (filename === undefined || filename === '') return DEFAULT_PLAYLIST_NAME;
  const base = filename.split(/[\\/]/u).pop() ?? filename;
  const stripped = base.replace(/\.[^.]{0,16}$/u, '').trim();
  const name = stripped.length > 0 ? stripped : base.trim();
  return name.length > 0 ? name : DEFAULT_PLAYLIST_NAME;
};

export interface ApplePlaylistInput {
  readonly id: string;
  readonly name: string;
  readonly tracks: readonly Track[];
  readonly warnings: readonly string[];
}

/**
 * Assembles the normalized Playlist shared by all local importers and
 * validates it against the contracts schema before it crosses the boundary.
 */
export const buildApplePlaylist = (input: ApplePlaylistInput): Playlist =>
  playlistSchema.parse({
    id: input.id,
    name: input.name,
    source: APPLE_MUSIC_SOURCE,
    total: input.tracks.length,
    tracks: input.tracks,
    complete: true,
    warnings: [...input.warnings],
  });
