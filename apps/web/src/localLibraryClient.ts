/**
 * 本机音乐库客户端(桌面壳/浏览器,零服务端参与)。
 *
 * - 通过 window.showDirectoryPicker 选择本机文件夹(File System Access API);
 * - 递归扫描音频扩展名,用 music-metadata 的 parseBlob 读取标签(浏览器安全入口);
 * - 条目/目录句柄/手工编辑持久化到 IndexedDB(库内建三个 store,无第三方依赖);
 * - 指纹与服务端一致:'t|' + normalize(title) + '|' + artists.map(normalize).sort().join(';')。
 */

/** 目录句柄里允许入库的音频扩展名(与服务端扫描范围一致)。 */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac',
]);

/** 扫描深度上限:跳过超深嵌套目录,避免符号链接环/病态目录树。 */
const MAX_SCAN_DEPTH = 16;

/** 本机音乐库条目上限(超出停止收录并提示)。 */
export const MAX_CLIENT_LIBRARY_ENTRIES = 20000;

/** 契约限制:excludeTrackKeys 最多 5000 项。 */
export const EXCLUDE_TRACK_KEYS_LIMIT = 5000;

/** 文本归一化:trim + toLowerCase + 空白折叠(与服务端 normalizeText 一致)。 */
export const normalizeText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/gu, ' ');

/**
 * 字符串形态歌手名的分隔符:英文/全角分号、斜杠、顿号、英文/全角逗号、
 * & 与全角＆、feat./ft.(大小写不敏感,允许前后空格)。与 apps/server 的
 * ARTIST_SEPARATOR_PATTERN 保持一致,包括"已知取舍":艺人名中的 & 也会被拆分。
 */
const ARTIST_SEPARATOR_PATTERN =
  /\s*(?:;|；|\/|、|,|，|&|＆|(?<![\p{L}\p{N}])feat\.|(?<![\p{L}\p{N}])ft\.)\s*/giu;

/** 把字符串形态的多歌手标签拆成歌手数组:逐段 trim、去空、大小写不敏感去重。 */
export const splitArtists = (artists: readonly string[]): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const artist of artists) {
    for (const part of artist.split(ARTIST_SEPARATOR_PATTERN)) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
};

export interface TrackKeyInput {
  readonly title: string;
  readonly artists: readonly string[];
}

/** 导出排除指纹:'t|' + normalize(title) + '|' + [...artists].map(normalize).sort().join(';')。 */
export const trackKeyOf = (input: TrackKeyInput): string => {
  const titleKey = normalizeText(input.title);
  const artistKeys = input.artists.map(normalizeText).filter(key => key !== '').sort();
  return `t|${titleKey}|${artistKeys.join(';')}`;
};

export interface ClientLibraryEntry {
  readonly id: string;
  readonly rootId: string;
  /** 相对根目录的展示路径,如 "Music/album/song.mp3"。 */
  readonly path: string;
  readonly name: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string | null;
  readonly durationMs: number | null;
  readonly size: number;
}

export interface ClientLibraryEdit {
  readonly title?: string;
  readonly artists?: readonly string[];
  readonly album?: string | null;
}

/** 存入 IndexedDB 的目录句柄记录(handle 可被结构化克隆持久化)。 */
export interface StoredClientRoot {
  readonly id: string;
  readonly name: string;
  readonly addedAt: string;
  readonly handle: unknown;
}

export interface ClientLibraryRootInfo {
  readonly id: string;
  readonly name: string;
  readonly addedAt: string;
}

export interface ClientLibrarySnapshot {
  readonly roots: ReadonlyArray<ClientLibraryRootInfo>;
  readonly entries: readonly ClientLibraryEntry[];
}

export interface StoredEdit extends ClientLibraryEdit {
  readonly id: string;
}

/** 持久化端口:默认由 IndexedDB 适配器实现,测试可注入内存实现。 */
export interface ClientLibraryStorage {
  loadRoots(): Promise<readonly StoredClientRoot[]>;
  putRoot(root: StoredClientRoot): Promise<void>;
  deleteRoot(id: string): Promise<void>;
  loadEntries(): Promise<readonly ClientLibraryEntry[]>;
  replaceEntries(entries: readonly ClientLibraryEntry[]): Promise<void>;
  loadEdits(): Promise<readonly StoredEdit[]>;
  putEdit(edit: StoredEdit): Promise<void>;
  deleteEdit(id: string): Promise<void>;
}

export interface ScanProgress {
  readonly scannedFiles: number;
  readonly matched: number;
}

export interface ScanResult extends ClientLibrarySnapshot {
  /** 本次扫描达到条目上限,超出部分未收录。 */
  readonly truncated: boolean;
  /** 重扫时因权限被拒而跳过的已保存目录名。 */
  readonly skippedRoots: readonly string[];
}

export interface TrackKeysResult {
  readonly keys: readonly string[];
  readonly total: number;
}

/** 用户取消选择文件夹(showDirectoryPicker 的 AbortError)。 */
export class DirectoryPickCancelled extends Error {
  constructor() {
    super('用户取消了文件夹选择');
    this.name = 'DirectoryPickCancelled';
  }
}

/** File System Access API 的最小结构类型(避免依赖 DOM lib 的版本差异)。 */
export interface DirectoryLikeHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  entries?(): AsyncIterableIterator<[string, DirectoryLikeHandle]>;
  getFile?(): Promise<File>;
  queryPermission?(descriptor?: { readonly mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { readonly mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: unknown): Promise<boolean>;
}

export type DirectoryPicker = (options?: { readonly mode?: 'read' | 'readwrite' }) => Promise<unknown>;

/** music-metadata 解析结果的裁剪视图(便于测试注入)。 */
export interface ParsedTags {
  readonly title?: string;
  readonly artists?: readonly string[];
  readonly album?: string | null;
  readonly durationMs?: number | null;
}

export type TagParser = (file: File, name: string) => Promise<ParsedTags>;

export const canPickDirectories = (): boolean =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const isDirectoryHandle = (value: unknown): value is DirectoryLikeHandle =>
  typeof value === 'object' && value !== null &&
  (value as DirectoryLikeHandle).kind === 'directory' &&
  typeof (value as DirectoryLikeHandle).name === 'string';

/** 默认目录选择器:window.showDirectoryPicker({ mode: 'read' })。 */
const defaultDirectoryPicker: DirectoryPicker = async options => {
  if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
    throw new Error('当前浏览器不支持选择文件夹');
  }
  const picker = (window as unknown as {
    showDirectoryPicker?: DirectoryPicker;
  }).showDirectoryPicker;
  if (typeof picker !== 'function') throw new Error('当前浏览器不支持选择文件夹');
  return picker({ mode: 'read', ...options });
};

/** 默认标签解析器:music-metadata parseBlob(动态 import,浏览器走 core 入口)。 */
const defaultTagParser: TagParser = async (file, _name) => {
  const { parseBlob } = await import('music-metadata');
  const metadata = await parseBlob(file, { duration: true });
  const common = metadata.common;
  const rawArtists = common.artists ?? (common.artist === undefined ? [] : [common.artist]);
  const duration = metadata.format.duration;
  return {
    ...(common.title === undefined ? {} : { title: common.title }),
    artists: splitArtists(rawArtists),
    ...(common.album === undefined ? {} : { album: common.album }),
    ...(duration === undefined || duration === null ||
      !Number.isFinite(duration) || duration <= 0
      ? {}
      : { durationMs: Math.round(duration * 1000) }),
  };
};

/** 64 位指纹(FNV-1a + 第二混合),供路径生成稳定 id,避免依赖 crypto.subtle。 */
const hashHex = (value: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x27d4eb2f;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
};

const stripExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

const toComparableKey = (value: string): string =>
  value.trim().toLowerCase();

// ---------------------------------------------------------------------------
// 内存存储(IDB 不可用时的回退,也供测试使用)
// ---------------------------------------------------------------------------

export const createMemoryStorage = (): ClientLibraryStorage => {
  const roots = new Map<string, StoredClientRoot>();
  const entries = new Map<string, ClientLibraryEntry>();
  const edits = new Map<string, StoredEdit>();
  return {
    async loadRoots() { return [...roots.values()]; },
    async putRoot(root) { roots.set(root.id, root); },
    async deleteRoot(id) { roots.delete(id); },
    async loadEntries() { return [...entries.values()]; },
    async replaceEntries(next) {
      entries.clear();
      for (const entry of next) entries.set(entry.id, entry);
    },
    async loadEdits() { return [...edits.values()]; },
    async putEdit(edit) { edits.set(edit.id, edit); },
    async deleteEdit(id) { edits.delete(id); },
  };
};

// ---------------------------------------------------------------------------
// IndexedDB 适配器(裸 indexedDB API,无新依赖)
// ---------------------------------------------------------------------------

const DB_NAME = 'playlist-exporter-local-library';
const DB_VERSION = 1;
const STORE_ROOTS = 'handles';
const STORE_ENTRIES = 'entries';
const STORE_EDITS = 'edits';

const requestAsPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

export const createIndexedDbStorage = (
  factory: IDBFactory = globalThis.indexedDB,
): ClientLibraryStorage => {
  // indexedDB 不可用(老浏览器/测试环境)时回退内存存储:功能可用但刷新不保留。
  if (factory === undefined || factory === null) return createMemoryStorage();

  let dbPromise: Promise<IDBDatabase> | undefined;
  const openDb = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_ROOTS)) {
          db.createObjectStore(STORE_ROOTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
          db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_EDITS)) {
          db.createObjectStore(STORE_EDITS, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return dbPromise;
  };

  const withStore = async <T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> => {
    const db = await openDb();
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = await run(store);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    return result;
  };

  return {
    async loadRoots() {
      return withStore(STORE_ROOTS, 'readonly', async store =>
        (await requestAsPromise(store.getAll() as IDBRequest<unknown[]>)) as StoredClientRoot[]);
    },
    async putRoot(root) {
      await withStore(STORE_ROOTS, 'readwrite', store => requestAsPromise(store.put(root)).then(() => undefined));
    },
    async deleteRoot(id) {
      await withStore(STORE_ROOTS, 'readwrite', store => requestAsPromise(store.delete(id)).then(() => undefined));
    },
    async loadEntries() {
      return withStore(STORE_ENTRIES, 'readonly', async store =>
        (await requestAsPromise(store.getAll() as IDBRequest<unknown[]>)) as ClientLibraryEntry[]);
    },
    async replaceEntries(next) {
      await withStore(STORE_ENTRIES, 'readwrite', async store => {
        await requestAsPromise(store.clear());
        for (const entry of next) await requestAsPromise(store.put(entry));
      });
    },
    async loadEdits() {
      return withStore(STORE_EDITS, 'readonly', async store =>
        (await requestAsPromise(store.getAll() as IDBRequest<unknown[]>)) as StoredEdit[]);
    },
    async putEdit(edit) {
      await withStore(STORE_EDITS, 'readwrite', store => requestAsPromise(store.put(edit)).then(() => undefined));
    },
    async deleteEdit(id) {
      await withStore(STORE_EDITS, 'readwrite', store => requestAsPromise(store.delete(id)).then(() => undefined));
    },
  };
};

// ---------------------------------------------------------------------------
// 客户端门面
// ---------------------------------------------------------------------------

export interface ClientLibraryOptions {
  readonly storage?: ClientLibraryStorage;
  readonly directoryPicker?: DirectoryPicker;
  readonly parseTags?: TagParser;
  readonly maxEntries?: number;
}

export interface ClientLibrary {
  pickAndScanDirectory(onProgress?: (progress: ScanProgress) => void): Promise<ScanResult>;
  rescanStoredRoots(onProgress?: (progress: ScanProgress) => void): Promise<ScanResult>;
  snapshot(): Promise<ClientLibrarySnapshot>;
  editEntry(id: string, patch: ClientLibraryEdit): Promise<ClientLibraryEntry>;
  removeEntry(id: string): Promise<ClientLibrarySnapshot>;
  trackKeys(): Promise<TrackKeysResult>;
  hasStoredRoots(): Promise<boolean>;
}

export const createClientLibrary = (options: ClientLibraryOptions = {}): ClientLibrary => {
  const storage = options.storage ?? createIndexedDbStorage();
  const picker = options.directoryPicker ?? defaultDirectoryPicker;
  const parseTags = options.parseTags ?? defaultTagParser;
  const maxEntries = options.maxEntries ?? MAX_CLIENT_LIBRARY_ENTRIES;

  const applyEdits = (
    entries: readonly ClientLibraryEntry[],
    edits: readonly StoredEdit[],
  ): ClientLibraryEntry[] => {
    if (edits.length === 0) return [...entries];
    const editById = new Map(edits.map(edit => [edit.id, edit]));
    return entries.map(entry => {
      const edit = editById.get(entry.id);
      if (edit === undefined) return entry;
      return {
        ...entry,
        ...(edit.title === undefined ? {} : { title: edit.title }),
        ...(edit.artists === undefined ? {} : { artists: [...edit.artists] }),
        ...(edit.album === undefined ? {} : { album: edit.album }),
      };
    });
  };

  const loadSnapshot = async (): Promise<ScanResult> => {
    const [storedRoots, storedEntries, edits] = await Promise.all([
      storage.loadRoots(), storage.loadEntries(), storage.loadEdits(),
    ]);
    return {
      roots: storedRoots.map(({ id, name, addedAt }) => ({ id, name, addedAt })),
      entries: applyEdits(storedEntries, edits),
      truncated: false,
      skippedRoots: [],
    };
  };

  const ensurePermission = async (handle: DirectoryLikeHandle): Promise<boolean> => {
    if (typeof handle.queryPermission !== 'function') return true;
    const status = await handle.queryPermission({ mode: 'read' });
    if (status === 'granted') return true;
    if (typeof handle.requestPermission !== 'function') return false;
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  };

  /** 递归遍历目录:跳过点开头隐藏项与超深层级,只产出音频文件。 */
  const walk = async function* (
    handle: DirectoryLikeHandle,
    prefix: string,
    depth: number,
  ): AsyncGenerator<{ readonly file: File; readonly path: string; readonly name: string }> {
    if (depth > MAX_SCAN_DEPTH || typeof handle.entries !== 'function') return;
    for await (const [name, child] of handle.entries()) {
      if (name.startsWith('.')) continue;
      if (child.kind === 'directory') {
        yield* walk(child, `${prefix}${name}/`, depth + 1);
        continue;
      }
      const dot = name.lastIndexOf('.');
      const extension = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (!AUDIO_EXTENSIONS.has(extension)) continue;
      const file = typeof child.getFile === 'function' ? await child.getFile() : null;
      if (file === null) continue;
      yield { file, path: `${prefix}${name}`, name };
    }
  };

  const scanRoots = async (
    rootHandles: ReadonlyArray<{ id: string; name: string; handle: unknown }>,
    onProgress?: (progress: ScanProgress) => void,
    requestPermission = true,
  ): Promise<ScanResult> => {
    const [previousEntries, edits] = await Promise.all([
      storage.loadEntries(), storage.loadEdits(),
    ]);

    // 先做权限检查:被跳过(拒绝/句柄失效)的目录,其旧条目原样保留;
    // 只有真正进入扫描的目录,才会用新扫描结果替换旧条目。
    const scanning: Array<{ id: string; name: string; handle: DirectoryLikeHandle }> = [];
    const skippedRoots: string[] = [];
    for (const root of rootHandles) {
      if (!isDirectoryHandle(root.handle)) {
        skippedRoots.push(root.name);
        continue;
      }
      if (requestPermission && !(await ensurePermission(root.handle))) {
        skippedRoots.push(root.name);
        continue;
      }
      scanning.push({ id: root.id, name: root.name, handle: root.handle });
    }
    const kept = previousEntries.filter(
      entry => !scanning.some(root => root.id === entry.rootId),
    );

    const scanned: ClientLibraryEntry[] = [];
    let truncated = false;
    let scannedFiles = 0;
    let lastEmit = 0;
    const emit = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastEmit < 100) return;
      lastEmit = now;
      onProgress?.({ scannedFiles, matched: kept.length + scanned.length });
    };

    for (const root of scanning) {
      for await (const found of walk(root.handle, '', 0)) {
        scannedFiles += 1;
        if (kept.length + scanned.length >= maxEntries) {
          truncated = true;
          break;
        }
        let parsed: ParsedTags = {};
        try {
          parsed = await parseTags(found.file, found.name);
        } catch {
          // 解析失败回退文件名,不丢文件。
          parsed = {};
        }
        const artists = splitArtists(parsed.artists ?? []);
        const album = typeof parsed.album === 'string' && parsed.album.trim() === ''
          ? null
          : parsed.album ?? null;
        scanned.push({
          id: hashHex(`${root.id}/${found.path}`),
          rootId: root.id,
          path: `${root.name}/${found.path}`,
          name: found.name,
          title: (parsed.title !== undefined && parsed.title.trim() !== ''
            ? parsed.title.trim()
            : stripExtension(found.name)),
          artists,
          album,
          durationMs: typeof parsed.durationMs === 'number' &&
            Number.isFinite(parsed.durationMs) && parsed.durationMs > 0
            ? parsed.durationMs
            : null,
          size: found.file.size,
        });
        emit();
      }
      emit(true);
    }

    // 重扫按 id 匹配保留手工编辑:edits 中存在的 id,其 patch 字段覆盖标签值。
    const merged = applyEdits([...kept, ...scanned], edits);
    await storage.replaceEntries(merged);
    return {
      roots: (await storage.loadRoots()).map(({ id, name, addedAt }) => ({ id, name, addedAt })),
      entries: merged,
      truncated,
      skippedRoots,
    };
  };

  return {
    async pickAndScanDirectory(onProgress) {
      let handle: unknown;
      try {
        handle = await picker({ mode: 'read' });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') {
          throw new DirectoryPickCancelled();
        }
        throw caught;
      }
      if (!isDirectoryHandle(handle)) throw new Error('选择的结果不是文件夹');

      const existingRoots = await storage.loadRoots();
      // 同一目录重复选择时不重复入库:优先 isSameEntry,退化按目录名比较。
      let existing: StoredClientRoot | undefined;
      for (const root of existingRoots) {
        const rootHandle = root.handle;
        if (isDirectoryHandle(rootHandle) && typeof rootHandle.isSameEntry === 'function') {
          if (await rootHandle.isSameEntry(handle).catch(() => false)) {
            existing = root;
            break;
          }
          continue;
        }
        if (toComparableKey(root.name) === toComparableKey(handle.name)) {
          existing = root;
          break;
        }
      }

      const rootId = existing?.id ?? `${hashHex(handle.name)}-${hashHex(String(Date.now()) + String(Math.random())).slice(0, 6)}`;
      const root = {
        id: rootId,
        name: handle.name,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
        handle,
      };
      await storage.putRoot(root);
      return scanRoots([{ id: root.id, name: root.name, handle }], onProgress, false);
    },

    async rescanStoredRoots(onProgress) {
      const storedRoots = await storage.loadRoots();
      return scanRoots(
        storedRoots.map(({ id, name, handle }) => ({ id, name, handle })),
        onProgress,
        true,
      );
    },

    snapshot: loadSnapshot,

    async editEntry(id, patch) {
      const entries = await storage.loadEntries();
      const target = entries.find(entry => entry.id === id);
      if (target === undefined) throw new Error('条目不存在或已被删除');

      const merged: ClientLibraryEntry = {
        ...target,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.artists === undefined ? {} : { artists: [...patch.artists] }),
        ...(patch.album === undefined ? {} : { album: patch.album }),
      };
      await storage.replaceEntries(entries.map(entry => (entry.id === id ? merged : entry)));

      // PATCH 语义:只记录显式给出的字段,重扫时仅覆盖这些字段。
      const edits = await storage.loadEdits();
      const previous = edits.find(edit => edit.id === id);
      const stored: {
        id: string;
        title?: string;
        artists?: string[];
        album?: string | null;
      } = { id };
      if (patch.title !== undefined) stored.title = patch.title;
      else if (previous?.title !== undefined) stored.title = previous.title;
      if (patch.artists !== undefined) stored.artists = [...patch.artists];
      else if (previous?.artists !== undefined) stored.artists = [...previous.artists];
      if (patch.album !== undefined) stored.album = patch.album;
      else if (previous?.album !== undefined) stored.album = previous.album;
      await storage.putEdit(stored);
      return merged;
    },

    async removeEntry(id) {
      const entries = await storage.loadEntries();
      await storage.replaceEntries(entries.filter(entry => entry.id !== id));
      await storage.deleteEdit(id);
      const [roots, remaining] = await Promise.all([
        storage.loadRoots().then(roots => roots.map(({ id: rootId, name, addedAt }) => ({
          id: rootId, name, addedAt,
        }))),
        storage.loadEntries(),
      ]);
      return { roots, entries: remaining };
    },

    async trackKeys() {
      const snapshot = await loadSnapshot();
      return {
        keys: snapshot.entries.map(entry => trackKeyOf(entry)),
        total: snapshot.entries.length,
      };
    },

    async hasStoredRoots() {
      return (await storage.loadRoots()).length > 0;
    },
  };
};

let defaultClient: ClientLibrary | undefined;

/** 进程级默认实例:浏览器走 IndexedDB,IndexedDB 不可用自动回退内存存储。 */
export const getDefaultClientLibrary = (): ClientLibrary => {
  defaultClient ??= createClientLibrary();
  return defaultClient;
};
