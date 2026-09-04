import { AppError, trackSchema, type Track } from '@playlist-exporter/contracts';
import { decodeAppleTextBytes } from './apple-text.js';
import {
  UNKNOWN_ARTIST,
  UNKNOWN_TITLE,
  buildApplePlaylist,
  playlistNameFromHint,
  type LocalFileHint,
} from './playlist.js';

/**
 * Parser for iTunes / Apple Music plist XML playlist exports
 * (`<plist version="1.0">`).
 *
 * This is a deliberately minimal strict subset parser: only
 * `<dict>/<key>/<string>/<integer>/<real>/<date>/<true>/<false>/<array>` are
 * understood, `data` values are skipped with an aggregated warning, and any
 * DOCTYPE declaration is rejected outright to rule out external-entity (XXE)
 * injection. Unknown or malformed constructs fail with structured errors
 * instead of being silently dropped.
 */

export interface AppleXmlImportOptions extends LocalFileHint {
  /** Selects a playlist by its `Name` when the file contains several. */
  readonly playlistName?: string;
}

export interface PlistDict {
  readonly [key: string]: PlistValue;
}

export type PlistValue = string | number | boolean | PlistDict | readonly PlistValue[];

/** Sentinel returned for skipped `<data>` elements. */
const DATA_SKIPPED = Symbol('data-skipped');

type PlistNode = PlistValue | typeof DATA_SKIPPED;

const isXmlWhitespace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

const ELEMENT_NAME_SOURCE = '[A-Za-z_][A-Za-z0-9._-]*';
const ELEMENT_NAME_RE = new RegExp(ELEMENT_NAME_SOURCE, 'uy');
const ATTRIBUTE_NAME_RE = new RegExp(`${ELEMENT_NAME_SOURCE}`, 'uy');
const INTEGER_RE = /^[+-]?\d+$/u;
const REAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** Human-readable type name used in structured error details. */
const describePlistValue = (value: PlistNode): string => {
  if (value === DATA_SKIPPED) return 'data';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'dict';
    default:
      return 'unknown';
  }
};

class PlistSyntaxError extends Error {
  public constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
    this.name = 'PlistSyntaxError';
  }
}

/**
 * Hand-rolled scanner over the decoded XML text. Tracks byte offsets so every
 * failure can report a line/column. Security-sensitive constructs (DOCTYPE)
 * throw the structured AppError directly.
 */
class PlistScanner {
  private pos = 0;
  private skippedDataCount = 0;

  public constructor(private readonly text: string) {}

  public get position(): number {
    return this.pos;
  }

  public get unsupportedDataCount(): number {
    return this.skippedDataCount;
  }

  public eof(): boolean {
    return this.pos >= this.text.length;
  }

  private char(offset = 0): string {
    return this.text[this.pos + offset] ?? '';
  }

  private startsWith(literal: string): boolean {
    return this.text.startsWith(literal, this.pos);
  }

  public locationOf(position: number): { line: number; column: number } {
    const before = this.text.slice(0, position);
    const lastNewline = before.lastIndexOf('\n');
    return {
      line: before.split('\n').length,
      column: lastNewline === -1 ? position + 1 : position - lastNewline,
    };
  }

  public skipWhitespace(): void {
    while (!this.eof() && isXmlWhitespace(this.text[this.pos])) this.pos += 1;
  }

  /**
   * Skips inter-element trivia: whitespace, comments and processing
   * instructions. A DOCTYPE (anywhere) and CDATA sections are rejected here.
   */
  public skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith('<!--')) {
        this.skipComment();
        continue;
      }
      if (this.startsWith('<?')) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.startsWith('<!')) this.rejectBangNode();
      return;
    }
  }

  private skipComment(): void {
    const end = this.text.indexOf('-->', this.pos + 4);
    if (end === -1) throw new PlistSyntaxError('XML 注释未闭合', this.pos);
    this.pos = end + 3;
  }

  private skipProcessingInstruction(): void {
    const end = this.text.indexOf('?>', this.pos + 2);
    if (end === -1) throw new PlistSyntaxError('处理指令未闭合', this.pos);
    this.pos = end + 2;
  }

  private rejectBangNode(): never {
    const head = this.text.slice(this.pos, this.pos + 9).toUpperCase();
    if (head.startsWith('<!DOCTYPE')) {
      const { line, column } = this.locationOf(this.pos);
      throw new AppError({
        code: 'IMPORT_XML_DOCTYPE_FORBIDDEN',
        message: '检测到 DOCTYPE 声明，为防范外部实体注入（XXE）已拒绝解析该文件',
        technicalDetails: { line, column },
      });
    }
    if (head.startsWith('<![CDATA[')) {
      const { line, column } = this.locationOf(this.pos);
      throw new AppError({
        code: 'IMPORT_XML_UNSUPPORTED_NODE',
        message: '解析器不支持 CDATA 节点，无法解析该文件',
        technicalDetails: { line, column },
      });
    }
    throw new PlistSyntaxError('无法识别的 <! 节点', this.pos);
  }

  /** Consumes `<name ...>` or `<name .../>`; attributes are parsed and ignored. */
  public expectOpenTag(expected?: string): { name: string; selfClosing: boolean } {
    if (this.char() !== '<') {
      throw new PlistSyntaxError(
        `期望元素开始标签，实际为 ${this.eof() ? '文件结尾' : `「${this.char()}」`}`,
        this.pos,
      );
    }
    ELEMENT_NAME_RE.lastIndex = this.pos + 1;
    const match = ELEMENT_NAME_RE.exec(this.text);
    if (match === null) throw new PlistSyntaxError('无法识别的元素名', this.pos);
    const name = match[0];
    if (expected !== undefined && name !== expected) {
      throw new PlistSyntaxError(`期望 <${expected}> 元素，实际为 <${name}>`, this.pos);
    }
    this.pos += 1 + name.length;
    return { name, selfClosing: this.parseAttributes() };
  }

  public expectCloseTag(name: string): void {
    if (!this.startsWith('</')) {
      throw new PlistSyntaxError(`期望 </${name}> 闭合标签`, this.pos);
    }
    this.pos += 2;
    this.skipWhitespace();
    ELEMENT_NAME_RE.lastIndex = this.pos;
    const match = ELEMENT_NAME_RE.exec(this.text);
    if (match === null || match[0] !== name) {
      throw new PlistSyntaxError(
        `闭合标签不匹配：期望 </${name}>，实际为 </${match?.[0] ?? ''}>`,
        this.pos,
      );
    }
    this.pos += match[0].length;
    this.skipWhitespace();
    if (this.char() !== '>') {
      throw new PlistSyntaxError(`闭合标签 </${name}> 缺少 ">"`, this.pos);
    }
    this.pos += 1;
  }

  private parseAttributes(): boolean {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith('/>')) {
        this.pos += 2;
        return true;
      }
      if (this.char() === '>') {
        this.pos += 1;
        return false;
      }
      if (this.eof()) throw new PlistSyntaxError('开始标签未闭合', this.pos);
      ATTRIBUTE_NAME_RE.lastIndex = this.pos;
      const name = ATTRIBUTE_NAME_RE.exec(this.text);
      if (name === null) {
        throw new PlistSyntaxError('开始标签包含无法解析的内容', this.pos);
      }
      this.pos += name[0].length;
      this.skipWhitespace();
      if (this.char() !== '=') throw new PlistSyntaxError('属性缺少 "="', this.pos);
      this.pos += 1;
      this.skipWhitespace();
      const quote = this.char();
      if (quote !== '"' && quote !== "'") {
        throw new PlistSyntaxError('属性值必须使用引号包裹', this.pos);
      }
      const end = this.text.indexOf(quote, this.pos + 1);
      if (end === -1) throw new PlistSyntaxError('属性值未闭合', this.pos);
      this.pos = end + 1;
    }
  }

  /**
   * Reads character data up to the next `<` and validates that it closes the
   * current element. Entity references are decoded with position tracking.
   */
  public readTextContent(elementName: string): string {
    const start = this.pos;
    const nextTag = this.text.indexOf('<', start);
    if (nextTag === -1) {
      throw new PlistSyntaxError(`元素 <${elementName}> 缺少闭合标签`, start);
    }
    const decoded = decodeXmlText(this.text.slice(start, nextTag), start);
    this.pos = nextTag;
    this.expectCloseTag(elementName);
    return decoded;
  }

  /** Reads the next plist value element (dict/array/scalar/data). */
  public readValue(): PlistNode {
    this.skipMisc();
    const { name, selfClosing } = this.expectOpenTag();
    switch (name) {
      case 'dict':
        if (selfClosing) return {};
        return this.readDict();
      case 'array':
        if (selfClosing) return [];
        return this.readArray();
      case 'key':
        throw new PlistSyntaxError('<key> 只能出现在 dict 内部', this.pos);
      case 'string':
        return selfClosing ? '' : this.readTextContent('string');
      case 'integer':
        return this.readNumber('integer', INTEGER_RE, selfClosing);
      case 'real':
        return this.readNumber('real', REAL_RE, selfClosing);
      case 'date': {
        const raw = selfClosing ? '' : this.readTextContent('date');
        return raw.trim();
      }
      case 'true':
      case 'false':
        if (!selfClosing) this.expectCloseTag(name);
        return name === 'true';
      case 'data':
        if (!selfClosing) this.readTextContent('data');
        this.skippedDataCount += 1;
        return DATA_SKIPPED;
      default:
        throw new AppError({
          code: 'IMPORT_XML_UNSUPPORTED_NODE',
          message: `解析器不支持 plist 值类型 <${name}>，无法解析该文件`,
          technicalDetails: this.locationOf(this.pos),
        });
    }
  }

  private readDict(): PlistDict {
    const entries: { [key: string]: PlistValue } = {};
    for (;;) {
      this.skipMisc();
      if (this.startsWith('</')) {
        this.expectCloseTag('dict');
        return entries;
      }
      if (this.eof()) throw new PlistSyntaxError('<dict> 未闭合', this.pos);
      this.expectOpenTag('key');
      const key = this.readTextContent('key');
      const value = this.readValue();
      if (value !== DATA_SKIPPED && !(key in entries)) {
        // Duplicate keys keep the first occurrence (iTunes writes unique keys).
        entries[key] = value;
      }
    }
  }

  private readArray(): PlistValue[] {
    const items: PlistValue[] = [];
    for (;;) {
      this.skipMisc();
      if (this.startsWith('</')) {
        this.expectCloseTag('array');
        return items;
      }
      if (this.eof()) throw new PlistSyntaxError('<array> 未闭合', this.pos);
      const value = this.readValue();
      if (value !== DATA_SKIPPED) items.push(value);
    }
  }

  private readNumber(
    elementName: 'integer' | 'real',
    pattern: RegExp,
    selfClosing: boolean,
  ): number {
    const raw = selfClosing ? '' : this.readTextContent(elementName);
    const value = raw.trim();
    if (!pattern.test(value) || !Number.isFinite(Number(value))) {
      throw new PlistSyntaxError(`<${elementName}> 的内容不是合法数值：「${value}」`, this.pos);
    }
    return Number(value);
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decodeXmlText = (raw: string, basePosition: number): string => {
  let result = '';
  let index = 0;
  while (index < raw.length) {
    const ch = raw[index];
    if (ch !== '&') {
      result += ch;
      index += 1;
      continue;
    }
    const semicolon = raw.indexOf(';', index + 1);
    if (semicolon === -1) {
      throw new PlistSyntaxError('实体引用缺少 ";"', basePosition + index);
    }
    const body = raw.slice(index + 1, semicolon);
    const fail = (message: string): never => {
      throw new PlistSyntaxError(message, basePosition + index);
    };
    if (body in NAMED_ENTITIES) {
      result += NAMED_ENTITIES[body];
    } else if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        fail(`无效的字符引用 &${body};`);
      }
      result += String.fromCodePoint(code);
    } else if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        fail(`无效的字符引用 &${body};`);
      }
      result += String.fromCodePoint(code);
    } else {
      fail(`不支持的实体引用 &${body};`);
    }
    index = semicolon + 1;
  }
  return result;
};

interface ParsedDocument {
  readonly root: PlistDict;
  readonly unsupportedDataCount: number;
}

const parsePlistDocument = (content: string): ParsedDocument => {
  const scanner = new PlistScanner(content);
  try {
    scanner.skipMisc();
    const rootTag = scanner.expectOpenTag();
    if (rootTag.name !== 'plist') {
      throw new PlistSyntaxError(
        `根元素必须是 <plist>，实际为 <${rootTag.name}>`,
        scanner.position,
      );
    }
    const value = scanner.readValue();
    scanner.skipMisc();
    scanner.expectCloseTag('plist');
    scanner.skipMisc();
    if (!scanner.eof()) {
      throw new PlistSyntaxError('plist 根元素之后存在多余内容', scanner.position);
    }
    if (!isPlistDict(value)) {
      throw new AppError({
        code: 'IMPORT_XML_ROOT',
        message: 'plist 根节点必须是 dict',
        technicalDetails: { foundRoot: describePlistValue(value) },
      });
    }
    return { root: value, unsupportedDataCount: scanner.unsupportedDataCount };
  } catch (error) {
    if (error instanceof PlistSyntaxError) {
      const { line, column } = scanner.locationOf(error.position);
      throw new AppError({
        code: 'IMPORT_XML_SYNTAX',
        message: `XML 解析失败：${error.message}`,
        technicalDetails: { line, column },
        cause: error,
      });
    }
    throw error;
  }
};

const isPlistDict = (value: PlistNode | undefined): value is PlistDict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asDict = (value: PlistValue | undefined): PlistDict | undefined =>
  isPlistDict(value) ? value : undefined;

const asTextField = (value: PlistValue | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Parses already-decoded plist XML into a normalized Playlist. Supports both
 * the full-library layout (`Tracks` dict + `Playlists` array) and the
 * single-playlist export (same structure with one playlist entry).
 */
export const parseApplePlistXmlFromText = (
  content: string,
  options?: AppleXmlImportOptions,
): ReturnType<typeof buildApplePlaylist> => {
  const { root, unsupportedDataCount } = parsePlistDocument(content);
  const warnings: string[] = [];
  if (unsupportedDataCount > 0) {
    warnings.push(`文件包含 ${unsupportedDataCount} 处不支持的 data（二进制）字段，已忽略`);
  }

  const playlistsValue = root['Playlists'];
  if (!Array.isArray(playlistsValue)) {
    throw new AppError({
      code: 'IMPORT_XML_NO_PLAYLIST',
      message: '文件中没有 Playlists 播放列表数组，无法导入',
      technicalDetails: {
        hasPlaylistsKey: 'Playlists' in root,
        foundType: describePlistValue(playlistsValue ?? DATA_SKIPPED),
      },
    });
  }
  const playlists = playlistsValue
    .map((entry) => asDict(entry))
    .filter((entry): entry is PlistDict => entry !== undefined);

  const requestedName = options?.playlistName;
  let selected: PlistDict | undefined;
  if (requestedName === undefined) {
    selected = playlists[0];
    if (selected === undefined) {
      throw new AppError({
        code: 'IMPORT_XML_NO_PLAYLIST',
        message: '文件中没有可导入的播放列表',
      });
    }
  } else {
    selected = playlists.find((entry) => entry['Name'] === requestedName);
    if (selected === undefined) {
      throw new AppError({
        code: 'IMPORT_XML_PLAYLIST_NOT_FOUND',
        message: `文件中没有名为「${requestedName}」的播放列表`,
        technicalDetails: {
          requestedName,
          availableNames: playlists
            .map((entry) => asTextField(entry['Name']))
            .filter((name): name is string => name !== undefined),
        },
      });
    }
  }

  const tracksDict = asDict(root['Tracks']);
  const tracksById = new Map<string, PlistDict>();
  if (tracksDict === undefined) {
    warnings.push('文件缺少有效的 Tracks 曲目字典，所有曲目将以占位表示');
  } else {
    for (const [id, node] of Object.entries(tracksDict)) {
      const entry = asDict(node);
      if (entry !== undefined && !tracksById.has(id)) tracksById.set(id, entry);
    }
  }

  const itemsValue = selected['Playlist Items'];
  const items = Array.isArray(itemsValue) ? itemsValue : [];
  const tracks: Track[] = [];
  let missingReferences = 0;

  items.forEach((item, index) => {
    const itemDict = asDict(item);
    const rawId = itemDict?.['Track ID'];
    const trackId =
      typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === 'string' && /^\d+$/u.test(rawId)
          ? rawId
          : undefined;
    const trackDict = trackId === undefined ? undefined : tracksById.get(trackId);

    if (itemDict === undefined || trackId === undefined || trackDict === undefined) {
      // Placeholders hold the position so downstream order never collapses.
      missingReferences += 1;
      const reason =
        itemDict === undefined
          ? '播放列表项不是 dict'
          : trackId === undefined
            ? '缺少有效的 Track ID'
            : `Track ID ${trackId} 不在资料库 Tracks 中`;
      tracks.push(trackSchema.parse({
        title: UNKNOWN_TITLE,
        artists: [UNKNOWN_ARTIST],
        source: 'apple-music',
        availability: 'removed',
        position: index,
        warnings: [`播放列表第 ${index + 1} 项曲目引用缺失（${reason}），已保留占位`],
      }));
      return;
    }

    const trackWarnings: string[] = [];
    const name = asTextField(trackDict['Name']);
    const title = name ?? UNKNOWN_TITLE;
    if (name === undefined) trackWarnings.push('歌曲名缺失，已使用占位');

    const artist = asTextField(trackDict['Artist']);
    if (artist === undefined) {
      trackWarnings.push('歌手信息缺失，已使用占位');
    }
    const album = asTextField(trackDict['Album']);

    tracks.push(trackSchema.parse({
      title,
      artists: [artist ?? UNKNOWN_ARTIST],
      ...(album === undefined ? {} : { album }),
      trackId,
      source: 'apple-music',
      availability: 'available',
      position: index,
      warnings: trackWarnings,
    }));
  });

  if (missingReferences > 0) {
    warnings.push(`${missingReferences} 项曲目引用缺失或无效，已保留占位`);
  }

  const playlistId =
    asTextField(selected['Playlist Persistent ID']) ??
    (typeof selected['Playlist ID'] === 'number' ? String(selected['Playlist ID']) : undefined) ??
    asTextField(selected['Playlist ID']) ??
    'apple-music-xml-import';

  return buildApplePlaylist({
    id: playlistId,
    name: asTextField(selected['Name']) ?? playlistNameFromHint(options),
    tracks,
    warnings,
  });
};

/** Parses raw plist XML bytes (encoding auto-detected) into a Playlist. */
export const parseApplePlistXmlFromBytes = (
  bytes: Uint8Array,
  options?: AppleXmlImportOptions,
): ReturnType<typeof buildApplePlaylist> =>
  parseApplePlistXmlFromText(decodeAppleTextBytes(bytes), options);
