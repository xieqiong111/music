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

/**
 * Upper bound (in characters) for the bounded prolog scan below. Real exports
 * carry only a short XML declaration and the standard DOCTYPE, so 4096 is
 * generous; anything beyond it is treated as an unknown format to keep the
 * sniffer immune to pathological inputs (e.g. megabytes of comments).
 */
const XML_PROLOG_SCAN_LIMIT = 4096;

const isXmlWhitespaceChar = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/**
 * Bounded scan over an XML prolog: skips whitespace, an optional
 * `<?xml ... ?>` declaration and any number of `<!-- ... -->` comments (up to
 * {@link XML_PROLOG_SCAN_LIMIT} characters in total), then reports the first
 * markup construct. `<!DOCTYPE`/`<!doctype` openings are only *detected*, never
 * interpreted — whether the declaration is the standard Apple plist DOCTYPE is
 * decided exclusively by the strict parser (which rejects internal subsets,
 * foreign DTDs, duplicates and lowercase keywords with
 * IMPORT_XML_DOCTYPE_FORBIDDEN). Exceeding the scan limit without reaching an
 * element keeps the pre-existing `unknown` routing.
 */
const xmlPrologFirstMarkup = (content: string): 'plist' | 'doctype' | 'other' => {
  let pos = 0;
  for (;;) {
    while (
      pos < content.length &&
      pos <= XML_PROLOG_SCAN_LIMIT &&
      isXmlWhitespaceChar(content[pos])
    ) pos += 1;
    if (pos > XML_PROLOG_SCAN_LIMIT) return 'other';
    if (content.startsWith('<!--', pos)) {
      const end = content.indexOf('-->', pos + 4);
      if (end === -1) return 'other';
      pos = end + 3;
      if (pos > XML_PROLOG_SCAN_LIMIT) return 'other';
      continue;
    }
    if (content.startsWith('<?xml', pos)) {
      const end = content.indexOf('?>', pos + 5);
      if (end === -1) return 'other';
      pos = end + 2;
      if (pos > XML_PROLOG_SCAN_LIMIT) return 'other';
      continue;
    }
    break;
  }
  if (content.startsWith('<plist', pos)) return 'plist';
  if (content.startsWith('<!DOCTYPE', pos) || content.startsWith('<!doctype', pos)) {
    return 'doctype';
  }
  return 'other';
};

const contentKindOf = (content: string): 'xml' | 'json' | 'text' | 'unknown' => {
  const head = content.trimStart().slice(0, 64).toLowerCase();
  if (XML_PREFIXES.some((prefix) => head.startsWith(prefix))) return 'xml';
  if (xmlPrologFirstMarkup(content) !== 'other') return 'xml';
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
 *      (a bounded prolog scan also routes `<!DOCTYPE`-first plists — preceded
 *      by whitespace, an XML declaration and/or comments — to the same strict
 *      parser, which alone decides whether the DOCTYPE is acceptable)
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
