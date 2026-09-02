import { z } from 'zod';

export const providerIdSchema = z.enum(['apple-music', 'netease', 'qq-music']);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const availabilitySchema = z.enum(['available', 'unavailable', 'removed', 'unknown']);

export type TrackAvailability = z.infer<typeof availabilitySchema>;

/**
 * The normalized, metadata-only representation of one playlist entry.
 *
 * Zod objects use the default strip behavior intentionally: provider payloads
 * can contain unrelated fields, but only this domain shape crosses the
 * package boundary.
 */
export const trackSchema = z.object({
  title: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string().optional(),
  trackId: z.string().optional(),
  isrc: z.string().optional(),
  source: providerIdSchema,
  availability: availabilitySchema,
  position: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export type Track = z.infer<typeof trackSchema>;

/** Normalized metadata for one playlist and its source-order track entries. */
export const playlistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  creator: z.string().optional(),
  source: providerIdSchema,
  total: z.number().int().nonnegative(),
  tracks: z.array(trackSchema),
  complete: z.boolean(),
  warnings: z.array(z.string()),
});

export type Playlist = z.infer<typeof playlistSchema>;
