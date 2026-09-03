import { describe, expect, it } from 'vitest';
import { exportPlaylist } from '../src/index.js';
import { playlist } from './fixtures.js';

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

describe('CSV exporter', () => {
  it('writes the fixed RFC 4180 columns in source order and can add index and album', () => {
    const artifact = exportPlaylist(playlist, {
      format: 'csv',
      includeIndex: true,
      includeAlbum: true,
      csvBom: false,
      date: '2026-09-03',
    });
    const rows = decode(artifact.bytes).split('\n');

    expect(rows[0]).toBe('序号,歌曲名,歌手,专辑,ID,来源,可用性');
    expect(rows[1]).toBe('1,歌一,歌手甲、歌手乙,专辑一,same-track,netease,available');
    expect(rows[2]).toBe('2,下架曲,[unknown artist],专辑二,removed-track,netease,[已下架]');
    expect(rows[3]).toContain('[地区不可用]');
    expect(rows[4]).toContain('[可用性未知]');
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)).toBe('');
    expect(artifact).toMatchObject({
      format: 'csv',
      encoding: 'utf-8',
      lineEnding: 'lf',
      bom: false,
      trackCount: 5,
      complete: true,
    });
  });

  it('quotes RFC 4180 fields and neutralizes formula-leading values', () => {
    const formulaPlaylist = {
      ...playlist,
      total: 1,
      tracks: [
        {
          ...playlist.tracks[0],
          title: '=SUM("A")',
          artists: ['+歌手, 一', '歌手"二'],
          album: '-专辑\r\n第二行',
          trackId: '@track-id',
        },
      ],
    };
    const artifact = exportPlaylist(formulaPlaylist, {
      format: 'csv',
      includeAlbum: true,
      date: '2026-09-03',
    });
    const text = decode(artifact.bytes);

    expect(text).toContain('"\'=SUM(""A"")"');
    expect(text).toContain('"\'+歌手, 一、歌手""二"');
    expect(text).toContain('"\'-专辑\r\n第二行"');
    expect(text).toContain("'@track-id");
  });

  it('adds an optional UTF-8 BOM and uses CRLF when requested', () => {
    const artifact = exportPlaylist(playlist, {
      format: 'csv',
      csvBom: true,
      lineEnding: 'crlf',
      date: '2026-09-03',
    });

    expect([...artifact.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(artifact.bom).toBe(true);
    expect(artifact.lineEnding).toBe('crlf');
    expect(new TextDecoder('utf-8').decode(artifact.bytes)).toContain('\r\n');
  });

  it('keeps header and data aligned with index but without album', () => {
    const artifact = exportPlaylist(playlist, {
      format: 'csv', includeIndex: true, includeAlbum: false, date: '2026-09-03',
    });
    const [header, first] = decode(artifact.bytes).split('\n');

    expect(header).toBe('序号,歌曲名,歌手,ID,来源,可用性');
    expect(first).toBe('1,歌一,歌手甲、歌手乙,same-track,netease,available');
  });

  it('marks missing optional fields and unknown availability without dropping the row', () => {
    const missing = {
      ...playlist,
      total: 1,
      tracks: [{ ...playlist.tracks[3], album: undefined, trackId: undefined }],
    };
    const artifact = exportPlaylist(missing, {
      format: 'csv', includeAlbum: true, date: '2026-09-03',
    });
    const [, row] = decode(artifact.bytes).split('\n');

    expect(row).toBe(
      '未知状态曲,歌手丁,[专辑缺失],[ID缺失],netease,[可用性未知]',
    );
  });
});
