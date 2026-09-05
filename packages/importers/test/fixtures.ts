import { AppError, type Playlist } from '@playlist-exporter/contracts';
import { expect } from 'vitest';

// ---------------------------------------------------------------------------
// Encoding helpers (synthetic bytes only; no real user data)
// ---------------------------------------------------------------------------

export const encodeUtf8 = (text: string, withBom = false): Uint8Array => {
  const body = new TextEncoder().encode(text);
  if (!withBom) return body;
  const out = new Uint8Array(3 + body.length);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
};

const utf16Units = (text: string): number[] => {
  const units: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const value = code - 0x10000;
      units.push(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
    } else {
      units.push(code);
    }
  }
  return units;
};

export const encodeUtf16Le = (text: string): Uint8Array => {
  const units = utf16Units(text);
  const out = new Uint8Array(2 + units.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  units.forEach((unit, index) => {
    out[2 + index * 2] = unit & 0xff;
    out[3 + index * 2] = unit >> 8;
  });
  return out;
};

export const encodeUtf16Be = (text: string): Uint8Array => {
  const units = utf16Units(text);
  const out = new Uint8Array(2 + units.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  units.forEach((unit, index) => {
    out[2 + index * 2] = unit >> 8;
    out[3 + index * 2] = unit & 0xff;
  });
  return out;
};

// ---------------------------------------------------------------------------
// Apple Music text export fixtures
// ---------------------------------------------------------------------------

export interface AppleTextSpec {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly eol?: '\n' | '\r\n';
}

export const appleTextContent = (spec: AppleTextSpec): string =>
  [
    spec.header.join('\t'),
    ...spec.rows.map((row) => row.join('\t')),
  ].join(spec.eol ?? '\n') + (spec.eol ?? '\n');

export const ENGLISH_HEADER = ['Name', 'Artist', 'Album', 'Total Time', 'Genre'] as const;
export const CHINESE_HEADER = ['名称', '艺术家', '专辑', '总时间'] as const;

// ---------------------------------------------------------------------------
// plist XML fixtures
// ---------------------------------------------------------------------------

export interface XmlTrackSpec {
  readonly id: number;
  readonly name?: string;
  readonly artist?: string;
  readonly album?: string;
  /** Raw extra `<key>…</key><value/>` pairs appended inside the track dict. */
  readonly extra?: string;
}

export const xmlTrackEntry = (spec: XmlTrackSpec): string => {
  const fields = [
    `<key>Track ID</key><integer>${spec.id}</integer>`,
    spec.name === undefined ? '' : `<key>Name</key><string>${spec.name}</string>`,
    spec.artist === undefined ? '' : `<key>Artist</key><string>${spec.artist}</string>`,
    spec.album === undefined ? '' : `<key>Album</key><string>${spec.album}</string>`,
    spec.extra ?? '',
  ].join('');
  return `<key>${spec.id}</key><dict>${fields}</dict>`;
};

export interface XmlPlaylistSpec {
  readonly name?: string;
  readonly playlistId?: number;
  /** Numbers become standard item dicts; strings are inserted verbatim. */
  readonly items?: readonly (number | string)[];
  readonly extra?: string;
}

export const xmlPlaylistEntry = (spec: XmlPlaylistSpec): string => {
  const items = (spec.items ?? [])
    .map((item) =>
      typeof item === 'number'
        ? `<dict><key>Track ID</key><integer>${item}</integer></dict>`
        : item,
    )
    .join('');
  return (
    '<dict>' +
    (spec.name === undefined ? '' : `<key>Name</key><string>${spec.name}</string>`) +
    (spec.playlistId === undefined
      ? ''
      : `<key>Playlist ID</key><integer>${spec.playlistId}</integer>`) +
    `<key>Playlist Items</key><array>${items}</array>` +
    (spec.extra ?? '') +
    '</dict>'
  );
};

/** The standard DOCTYPE declaration emitted by iTunes / Apple Music exports. */
export const PLIST_STANDARD_DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

export interface XmlDocSpec {
  readonly tracks?: readonly XmlTrackSpec[];
  readonly playlists?: readonly XmlPlaylistSpec[];
  /** Replaces the whole `Tracks` dict content. */
  readonly tracksRaw?: string;
  /** Replaces the whole `Playlists` array content. */
  readonly playlistsRaw?: string;
  /** Replaces the value under `<plist>` entirely (for root-shape tests). */
  readonly rootValue?: string;
  readonly includeDoctype?: boolean;
  /**
   * Overrides the prolog DOCTYPE chunk (injected independently of
   * `includeDoctype`); defaults to the standard declaration when
   * `includeDoctype` is set.
   */
  readonly doctypeRaw?: string;
}

export const plistLibraryXml = (spec: XmlDocSpec): string => {
  const doctype =
    spec.doctypeRaw ?? (spec.includeDoctype ? PLIST_STANDARD_DOCTYPE : '');
  const tracks =
    spec.tracksRaw ?? `<dict>${(spec.tracks ?? []).map(xmlTrackEntry).join('')}</dict>`;
  const playlists =
    spec.playlistsRaw ??
    `<array>${(spec.playlists ?? []).map(xmlPlaylistEntry).join('')}</array>`;
  const body =
    spec.rootValue ??
    `<dict>` +
      `<key>Major Version</key><integer>1</integer>` +
      `<key>Application Version</key><string>12.9.0.167</string>` +
      `<key>Tracks</key>${tracks}` +
      `<key>Playlists</key>${playlists}` +
      `</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>${doctype}\n<plist version="1.0">${body}</plist>`;
};

// ---------------------------------------------------------------------------
// JSON envelope fixture (hand-written minimal shape of createJsonEnvelope)
// ---------------------------------------------------------------------------

export const applePlaylistFixture: Playlist = {
  id: 'local-playlist-1',
  name: '导入测试歌单',
  source: 'apple-music',
  total: 3,
  tracks: [
    {
      title: '测试曲目一',
      artists: ['歌手甲', '歌手乙'],
      album: '专辑一',
      trackId: '101',
      source: 'apple-music',
      availability: 'available',
      position: 0,
      warnings: [],
    },
    {
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      source: 'apple-music',
      availability: 'removed',
      position: 1,
      warnings: ['播放列表第 2 项曲目引用缺失（Track ID 999 不在资料库 Tracks 中），已保留占位'],
    },
    {
      title: '测试曲目三',
      artists: ['歌手丙、歌手丁'],
      source: 'apple-music',
      availability: 'available',
      position: 2,
      warnings: [],
    },
  ],
  complete: true,
  warnings: ['1 项曲目引用缺失或无效，已保留占位'],
};

export const envelopeJsonText = (
  playlist: unknown = applePlaylistFixture,
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-04T08:00:00.000Z',
    options: {
      format: 'json',
      includeIndex: false,
      order: 'title-artist',
      includeAlbum: true,
      dedupe: false,
      lineEnding: 'lf',
      csvBom: false,
      date: '2026-09-04',
    },
    sourceTrackCount: 3,
    exportedTrackCount: 3,
    complete: true,
    playlist,
    tracks: Array.isArray((playlist as { tracks?: unknown })?.tracks)
      ? (playlist as { tracks: unknown }).tracks
      : undefined,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export const caughtError = (fn: () => unknown): AppError => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
};

export const expectErrorCode = (fn: () => unknown, code: string): AppError => {
  const error = caughtError(fn);
  expect(error.code).toBe(code);
  return error;
};

export const caughtErrorAsync = async (fn: () => Promise<unknown>): Promise<AppError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
};

export const expectErrorCodeAsync = async (
  fn: () => Promise<unknown>,
  code: string,
): Promise<AppError> => {
  const error = await caughtErrorAsync(fn);
  expect(error.code).toBe(code);
  return error;
};
