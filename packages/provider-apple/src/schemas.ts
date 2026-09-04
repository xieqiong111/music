import { z } from 'zod';

/**
 * MusicKit API v1 catalog shapes. WARNING: these are modeled from Apple's
 * published MusicKit documentation only; no live Apple API call was possible
 * in this environment (no real developer token), so every field is kept
 * nullish-tolerant on purpose.
 *
 * Zod's default strip behavior deliberately drops unmodeled payload fields:
 * artwork, contentRating, playParams, editorial notes, envelope `meta`, and
 * in particular `previewUrl` — audio URLs are never modeled, so they can
 * never cross the package boundary.
 */

/**
 * One entry of a playlist `relationships.tracks.data` (or of a continuation
 * tracks page). `type` is compared at normalize time: entries that are not
 * `songs` (e.g. `music-videos`) become explicit placeholder Tracks instead of
 * being silently dropped.
 */
export const appleCatalogSongSchema = z.object({
  id: z.string().nullish(),
  type: z.string().nullish(),
  attributes: z.object({
    name: z.string().nullish(),
    artistName: z.string().nullish(),
    albumName: z.string().nullish(),
    trackNumber: z.number().int().nullish(),
    durationInMillis: z.number().nullish(),
  }).nullish(),
});
export type AppleCatalogSong = z.infer<typeof appleCatalogSongSchema>;
export type AppleCatalogEntry = AppleCatalogSong | null;

/** `relationships.tracks` of a catalog playlist object. */
export const applePlaylistTracksSchema = z.object({
  href: z.string().nullish(),
  next: z.string().nullish(),
  data: z.array(appleCatalogSongSchema.nullable())
    .nullish()
    .transform((value) => value ?? []),
});

/** One `data[]` element of GET /v1/catalog/{storefront}/playlists/{id}. */
export const appleCatalogPlaylistSchema = z.object({
  id: z.string().nullish(),
  type: z.string().nullish(),
  attributes: z.object({
    // The normalized Playlist needs a non-blank name; a missing name is
    // reported as schema drift instead of a fabricated placeholder.
    name: z.string().min(1),
    curatorName: z.string().nullish(),
    playlistType: z.string().nullish(),
    // Declared track total; used only as a cross-check, never trusted blindly.
    trackCount: z.number().int().nonnegative().nullish(),
  }),
  relationships: z.object({
    tracks: applePlaylistTracksSchema.nullish(),
  }).nullish(),
});

/**
 * First request envelope: `{ data: [playlist], meta? }`. `meta` and any other
 * top-level fields are intentionally unmodeled and stripped.
 */
export const appleCatalogPlaylistResponseSchema = z.object({
  data: z.array(appleCatalogPlaylistSchema),
});

/**
 * Continuation envelope returned by the absolute `next` URL
 * (`/v1/catalog/{storefront}/playlists/{id}/tracks`): `{ data: [...], next? }`.
 * A missing `next` terminates pagination normally.
 */
export const appleCatalogTracksResponseSchema = z.object({
  data: z.array(appleCatalogSongSchema.nullable())
    .nullish()
    .transform((value) => value ?? []),
  next: z.string().nullish(),
});

export type AppleCatalogPlaylist = z.infer<typeof appleCatalogPlaylistSchema>;
export type AppleCatalogPlaylistResponse = z.infer<typeof appleCatalogPlaylistResponseSchema>;
export type AppleCatalogTracksResponse = z.infer<typeof appleCatalogTracksResponseSchema>;
