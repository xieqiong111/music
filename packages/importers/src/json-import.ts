import { z } from 'zod';
import { AppError, playlistSchema, trackSchema, type Playlist } from '@playlist-exporter/contracts';
import { decodeAppleTextBytes } from './apple-text.js';

/**
 * Importer for JSON envelopes exported by this project
 * (`packages/exporters` `createJsonEnvelope` / `renderJson`).
 *
 * The envelope is validated with zod and the canonical `playlist` object is
 * returned as-is; the flat `tracks` view is intentionally NOT used for
 * reconstruction so positions, warnings and availability always come from the
 * validated domain model.
 */

const jsonEnvelopeSchema = z.object({
  schemaVersion: z.number().int(),
  generatedAt: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  sourceTrackCount: z.number().int().nonnegative().optional(),
  exportedTrackCount: z.number().int().nonnegative().optional(),
  complete: z.boolean().optional(),
  playlist: playlistSchema,
  tracks: z.array(trackSchema).optional(),
});

/**
 * Parses already-decoded envelope JSON into the Playlist it contains. The
 * schema version is checked before the full schema so unsupported future
 * versions fail with a precise error instead of unrelated field complaints.
 */
export const parsePlaylistJsonFromText = (content: string): Playlist => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new AppError({
      code: 'IMPORT_INVALID_JSON',
      message: '文件不是有效的 JSON',
      technicalDetails: {
        reason: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    });
  }

  const version =
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new AppError({
      code: 'IMPORT_INVALID_JSON',
      message: 'JSON 缺少有效的 schemaVersion 字段',
      technicalDetails: { foundSchemaVersion: version === undefined ? null : version },
    });
  }
  if (version !== 1) {
    throw new AppError({
      code: 'IMPORT_UNSUPPORTED_SCHEMA_VERSION',
      message: '不支持的 JSON schema 版本，当前仅支持 schemaVersion 1',
      technicalDetails: { found: version, supported: 1 },
    });
  }

  const parsed = jsonEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError({
      code: 'IMPORT_INVALID_JSON',
      message: 'JSON 结构不符合本项目的播放清单 envelope 格式',
      technicalDetails: {
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data.playlist;
};

/** Parses raw envelope bytes (UTF-8 strict, BOM tolerated) into a Playlist. */
export const importPlaylistJsonFromBytes = (bytes: Uint8Array): Playlist =>
  parsePlaylistJsonFromText(decodeAppleTextBytes(bytes));
