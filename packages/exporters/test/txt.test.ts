import { describe, expect, it } from 'vitest';
import { exportPlaylist } from '../src/index.js';
import { playlist } from './fixtures.js';

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

describe('TXT exporter', () => {
  it('writes UTF-8 LF text in source order and keeps every availability state', () => {
    const artifact = exportPlaylist(playlist, {
      format: 'txt',
      date: '2026-09-03',
    });

    expect(decode(artifact.bytes)).toBe(
      '歌一 - 歌手甲、歌手乙\n下架曲 [已下架] - [unknown artist]\n不可用曲 [地区不可用] - 歌手丙\n未知状态曲 [可用性未知] - 歌手丁\n歌一 - 歌手甲、歌手乙\n',
    );
    expect([...artifact.bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(artifact).toMatchObject({
      format: 'txt',
      encoding: 'utf-8',
      lineEnding: 'lf',
      bom: false,
      trackCount: 5,
      complete: true,
    });
    expect(artifact.filename).toBe('netease_我的_歌单_测试_2026-09-03.txt');
    expect(decode(artifact.bytes).endsWith('\n')).toBe(true);
  });

  it('supports numbering, artist-title order, albums, dedupe, and CRLF', () => {
    const artifact = exportPlaylist(playlist, {
      format: 'txt',
      includeIndex: true,
      order: 'artist-title',
      includeAlbum: true,
      dedupe: true,
      lineEnding: 'crlf',
      date: '2026-09-03',
    });
    const text = decode(artifact.bytes);

    expect(text).toBe(
      '1. 歌手甲、歌手乙 - 歌一 - 专辑一\r\n' +
        '2. [unknown artist] - 下架曲 [已下架] - 专辑二\r\n' +
        '3. 歌手丙 - 不可用曲 [地区不可用] - 专辑三\r\n' +
        '4. 歌手丁 - 未知状态曲 [可用性未知]\r\n',
    );
    expect(artifact.trackCount).toBe(4);
    expect(artifact.lineEnding).toBe('crlf');
    expect(artifact.bom).toBe(false);
  });
});
