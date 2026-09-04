import { describe, expect, it } from 'vitest';
import {
  decodeAppleTextBytes,
  detectAppleTextEncoding,
  parseAppleTextFromBytes,
  parseAppleTextFromText,
} from '../src/apple-text.js';
import {
  appleTextContent,
  CHINESE_HEADER,
  encodeUtf16Be,
  encodeUtf16Le,
  encodeUtf8,
  ENGLISH_HEADER,
  expectErrorCode,
} from './fixtures.js';

describe('Apple Music 文本导出解析', () => {
  it('解析 UTF-8（带 BOM）与英文表头的导出文件', () => {
    const playlist = parseAppleTextFromBytes(encodeUtf8(appleTextContent({
      header: ENGLISH_HEADER,
      rows: [
        ['测试曲目一', '歌手甲', '专辑一', '200000', 'Pop'],
        ['测试曲目二', '歌手乙', '专辑二', '180000', 'Rock'],
      ],
    }), true));

    expect(playlist.source).toBe('apple-music');
    expect(playlist.complete).toBe(true);
    expect(playlist.total).toBe(2);
    expect(playlist.id).toBe('apple-music-text-import');
    expect(playlist.tracks.map((track) => track.title)).toEqual(['测试曲目一', '测试曲目二']);
    expect(playlist.tracks[0]).toMatchObject({
      artists: ['歌手甲'],
      album: '专辑一',
      position: 0,
      availability: 'available',
      warnings: [],
    });
    expect(playlist.tracks[1]).toMatchObject({ position: 1 });
  });

  it('无 BOM 的文件按严格 UTF-8 解码，且 BOM 会被剥离', () => {
    expect(decodeAppleTextBytes(encodeUtf8('甲'))).toBe('甲');
    expect(decodeAppleTextBytes(encodeUtf8('甲', true))).toBe('甲');

    const playlist = parseAppleTextFromBytes(encodeUtf8(appleTextContent({
      header: ENGLISH_HEADER,
      rows: [['测试曲目一', '歌手甲', '专辑一', '200000', 'Pop']],
    })));
    expect(playlist.tracks).toHaveLength(1);
  });

  it('解析 UTF-16LE BOM 的旧版 iTunes 导出（中文表头）', () => {
    const bytes = encodeUtf16Le(appleTextContent({
      header: CHINESE_HEADER,
      rows: [['测试曲目一', '歌手甲', '专辑一', '200000']],
    }));
    expect(detectAppleTextEncoding(bytes)).toBe('utf-16le');

    const playlist = parseAppleTextFromBytes(bytes);
    expect(playlist.tracks[0]).toMatchObject({
      title: '测试曲目一',
      artists: ['歌手甲'],
      album: '专辑一',
    });
  });

  it('解析 UTF-16BE BOM 的导出文件（含非 BMP 字符）', () => {
    const bytes = encodeUtf16Be(appleTextContent({
      header: ENGLISH_HEADER,
      rows: [['测试曲目🎵一', '歌手甲', '专辑一', '200000', 'Pop']],
    }));
    expect(detectAppleTextEncoding(bytes)).toBe('utf-16be');

    const playlist = parseAppleTextFromBytes(bytes);
    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目🎵一' });
  });

  it('支持中文表头同义词（歌曲名称/演唱者）', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['歌曲名称', '演唱者'],
      rows: [['测试曲目一', '歌手甲']],
    }));
    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一', artists: ['歌手甲'] });
  });

  it('缺失歌手的行使用占位并在汇总 warning 中计数', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [
        ['测试曲目一', ''],
        ['测试曲目二', '歌手乙'],
        ['测试曲目三', ''],
      ],
    }));

    expect(playlist.tracks[0].artists).toEqual(['[unknown artist]']);
    expect(playlist.tracks[2].artists).toEqual(['[unknown artist]']);
    expect(playlist.tracks[0].warnings.join(' ')).toContain('第 2 行');
    expect(playlist.tracks[2].warnings.join(' ')).toContain('第 4 行');
    expect(playlist.warnings.some((w) => w.includes('2 行歌手信息缺失'))).toBe(true);
  });

  it('缺失歌名的行使用 [unknown title] 占位', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [['', '歌手甲'], ['测试曲目二', '歌手乙']],
    }));

    expect(playlist.tracks[0].title).toBe('[unknown title]');
    expect(playlist.tracks[0].warnings.length).toBeGreaterThan(0);
    expect(playlist.warnings.some((w) => w.includes('1 行歌曲名缺失'))).toBe(true);
  });

  it('多歌手字符串不拆分，整串保留为单个歌手条目并在 warnings 注明', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [['测试曲目一', '歌手甲、歌手乙'], ['测试曲目二', 'AC/DC']],
    }));

    expect(playlist.tracks[0].artists).toEqual(['歌手甲、歌手乙']);
    expect(playlist.tracks[0].artists).toHaveLength(1);
    expect(playlist.tracks[1].artists).toEqual(['AC/DC']);
    expect(playlist.warnings.some((w) => w.includes('不做多名歌手拆分'))).toBe(true);
  });

  it('保留原始行顺序（含重复行）与连续 position', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [['甲曲', '歌手甲'], ['乙曲', '歌手乙'], ['甲曲', '歌手甲']],
    }));

    expect(playlist.tracks.map((track) => track.title)).toEqual(['甲曲', '乙曲', '甲曲']);
    expect(playlist.tracks.map((track) => track.position)).toEqual([0, 1, 2]);
  });

  it('跳过空行且不影响 position 连续性', () => {
    const content = ['Name\tArtist', '甲曲\t歌手甲', '', '   ', '乙曲\t歌手乙', ''].join('\n');
    const playlist = parseAppleTextFromText(content);

    expect(playlist.tracks).toHaveLength(2);
    expect(playlist.tracks.map((track) => track.position)).toEqual([0, 1]);
    expect(playlist.tracks[1].title).toBe('乙曲');
  });

  it('首行没有制表符时报 IMPORT_MISSING_HEADER 并记录首行内容', () => {
    const error = expectErrorCode(
      () => parseAppleTextFromText('no tabs in this line'),
      'IMPORT_MISSING_HEADER',
    );
    expect(error.message).toContain('表头');
    expect(error.technicalDetails).toMatchObject({ firstLine: 'no tabs in this line' });
  });

  it('表头缺少必需列时报 IMPORT_MISSING_REQUIRED_COLUMNS 并记录检测到的表头', () => {
    const error = expectErrorCode(
      () => parseAppleTextFromText(appleTextContent({
        header: ['Foo', 'Bar', 'Baz'],
        rows: [['1', '2', '3']],
      })),
      'IMPORT_MISSING_REQUIRED_COLUMNS',
    );
    expect(error.technicalDetails).toMatchObject({
      detectedHeaders: ['foo', 'bar', 'baz'],
    });
  });

  it('无 BOM 且非 UTF-8 字节序列报 IMPORT_INVALID_ENCODING', () => {
    const error = expectErrorCode(
      () => parseAppleTextFromBytes(new Uint8Array([0x61, 0xff, 0xfe, 0x00])),
      'IMPORT_INVALID_ENCODING',
    );
    expect(error.technicalDetails).toMatchObject({ encoding: 'utf-8' });
  });

  it('支持 CRLF 行尾', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [['甲曲', '歌手甲'], ['乙曲', '歌手乙']],
      eol: '\r\n',
    }));
    expect(playlist.tracks.map((track) => track.title)).toEqual(['甲曲', '乙曲']);
  });

  it('未知列（Genre/自定义列）被忽略，缺专辑列时 album 字段不存在', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist', 'My Custom Column'],
      rows: [['测试曲目一', '歌手甲', 'whatever']],
    }));
    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一', artists: ['歌手甲'] });
    expect(playlist.tracks[0].album).toBeUndefined();
  });

  it('时长列可选：识别后不持久化（contracts Track 无时长字段）', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['Name', 'Artist', 'Total Time'],
      rows: [['测试曲目一', '歌手甲', '99999']],
    }));
    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一' });
    expect(Object.keys(playlist.tracks[0])).not.toContain('duration');
  });

  it('值不解析引号；带引号的表头仍可识别', () => {
    const playlist = parseAppleTextFromText(appleTextContent({
      header: ['"Name"', '"Artist"'],
      rows: [['"引号"标题', '歌手甲']],
    }));
    expect(playlist.tracks[0].title).toBe('"引号"标题');
    expect(playlist.tracks[0].artists).toEqual(['歌手甲']);
  });
});
