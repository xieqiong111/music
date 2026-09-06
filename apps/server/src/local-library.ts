import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseFile } from 'music-metadata';
import type { IAudioMetadata } from 'music-metadata';
import { Hono } from 'hono';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { Playlist, Track } from '@playlist-exporter/contracts';

/**
 * NAS 本地音乐库服务。
 *
 * 职责:扫描 NAS 上的音乐目录、读取音频元数据、支持手工修正/移除、
 * 将库状态持久化到 /data 卷中的 JSON 文件,并在导出时用于剔除本地已有的重复曲目。
 * 认证由外层 app 统一处理,这里只提供领域服务与子路由。
 */

export interface LibraryRoot {
  id: string;
  /** 已解析的绝对路径 */
  path: string;
  addedAt: string;
  lastScanAt?: string;
  fileCount?: number;
}

export interface LibraryEntry {
  id: string;
  rootId: string;
  /** 已解析的绝对路径 */
  path: string;
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number | null;
  mtimeMs: number;
}

export interface LibraryScanStatus {
  active: boolean;
  scannedFiles: number;
}

/** 浏览结果中的一个子目录 */
export interface BrowseEntry {
  name: string;
  /** 子目录绝对路径(可直接作为下一次 browse 的 path 参数) */
  path: string;
}

export interface BrowseDirResult {
  /** 规范化后的绝对路径 */
  path: string;
  /** 父目录绝对路径;path 已是文件系统根(如 '/')时为 null */
  parent: string | null;
  /** 直接子目录中"是目录且可读"的条目,按名称(zh-Hans-CN)排序;
   *  普通文件、点开头隐藏目录与不可读目录一律不出现(即"只展示已授权文件夹") */
  dirs: BrowseEntry[];
}

export interface LibraryState {
  roots: LibraryRoot[];
  entries: LibraryEntry[];
  scan: LibraryScanStatus;
  /** 任一 root 扫描时因达到条目上限被截断时为 true */
  truncated: boolean;
}

export interface EntryPatch {
  title?: string;
  artists?: string[];
  album?: string | null;
}

export type ParseAudioFile = (filePath: string, options: { duration: boolean }) => Promise<IAudioMetadata>;

/** 目录可访问性探测:可访问时 resolve,不可访问时 reject;默认 fs.access(path, R_OK|X_OK) */
export type ProbePathAccess = (absolutePath: string) => Promise<void>;

export interface LocalLibraryServiceOptions {
  /** 持久化文件路径(部署时位于 /data 卷) */
  readonly dataFile: string;
  /** 库内总条目上限,达到后停止扫描并标记截断;默认 50000 */
  readonly maxEntries?: number;
  /** 音频元数据解析函数;默认为 music-metadata 的 parseFile(测试可注入) */
  readonly parseAudio?: ParseAudioFile;
  /** 浏览根候选列表;默认探测 fnOS 卷约定路径 /vol1../vol9(测试可注入) */
  readonly browseRootsProbe?: readonly string[];
  /** 目录可访问性探测函数;默认 fs.access(path, R_OK|X_OK)(测试可注入以模拟不可读子目录) */
  readonly probePathAccess?: ProbePathAccess;
}

export interface LocalLibraryService {
  getState(): LibraryState;
  /** 校验并新增目录,成功后立即开始后台扫描并持久化;失败抛 LocalLibraryError */
  addRoot(path: string): Promise<LibraryState>;
  removeRoot(id: string): Promise<LibraryState>;
  /** 重新扫描该 root(整体替换其 entries);该 root 正在扫描时抛 409 */
  rescanRoot(id: string): Promise<LibraryState>;
  /** 手工修正单条元数据(会覆盖自动读取的字段;下次重扫会被磁盘标签覆盖) */
  editEntry(id: string, patch: EntryPatch): Promise<LibraryEntry>;
  /** 从库中移除单条。注意:这只是"从库中隐藏",磁盘文件不会被删除,
   *  下次重扫(rescanRoot / 服务启动自动重扫)会把该文件重新扫入库中。 */
  removeEntry(id: string): Promise<LibraryState>;
  /** 按匹配规则从歌单中剔除本地已有的重复曲目 */
  filterDuplicates(playlist: Playlist): { playlist: Playlist; excluded: number };
  /** 探测可用的浏览根目录(存在、是目录且可读),按名称排序;一个都没有时返回空数组 */
  browseRoots(): Promise<string[]>;
  /** 浏览目录:返回可直接进入的可读子目录列表;纯只读操作,不会把路径加入 roots */
  browseDir(path: string): Promise<BrowseDirResult>;
  /** 等待所有后台扫描结束(用于测试与优雅停机) */
  whenIdle(): Promise<void>;
}

export class LocalLibraryError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: 'INVALID_REQUEST' | 'LOCAL_LIBRARY_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'LocalLibraryError';
  }
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac']);
const DEFAULT_MAX_ENTRIES = 50_000;
const SHORT_ID_LENGTH = 16;
const EDITABLE_FIELDS = new Set(['title', 'artists', 'album']);

/** fnOS 卷约定路径的探测上限:/vol1../vol9 */
const BROWSE_VOL_MAX = 9;
const DEFAULT_BROWSE_ROOTS: readonly string[] =
  Array.from({ length: BROWSE_VOL_MAX }, (_, index) => `/vol${index + 1}`);
/** 判定目录"可进入"的访问位:可读 + 可执行(进入目录需要 X 位) */
const BROWSE_ACCESS_MODE = fsConstants.R_OK | fsConstants.X_OK;

interface PersistedLibrary {
  roots: LibraryRoot[];
  entries: LibraryEntry[];
  updatedAt: string;
}

const normalizeText = (value: string): string => value.trim().toLowerCase().replace(/\s+/gu, ' ');

const shortPathId = (absolutePath: string): string =>
  createHash('sha256').update(absolutePath).digest('hex').slice(0, SHORT_ID_LENGTH);

/** Windows 路径大小写不敏感,比较时折叠大小写 */
const pathCompareKey = (absolutePath: string): string =>
  process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;

const stripAudioExtension = (absolutePath: string): string =>
  basename(absolutePath, extname(absolutePath));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reviveRoot = (value: unknown): LibraryRoot | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || typeof value.path !== 'string' || typeof value.addedAt !== 'string') {
    return undefined;
  }
  return {
    id: value.id,
    path: value.path,
    addedAt: value.addedAt,
    ...(typeof value.lastScanAt === 'string' ? { lastScanAt: value.lastScanAt } : {}),
    ...(typeof value.fileCount === 'number' && Number.isFinite(value.fileCount)
      ? { fileCount: value.fileCount }
      : {}),
  };
};

const reviveEntry = (value: unknown): LibraryEntry | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || typeof value.rootId !== 'string' ||
      typeof value.path !== 'string' || typeof value.title !== 'string') {
    return undefined;
  }
  return {
    id: value.id,
    rootId: value.rootId,
    path: value.path,
    title: value.title,
    artists: Array.isArray(value.artists) ? value.artists.filter((a): a is string => typeof a === 'string') : [],
    album: typeof value.album === 'string' ? value.album : null,
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? value.durationMs : null,
    mtimeMs: typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs) ? value.mtimeMs : 0,
  };
};

interface CollectedFiles {
  files: string[];
  truncated: boolean;
}

/**
 * 递归收集音频文件:跳过隐藏文件/目录(以 . 开头)与符号链接(符号链接既避免
 * 循环也避免重复计入挂载点),只保留扩展名白名单内的常规文件。
 * 收集数量达到 limit 时立即停止并把 truncated 置为 true。
 */
const collectAudioFiles = async (rootPath: string, limit: number): Promise<CollectedFiles> => {
  const files: string[] = [];
  let truncated = false;
  if (limit <= 0) {
    return { files, truncated: true };
  }
  const walk = async (directory: string): Promise<void> => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // 无权限或已被删除的子目录:跳过,不让整次扫描失败
    }
    for (const dirent of dirents) {
      if (truncated) return;
      if (dirent.name.startsWith('.')) continue; // 隐藏文件/目录
      if (dirent.isSymbolicLink()) continue; // 符号链接(含循环)
      const fullPath = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!AUDIO_EXTENSIONS.has(extname(dirent.name).toLowerCase())) continue;
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      files.push(fullPath);
    }
  };
  await walk(rootPath);
  return { files, truncated };
};

class LocalLibraryServiceImpl implements LocalLibraryService {
  private readonly dataFile: string;
  private readonly maxEntries: number;
  private readonly parseAudio: ParseAudioFile;
  private readonly browseRootsProbe: readonly string[];
  private readonly probePathAccess: ProbePathAccess;
  private roots: LibraryRoot[] = [];
  private entries: LibraryEntry[] = [];
  private readonly truncatedRootIds = new Set<string>();
  private scanStatus: LibraryScanStatus = { active: false, scannedFiles: 0 };
  private readonly activeScans = new Map<string, Promise<void>>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: LocalLibraryServiceOptions) {
    this.dataFile = options.dataFile;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.parseAudio = options.parseAudio ?? (async (filePath, parseOptions) =>
      parseFile(filePath, { duration: parseOptions.duration }));
    this.browseRootsProbe = options.browseRootsProbe ?? DEFAULT_BROWSE_ROOTS;
    this.probePathAccess = options.probePathAccess ?? (candidate => access(candidate, BROWSE_ACCESS_MODE));
  }

  getState(): LibraryState {
    return {
      roots: this.roots.map(root => ({ ...root })),
      entries: this.entries.map(entry => ({ ...entry, artists: [...entry.artists] })),
      scan: { ...this.scanStatus },
      truncated: this.truncatedRootIds.size > 0,
    };
  }

  async addRoot(path: string): Promise<LibraryState> {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '音乐库路径不能为空');
    }
    if (!isAbsolute(path)) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '音乐库路径必须为绝对路径');
    }
    const absolutePath = resolve(path);
    let stats;
    try {
      stats = await stat(absolutePath);
    } catch {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '目录不存在或无法访问');
    }
    if (!stats.isDirectory()) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '路径不是目录');
    }
    const key = pathCompareKey(absolutePath);
    for (const root of this.roots) {
      const existing = pathCompareKey(root.path);
      if (existing === key || existing.startsWith(`${key}${sep}`) || key.startsWith(`${existing}${sep}`)) {
        throw new LocalLibraryError(400, 'INVALID_REQUEST', '该目录与其他音乐库目录重复或存在嵌套重叠');
      }
    }
    const root: LibraryRoot = {
      id: shortPathId(absolutePath),
      path: absolutePath,
      addedAt: new Date().toISOString(),
    };
    this.roots.push(root);
    await this.persist();
    this.startScan(root); // 立即开始后台扫描,完成后再持久化一次
    return this.getState();
  }

  async removeRoot(id: string): Promise<LibraryState> {
    const index = this.roots.findIndex(root => root.id === id);
    if (index === -1) {
      throw new LocalLibraryError(404, 'LOCAL_LIBRARY_ERROR', '未找到该音乐库目录');
    }
    this.roots.splice(index, 1);
    this.entries = this.entries.filter(entry => entry.rootId !== id);
    this.truncatedRootIds.delete(id);
    await this.persist();
    return this.getState();
  }

  async rescanRoot(id: string): Promise<LibraryState> {
    const root = this.roots.find(candidate => candidate.id === id);
    if (root === undefined) {
      throw new LocalLibraryError(404, 'LOCAL_LIBRARY_ERROR', '未找到该音乐库目录');
    }
    if (this.activeScans.has(id)) {
      throw new LocalLibraryError(409, 'LOCAL_LIBRARY_ERROR', '该目录正在扫描中，请稍后再试');
    }
    this.startScan(root);
    return this.getState();
  }

  async editEntry(id: string, patch: EntryPatch): Promise<LibraryEntry> {
    if (!isRecord(patch)) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '请求内容必须为 JSON 对象');
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '至少需要提供一个要修改的字段');
    }
    const unsupported = keys.find(key => !EDITABLE_FIELDS.has(key));
    if (unsupported !== undefined) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', `不支持修改字段: ${unsupported}`);
    }
    const entry = this.entries.find(candidate => candidate.id === id);
    if (entry === undefined) {
      throw new LocalLibraryError(404, 'LOCAL_LIBRARY_ERROR', '未找到该歌曲条目');
    }
    const { title, artists, album } = patch as {
      title?: unknown;
      artists?: unknown;
      album?: unknown;
    };
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw new LocalLibraryError(400, 'INVALID_REQUEST', '歌曲标题不能为空');
      }
      entry.title = title.trim();
    }
    if (artists !== undefined) {
      if (!Array.isArray(artists) || artists.some(artist => typeof artist !== 'string')) {
        throw new LocalLibraryError(400, 'INVALID_REQUEST', '艺术家必须是字符串数组');
      }
      entry.artists = (artists as string[]).map(artist => artist.trim()).filter(artist => artist !== '');
    }
    if (album !== undefined) {
      if (album !== null && typeof album !== 'string') {
        throw new LocalLibraryError(400, 'INVALID_REQUEST', '专辑必须是字符串或 null');
      }
      const normalizedAlbum = typeof album === 'string' ? album.trim() : '';
      entry.album = normalizedAlbum === '' ? null : normalizedAlbum;
    }
    await this.persist();
    return { ...entry, artists: [...entry.artists] };
  }

  async removeEntry(id: string): Promise<LibraryState> {
    const index = this.entries.findIndex(entry => entry.id === id);
    if (index === -1) {
      throw new LocalLibraryError(404, 'LOCAL_LIBRARY_ERROR', '未找到该歌曲条目');
    }
    this.entries.splice(index, 1);
    await this.persist();
    return this.getState();
    // 注意:磁盘文件并未删除,下次重扫(手动 rescanRoot 或服务启动自动重扫)会把它重新扫入。
  }

  async browseRoots(): Promise<string[]> {
    const available: string[] = [];
    for (const candidate of this.browseRootsProbe) {
      if (await this.isReadableDir(candidate)) {
        available.push(candidate);
      }
    }
    return available.sort((a, b) => basename(a).localeCompare(basename(b), 'zh-Hans-CN'));
  }

  async browseDir(rawPath: string): Promise<BrowseDirResult> {
    if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '音乐库路径必须为绝对路径');
    }
    const absolutePath = resolve(rawPath);
    if (!(await this.isReadableDir(absolutePath))) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '路径无效或无法访问');
    }
    let dirents;
    try {
      dirents = await readdir(absolutePath, { withFileTypes: true });
    } catch {
      // isReadableDir 已确认可读;此分支仅为兜底,不让浏览 500
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '路径无效或无法访问');
    }
    const dirs: BrowseEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue; // 点开头隐藏目录
      const childPath = join(absolutePath, dirent.name);
      try {
        const childStats = await stat(childPath);
        if (!childStats.isDirectory()) continue; // 普通文件不出现在浏览结果中
        await this.probePathAccess(childPath);
      } catch {
        continue; // 单个子目录已被删除/无权限等:跳过该项,不让整个浏览失败
      }
      dirs.push({ name: dirent.name, path: childPath });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const parent = dirname(absolutePath);
    return {
      path: absolutePath,
      parent: parent === absolutePath ? null : parent,
      dirs,
    };
  }

  /** 判定路径存在、是目录且可访问(R_OK|X_OK);任何一步异常都视为不可用 */
  private async isReadableDir(candidate: string): Promise<boolean> {
    try {
      const stats = await stat(candidate);
      if (!stats.isDirectory()) return false;
      await this.probePathAccess(candidate);
      return true;
    } catch {
      return false;
    }
  }

  filterDuplicates(playlist: Playlist): { playlist: Playlist; excluded: number } {
    const libraryIndex = new Map<string, Array<{ artistKeys: Set<string>; hasArtists: boolean }>>();
    for (const entry of this.entries) {
      const titleKey = normalizeText(entry.title);
      if (titleKey === '') continue;
      const artistKeys = new Set(
        entry.artists.map(normalizeText).filter(artistKey => artistKey !== ''),
      );
      const bucket = libraryIndex.get(titleKey) ?? [];
      bucket.push({ artistKeys, hasArtists: artistKeys.size > 0 });
      libraryIndex.set(titleKey, bucket);
    }

    const kept: Track[] = [];
    let excluded = 0;
    for (const track of playlist.tracks) {
      const titleKey = normalizeText(track.title);
      const trackArtistKeys = new Set(
        track.artists.map(normalizeText).filter(artistKey => artistKey !== ''),
      );
      const candidates = titleKey === '' ? [] : libraryIndex.get(titleKey) ?? [];
      const isDuplicate = candidates.some(candidate => {
        // 歌单曲目没有艺术家信息时,只有库中条目同样没有艺术家才保守判定为重复,避免误杀
        if (trackArtistKeys.size === 0) return !candidate.hasArtists;
        return [...trackArtistKeys].some(artistKey => candidate.artistKeys.has(artistKey));
      });
      if (isDuplicate) {
        excluded += 1;
      } else {
        kept.push(track);
      }
    }

    const tracks = kept.map((track, position) => ({ ...track, position }));
    const warnings = excluded > 0
      ? [...playlist.warnings, `已按本地音乐库排除 ${excluded} 首重复曲目`]
      : [...playlist.warnings];
    // total 重算为剔除后的曲目数,保持 schema 不变式(complete 时 total === tracks.length)
    return {
      playlist: { ...playlist, total: tracks.length, tracks, warnings },
      excluded,
    };
  }

  async whenIdle(): Promise<void> {
    while (this.activeScans.size > 0) {
      await Promise.all([...this.activeScans.values()]);
    }
  }

  /** 服务启动加载持久化状态后,对每个已有 root 做一次后台重扫 */
  startStartupRescans(): void {
    for (const root of this.roots) {
      this.startScan(root);
    }
  }

  async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.dataFile, 'utf8');
    } catch {
      return; // 数据文件不存在:以空库启动
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[local-library] 数据文件损坏，已忽略: ${this.dataFile}`);
      return;
    }
    if (!isRecord(parsed)) return;
    if (Array.isArray(parsed.roots)) {
      this.roots = parsed.roots
        .map(reviveRoot)
        .filter((root): root is LibraryRoot => root !== undefined);
    }
    if (Array.isArray(parsed.entries)) {
      this.entries = parsed.entries
        .map(reviveEntry)
        .filter((entry): entry is LibraryEntry => entry !== undefined);
    }
  }

  private startScan(root: LibraryRoot): Promise<void> {
    const existing = this.activeScans.get(root.id);
    if (existing !== undefined) return existing;
    const wasIdle = this.activeScans.size === 0;
    const scanPromise = this.runScan(root).finally(() => {
      this.activeScans.delete(root.id);
      if (this.activeScans.size === 0) {
        this.scanStatus = { active: false, scannedFiles: this.scanStatus.scannedFiles };
      }
    });
    this.activeScans.set(root.id, scanPromise);
    // 后台扫描无等待方时吞掉拒绝,避免未处理的 Promise 拒绝;whenIdle 仍会拿到原始结果
    void scanPromise.catch(() => undefined);
    if (wasIdle) {
      this.scanStatus = { active: true, scannedFiles: 0 };
    }
    return scanPromise;
  }

  private async runScan(root: LibraryRoot): Promise<void> {
    const otherEntryCount = this.entries.filter(entry => entry.rootId !== root.id).length;
    const limit = Math.max(0, this.maxEntries - otherEntryCount);
    const { files, truncated } = await collectAudioFiles(root.path, limit);
    if (truncated) {
      this.truncatedRootIds.add(root.id);
    } else {
      this.truncatedRootIds.delete(root.id);
    }
    const scanned: LibraryEntry[] = [];
    for (const filePath of files) {
      const entry = await this.readEntry(filePath, root.id);
      if (entry !== undefined) scanned.push(entry);
      this.scanStatus.scannedFiles += 1;
    }
    // 扫描期间 root 可能已被删除:此时直接丢弃结果
    if (!this.roots.some(candidate => candidate.id === root.id)) {
      this.truncatedRootIds.delete(root.id);
      return;
    }
    this.entries = [
      ...this.entries.filter(entry => entry.rootId !== root.id),
      ...scanned,
    ];
    root.lastScanAt = new Date().toISOString();
    root.fileCount = scanned.length;
    await this.persist();
  }

  private async readEntry(filePath: string, rootId: string): Promise<LibraryEntry | undefined> {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      return undefined; // 文件在扫描期间被删除
    }
    let title: string | null = null;
    let artists: string[] | null = null;
    let album: string | null = null;
    let durationMs: number | null = null;
    try {
      const metadata = await this.parseAudio(filePath, { duration: true });
      const common = metadata.common;
      if (typeof common.title === 'string' && common.title.trim() !== '') {
        title = common.title;
      }
      const parsedArtists = (Array.isArray(common.artists) ? common.artists
        : typeof common.artist === 'string' ? [common.artist] : [])
        .filter((artist): artist is string => typeof artist === 'string' && artist.trim() !== '');
      if (parsedArtists.length > 0) {
        artists = parsedArtists;
      }
      if (typeof common.album === 'string' && common.album.trim() !== '') {
        album = common.album;
      }
      const seconds = metadata.format.duration;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
        durationMs = Math.round(seconds * 1000);
      }
    } catch {
      // 解析失败:不丢文件,回退到文件名等兜底字段
    }
    const absolutePath = resolve(filePath);
    return {
      id: shortPathId(absolutePath),
      rootId,
      path: absolutePath,
      title: title ?? stripAudioExtension(absolutePath),
      artists: artists ?? [],
      album,
      durationMs,
      mtimeMs,
    };
  }

  private persist(): Promise<void> {
    const next = this.persistChain.then(
      () => this.persistNow(),
      () => this.persistNow(),
    );
    this.persistChain = next.catch(() => undefined); // 保证链不因单次失败而断掉
    return next;
  }

  /** JSON 原子写:先写临时文件再 rename,避免进程被杀后留下半截数据 */
  private async persistNow(): Promise<void> {
    const payload = JSON.stringify({
      roots: this.roots,
      entries: this.entries,
      updatedAt: new Date().toISOString(),
    } satisfies PersistedLibrary, null, 2);
    await mkdir(dirname(this.dataFile), { recursive: true });
    const tmpPath = `${this.dataFile}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, this.dataFile);
  }
}

export const createLocalLibraryService = async (
  options: LocalLibraryServiceOptions,
): Promise<LocalLibraryService> => {
  if (typeof options.dataFile !== 'string' || options.dataFile.trim() === '') {
    throw new LocalLibraryError(400, 'INVALID_REQUEST', 'dataFile 必须为非空路径');
  }
  const service = new LocalLibraryServiceImpl(options);
  await service.loadFromDisk();
  service.startStartupRescans();
  return service;
};

const addRootBodySchema = z.object({ path: z.string() }).strict();

/**
 * 本地音乐库子路由(不做鉴权,认证由外层 app 的 /api/* 中间件统一处理):
 *   GET    /api/local-library              → LibraryState
 *   PUT    /api/local-library/roots        {path} → 200 新状态 / 400
 *   DELETE /api/local-library/roots/:id    → 200 新状态 / 404
 *   POST   /api/local-library/roots/:id/rescan → 200 新状态 / 404 / 409
 *   PATCH  /api/local-library/entries/:id  patch → 200 更新后的条目 / 400 / 404
 *   DELETE /api/local-library/entries/:id  → 200 新状态 / 404
 *   GET    /api/local-library/browse       不带 path → {browseRoots}(探测 /vol1../vol9)
 *                                          ?path=<绝对路径> → {path, parent, dirs}(仅可读子目录)
 * 所有错误响应均为 {code, message}(中文),code ∈ INVALID_REQUEST | LOCAL_LIBRARY_ERROR。
 */
export const createLocalLibraryRouter = <E extends Env = Env>(service: LocalLibraryService): Hono<E> => {
  const router = new Hono<E>();

  const readJsonBody = async (context: Context<E>): Promise<unknown> => {
    try {
      return await context.req.json();
    } catch {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '请求 JSON 格式无效');
    }
  };

  router.get('/', context => context.json(service.getState()));

  router.get('/browse', async context => {
    const requestedPath = context.req.query('path');
    if (requestedPath === undefined || requestedPath.trim() === '') {
      // 不带 path:返回探测到的浏览根目录(如 fnOS 的 /vol1../vol9);一个都没有时为空数组
      return context.json({ browseRoots: await service.browseRoots() });
    }
    // 带 path:浏览该目录(纯只读,不会把路径加入 roots)
    return context.json(await service.browseDir(requestedPath));
  });

  router.put('/roots', async context => {
    const body = await readJsonBody(context);
    const parsed = addRootBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '请求内容无效，需要提供 path 字段');
    }
    return context.json(await service.addRoot(parsed.data.path));
  });

  router.delete('/roots/:id', async context => {
    return context.json(await service.removeRoot(context.req.param('id')));
  });

  router.post('/roots/:id/rescan', async context => {
    return context.json(await service.rescanRoot(context.req.param('id')));
  });

  router.patch('/entries/:id', async context => {
    const body = await readJsonBody(context);
    if (!isRecord(body)) {
      throw new LocalLibraryError(400, 'INVALID_REQUEST', '请求内容必须为 JSON 对象');
    }
    return context.json(await service.editEntry(context.req.param('id'), body as EntryPatch));
  });

  router.delete('/entries/:id', async context => {
    return context.json(await service.removeEntry(context.req.param('id')));
  });

  router.onError((error, context) => {
    if (error instanceof LocalLibraryError) {
      return context.json({ code: error.code, message: error.message }, error.status);
    }
    return context.json({ code: 'LOCAL_LIBRARY_ERROR', message: '本地音乐库操作失败' }, 500);
  });

  return router;
};
