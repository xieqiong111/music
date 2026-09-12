import { z } from 'zod';

export const providerIdSchema = z.enum(['apple-music', 'netease', 'qq-music']);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const availabilitySchema = z.enum(['available', 'unavailable', 'removed', 'unknown']);

export type TrackAvailability = z.infer<typeof availabilitySchema>;

const nonBlankText = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be blank',
});

/**
 * The normalized, metadata-only representation of one playlist entry.
 *
 * Zod objects use the default strip behavior intentionally: provider payloads
 * can contain unrelated fields, but only this domain shape crosses the
 * package boundary. Missing artist metadata is represented by the explicit
 * marker `[unknown artist]` and a provider warning; an empty artist list is
 * not a valid normalized Track.
 */
export const trackSchema = z.object({
  title: z.string().min(1),
  artists: z.array(nonBlankText).min(1),
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
export const playlistSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    creator: z.string().optional(),
    source: providerIdSchema,
    total: z.number().int().nonnegative(),
    tracks: z.array(trackSchema),
    complete: z.boolean(),
    warnings: z.array(z.string()),
  })
  .superRefine((playlist, ctx) => {
    if (playlist.complete && playlist.tracks.length !== playlist.total) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracks'],
        message: 'a complete playlist must contain exactly total tracks',
      });
    }
  });

export type Playlist = z.infer<typeof playlistSchema>;

/**
 * 曲目指纹(track key)的归一化规则(冻结契约):
 * normalize(s) = s.trim().toLowerCase().replace(/\s+/g, ' ')。
 */
const normalizeTrackKeyText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/gu, ' ');

/**
 * 曲目指纹:用于“排除与本机音乐库重复的曲目”的导出选项(指纹由前端对本机库
 * 条目按同一公式计算后随导出选项传入,服务端对歌单曲目计算同形指纹并按集合排除)。
 *
 * 冻结格式:`'t|' + normalize(title) + '|' + artists.map(normalize).sort().join(';')`;
 * artists 为空数组/缺失时歌手段为空串。例:歌名 "Starlight"、artists ["Aimer"]
 * → `t|starlight|aimer`。
 */
export const trackKey = (title: string, artists: readonly string[] = []): string =>
  `t|${normalizeTrackKeyText(title)}|${artists.map(normalizeTrackKeyText).sort().join(';')}`;

/** 单个曲目指纹的长度约束:1..200 字符。 */
export const trackKeySchema = z.string().min(1).max(200);

/** 导出选项 excludeTrackKeys 的整体约束:最多 5000 项。 */
export const excludeTrackKeysSchema = z.array(trackKeySchema).max(5000);

export type ExcludeTrackKeys = z.infer<typeof excludeTrackKeysSchema>;
