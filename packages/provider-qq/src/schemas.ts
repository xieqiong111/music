import { z } from 'zod';

/**
 * QQ Music ids appear either as JSON numbers or as digit strings depending on
 * the field; both are accepted here.
 */
export const qqIdSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

/**
 * Songlist entry per the probed fcg_ucc_getcdinfo_byids_cp.fcg shape. Every
 * field is tolerant and optional so unrelated payload fields strip safely;
 * missing fields map to explicit placeholder Tracks in normalize.ts (same
 * convention as the netease provider).
 */
export const qqSongSchema = z.object({
  songid: qqIdSchema.nullish(),
  songmid: z.string().nullish(),
  strMediaMid: z.string().nullish(),
  songname: z.string().nullish(),
  singer: z.array(z.object({
    name: z.string().nullish(),
  })).optional().default([]),
  albumname: z.string().nullish(),
  interval: z.number().nullish(),
  pay: z.object({
    payplay: z.number().nullish(),
  }).nullish(),
});

/**
 * One `cdlist` entry (playlist directory). `disstid` is the full string id,
 * but the provider intentionally echoes the requested id instead of the
 * response one. The numeric `dissid` field is int32-truncated upstream and is
 * deliberately NOT modeled here so it can never leak back into an output.
 * Creator PII fields (nick/uin/headurl/...) are also unmodeled and stripped.
 */
export const qqCdSchema = z.object({
  disstid: z.string().nullish(),
  dissname: z.string().min(1),
  songnum: z.number().int().nonnegative(),
  total_song_num: z.number().int().nonnegative().nullish(),
  /** Full ordered songid comma-joined manifest; the anti-truncation sentinel. */
  songids: z.string().nullish(),
  /** Echoed cursor values are clamped upstream and must never drive paging. */
  song_begin: z.number().int().nonnegative().nullish(),
  cur_song_num: z.number().int().nonnegative().nullish(),
  songlist: z.array(qqSongSchema.nullable())
    .nullish()
    .transform((value) => value ?? []),
});

/**
 * Probed envelope: `{ code, subcode?, msg?, cdlist[] }`. `cdlist` is nullish
 * so the `invalid referer` envelope (which carries no cdlist) parses and is
 * reported as a business error instead of schema drift.
 */
export const qqPlaylistDetailResponseSchema = z.object({
  code: z.number().int(),
  subcode: z.number().int().nullish(),
  msg: z.string().nullish(),
  cdlist: z.array(qqCdSchema).nullish(),
});

export type QqSong = z.infer<typeof qqSongSchema>;
export type QqSonglistEntry = QqSong | null;
export type QqCd = z.infer<typeof qqCdSchema>;
export type QqPlaylistDetailResponse = z.infer<typeof qqPlaylistDetailResponseSchema>;
