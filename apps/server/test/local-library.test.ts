import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseFile } from 'music-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Playlist, Track } from '@playlist-exporter/contracts';
import {
  createLocalLibraryRouter,
  createLocalLibraryService,
  LocalLibraryError,
  type BrowseDirResult,
  type EntryPatch,
  type LibraryEntry,
  type LibraryState,
  type LocalLibraryService,
  type LocalLibraryServiceOptions,
} from '../src/local-library.js';

// ---------------------------------------------------------------------------
// 手工构造的最小音频文件(ID3v2.3 + 一帧 MPEG / fLaC + STREAMINFO + Vorbis Comment)
// ---------------------------------------------------------------------------

const id3TextFrame = (frameId: string, text: string): Buffer => {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, 'latin1')]);
  const header = Buffer.alloc(10);
  header.write(frameId, 0, 'latin1');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
};

const id3v23 = (tags: Array<readonly [string, string]>): Buffer => {
  const frames = Buffer.concat(tags.map(([frameId, value]) => id3TextFrame(frameId, value)));
  const size = frames.length;
  const syncsafe = Buffer.from([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00, 0x00]),
    syncsafe,
  ]);
  return Buffer.concat([header, frames]);
};

// MPEG1 Layer III, 128kbps, 44100Hz → 帧长 417 字节
const mpegFrame = (): Buffer => {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return frame;
};

const flacMetadataBlock = (type: number, payload: Buffer, last: boolean): Buffer => {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0x00) | type;
  header.writeUIntBE(payload.length, 1, 3);
  return Buffer.concat([header, payload]);
};

const vorbisComments = (tags: Record<string, string>): Buffer => {
  const vendor = Buffer.from('playlist-exporter', 'utf8');
  const parts: Buffer[] = [];
  let length = 4 + vendor.length + 4;
  for (const [key, value] of Object.entries(tags)) {
    const comment = Buffer.from(`${key}=${value}`, 'utf8');
    const commentLength = Buffer.alloc(4);
    commentLength.writeUInt32LE(comment.length, 0);
    parts.push(commentLength, comment);
    length += 4 + comment.length;
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  buffer.writeUInt32LE(vendor.length, offset);
  offset += 4;
  vendor.copy(buffer, offset);
  offset += vendor.length;
  buffer.writeUInt32LE(Object.keys(tags).length, offset);
  offset += 4;
  for (const part of parts) {
    part.copy(buffer, offset);
    offset += part.length;
  }
  return buffer;
};

// STREAMINFO: 44100Hz / 1ch / 16bit / totalSamples = 44100 → 约 1 秒时长
const streamInfoBlock = (): Buffer => {
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  streamInfo[10] = 0x0a;
  streamInfo[11] = 0xca;
  streamInfo[12] = 0x40;
  streamInfo[13] = 0xf0;
  streamInfo.writeUInt32BE(44100, 14);
  return streamInfo;
};

const writeTaggedMp3 = (
  dir: string,
  fileName: string,
  tags: { title: string; artist: string; album: string },
): void => {
  writeFileSync(
    join(dir, fileName),
    Buffer.concat([
      id3v23([['TIT2', tags.title], ['TPE1', tags.artist], ['TALB', tags.album]]),
      mpegFrame(),
      Buffer.alloc(50),
    ]),
  );
};

const writeTaggedFlac = (
  dir: string,
  fileName: string,
  tags: { title: string; artist: string; album: string | null },
): void => {
  const comments: Record<string, string> = { TITLE: tags.title, ARTIST: tags.artist };
  if (tags.album !== null) comments.ALBUM = tags.album;
  writeFileSync(
    join(dir, fileName),
    Buffer.concat([
      Buffer.from('fLaC', 'latin1'),
      flacMetadataBlock(0, streamInfoBlock(), false),
      flacMetadataBlock(4, vorbisComments(comments), true),
    ]),
  );
};

const writeGarbage = (dir: string, fileName: string): void => {
  writeFileSync(join(dir, fileName), 'this is not audio data at all');
};

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'local-library-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const dataFileOf = (name = 'library.json'): string => join(workspace, 'data', name);
const musicDirOf = (name = 'music'): string => join(workspace, name);

const createService = async (
  overrides: Partial<LocalLibraryServiceOptions> = {},
): Promise<LocalLibraryService> =>
  createLocalLibraryService({ dataFile: dataFileOf(), ...overrides });

const expectLibraryError = async (
  promise: Promise<unknown>,
  status: number,
  code: string,
  messageIncludes?: string,
): Promise<void> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LocalLibraryError);
  const libraryError = caught as LocalLibraryError;
  expect(libraryError.status).toBe(status);
  expect(libraryError.code).toBe(code);
  if (messageIncludes !== undefined) {
    expect(libraryError.message).toContain(messageIncludes);
  }
};

const track = (position: number, title: string, artists: string[]): Track => ({
  title,
  artists,
  source: 'netease',
  availability: 'available',
  position,
  warnings: [],
});

const makePlaylist = (tracks: Track[], warnings: string[] = []): Playlist => ({
  id: 'pl-1',
  name: '测试歌单',
  source: 'netease',
  total: tracks.length,
  tracks,
  complete: true,
  warnings,
});

const seedMusicDir = (): string => {
  const musicDir = musicDirOf();
  mkdirSync(musicDir, { recursive: true });
  writeTaggedMp3(musicDir, 'a-sunny.mp3', { title: 'Sunny Day', artist: 'Jay Chou', album: 'Album A' });
  writeTaggedFlac(musicDir, 'b-night.flac', { title: 'Night  Dance', artist: 'dj test', album: null });
  writeGarbage(musicDir, 'Fallback Tune.mp3');
  return musicDir;
};

const seedLibrary = async (service: LocalLibraryService, dir = seedMusicDir()): Promise<LibraryState> => {
  await service.addRoot(dir);
  await service.whenIdle();
  return service.getState();
};

const findEntryByTitle = (state: LibraryState, title: string): LibraryEntry => {
  const entry = state.entries.find(candidate => candidate.title === title);
  expect(entry, `库中应存在标题为 ${title} 的条目`).toBeDefined();
  return entry as LibraryEntry;
};

// ---------------------------------------------------------------------------
// 服务:扫描与元数据
// ---------------------------------------------------------------------------

describe('local library service', () => {
  it('递归扫描目录并解析 mp3 / flac 标签,跳过隐藏文件与目录', async () => {
    const musicDir = musicDirOf();
    mkdirSync(join(musicDir, 'sub'), { recursive: true });
    mkdirSync(join(musicDir, '.hidden'), { recursive: true });
    writeTaggedMp3(musicDir, 'Midnight City.mp3', { title: 'Midnight City', artist: 'M83', album: 'Hurry Up' });
    writeTaggedFlac(musicDir, '夜曲.flac', { title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' });
    writeTaggedFlac(join(musicDir, 'sub'), 'Deeper.flac', { title: 'Deeper', artist: 'Kaskade', album: null });
    writeGarbage(join(musicDir, '.hidden'), 'Secret.mp3');
    writeFileSync(join(musicDir, '.DS_Store'), 'junk');
    writeFileSync(join(musicDir, 'notes.txt'), 'ignored');

    const service = await createService();
    const state = await seedLibrary(service, musicDir);

    expect(state.roots).toHaveLength(1);
    expect(state.roots[0]?.path).toBe(musicDir);
    expect(state.roots[0]?.fileCount).toBe(3);
    expect(state.roots[0]?.lastScanAt).toBeDefined();
    expect(state.truncated).toBe(false);

    const midnight = findEntryByTitle(state, 'Midnight City');
    expect(midnight.artists).toEqual(['M83']);
    expect(midnight.album).toBe('Hurry Up');
    expect(midnight.path).toBe(join(musicDir, 'Midnight City.mp3'));
    expect(midnight.id).toHaveLength(16);
    expect(midnight.mtimeMs).toBeGreaterThan(0);
    // 单帧 128kbps mp3 可能无法得出时长:允许 null 或正数
    expect(midnight.durationMs === null || midnight.durationMs > 0).toBe(true);

    const nightSong = findEntryByTitle(state, '夜曲');
    expect(nightSong.artists).toEqual(['周杰伦']);
    expect(nightSong.album).toBe('十一月的萧邦');
    // STREAMINFO totalSamples = 44100 @ 44100Hz → 约 1 秒
    expect(nightSong.durationMs).toBeGreaterThan(900);
    expect(nightSong.durationMs).toBeLessThan(1100);

    const deeper = findEntryByTitle(state, 'Deeper');
    expect(deeper.path).toBe(join(musicDir, 'sub', 'Deeper.flac'));

    const scannedPaths = state.entries.map(entry => entry.path);
    expect(scannedPaths.some(path => path.includes('.hidden'))).toBe(false);
    expect(scannedPaths.some(path => path.includes('.DS_Store'))).toBe(false);
    expect(scannedPaths.some(path => path.endsWith('.txt'))).toBe(false);
    expect(state.entries).toHaveLength(3);
    expect(state.scan.active).toBe(false);
  });

  it('解析不出标签的坏文件回退为文件名且不丢文件,扩展名白名单大小写不敏感', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    writeGarbage(musicDir, 'Broken Song.mp3');
    writeGarbage(musicDir, 'Upper.MP3');
    writeFileSync(join(musicDir, 'notes.txt'), 'not audio but wrong extension');

    const service = await createService();
    const state = await seedLibrary(service, musicDir);

    expect(state.entries).toHaveLength(2);
    const broken = findEntryByTitle(state, 'Broken Song');
    expect(broken.artists).toEqual([]);
    expect(broken.album).toBeNull();
    expect(broken.durationMs).toBeNull();
    expect(state.entries.map(entry => entry.title)).toContain('Upper');
  });

  it('元数据解析抛异常时同样回退文件名,不丢文件', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    writeGarbage(musicDir, 'Throwing.mp3');
    writeGarbage(musicDir, 'Also Bad.flac');
    const service = await createService({
      parseAudio: async () => {
        throw new Error('parser exploded');
      },
    });
    const state = await seedLibrary(service, musicDir);
    expect(state.entries).toHaveLength(2);
    expect(state.entries.map(entry => entry.title).sort()).toEqual(['Also Bad', 'Throwing']);
    for (const entry of state.entries) {
      expect(entry.artists).toEqual([]);
      expect(entry.album).toBeNull();
      expect(entry.durationMs).toBeNull();
    }
  });

  it('扫描时把字符串形态的多歌手标签按常见分隔符拆分', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    // 注:多歌手整串用 FLAC(Vorbis Comment 为 UTF-8);mp3 辅助函数按 latin1 编码,写非拉丁字符会乱码
    writeTaggedFlac(musicDir, 'duo.flac', { title: 'Duo Song', artist: 'Aqu3ra;早見沙織', album: null });
    writeTaggedFlac(musicDir, 'mixed.flac', {
      title: 'Mixed Song',
      artist: '歌手A/歌手B、歌手C,歌手D & 歌手E feat. 歌手F',
      album: null,
    });

    const service = await createService();
    const state = await seedLibrary(service, musicDir);

    expect(findEntryByTitle(state, 'Duo Song').artists).toEqual(['Aqu3ra', '早見沙織']);
    expect(findEntryByTitle(state, 'Mixed Song').artists).toEqual([
      '歌手A', '歌手B', '歌手C', '歌手D', '歌手E', '歌手F',
    ]);
  });

  it('单一歌手(无分隔符)不拆分;艺人名含 & 时按既定取舍仍作为分隔符', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    writeTaggedFlac(musicDir, 'single.flac', { title: 'Single Song', artist: 'Jay Chou', album: null });
    writeTaggedFlac(musicDir, 'amp.flac', { title: 'Amp Song', artist: 'Simon & Garfunkel', album: null });

    const service = await createService();
    const state = await seedLibrary(service, musicDir);

    expect(findEntryByTitle(state, 'Single Song').artists).toEqual(['Jay Chou']);
    // 已知取舍:个别艺人名(如 Simon & Garfunkel)中的 & 会被当作分隔符误拆,见 splitArtistStrings 注释
    expect(findEntryByTitle(state, 'Amp Song').artists).toEqual(['Simon', 'Garfunkel']);
  });

  it('拆分时清理分隔符前后空格与空段,并按大小写不敏感去重(保留原大小写)', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    // "C c" 与 ";" 之间是一个全角空格(U+3000),末尾还有一个大小写不同的重复 "A"
    writeTaggedFlac(musicDir, 'messy.flac', { title: 'Messy Song', artist: 'A;;  B , C c　;  A ', album: null });

    const service = await createService();
    const state = await seedLibrary(service, musicDir);

    expect(findEntryByTitle(state, 'Messy Song').artists).toEqual(['A', 'B', 'C c']);
  });

  it('跳过符号链接目录,避免循环扫描', async ({ skip }) => {
    if (process.platform === 'win32') {
      skip(); // Windows 普通权限无法创建符号链接
      return;
    }
    const musicDir = musicDirOf();
    // POSIX 上 symlink 的目标父目录必须存在,先建 music/ 再挂链接
    mkdirSync(musicDir, { recursive: true });
    const realDir = join(workspace, 'real');
    mkdirSync(realDir, { recursive: true });
    writeTaggedMp3(realDir, 'Real.mp3', { title: 'Real Song', artist: 'A', album: 'B' });
    symlinkSync(realDir, join(musicDir, 'link'));

    const service = await createService();
    const state = await seedLibrary(service, musicDir);
    expect(state.entries).toHaveLength(0);
  });

  it('addRoot 校验绝对路径、存在性、目录类型与重复/嵌套', async () => {
    const service = await createService();
    const musicDir = musicDirOf();
    mkdirSync(join(musicDir, 'child'), { recursive: true });

    await expectLibraryError(service.addRoot('music'), 400, 'INVALID_REQUEST');
    await expectLibraryError(service.addRoot(join(workspace, 'missing')), 400, 'INVALID_REQUEST');
    const filePath = join(workspace, 'plain.txt');
    writeFileSync(filePath, 'a file, not a dir');
    await expectLibraryError(service.addRoot(filePath), 400, 'INVALID_REQUEST');

    const added = await service.addRoot(musicDir);
    expect(added.roots).toHaveLength(1);
    await expectLibraryError(service.addRoot(musicDir), 400, 'INVALID_REQUEST');
    await expectLibraryError(service.addRoot(join(musicDir, 'child')), 400, 'INVALID_REQUEST');
    await expectLibraryError(service.addRoot(`${musicDir}/`), 400, 'INVALID_REQUEST');

    expect(service.getState().roots).toHaveLength(1);
    // 删除后允许重新添加
    await service.removeRoot(service.getState().roots[0]?.id ?? '');
    const child = await service.addRoot(join(musicDir, 'child'));
    expect(child.roots).toHaveLength(1);
    await expectLibraryError(service.addRoot(musicDir), 400, 'INVALID_REQUEST');
  });

  it('editEntry 校验非法输入并支持手工修正元数据', async () => {
    const service = await createService();
    const state = await seedLibrary(service);
    const entryId = state.entries[0]?.id ?? '';

    await expectLibraryError(service.editEntry(entryId, {}), 400, 'INVALID_REQUEST');
    await expectLibraryError(service.editEntry(entryId, { title: '' }), 400, 'INVALID_REQUEST');
    await expectLibraryError(service.editEntry(entryId, { title: '   ' }), 400, 'INVALID_REQUEST');
    await expectLibraryError(
      service.editEntry(entryId, { artists: '周杰伦' as unknown as string[] }),
      400,
      'INVALID_REQUEST',
    );
    await expectLibraryError(
      service.editEntry(entryId, { artists: [42] as unknown as string[] }),
      400,
      'INVALID_REQUEST',
    );
    await expectLibraryError(
      service.editEntry(entryId, { album: 5 as unknown as string }),
      400,
      'INVALID_REQUEST',
    );
    await expectLibraryError(
      service.editEntry(entryId, { unknown: 1 } as unknown as EntryPatch),
      400,
      'INVALID_REQUEST',
    );
    await expectLibraryError(service.editEntry('no-such-id', { title: 'x' }), 404, 'LOCAL_LIBRARY_ERROR');

    const edited = await service.editEntry(entryId, {
      title: '  新标题  ',
      artists: ['  A ', 'B'],
      album: 'Live Album',
    });
    expect(edited.title).toBe('新标题');
    expect(edited.artists).toEqual(['A', 'B']);
    expect(edited.album).toBe('Live Album');
    expect(service.getState().entries.find(entry => entry.id === entryId)?.title).toBe('新标题');

    const cleared = await service.editEntry(entryId, { album: null });
    expect(cleared.album).toBeNull();
  });

  it('removeEntry 只从库中移除单条,重扫后按设计重新出现', async () => {
    const service = await createService();
    const state = await seedLibrary(service);
    const target = state.entries[0] as LibraryEntry;

    const afterRemove = await service.removeEntry(target.id);
    expect(afterRemove.entries).toHaveLength(state.entries.length - 1);
    await expectLibraryError(service.removeEntry(target.id), 404, 'LOCAL_LIBRARY_ERROR');

    // 磁盘文件仍在:重扫会把该文件重新扫入库中(手工移除只是临时隐藏)
    await service.rescanRoot(state.roots[0]?.id ?? '');
    await service.whenIdle();
    expect(service.getState().entries.some(entry => entry.id === target.id)).toBe(true);
  });

  it('removeRoot 删除目录与其全部条目,未知 id 返回 404', async () => {
    const service = await createService();
    const state = await seedLibrary(service);
    expect(state.entries.length).toBeGreaterThan(0);

    const afterRemove = await service.removeRoot(state.roots[0]?.id ?? '');
    expect(afterRemove.roots).toHaveLength(0);
    expect(afterRemove.entries).toHaveLength(0);
    await expectLibraryError(service.removeRoot('no-such-root'), 404, 'LOCAL_LIBRARY_ERROR');
  });

  it('rescanRoot 整体替换条目(手工修改会被磁盘标签覆盖)', async () => {
    const service = await createService();
    const state = await seedLibrary(service);
    const rootId = state.roots[0]?.id ?? '';
    const tagged = state.entries.find(entry => entry.title === 'Sunny Day') as LibraryEntry;

    await service.editEntry(tagged.id, { title: '手工标题' });
    await service.rescanRoot(rootId);
    await service.whenIdle();

    const rescanned = service.getState();
    expect(findEntryByTitle(rescanned, 'Sunny Day')).toBeDefined();
    expect(rescanned.entries.some(entry => entry.title === '手工标题')).toBe(false);
    await expectLibraryError(service.rescanRoot('no-such-root'), 404, 'LOCAL_LIBRARY_ERROR');
  });

  it('达到可注入的条目上限时停止扫描并标记截断', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      writeGarbage(musicDir, `Track ${String(index).padStart(3, '0')}.mp3`);
    }

    const limited = await createLocalLibraryService({
      dataFile: dataFileOf('limited.json'),
      maxEntries: 50,
    });
    await seedLibrary(limited, musicDir);
    const limitedState = limited.getState();
    expect(limitedState.entries).toHaveLength(50);
    expect(limitedState.truncated).toBe(true);
    expect(limitedState.scan.active).toBe(false);

    // 默认上限(50000)下 200 个文件不会被截断
    const normal = await createLocalLibraryService({ dataFile: dataFileOf('normal.json') });
    await seedLibrary(normal, musicDir);
    const normalState = normal.getState();
    expect(normalState.entries).toHaveLength(200);
    expect(normalState.truncated).toBe(false);
  });

  it('持久化后重载会自动对已有 root 重扫,手工修改在重扫前可见', async () => {
    const dataFile = dataFileOf('reload.json');
    const serviceA = await createLocalLibraryService({ dataFile });
    const stateA = await seedLibrary(serviceA);
    const tagged = stateA.entries.find(entry => entry.title === 'Sunny Day') as LibraryEntry;
    await serviceA.editEntry(tagged.id, { title: '手工标题' });

    const persisted = JSON.parse(readFileSync(dataFile, 'utf8')) as {
      roots: unknown[];
      entries: Array<{ title: string }>;
      updatedAt: string;
    };
    expect(persisted.roots).toHaveLength(1);
    expect(persisted.entries).toHaveLength(3);
    expect(typeof persisted.updatedAt).toBe('string');

    // 用受控解析器挂起重扫,验证重载先读到磁盘上的手工修改
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const serviceB = await createLocalLibraryService({
      dataFile,
      parseAudio: async (filePath, options) => {
        await gate;
        return parseFile(filePath, options);
      },
    });
    const loadedState = serviceB.getState();
    expect(loadedState.roots).toHaveLength(1);
    expect(loadedState.entries).toHaveLength(3);
    expect(loadedState.entries.some(entry => entry.title === '手工标题')).toBe(true);

    release();
    await serviceB.whenIdle();
    const rescannedState = serviceB.getState();
    expect(findEntryByTitle(rescannedState, 'Sunny Day')).toBeDefined();
    expect(rescannedState.entries.some(entry => entry.title === '手工标题')).toBe(false);
    expect(rescannedState.roots[0]?.fileCount).toBe(3);
    expect(rescannedState.scan.active).toBe(false);
  });

  it('同一 root 同时只允许一个扫描,scan 状态随扫描切换', async () => {
    const dataFile = dataFileOf('scan-state.json');
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const service = await createLocalLibraryService({
      dataFile,
      parseAudio: async (filePath, options) => {
        await gate;
        return parseFile(filePath, options);
      },
    });
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    writeTaggedMp3(musicDir, 'a.mp3', { title: 'A', artist: 'X', album: 'Y' });
    writeTaggedFlac(musicDir, 'b.flac', { title: 'B', artist: 'X', album: null });

    const state = await service.addRoot(musicDir);
    expect(state.scan.active).toBe(true);
    expect(state.scan.scannedFiles).toBe(0);

    const rootId = state.roots[0]?.id ?? '';
    await expectLibraryError(service.rescanRoot(rootId), 409, 'LOCAL_LIBRARY_ERROR');

    release();
    await service.whenIdle();
    const idleState = service.getState();
    expect(idleState.scan.active).toBe(false);
    expect(idleState.scan.scannedFiles).toBe(2);
    expect(idleState.roots[0]?.fileCount).toBe(2);
  });

  it('filterDuplicates:精确命中与艺术家交集命中', async () => {
    const service = await createService();
    await seedLibrary(service);
    const result = service.filterDuplicates(makePlaylist([
      track(0, 'Sunny Day', ['Jay Chou']),
      track(1, 'Sunny Day', ['Jay Chou', 'Guest']),
    ]));
    expect(result.excluded).toBe(2);
    expect(result.playlist.tracks).toHaveLength(0);
    expect(result.playlist.warnings).toContain('已按本地音乐库排除 2 首重复曲目');
  });

  it('filterDuplicates:标题大小写与连续空白差异、artist 大小写差异仍命中', async () => {
    const service = await createService();
    await seedLibrary(service);
    const result = service.filterDuplicates(makePlaylist([
      track(0, '  NIGHT   dance ', ['DJ TEST']),
    ]));
    expect(result.excluded).toBe(1);
    expect(result.playlist.tracks).toHaveLength(0);
  });

  it('filterDuplicates:库中"多歌手整串"标签与歌单拆分后的 artists 现在能命中剔除', async () => {
    const musicDir = musicDirOf();
    mkdirSync(musicDir, { recursive: true });
    // 库中文件标签是单个整串("Aqu3ra;早見沙織"),歌单曲目的 artists 是拆开的数组(网易云/QQ 形态)
    writeTaggedFlac(musicDir, 'duet.flac', { title: 'Duet', artist: 'Aqu3ra;早見沙織', album: null });

    const service = await createService();
    await seedLibrary(service, musicDir);
    const result = service.filterDuplicates(makePlaylist([
      track(0, 'Duet', ['Aqu3ra', '早見沙織']),
    ]));
    expect(result.excluded).toBe(1);
    expect(result.playlist.tracks).toHaveLength(0);
  });

  it('filterDuplicates:标题相同但艺术家不相交时不剔除', async () => {
    const service = await createService();
    await seedLibrary(service);
    const result = service.filterDuplicates(makePlaylist([
      track(0, 'Sunny Day', ['Someone Else']),
    ]));
    expect(result.excluded).toBe(0);
    expect(result.playlist.tracks).toHaveLength(1);
    expect(result.playlist.warnings).toHaveLength(0);
  });

  it('filterDuplicates:歌单曲目无艺术家时仅在库中条目也无艺术家时保守命中', async () => {
    const service = await createService();
    await seedLibrary(service);
    const result = service.filterDuplicates(makePlaylist([
      track(0, 'Fallback Tune', []), // 库中条目同样没有艺术家 → 命中
      track(1, 'Sunny Day', []), // 库中条目有艺术家 → 保守保留
    ]));
    expect(result.excluded).toBe(1);
    expect(result.playlist.tracks.map(t => t.title)).toEqual(['Sunny Day']);
  });

  it('filterDuplicates:多首剔除后重排 position、保留 complete/warnings 并追加中文提示', async () => {
    const service = await createService();
    await seedLibrary(service);
    const source = makePlaylist([
      track(0, 'Sunny Day', ['Jay Chou']), // 命中(精确)
      track(1, 'Mystery', ['Whoever']), // 保留
      track(2, 'night dance', ['DJ TEST']), // 命中(大小写/空白差异)
      track(3, 'Only You', ['Yazoo']), // 保留
    ], ['源警告']);
    source.total = 4;

    const result = service.filterDuplicates(source);
    expect(result.excluded).toBe(2);
    expect(result.playlist.complete).toBe(true);
    expect(result.playlist.warnings).toEqual(['源警告', '已按本地音乐库排除 2 首重复曲目']);
    expect(result.playlist.tracks.map(t => [t.position, t.title])).toEqual([
      [0, 'Mystery'],
      [1, 'Only You'],
    ]);
    // 保持 playlist schema 不变式:complete 时 total === tracks.length
    expect(result.playlist.total).toBe(2);
    // 原歌单对象不被修改
    expect(source.tracks).toHaveLength(4);
    expect(source.warnings).toEqual(['源警告']);
  });
});

// ---------------------------------------------------------------------------
// browse 目录浏览(服务层):UI 点击式选择已授权文件夹
// ---------------------------------------------------------------------------

describe('browse 目录浏览(服务层)', () => {
  it('browseRoots:默认探测 /vol1../vol9,测试环境不存在这些卷时返回空数组', async () => {
    const service = await createService();
    expect(await service.browseRoots()).toEqual([]);
  });

  it('browseRoots:注入候选根列表,仅保留存在且为目录且可读的项,按名称排序', async () => {
    const rootsDir = join(workspace, 'roots');
    const volumeLatin = join(rootsDir, 'aaa');
    const volumeChinese = join(rootsDir, '音乐');
    mkdirSync(volumeLatin, { recursive: true });
    mkdirSync(volumeChinese, { recursive: true });
    const filePath = join(rootsDir, 'plain.txt');
    writeFileSync(filePath, 'a file, not a dir');

    const service = await createService({
      browseRootsProbe: [volumeLatin, join(rootsDir, 'missing'), filePath, volumeChinese],
    });
    // 名称排序(zh-Hans-CN):汉字按拼音在前,拉丁字母随后
    expect(await service.browseRoots()).toEqual([volumeChinese, volumeLatin]);
  });

  it('browseDir:仅列出可读的直接子目录,过滤普通文件、隐藏目录与不可读目录', async () => {
    const root = join(workspace, 'lib-root');
    mkdirSync(join(root, 'A'), { recursive: true });
    mkdirSync(join(root, 'B'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    mkdirSync(join(root, 'locked'), { recursive: true });
    writeFileSync(join(root, 'plain.txt'), 'a file');
    // Windows 上 chmod 000 不生效,用注入的 access 探测 mock 模拟不可读
    const service = await createService({
      probePathAccess: async candidate => {
        if (basename(candidate) === 'locked') {
          throw new Error('EACCES: 模拟无权限');
        }
      },
    });

    const result = await service.browseDir(root);
    expect(result.path).toBe(root);
    expect(result.parent).toBe(dirname(root));
    expect(result.dirs.map(entry => entry.name)).toEqual(['A', 'B']);
    expect(result.dirs.map(entry => entry.path)).toEqual([join(root, 'A'), join(root, 'B')]);
  });

  it('browseDir:chmod 000 的子目录同样被过滤(仅 POSIX 非 root)', async ({ skip }) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      skip(); // Windows 上 chmod 000 不生效;root 用户无视权限位。过滤逻辑已由注入 mock 用例覆盖
      return;
    }
    const root = join(workspace, 'posix-root');
    mkdirSync(join(root, 'A'), { recursive: true });
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const service = await createService();
      const result = await service.browseDir(root);
      expect(result.dirs.map(entry => entry.name)).toEqual(['A']);
    } finally {
      chmodSync(locked, 0o755); // 恢复权限,保证 afterEach 清理成功
    }
  });

  it('browseDir:单个子目录 stat 异常时跳过该项,浏览整体不失败(坏符号链接,仅 POSIX)', async ({ skip }) => {
    if (process.platform === 'win32') {
      skip(); // Windows 普通权限无法创建符号链接
      return;
    }
    const root = join(workspace, 'dangling-root');
    mkdirSync(join(root, 'A'), { recursive: true });
    symlinkSync(join(root, 'gone'), join(root, 'dangling'));
    const service = await createService();
    const result = await service.browseDir(root);
    expect(result.dirs.map(entry => entry.name)).toEqual(['A']);
  });

  it('browseDir:文件系统根路径的 parent 为 null', async () => {
    const service = await createService();
    const result = await service.browseDir('/');
    expect(result.parent).toBeNull();
    expect(Array.isArray(result.dirs)).toBe(true);
    expect(result.dirs.every(entry => entry.name !== '' && entry.path !== '')).toBe(true);
  });

  it('browseDir:不存在与非目录返回 400 "路径无效或无法访问",相对路径返回 400 "必须为绝对路径"', async () => {
    const service = await createService();
    await expectLibraryError(
      service.browseDir(join(workspace, 'missing-dir')),
      400,
      'INVALID_REQUEST',
      '路径无效或无法访问',
    );
    const filePath = join(workspace, 'plain-file.txt');
    writeFileSync(filePath, 'a file, not a dir');
    await expectLibraryError(service.browseDir(filePath), 400, 'INVALID_REQUEST', '路径无效或无法访问');
    await expectLibraryError(service.browseDir('music'), 400, 'INVALID_REQUEST', '音乐库路径必须为绝对路径');
  });

  it('browseDir:中文目录名正常列出并按 zh-Hans-CN 拼音顺序排序', async () => {
    const root = join(workspace, '中文根目录');
    mkdirSync(join(root, '张三'), { recursive: true });
    mkdirSync(join(root, '李四'), { recursive: true });
    mkdirSync(join(root, '王五'), { recursive: true });
    mkdirSync(join(root, 'Beyond'), { recursive: true });
    const service = await createService();
    const result = await service.browseDir(root);
    // zh-Hans-CN 拼音序:汉字在前(李 li < 王 wang < 张 zhang),拉丁字母 Beyond 随后
    expect(result.dirs.map(entry => entry.name)).toEqual(['李四', '王五', '张三', 'Beyond']);
    expect(result.dirs.map(entry => entry.path)).toEqual([
      join(root, '李四'),
      join(root, '王五'),
      join(root, '张三'),
      join(root, 'Beyond'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 子路由(挂到测试 Hono 实例,无认证)
// ---------------------------------------------------------------------------

describe('local library router', () => {
  it('GET /api/local-library 返回库状态', async () => {
    const service = await createService();
    await seedLibrary(service);
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));

    const response = await app.request('/api/local-library');
    expect(response.status).toBe(200);
    const body = await response.json() as LibraryState;
    expect(Object.keys(body).sort()).toEqual(['entries', 'roots', 'scan', 'truncated']);
    expect(body.roots).toHaveLength(1);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.scan).toEqual({ active: false, scannedFiles: expect.any(Number) });
  });

  it('PUT /api/local-library/roots 新增目录,非法请求返回 400 与中文错误', async () => {
    const service = await createService();
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));
    const musicDir = seedMusicDir();

    const badJson = await app.request('/api/local-library/roots', {
      method: 'PUT',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ code: 'INVALID_REQUEST' });

    const missingPath = await app.request('/api/local-library/roots', {
      method: 'PUT',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(missingPath.status).toBe(400);
    expect(await missingPath.json()).toMatchObject({ code: 'INVALID_REQUEST' });

    const ok = await app.request('/api/local-library/roots', {
      method: 'PUT',
      body: JSON.stringify({ path: musicDir }),
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.status).toBe(200);
    const state = await ok.json() as LibraryState;
    expect(state.roots).toHaveLength(1);

    const duplicate = await app.request('/api/local-library/roots', {
      method: 'PUT',
      body: JSON.stringify({ path: musicDir }),
      headers: { 'content-type': 'application/json' },
    });
    expect(duplicate.status).toBe(400);
    const duplicateBody = await duplicate.json() as { code: string; message: string };
    expect(duplicateBody.code).toBe('INVALID_REQUEST');
    expect(duplicateBody.message).toContain('重复');
    await service.whenIdle();
  });

  it('DELETE/POST roots 路由:未知 id 404,成功后返回最新状态', async () => {
    const service = await createService();
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));
    const musicDir = seedMusicDir();

    const unknownRescan = await app.request('/api/local-library/roots/no-such-id/rescan', { method: 'POST' });
    expect(unknownRescan.status).toBe(404);
    expect(await unknownRescan.json()).toMatchObject({ code: 'LOCAL_LIBRARY_ERROR' });

    const unknownDelete = await app.request('/api/local-library/roots/no-such-id', { method: 'DELETE' });
    expect(unknownDelete.status).toBe(404);

    const added = await app.request('/api/local-library/roots', {
      method: 'PUT',
      body: JSON.stringify({ path: musicDir }),
      headers: { 'content-type': 'application/json' },
    });
    const rootId = ((await added.json()) as LibraryState).roots[0]?.id ?? '';
    await service.whenIdle(); // 等 PUT 触发的首次扫描结束,避免 rescan 撞上 409

    const rescan = await app.request(`/api/local-library/roots/${rootId}/rescan`, { method: 'POST' });
    expect(rescan.status).toBe(200);
    await service.whenIdle();
    // 重扫在后台进行,完成后再查询状态才能看到 fileCount
    const afterRescan = await app.request('/api/local-library');
    expect(((await afterRescan.json()) as LibraryState).roots[0]?.fileCount).toBe(3);

    const removed = await app.request(`/api/local-library/roots/${rootId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    const afterRemove = await removed.json() as LibraryState;
    expect(afterRemove.roots).toHaveLength(0);
    expect(afterRemove.entries).toHaveLength(0);
  });

  it('PATCH/DELETE entries 路由:校验失败 400,成功返回更新结果', async () => {
    const service = await createService();
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));
    const state = await seedLibrary(service);
    const entryId = (state.entries.find(entry => entry.title === 'Sunny Day') as LibraryEntry).id;

    const emptyPatch = await app.request(`/api/local-library/entries/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(emptyPatch.status).toBe(400);
    expect(await emptyPatch.json()).toMatchObject({ code: 'INVALID_REQUEST' });

    const invalidJson = await app.request(`/api/local-library/entries/${entryId}`, {
      method: 'PATCH',
      body: 'oops',
      headers: { 'content-type': 'application/json' },
    });
    expect(invalidJson.status).toBe(400);

    const patched = await app.request(`/api/local-library/entries/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '路由改标题', artists: ['A', 'B'] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: entryId, title: '路由改标题', artists: ['A', 'B'] });

    const unknownEntry = await app.request('/api/local-library/entries/no-such-entry', { method: 'DELETE' });
    expect(unknownEntry.status).toBe(404);

    const deleted = await app.request(`/api/local-library/entries/${entryId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as LibraryState).entries.some(entry => entry.id === entryId)).toBe(false);
    await service.whenIdle();
  });
});

// ---------------------------------------------------------------------------
// 子路由 GET /browse(目录浏览端点,契约冻结版)
// ---------------------------------------------------------------------------

describe('local library router GET /browse', () => {
  it('不带 path(或空 path)返回探测到的 browseRoots,且浏览不改变库状态', async () => {
    const volume = join(workspace, 'vol1');
    mkdirSync(volume, { recursive: true });
    const service = await createService({ browseRootsProbe: [volume] });
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));

    const response = await app.request('/api/local-library/browse');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ browseRoots: [volume] });

    const emptyPath = await app.request('/api/local-library/browse?path=');
    expect(emptyPath.status).toBe(200);
    expect(await emptyPath.json()).toEqual({ browseRoots: [volume] });

    // 浏览是纯只读操作,不会把路径加入 roots
    expect(service.getState().roots).toEqual([]);
  });

  it('?path=<绝对路径> 返回 path/parent/dirs,dirs 仅含可读子目录', async () => {
    const root = join(workspace, 'router-browse');
    mkdirSync(join(root, '甲'), { recursive: true });
    mkdirSync(join(root, '乙'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), 'a file');
    const service = await createService();
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));

    const response = await app.request(`/api/local-library/browse?path=${encodeURIComponent(root)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as BrowseDirResult;
    expect(body.path).toBe(root);
    expect(body.parent).toBe(dirname(root));
    // 拼音序:甲(jia) < 乙(yi);普通文件与隐藏目录不出现
    expect(body.dirs).toEqual([
      { name: '甲', path: join(root, '甲') },
      { name: '乙', path: join(root, '乙') },
    ]);
  });

  it('?path=/ 文件系统根路径 parent 为 null', async () => {
    const service = await createService();
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));

    const response = await app.request('/api/local-library/browse?path=%2F');
    expect(response.status).toBe(200);
    expect(((await response.json()) as BrowseDirResult).parent).toBeNull();
  });

  it('?path= 相对路径与无效路径返回 400 中文错误', async () => {
    const service = await createService();
    const app = new Hono();
    app.route('/api/local-library', createLocalLibraryRouter(service));

    const relative = await app.request('/api/local-library/browse?path=music');
    expect(relative.status).toBe(400);
    expect(await relative.json()).toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('必须为绝对路径'),
    });

    const missing = await app.request(
      `/api/local-library/browse?path=${encodeURIComponent(join(workspace, 'no-such-dir'))}`,
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: 'INVALID_REQUEST', message: '路径无效或无法访问' });
  });
});
