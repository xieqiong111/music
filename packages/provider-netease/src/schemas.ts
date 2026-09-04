import { z } from 'zod';

export const neteaseIdSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

export const neteaseTrackIdSchema = z.object({
  id: neteaseIdSchema,
});

export const neteasePlaylistDetailResponseSchema = z.object({
  code: z.number().int(),
  playlist: z.object({
    id: neteaseIdSchema,
    name: z.string().min(1),
    trackCount: z.number().int().nonnegative(),
    creator: z.object({
      nickname: z.string().min(1),
    }).nullish(),
    trackIds: z.array(neteaseTrackIdSchema),
  }),
});

export const neteaseSongSchema = z.object({
  id: neteaseIdSchema,
  name: z.string().nullish(),
  ar: z.array(z.object({
    name: z.string().nullish(),
  })).optional().default([]),
  al: z.object({
    name: z.string().nullish(),
  }).nullish(),
});

export const neteaseSongDetailResponseSchema = z.object({
  code: z.number().int(),
  songs: z.array(neteaseSongSchema),
});

export type NeteaseTrackId = z.infer<typeof neteaseTrackIdSchema>;
export type NeteasePlaylistDetailResponse = z.infer<typeof neteasePlaylistDetailResponseSchema>;
export type NeteaseSong = z.infer<typeof neteaseSongSchema>;
export type NeteaseSongDetailResponse = z.infer<typeof neteaseSongDetailResponseSchema>;
