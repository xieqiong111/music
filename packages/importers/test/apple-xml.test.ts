import { describe, expect, it } from 'vitest';
import {
  parseApplePlistXmlFromBytes,
  parseApplePlistXmlFromText,
} from '../src/apple-xml.js';
import {
  encodeUtf16Le,
  expectErrorCode,
  plistLibraryXml,
  xmlPlaylistEntry,
} from './fixtures.js';

const LIBRARY_TRACKS = [
  { id: 101, name: '测试曲目一', artist: '歌手甲', album: '专辑一' },
  { id: 102, name: '测试曲目二', artist: '歌手乙' },
  { id: 103, name: '测试曲目三', artist: '歌手丙', album: '专辑三' },
];

describe('Apple Music plist XML 解析', () => {
  it('解析完整资料库布局并取第一个播放列表，按 Playlist Items 顺序输出', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: LIBRARY_TRACKS,
      playlists: [{ name: '合成歌单', playlistId: 9001, items: [101, 102, 103] }],
    }));

    expect(playlist.source).toBe('apple-music');
    expect(playlist.complete).toBe(true);
    expect(playlist.total).toBe(3);
    expect(playlist.id).toBe('9001');
    expect(playlist.name).toBe('合成歌单');
    expect(playlist.warnings).toEqual([]);
    expect(playlist.tracks.map((track) => [track.title, track.trackId])).toEqual([
      ['测试曲目一', '101'],
      ['测试曲目二', '102'],
      ['测试曲目三', '103'],
    ]);
    expect(playlist.tracks[0]).toMatchObject({ artists: ['歌手甲'], album: '专辑一', position: 0 });
    expect(playlist.tracks[1].album).toBeUndefined();
    expect(playlist.tracks[2]).toMatchObject({ position: 2 });
  });

  it('解析单播放列表导出布局，缺 Playlist ID 时使用稳定回退 id', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{ id: 201, name: '测试曲目一', artist: '歌手甲' }],
      playlists: [{ name: '单一歌单', items: [201] }],
    }));

    expect(playlist.id).toBe('apple-music-xml-import');
    expect(playlist.name).toBe('单一歌单');
    expect(playlist.tracks).toHaveLength(1);
    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一', trackId: '201' });
  });

  it('playlistName 选项按名称选择播放列表', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [
        { id: 301, name: '甲歌单曲目', artist: '歌手甲' },
        { id: 302, name: '乙歌单曲目', artist: '歌手乙' },
      ],
      playlists: [
        { name: '甲歌单', playlistId: 1, items: [301] },
        { name: '乙歌单', playlistId: 2, items: [302] },
      ],
    }), { playlistName: '乙歌单' });

    expect(playlist.name).toBe('乙歌单');
    expect(playlist.id).toBe('2');
    expect(playlist.tracks.map((track) => track.title)).toEqual(['乙歌单曲目']);
  });

  it('playlistName 未命中时报 IMPORT_XML_PLAYLIST_NOT_FOUND 并列出可用名称', () => {
    const error = expectErrorCode(
      () => parseApplePlistXmlFromText(plistLibraryXml({
        tracks: [],
        playlists: [{ name: '甲歌单', items: [] }, { name: '乙歌单', items: [] }],
      }), { playlistName: '不存在的歌单' }),
      'IMPORT_XML_PLAYLIST_NOT_FOUND',
    );
    expect(error.technicalDetails).toMatchObject({
      requestedName: '不存在的歌单',
      availableNames: ['甲歌单', '乙歌单'],
    });
  });

  it('Track 引用不存在时占位 Track 占住位置，顺序不塌缩', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: LIBRARY_TRACKS,
      playlists: [{ name: '合成歌单', items: [101, 999, 102] }],
    }));

    expect(playlist.tracks).toHaveLength(3);
    expect(playlist.tracks[1]).toMatchObject({
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      availability: 'removed',
      position: 1,
    });
    expect(playlist.tracks[1].trackId).toBeUndefined();
    expect(playlist.tracks[1].warnings.join(' ')).toContain('999');
    expect(playlist.tracks[2].title).toBe('测试曲目二');
    expect(playlist.warnings.some((w) => w.includes('1 项曲目引用缺失'))).toBe(true);
  });

  it('Playlist Item 缺少 Track ID 时同样占位', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{ id: 401, name: '测试曲目一', artist: '歌手甲' }],
      playlists: [{
        name: '合成歌单',
        items: ['<dict><key>Skip</key><true/></dict>', 401],
      }],
    }));

    expect(playlist.tracks).toHaveLength(2);
    expect(playlist.tracks[0].title).toBe('[unknown title]');
    expect(playlist.tracks[0].warnings.join(' ')).toContain('缺少有效的 Track ID');
    expect(playlist.tracks[1]).toMatchObject({ title: '测试曲目一', position: 1 });
  });

  it('data 值按不支持字段容错：跳过并产生汇总 warning，不崩溃', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{
        id: 501,
        name: '测试曲目一',
        artist: '歌手甲',
        extra: '<key>Artwork</key><data>PD9waHAg</data><key>Total Time</key><integer>1</integer>',
      }],
      playlists: [{
        name: '合成歌单',
        items: [501],
        extra: '<key>Smart Info</key><data>AQ==</data>',
      }],
    }));

    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一', trackId: '501' });
    expect(playlist.warnings.some((w) => w.includes('2 处不支持的 data'))).toBe(true);
  });

  it('DOCTYPE 声明被拒绝（防外部实体注入）', () => {
    const error = expectErrorCode(
      () => parseApplePlistXmlFromText(plistLibraryXml({
        tracks: [],
        playlists: [{ name: '合成歌单', items: [] }],
        includeDoctype: true,
      })),
      'IMPORT_XML_DOCTYPE_FORBIDDEN',
    );
    expect(error.technicalDetails).toMatchObject({ line: 1 });
  });

  it('根节点不是 dict（array 根）时报 IMPORT_XML_ROOT', () => {
    const error = expectErrorCode(
      () => parseApplePlistXmlFromText(
        '<plist version="1.0"><array><dict><key>Name</key><string>x</string></dict></array></plist>',
      ),
      'IMPORT_XML_ROOT',
    );
    expect(error.technicalDetails).toMatchObject({ foundRoot: 'array' });
  });

  it('缺少 Playlists 数组时报 IMPORT_XML_NO_PLAYLIST', () => {
    const error = expectErrorCode(
      () => parseApplePlistXmlFromText(
        '<plist version="1.0"><dict><key>Tracks</key><dict></dict></dict></plist>',
      ),
      'IMPORT_XML_NO_PLAYLIST',
    );
    expect(error.technicalDetails).toMatchObject({ hasPlaylistsKey: false });
  });

  it('Playlists 为空数组时报 IMPORT_XML_NO_PLAYLIST', () => {
    expectErrorCode(
      () => parseApplePlistXmlFromText(plistLibraryXml({ tracks: [], playlists: [] })),
      'IMPORT_XML_NO_PLAYLIST',
    );
  });

  it('解码命名实体与数字/十六进制字符引用', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{ id: 601, name: 'Tom &amp; Jerry &#x4E2D;&#65;', artist: '歌手甲&apos;s' }],
      playlists: [{ name: '合成 &amp; 歌单', items: [601] }],
    }));

    expect(playlist.name).toBe('合成 & 歌单');
    expect(playlist.tracks[0].title).toBe('Tom & Jerry 中A');
    expect(playlist.tracks[0].artists).toEqual(["歌手甲's"]);
  });

  it('integer/real/date/true/false 值解析不崩溃', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{
        id: 701,
        name: '测试曲目一',
        artist: '歌手甲',
        extra:
          '<key>Total Time</key><integer>200000</integer>' +
          '<key>Volume Adjustment</key><real>-0.5</real>' +
          '<key>Compilation</key><true/>' +
          '<key>Part Of Compilation</key><false/>' +
          '<key>Release Date</key><date>2024-01-02T03:04:05Z</date>' +
          '<key>Track Count</key><integer>12</integer>',
      }],
      playlists: [{ name: '合成歌单', items: [701] }],
    }));

    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一', trackId: '701' });
    expect(playlist.warnings).toEqual([]);
  });

  it('XML 语法错误报 IMPORT_XML_SYNTAX 并带行列位置', () => {
    const error = expectErrorCode(
      () => parseApplePlistXmlFromText(
        '<plist version="1.0"><dict><key>Name</key><string>unclosed',
      ),
      'IMPORT_XML_SYNTAX',
    );
    expect(error.technicalDetails).toMatchObject({ line: 1 });
    expect((error.technicalDetails?.column as number | undefined) ?? 0).toBeGreaterThan(0);
  });

  it('CDATA 节点报 IMPORT_XML_UNSUPPORTED_NODE', () => {
    expectErrorCode(
      () => parseApplePlistXmlFromText(
        '<plist version="1.0"><dict><![CDATA[oops]]><key>Name</key><string>x</string></dict></plist>',
      ),
      'IMPORT_XML_UNSUPPORTED_NODE',
    );
  });

  it('Track 缺少 Name/Artist 时使用占位并给出行级 warning', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{ id: 801 }],
      playlists: [{ name: '合成歌单', items: [801] }],
    }));

    expect(playlist.tracks[0]).toMatchObject({
      title: '[unknown title]',
      artists: ['[unknown artist]'],
      trackId: '801',
      position: 0,
    });
    expect(playlist.tracks[0].warnings.some((w) => w.includes('歌曲名缺失'))).toBe(true);
    expect(playlist.tracks[0].warnings.some((w) => w.includes('歌手信息缺失'))).toBe(true);
  });

  it('Tracks 字典整体缺失时全部曲目占位并汇总 warning', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      rootValue:
        '<dict><key>Playlists</key><array>' +
        xmlPlaylistEntry({ name: '无字典歌单', items: [901, 902] }) +
        '</array></dict>',
    }));

    expect(playlist.tracks).toHaveLength(2);
    expect(playlist.tracks.every((track) => track.availability === 'removed')).toBe(true);
    expect(playlist.tracks.map((track) => track.position)).toEqual([0, 1]);
    expect(playlist.warnings.some((w) => w.includes('Tracks 曲目字典'))).toBe(true);
    expect(playlist.warnings.some((w) => w.includes('2 项曲目引用缺失'))).toBe(true);
  });

  it('字节输入按编码嗅探解码（UTF-16LE 编码的 XML）', () => {
    const playlist = parseApplePlistXmlFromBytes(encodeUtf16Le(plistLibraryXml({
      tracks: [{ id: 111, name: '测试曲目一', artist: '歌手甲' }],
      playlists: [{ name: '编码歌单', items: [111] }],
    })));

    expect(playlist.name).toBe('编码歌单');
    expect(playlist.tracks[0].title).toBe('测试曲目一');
  });

  it('拒绝非 plist 的根元素并支持注释与空白', () => {
    expectErrorCode(
      () => parseApplePlistXmlFromText('<root><child/></root>'),
      'IMPORT_XML_SYNTAX',
    );

    const playlist = parseApplePlistXmlFromText([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- synthetic fixture -->',
      '<plist version="1.0">',
      '<dict>',
      '  <!-- comment between elements -->',
      '  <key>Playlists</key>',
      '  <array>',
      xmlPlaylistEntry({ name: '注释歌单', items: [] }),
      '  </array>',
      '</dict>',
      '</plist>',
    ].join('\n'));
    expect(playlist.name).toBe('注释歌单');
    expect(playlist.tracks).toEqual([]);
  });

  it('Tracks 字段值不是 dict 时按缺失字典处理', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      rootValue:
        '<dict><key>Tracks</key><string>corrupted</string>' +
        `<key>Playlists</key><array>${xmlPlaylistEntry({ name: '异常歌单', items: [111] })}</array></dict>`,
    }));

    expect(playlist.tracks).toHaveLength(1);
    expect(playlist.tracks[0].availability).toBe('removed');
    expect(playlist.warnings.some((w) => w.includes('Tracks 曲目字典'))).toBe(true);
  });
});

describe('重复引用', () => {
  it('同一 Track ID 可被多个 Playlist Item 引用', () => {
    const playlist = parseApplePlistXmlFromText(plistLibraryXml({
      tracks: [{ id: 121, name: '测试曲目一', artist: '歌手甲' }],
      playlists: [{ name: '合成歌单', items: [121, 121] }],
    }));

    expect(playlist.tracks.map((track) => track.title)).toEqual(['测试曲目一', '测试曲目一']);
    expect(playlist.tracks.map((track) => track.position)).toEqual([0, 1]);
  });
});
