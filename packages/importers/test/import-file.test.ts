import { describe, expect, it } from 'vitest';
import * as importers from '../src/index.js';
import { importPlaylistFile } from '../src/index.js';
import { parseAppleTextFromBytes } from '../src/apple-text.js';
import {
  applePlaylistFixture,
  appleTextContent,
  encodeUtf16Le,
  encodeUtf8,
  envelopeJsonText,
  expectErrorCodeAsync,
  PLIST_STANDARD_DOCTYPE,
  plistLibraryXml,
  xmlPlaylistEntry,
  xmlTrackEntry,
} from './fixtures.js';

describe('importPlaylistFile 统一入口', () => {
  it('UTF-16LE BOM 的文本导出自动路由到文本解析器，并用 filename 提示回退歌单名', async () => {
    const bytes = encodeUtf16Le(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [['测试曲目一', '歌手甲'], ['测试曲目二', '歌手乙']],
    }));

    const playlist = await importPlaylistFile(bytes, { filename: '我的歌单.txt' });

    expect(playlist.name).toBe('我的歌单');
    expect(playlist.tracks.map((track) => track.title)).toEqual(['测试曲目一', '测试曲目二']);
    expect(playlist).toEqual(parseAppleTextFromBytes(bytes, { filename: '我的歌单.txt' }));
  });

  it('无 BOM 的 UTF-8 文本导出自动路由到文本解析器', async () => {
    const playlist = await importPlaylistFile(encodeUtf8(appleTextContent({
      header: ['Name', 'Artist'],
      rows: [['测试曲目一', '歌手甲']],
    })));

    expect(playlist.name).toBe('本地导入歌单');
    expect(playlist.tracks[0]).toMatchObject({ title: '测试曲目一', artists: ['歌手甲'] });
  });

  it('<?xml 开头的 plist 资料库路由到 XML 解析器，歌单名优先取文件内的 Name', async () => {
    const playlist = await importPlaylistFile(encodeUtf8(plistLibraryXml({
      tracks: [{ id: 101, name: '测试曲目一', artist: '歌手甲' }],
      playlists: [{ name: '合成歌单', playlistId: 9001, items: [101] }],
    })), { filename: 'ignored.txt' });

    expect(playlist.name).toBe('合成歌单');
    expect(playlist.id).toBe('9001');
    expect(playlist.tracks[0].title).toBe('测试曲目一');
  });

  it('带前导空白且无 XML 声明的 <plist 也能路由到 XML 解析器', async () => {
    const bare = '  \n<plist version="1.0"><dict><key>Playlists</key><array>' +
      '<dict><key>Name</key><string>裸歌单</string><key>Playlist Items</key><array/></dict>' +
      '</array></dict></plist>';
    const playlist = await importPlaylistFile(encodeUtf8(bare));

    expect(playlist.name).toBe('裸歌单');
    expect(playlist.tracks).toEqual([]);
  });

  it('{ 开头路由到 JSON envelope 导入', async () => {
    const playlist = await importPlaylistFile(encodeUtf8(envelopeJsonText()));

    expect(playlist).toEqual(applePlaylistFixture);
  });

  // --- DOCTYPE 前导（无 XML 声明）的 plist 必须仍能路由到严格解析器 ---

  /** 标准 DOCTYPE 开头（无 `<?xml` 声明）的完整资料库：真实曲目 + 播放列表。 */
  const doctypeFirstLibraryXml = (doctype: string): string =>
    `${doctype}\n<plist version="1.0"><dict>` +
    `<key>Tracks</key><dict>` +
    xmlTrackEntry({ id: 201, name: 'DOC 曲目一', artist: '歌手甲' }) +
    xmlTrackEntry({ id: 202, name: 'DOC 曲目二', artist: '歌手乙' }) +
    `</dict>` +
    `<key>Playlists</key><array>` +
    xmlPlaylistEntry({ name: 'DOCTYPE 歌单', playlistId: 7001, items: [201, 202] }) +
    `</array>` +
    `</dict></plist>`;

  it('无 XML 声明、以标准 DOCTYPE 开头的合法资料库经统一入口成功导入', async () => {
    const playlist = await importPlaylistFile(
      encodeUtf8(doctypeFirstLibraryXml(PLIST_STANDARD_DOCTYPE)),
      { filename: 'Library.xml' },
    );

    expect(playlist.name).toBe('DOCTYPE 歌单');
    expect(playlist.id).toBe('7001');
    expect(playlist.tracks.map((track) => track.title)).toEqual(['DOC 曲目一', 'DOC 曲目二']);
  });

  it('<?xml 声明 + DOCTYPE 组合经统一入口成功导入', async () => {
    const playlist = await importPlaylistFile(encodeUtf8(plistLibraryXml({
      includeDoctype: true,
      tracks: [{ id: 301, name: '声明曲目', artist: '歌手丙' }],
      playlists: [{ name: '声明歌单', playlistId: 7002, items: [301] }],
    })));

    expect(playlist.name).toBe('声明歌单');
    expect(playlist.tracks[0].title).toBe('声明曲目');
  });

  it('注释前导 + DOCTYPE 组合（无 XML 声明）经统一入口成功导入', async () => {
    const xml = `<!-- 导出工具注释 -->\n<!-- 第二条注释 -->\n${
      doctypeFirstLibraryXml(PLIST_STANDARD_DOCTYPE)
    }`;

    const playlist = await importPlaylistFile(encodeUtf8(xml), { filename: 'Library.xml' });

    expect(playlist.name).toBe('DOCTYPE 歌单');
    expect(playlist.tracks.map((track) => track.title)).toEqual(['DOC 曲目一', 'DOC 曲目二']);
  });

  it('DOCTYPE-first 但包含内部子集时报 IMPORT_XML_DOCTYPE_FORBIDDEN（而非未知格式）', async () => {
    const internalSubset =
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd" [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>';

    const error = await expectErrorCodeAsync(
      () => importPlaylistFile(encodeUtf8(doctypeFirstLibraryXml(internalSubset))),
      'IMPORT_XML_DOCTYPE_FORBIDDEN',
    );
    expect(error.message).toContain('内部子集');
  });

  it('DOCTYPE-first 但指向未知 DTD 时报 IMPORT_XML_DOCTYPE_FORBIDDEN', async () => {
    const foreignDoctype =
      '<!DOCTYPE plist PUBLIC "-//Widgets Inc//DTD PLIST 9.9//EN" ' +
      '"http://www.example.com/DTDs/PropertyList-9.9.dtd">';

    await expectErrorCodeAsync(
      () => importPlaylistFile(encodeUtf8(doctypeFirstLibraryXml(foreignDoctype))),
      'IMPORT_XML_DOCTYPE_FORBIDDEN',
    );
  });

  it('小写 <!doctype 前导路由到解析器并按严格规则拒绝', async () => {
    const lowercase = PLIST_STANDARD_DOCTYPE.replace('<!DOCTYPE', '<!doctype');

    await expectErrorCodeAsync(
      () => importPlaylistFile(encodeUtf8(doctypeFirstLibraryXml(lowercase))),
      'IMPORT_XML_DOCTYPE_FORBIDDEN',
    );
  });

  it('前导注释使 prolog 超过有界扫描上限时维持未知格式路径', async () => {
    const xml = `<!-- ${'x'.repeat(5000)} -->\n${doctypeFirstLibraryXml(PLIST_STANDARD_DOCTYPE)}`;

    await expectErrorCodeAsync(
      () => importPlaylistFile(encodeUtf8(xml)),
      'IMPORT_UNKNOWN_FORMAT',
    );
  });


  it('UTF-16LE 编码的 plist XML 在路由前先按 BOM 解码', async () => {
    const playlist = await importPlaylistFile(encodeUtf16Le(plistLibraryXml({
      tracks: [{ id: 111, name: '测试曲目一', artist: '歌手甲' }],
      playlists: [{ name: '编码歌单', items: [111] }],
    })));

    expect(playlist.name).toBe('编码歌单');
    expect(playlist.tracks[0].title).toBe('测试曲目一');
  });

  it('纯文本无 tab 报 IMPORT_UNKNOWN_FORMAT 并记录首行', async () => {
    const error = await expectErrorCodeAsync(
      () => importPlaylistFile(encodeUtf8('just some plain notes\nsecond line')),
      'IMPORT_UNKNOWN_FORMAT',
    );
    expect(error.message).toContain('无法识别的文件格式');
    expect(error.technicalDetails).toMatchObject({ firstLine: 'just some plain notes' });
  });

  it('空文件报 IMPORT_UNKNOWN_FORMAT', async () => {
    const error = await expectErrorCodeAsync(
      () => importPlaylistFile(new Uint8Array(0)),
      'IMPORT_UNKNOWN_FORMAT',
    );
    expect(error.technicalDetails).toMatchObject({ byteLength: 0 });
  });

  it('首行含 tab 但表头无法识别时报 IMPORT_MISSING_REQUIRED_COLUMNS（而非未知格式）', async () => {
    await expectErrorCodeAsync(
      () => importPlaylistFile(encodeUtf8('Foo\tBar\n1\t2')),
      'IMPORT_MISSING_REQUIRED_COLUMNS',
    );
  });

  it('统一入口与各解析器具名导出齐全', () => {
    expect(typeof importers.importPlaylistFile).toBe('function');
    expect(typeof importers.parseAppleTextFromBytes).toBe('function');
    expect(typeof importers.parseAppleTextFromText).toBe('function');
    expect(typeof importers.parseApplePlistXmlFromBytes).toBe('function');
    expect(typeof importers.parseApplePlistXmlFromText).toBe('function');
    expect(typeof importers.importPlaylistJsonFromBytes).toBe('function');
    expect(typeof importers.parsePlaylistJsonFromText).toBe('function');
    expect(typeof importers.decodeAppleTextBytes).toBe('function');
    expect(importers.UNKNOWN_TITLE).toBe('[unknown title]');
    expect(importers.UNKNOWN_ARTIST).toBe('[unknown artist]');
  });
});
