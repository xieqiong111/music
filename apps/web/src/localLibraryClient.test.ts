// @vitest-environment jsdom
// 本机音乐库客户端核心逻辑测试:指纹、歌手拆分、IndexedDB 持久化(内存实现)、
// 编辑保留、20000 上限、扫描回退与目录遍历规则。
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CLIENT_LIBRARY_ENTRIES,
  canPickDirectories,
  createClientLibrary,
  createIndexedDbStorage,
  createMemoryStorage,
  normalizeText,
  splitArtists,
  trackKeyOf,
  type ClientLibraryEntry,
  type DirectoryLikeHandle,
  type ParsedTags,
} from './localLibraryClient.js';

const fileOf = (name: string, size = 12): File => new File(['0'.repeat(size)], name);

/** 构造测试用目录句柄(children 为文件句柄或子目录句柄)。 */
const dirHandle = (
  name: string,
  children: ReadonlyArray<DirectoryLikeHandle>,
): DirectoryLikeHandle => ({
  kind: 'directory',
  name,
  async *entries() {
    for (const child of children) yield [child.name, child] as const;
  },
});

const fileHandle = (name: string, size = 12): DirectoryLikeHandle => {
  const file = fileOf(name, size);
  return {
    kind: 'file',
    name,
    getFile: async () => file,
  };
};

const tags = (parsed: Partial<ParsedTags>): ParsedTags => parsed;

/** 遍历整棵目录树,返回所有(路径, 句柄)对,供批量构造大目录使用。 */
const flatAudioHandles = (count: number): ReadonlyArray<DirectoryLikeHandle> =>
  Array.from({ length: count }, (_unused, index) => fileHandle(`song ${index}.mp3`));

describe('normalizeText / trackKeyOf(指纹格式)', () => {
  it('folds case and whitespace when computing the track key', () => {
    expect(normalizeText('  Night   SKY ')).toBe('night sky');
  });

  it('builds t|title|sorted-artist-keys exactly per the frozen contract', () => {
    expect(trackKeyOf({ title: '  夜空   最亮 ', artists: ['B', 'a '] })).toBe('t|夜空 最亮|a;b');
  });

  it('sorts artists and folds case/spaces inside each artist', () => {
    expect(trackKeyOf({ title: 'X', artists: ['Zed', 'alpha ONE'] })).toBe('t|x|alpha one;zed');
  });

  it('keeps an empty artist section when there are no artists', () => {
    expect(trackKeyOf({ title: ' Intro ', artists: [] })).toBe('t|intro|');
  });
});

describe('splitArtists(与服务端 splitArtistStrings 规则一致)', () => {
  it('splits on ; ; / 、 , , & ＆ feat. ft.', () => {
    expect(splitArtists(['A;B/ C 、D,E，F&G feat. H ft. I'])).toEqual([
      'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I',
    ]);
  });

  it('splits every element of the array and dedupes case-insensitively', () => {
    expect(splitArtists(['abc;XYZ', 'xyz ', 'Abc'])).toEqual(['abc', 'XYZ']);
  });

  it('does not split words that merely contain ft. after a letter', () => {
    expect(splitArtists(['left. right'])).toEqual(['left. right']);
  });

  it('drops empty segments', () => {
    expect(splitArtists([' ; A ; '])).toEqual(['A']);
  });
});

describe('canPickDirectories', () => {
  it('is false when showDirectoryPicker is unavailable', () => {
    // jsdom 没有 showDirectoryPicker
    expect(canPickDirectories()).toBe(false);
  });

  it('is true when showDirectoryPicker exists', () => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: vi.fn(), configurable: true });
    try {
      expect(canPickDirectories()).toBe(true);
    } finally {
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
  });
});

describe('createClientLibrary(内存存储)', () => {
  const parseAll = (parsed: ParsedTags) => async (): Promise<ParsedTags> => parsed;

  it('scans a picked directory into entries with tags, id and display path', async () => {
    const picker = vi.fn(async () => dirHandle('Music', [
      dirHandle('album', [
        fileHandle('夜空.flac', 100),
      ]),
      fileHandle('Intro.mp3'),
      fileHandle('cover.jpg'), // 非音频扩展名,跳过
    ]));
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: picker,
      parseTags: parseAll(tags({ title: '夜空中最亮的星', artists: ['逃跑计划'], album: '世界', durationMs: 253000 })),
    });

    const result = await client.pickAndScanDirectory();
    expect(picker).toHaveBeenCalledWith({ mode: 'read' });
    expect(result.truncated).toBe(false);
    expect(result.entries.map(entry => entry.path).sort()).toEqual([
      'Music/Intro.mp3',
      'Music/album/夜空.flac',
    ]);

    const song = result.entries.find(entry => entry.title === '夜空中最亮的星');
    expect(song).toMatchObject({
      rootId: expect.any(String),
      name: '夜空.flac',
      artists: ['逃跑计划'],
      album: '世界',
      durationMs: 253000,
      size: 100,
    });
    expect(song?.id).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('skips hidden entries and directories beyond the depth cap', async () => {
    // 17 层嵌套目录:最内层深度 17 > 16,其内容被跳过
    let tooDeep: DirectoryLikeHandle = fileHandle('too-deep.mp3');
    for (let level = 0; level < 17; level += 1) {
      tooDeep = dirHandle(`d${level}`, [tooDeep]);
    }
    const picker = vi.fn(async () => dirHandle('Music', [
      fileHandle('.hidden.mp3'),
      dirHandle('.git', [fileHandle('leaked.mp3')]),
      tooDeep,
      fileHandle('shallow.wav'),
    ]));
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: picker,
      parseTags: async () => ({}),
    });

    const result = await client.pickAndScanDirectory();
    expect(result.entries.map(entry => entry.name)).toEqual(['shallow.wav']);
  });

  it('falls back to the file name without extension when tag parsing fails', async () => {
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: vi.fn(async () => dirHandle('M', [fileHandle('回退 曲名.mp3')])),
      parseTags: async () => {
        throw new Error('unsupported container');
      },
    });

    const result = await client.pickAndScanDirectory();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      title: '回退 曲名',
      artists: [],
      album: null,
      durationMs: null,
    });
  });

  it('reports scan progress while walking files', async () => {
    const onProgress = vi.fn();
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: vi.fn(async () => dirHandle('M', [
        fileHandle('a.mp3'), fileHandle('b.mp3'), fileHandle('c.mp3'),
      ])),
      parseTags: async () => ({}),
    });

    await client.pickAndScanDirectory(onProgress);
    // 至少报告每个文件一次,最后一次必须达到文件总数
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ scannedFiles: 3 }));
  });

  it('persists entries and roots across reloads (new client instance, same storage)', async () => {
    const storage = createMemoryStorage();
    const picker = vi.fn(async () => dirHandle('Music', [fileHandle('one.mp3'), fileHandle('two.mp3')]));
    const first = createClientLibrary({
      storage,
      directoryPicker: picker,
      parseTags: parseAll(tags({ title: 'one', artists: ['x'], album: null })),
    });
    await first.pickAndScanDirectory();

    const second = createClientLibrary({ storage, parseTags: parseAll({}) });
    const snapshot = await second.snapshot();
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots[0]?.name).toBe('Music');
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.every(entry => entry.title === 'one')).toBe(true);
  });

  it('keeps manual edits when rescanning the stored root', async () => {
    const storage = createMemoryStorage();
    const picker = vi.fn(async () => dirHandle('Music', [fileHandle('one.flac'), fileHandle('two.flac')]));
    const client = createClientLibrary({
      storage,
      directoryPicker: picker,
      parseTags: parseAll(tags({ title: '原始标题', artists: ['原始歌手'], album: '原始专辑' })),
    });
    const scanned = await client.pickAndScanDirectory();
    const target = scanned.entries[0] as ClientLibraryEntry;

    const edited = await client.editEntry(target.id, {
      title: '手工标题',
      artists: ['歌手甲', '歌手乙'],
      album: '手工专辑',
    });
    expect(edited).toMatchObject({ title: '手工标题', artists: ['歌手甲', '歌手乙'], album: '手工专辑' });

    // 重扫:文件仍在、标签未变 → 手工编辑保留
    const rescanned = await client.rescanStoredRoots();
    expect(rescanned.entries).toHaveLength(2);
    expect(rescanned.entries.find(entry => entry.id === target.id)).toMatchObject({
      title: '手工标题',
      artists: ['歌手甲', '歌手乙'],
      album: '手工专辑',
    });
    expect(rescanned.entries.find(entry => entry.id !== target.id)?.title).toBe('原始标题');

    // 部分字段编辑:只覆盖给出的字段
    await client.editEntry(target.id, { album: null });
    const partial = await (await client.snapshot()).entries;
    expect(partial.find(entry => entry.id === target.id)).toMatchObject({
      title: '手工标题',
      album: null,
    });
  });

  it('removes entries and persists the removal', async () => {
    const storage = createMemoryStorage();
    const client = createClientLibrary({
      storage,
      directoryPicker: vi.fn(async () => dirHandle('M', [fileHandle('a.mp3'), fileHandle('b.mp3')])),
      parseTags: async () => ({}),
    });
    const scanned = await client.pickAndScanDirectory();
    const target = scanned.entries[0] as ClientLibraryEntry;

    const after = await client.removeEntry(target.id);
    expect(after.entries.map(entry => entry.id)).not.toContain(target.id);
    expect(await (await createClientLibrary({ storage }).snapshot()).entries).toHaveLength(1);
  });

  it('caps the library at 20000 entries and reports truncation', async () => {
    const picker = vi.fn(async () => dirHandle('Big', flatAudioHandles(MAX_CLIENT_LIBRARY_ENTRIES + 5)));
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: picker,
      parseTags: async () => ({}),
    });

    const result = await client.pickAndScanDirectory();
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(MAX_CLIENT_LIBRARY_ENTRIES);
    expect((await client.snapshot()).entries).toHaveLength(MAX_CLIENT_LIBRARY_ENTRIES);
  });

  it('computes export fingerprints for every entry (trackKeys)', async () => {
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: vi.fn(async () => dirHandle('M', [fileHandle('s1.mp3'), fileHandle('s2.mp3')])),
      parseTags: async (_file: File, name: string) =>
        name === 's1.mp3'
          ? tags({ title: 'Song One', artists: ['A;B'] })
          : tags({ title: '  平静  ', artists: [] }),
    });
    await client.pickAndScanDirectory();

    const { keys, total } = await client.trackKeys();
    expect(total).toBe(2);
    expect(keys).toContain('t|song one|a;b');
    expect(keys).toContain('t|平静|');
    expect(keys.every(key => key.startsWith('t|'))).toBe(true);
  });

  it('reports skipped roots when stored permissions were denied during rescan', async () => {
    const storage = createMemoryStorage();
    const picker = vi.fn(async () => dirHandle('Locked', [fileHandle('a.mp3')]));
    const client = createClientLibrary({
      storage,
      directoryPicker: picker,
      parseTags: async () => ({}),
    });
    await client.pickAndScanDirectory();

    // 模拟重开页面后权限回到 prompt:queryPermission 返回 prompt 且拒绝请求
    const lockedRoot = (await storage.loadRoots())[0];
    expect(lockedRoot).toBeDefined();
    const handle = lockedRoot?.handle as DirectoryLikeHandle & {
      queryPermission: () => Promise<string>;
    };
    handle.queryPermission = async () => 'prompt';
    handle.requestPermission = async () => 'denied';

    const result = await client.rescanStoredRoots();
    expect(result.skippedRoots).toEqual(['Locked']);
    // 已有条目不受影响
    expect((await client.snapshot()).entries).toHaveLength(1);
  });

  it('does not duplicate entries when the same directory is picked twice', async () => {
    const root = dirHandle('Music', [fileHandle('a.mp3')]);
    const client = createClientLibrary({
      storage: createMemoryStorage(),
      directoryPicker: vi.fn(async () => root),
      parseTags: async () => ({}),
    });
    await client.pickAndScanDirectory();
    await client.pickAndScanDirectory();
    expect((await client.snapshot()).entries).toHaveLength(1);
    expect((await client.snapshot()).roots).toHaveLength(1);
  });
});

describe('createIndexedDbStorage(假 IndexedDB)', () => {
  it('round-trips roots, entries and edits through a real-shaped IDB adapter', async () => {
    const storage = createIndexedDbStorage(fakeIndexedDbFactory());
    await storage.putRoot({ id: 'root-1', name: 'Music', addedAt: '2026-09-12T00:00:00.000Z', handle: {} });
    await storage.replaceEntries([
      {
        id: 'e1', rootId: 'root-1', path: 'Music/a.mp3', name: 'a.mp3',
        title: 'A', artists: ['X'], album: null, durationMs: null, size: 1,
      },
    ]);
    await storage.putEdit({ id: 'e1', title: '改' });

    expect(await storage.loadRoots()).toHaveLength(1);
    expect((await storage.loadEntries())[0]?.title).toBe('A');
    expect(await storage.loadEdits()).toEqual([{ id: 'e1', title: '改' }]);

    await storage.deleteRoot('root-1');
    await storage.deleteEdit('e1');
    expect(await storage.loadRoots()).toHaveLength(0);
    expect(await storage.loadEdits()).toHaveLength(0);
  });

  it('falls back to the memory storage when indexedDB is unavailable', () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    try {
      expect(createIndexedDbStorage()).not.toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true });
    }
  });
});

/**
 * 最小 IndexedDB 工厂:只实现本适配器用到的 open/transaction/objectStore/
 * get/getAll/put/delete/clear 面,内存 Map 存储。
 */
const fakeIndexedDbFactory = (): IDBFactory => {
  type Row = Record<string, unknown>;
  const databases = new Map<string, FakeDb>();

  class FakeRequest<T> {
    result?: T;
    error: unknown = null;
    onsuccess: ((event?: unknown) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onupgradeneeded: ((event?: unknown) => void) | null = null;
  }

  class FakeObjectStore {
    constructor(
      private readonly rows: Map<string, Row>,
      private readonly keyPath: string,
    ) {}
    private keyOf(row: Row): string {
      return String(row[this.keyPath]);
    }
    get(key: IDBValidKey): FakeRequest<Row | undefined> {
      const request = new FakeRequest<Row | undefined>();
      queueMicrotask(() => {
        request.result = this.rows.get(String(key));
        request.onsuccess?.();
      });
      return request;
    }
    getAll(): FakeRequest<Row[]> {
      const request = new FakeRequest<Row[]>();
      queueMicrotask(() => {
        request.result = [...this.rows.values()];
        request.onsuccess?.();
      });
      return request;
    }
    put(row: Row): FakeRequest<string> {
      const request = new FakeRequest<string>();
      queueMicrotask(() => {
        this.rows.set(this.keyOf(row), row);
        request.result = this.keyOf(row);
        request.onsuccess?.();
      });
      return request;
    }
    delete(key: IDBValidKey): FakeRequest<undefined> {
      const request = new FakeRequest<undefined>();
      queueMicrotask(() => {
        this.rows.delete(String(key));
        request.result = undefined;
        request.onsuccess?.();
      });
      return request;
    }
    clear(): FakeRequest<undefined> {
      const request = new FakeRequest<undefined>();
      queueMicrotask(() => {
        this.rows.clear();
        request.result = undefined;
        request.onsuccess?.();
      });
      return request;
    }
  }

  class FakeTransaction {
    oncomplete: ((event?: unknown) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    onabort: ((event?: unknown) => void) | null = null;
    constructor(
      private readonly stores: Map<string, Map<string, Row>>,
      private readonly storeNames: ReadonlyArray<string>,
    ) {
      // 操作在微任务中完成,事务用宏任务收尾,保证先写数据再触发 complete。
      setTimeout(() => this.oncomplete?.(), 0);
    }
    objectStore(name: string): FakeObjectStore {
      const rows = this.stores.get(name);
      if (rows === undefined || !this.storeNames.includes(name)) {
        throw new Error(`no object store: ${name}`);
      }
      return new FakeObjectStore(rows, 'id');
    }
  }

  class FakeDb {
    readonly stores = new Map<string, Map<string, Row>>();
    onversionchange: ((event?: unknown) => void) | null = null;
    get objectStoreNames(): { contains(name: string): boolean } {
      return { contains: name => this.stores.has(name) };
    }
    close(): void {}
    createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
      const rows = new Map<string, Row>();
      this.stores.set(name, rows);
      return new FakeObjectStore(rows, options.keyPath);
    }
    transaction(
      names: string | ReadonlyArray<string>,
      _mode?: IDBTransactionMode,
    ): FakeTransaction {
      return new FakeTransaction(this.stores, typeof names === 'string' ? [names] : [...names]);
    }
  }

  return {
    open(name: string, _version?: number): FakeRequest<FakeDb> {
      const request = new FakeRequest<FakeDb>();
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = db === undefined;
        if (db === undefined) {
          db = new FakeDb();
          databases.set(name, db);
        }
        // 与真实 IDB 一致:升级回调里 request.result 已经可用
        request.result = db;
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
};
