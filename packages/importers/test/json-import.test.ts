import { describe, expect, it } from 'vitest';
import {
  importPlaylistJsonFromBytes,
  parsePlaylistJsonFromText,
} from '../src/json-import.js';
import {
  applePlaylistFixture,
  encodeUtf8,
  expectErrorCode,
  envelopeJsonText,
} from './fixtures.js';

describe('JSON envelope 导入', () => {
  it('round-trip：原样还原本项目 envelope 中的 playlist', () => {
    const playlist = parsePlaylistJsonFromText(envelopeJsonText());

    expect(playlist).toEqual(applePlaylistFixture);
    expect(playlist.source).toBe('apple-music');
    expect(playlist.complete).toBe(true);
    expect(playlist.total).toBe(3);
  });

  it('保留 playlist 的 warnings 与占位曲目状态', () => {
    const playlist = parsePlaylistJsonFromText(envelopeJsonText());

    expect(playlist.warnings).toEqual(['1 项曲目引用缺失或无效，已保留占位']);
    expect(playlist.tracks[1]).toMatchObject({
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      availability: 'removed',
      position: 1,
    });
    expect(playlist.tracks[2].artists).toEqual(['歌手丙、歌手丁']);
  });

  it('schemaVersion 为 2 时报 IMPORT_UNSUPPORTED_SCHEMA_VERSION', () => {
    const error = expectErrorCode(
      () => parsePlaylistJsonFromText(envelopeJsonText(undefined, { schemaVersion: 2 })),
      'IMPORT_UNSUPPORTED_SCHEMA_VERSION',
    );
    expect(error.message).toContain('schemaVersion');
    expect(error.technicalDetails).toMatchObject({ found: 2, supported: 1 });
  });

  it('schemaVersion 非整数或缺失时报 IMPORT_INVALID_JSON', () => {
    expectErrorCode(
      () => parsePlaylistJsonFromText(envelopeJsonText(undefined, { schemaVersion: '1' })),
      'IMPORT_INVALID_JSON',
    );
    expectErrorCode(
      () => parsePlaylistJsonFromText('{"playlist":{}}'),
      'IMPORT_INVALID_JSON',
    );
  });

  it('非法 JSON 文本报 IMPORT_INVALID_JSON', () => {
    const error = expectErrorCode(
      () => parsePlaylistJsonFromText('this is not json {'),
      'IMPORT_INVALID_JSON',
    );
    expect(error.technicalDetails?.reason).toBeDefined();
  });

  it('playlist 不符合 playlistSchema（complete 与 total 不一致）时报 IMPORT_INVALID_JSON', () => {
    const error = expectErrorCode(
      () => parsePlaylistJsonFromText(envelopeJsonText(undefined, {
        playlist: { ...applePlaylistFixture, total: 5 },
      })),
      'IMPORT_INVALID_JSON',
    );
    expect(error.technicalDetails?.issues).toBeDefined();
  });

  it('缺少 playlist 字段时报 IMPORT_INVALID_JSON', () => {
    const error = expectErrorCode(
      () => parsePlaylistJsonFromText(envelopeJsonText(undefined, { playlist: undefined })),
      'IMPORT_INVALID_JSON',
    );
    expect(JSON.stringify(error.technicalDetails)).toContain('playlist');
  });

  it('容忍 envelope 中的未知字段与缺失可选字段', () => {
    const withFutureField = parsePlaylistJsonFromText(envelopeJsonText(undefined, {
      futureField: { anything: true },
    }));
    expect(withFutureField.id).toBe(applePlaylistFixture.id);

    const minimal = parsePlaylistJsonFromText(
      JSON.stringify({ schemaVersion: 1, playlist: applePlaylistFixture }),
    );
    expect(minimal).toEqual(applePlaylistFixture);
  });

  it('字节输入：UTF-8 BOM 被容忍', () => {
    const playlist = importPlaylistJsonFromBytes(encodeUtf8(envelopeJsonText(), true));
    expect(playlist).toEqual(applePlaylistFixture);
  });

  it('字节输入：无效 UTF-8 报 IMPORT_INVALID_ENCODING', () => {
    expectErrorCode(
      () => importPlaylistJsonFromBytes(new Uint8Array([0x7b, 0xff, 0x7d])),
      'IMPORT_INVALID_ENCODING',
    );
  });
});
