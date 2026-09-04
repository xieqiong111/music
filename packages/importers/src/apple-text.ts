import { AppError, trackSchema, type Track } from '@playlist-exporter/contracts';
import {
  UNKNOWN_ARTIST,
  UNKNOWN_TITLE,
  buildApplePlaylist,
  playlistNameFromHint,
  truncateForDetails,
  type LocalFileHint,
} from './playlist.js';

/**
 * Parser for the tab-separated text files produced by Apple Music
 * (macOS Music.app / iTunes) "导出播放列表" / "Export Playlist".
 *
 * The file has one header line followed by one line per playlist entry; the
 * exact column order varies by app version and locale, so columns are located
 * through a synonym table instead of fixed positions. Values are never quoted
 * (a literal `"` is part of the value), and multi-artist strings are kept
 * verbatim as a single artist entry: splitting on `、`/`,`/`/` would corrupt
 * legitimate artist names such as "AC/DC".
 */

export type AppleTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** Column roles recognized in the header line. Everything else is ignored. */
type ColumnKind = 'title' | 'artist' | 'album' | 'duration';

/**
 * Header synonym table (matched case-insensitively after trimming).
 * `title` and `artist` are required columns; `album` and `duration` are
 * optional. The duration value itself is not persisted because the contracts
 * Track model is metadata-only without a duration field.
 */
const HEADER_SYNONYMS: Readonly<Record<ColumnKind, readonly string[]>> = {
  title: ['name', '名称', '歌曲名称'],
  artist: ['artist', '艺术家', '演唱者'],
  album: ['album', '专辑'],
  duration: ['total time', '总时间'],
};

/** Detects the byte-order mark: UTF-16 BOMs first, then the UTF-8 BOM. */
export const detectAppleTextEncoding = (bytes: Uint8Array): AppleTextEncoding => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
};

/**
 * Decodes raw file bytes into text. Files without a BOM are decoded strictly
 * as UTF-8 (fatal TextDecoder); decoding failures surface as a structured
 * error instead of producing mojibake rows. A matching BOM is stripped by the
 * decoder itself.
 */
export const decodeAppleTextBytes = (bytes: Uint8Array): string => {
  const encoding = detectAppleTextEncoding(bytes);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch (error) {
    throw new AppError({
      code: 'IMPORT_INVALID_ENCODING',
      message: '当前运行环境不支持该文本编码，无法解码文件',
      technicalDetails: { encoding },
      cause: error,
    });
  }
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new AppError({
      code: 'IMPORT_INVALID_ENCODING',
      message: '无法按检测到的编码解码文件，文件可能已损坏或不是 UTF-8 编码',
      technicalDetails: {
        encoding,
        byteLength: bytes.length,
        reason: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    });
  }
};

const normalizeHeaderCell = (cell: string): string =>
  cell.trim().replace(/^["']+|["']+$/gu, '').toLowerCase();

const cellAt = (cells: readonly string[], index: number): string => {
  const raw = cells[index];
  return raw === undefined ? '' : raw.trim();
};

const splitLines = (content: string): string[] => content.split(/\r\n|\n|\r/u);

/**
 * Parses already-decoded export text into a normalized Playlist. Exported for
 * `importPlaylistFile`, which performs encoding detection before routing.
 */
export const parseAppleTextFromText = (
  content: string,
  hint?: LocalFileHint,
): ReturnType<typeof buildApplePlaylist> => {
  const lines = splitLines(content);
  const headerLine = lines[0] ?? '';
  if (!headerLine.includes('\t')) {
    throw new AppError({
      code: 'IMPORT_MISSING_HEADER',
      message: '文件缺少表头行：Apple Music 文本导出的首行应为制表符分隔的列名',
      technicalDetails: { firstLine: truncateForDetails(headerLine) },
    });
  }

  const headerCells = headerLine.split('\t').map(normalizeHeaderCell);
  const columnOf = new Map<ColumnKind, number>();
  for (const [kind, synonyms] of Object.entries(HEADER_SYNONYMS) as readonly [
    ColumnKind,
    readonly string[],
  ][]) {
    const index = headerCells.findIndex((cell) => synonyms.includes(cell));
    if (index >= 0) columnOf.set(kind, index);
  }

  const titleIndex = columnOf.get('title');
  const artistIndex = columnOf.get('artist');
  if (titleIndex === undefined || artistIndex === undefined) {
    throw new AppError({
      code: 'IMPORT_MISSING_REQUIRED_COLUMNS',
      message: '表头缺少必需列：需要「歌名」列（Name/名称/歌曲名称）和「歌手」列（Artist/艺术家/演唱者）',
      technicalDetails: {
        detectedHeaders: headerCells,
        foundColumns: [...columnOf.keys()],
      },
    });
  }
  const albumIndex = columnOf.get('album');

  const tracks: Track[] = [];
  const warnings: string[] = [];
  let missingTitleRows = 0;
  let missingArtistRows = 0;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.length === 0 || line.trim().length === 0) continue;

    const cells = line.split('\t');
    const trackWarnings: string[] = [];

    const rawTitle = cellAt(cells, titleIndex);
    const title = rawTitle.length > 0 ? rawTitle : UNKNOWN_TITLE;
    if (rawTitle.length === 0) {
      missingTitleRows += 1;
      trackWarnings.push(`第 ${lineIndex + 1} 行歌曲名缺失，已使用占位`);
    }

    // Multi-artist text is intentionally NOT split: the whole trimmed cell
    // stays one artist entry so names like "AC/DC" or "歌手甲、歌手乙" are
    // preserved verbatim.
    const rawArtist = cellAt(cells, artistIndex);
    const artists = rawArtist.length > 0 ? [rawArtist] : [UNKNOWN_ARTIST];
    if (rawArtist.length === 0) {
      missingArtistRows += 1;
      trackWarnings.push(`第 ${lineIndex + 1} 行歌手信息缺失，已使用占位`);
    }

    const album = albumIndex === undefined ? undefined : cellAt(cells, albumIndex);

    tracks.push(trackSchema.parse({
      title,
      artists,
      ...(album !== undefined && album.length > 0 ? { album } : {}),
      source: 'apple-music',
      availability: 'available',
      position: tracks.length,
      warnings: trackWarnings,
    }));
  }

  if (missingTitleRows > 0) {
    warnings.push(`${missingTitleRows} 行歌曲名缺失，已使用 ${UNKNOWN_TITLE} 占位`);
  }
  if (missingArtistRows > 0) {
    warnings.push(`${missingArtistRows} 行歌手信息缺失，已使用 ${UNKNOWN_ARTIST} 占位`);
  }
  warnings.push('歌手列不做多名歌手拆分：整段文本保留为单个歌手条目，避免错误拆分');

  return buildApplePlaylist({
    id: 'apple-music-text-import',
    name: playlistNameFromHint(hint),
    tracks,
    warnings,
  });
};

/** Parses raw export bytes (encoding auto-detected) into a Playlist. */
export const parseAppleTextFromBytes = (
  bytes: Uint8Array,
  hint?: LocalFileHint,
): ReturnType<typeof buildApplePlaylist> =>
  parseAppleTextFromText(decodeAppleTextBytes(bytes), hint);
