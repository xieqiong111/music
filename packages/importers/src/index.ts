import { AppError, type Playlist } from '@playlist-exporter/contracts';
import {
  decodeAppleTextBytes,
  detectAppleTextEncoding,
  parseAppleTextFromText,
} from './apple-text.js';
import { parseApplePlistXmlFromText } from './apple-xml.js';
import { parsePlaylistJsonFromText } from './json-import.js';
import { truncateForDetails, type LocalFileHint } from './playlist.js';

export {
  decodeAppleTextBytes,
  detectAppleTextEncoding,
  parseAppleTextFromBytes,
  parseAppleTextFromText,
} from './apple-text.js';
export type { AppleTextEncoding } from './apple-text.js';
export { parseApplePlistXmlFromBytes, parseApplePlistXmlFromText } from './apple-xml.js';
export type { AppleXmlImportOptions, PlistDict, PlistValue } from './apple-xml.js';
export { importPlaylistJsonFromBytes, parsePlaylistJsonFromText } from './json-import.js';
export { DEFAULT_PLAYLIST_NAME, UNKNOWN_ARTIST, UNKNOWN_TITLE } from './playlist.js';
export type { LocalFileHint } from './playlist.js';

const XML_PREFIXES = ['<?xml', '<plist'] as const;

const contentKindOf = (content: string): 'xml' | 'json' | 'text' | 'unknown' => {
  const head = content.trimStart().slice(0, 64).toLowerCase();
  if (XML_PREFIXES.some((prefix) => head.startsWith(prefix))) return 'xml';
  if (head.startsWith('{')) return 'json';
  const firstLine = content.trimStart().split(/\r\n|\n|\r/u, 1)[0] ?? '';
  if (firstLine.includes('\t')) return 'text';
  return 'unknown';
};

/**
 * Unified entry point: imports a local playlist file by content sniffing.
 *
 * Routing order after BOM-aware decoding:
 *   1. `<?xml` / `<plist` prefix → plist XML importer
 *   2. `{` prefix → JSON envelope importer
 *   3. first line containing a tab → Apple Music text exporter
 *   4. anything else → structured "unrecognized format" error
 *
 * UTF-16 encoded files (old iTunes text exports) are decoded from their BOM
 * before sniffing, so a UTF-16 XML or JSON file is routed correctly too.
 * All results use `source: 'apple-music'` and `complete: true`, with parse
 * warnings aggregated on the playlist.
 */
export const importPlaylistFile = async (
  bytes: Uint8Array,
  hint?: LocalFileHint,
): Promise<Playlist> => {
  if (bytes.length === 0) {
    throw new AppError({
      code: 'IMPORT_UNKNOWN_FORMAT',
      message: '无法识别的文件格式：文件为空',
      technicalDetails: { byteLength: 0 },
    });
  }

  const content = decodeAppleTextBytes(bytes);
  switch (contentKindOf(content)) {
    case 'xml':
      return parseApplePlistXmlFromText(content, hint);
    case 'json':
      return parsePlaylistJsonFromText(content);
    case 'text':
      return parseAppleTextFromText(content, hint);
    default: {
      const firstLine = content.trimStart().split(/\r\n|\n|\r/u, 1)[0] ?? '';
      throw new AppError({
        code: 'IMPORT_UNKNOWN_FORMAT',
        message:
          '无法识别的文件格式：支持 Apple Music 文本导出（制表符分隔）、plist XML 与本项目 JSON envelope',
        technicalDetails: {
          byteLength: bytes.length,
          encoding: detectAppleTextEncoding(bytes),
          firstLine: truncateForDetails(firstLine),
          hintFilename: hint?.filename ?? null,
        },
      });
    }
  }
};
