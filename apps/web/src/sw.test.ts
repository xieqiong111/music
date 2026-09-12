// @vitest-environment node
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type FetchEvent = {
  readonly request: Request;
  readonly respondWith: (response: Promise<Response>) => void;
};
type LifecycleEvent = {
  readonly waitUntil: (promise: Promise<unknown>) => void;
};
type Listener = (event: FetchEvent | LifecycleEvent) => void;

const ORIGIN = 'https://app.example';
const CACHE_PREFIX = 'playlist-exporter-static-';
const OLD_CACHE_NAME = `${CACHE_PREFIX}v1`;

// 浏览器同源 fetch 响应的类型为 basic,SW 的写入守卫依赖该字段。
const basicResponse = (body: string) => {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
};

const loadServiceWorker = async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const cacheVersion = source.match(/const CACHE_VERSION = '([^']+)';/u)?.[1];
  if (cacheVersion === undefined) throw new Error('cache version missing');
  const currentCacheName = CACHE_PREFIX + cacheVersion;

  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    keys: vi.fn(async () => [...stores.keys()]),
    match: vi.fn(async (request: Request) => {
      for (const store of stores.values()) {
        const hit = store.get(request.url);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }),
    open: vi.fn(async (name: string) => {
      let store = stores.get(name);
      if (store === undefined) {
        store = new Map<string, Response>();
        stores.set(name, store);
      }
      const pinned = store;
      return {
        put: async (request: Request, response: Response) => {
          pinned.set(request.url, response.clone());
        },
        match: async (request: Request) => pinned.get(request.url),
      };
    }),
    delete: vi.fn(async (name: string) => {
      stores.delete(name);
    }),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const fetchMock = vi.fn(async () => basicResponse('fetched'));
  const consoleDebug = vi.fn();
  vm.runInNewContext(source, {
    self,
    URL,
    fetch: fetchMock,
    caches,
    // SW 全局作用域存在 console;沙箱需显式提供,写失败调试日志才不会抛错。
    console: { debug: consoleDebug },
  });

  const fetchListener = listeners.get('fetch');
  const installListener = listeners.get('install');
  const activateListener = listeners.get('activate');
  if (fetchListener === undefined || installListener === undefined || activateListener === undefined) {
    throw new Error('service worker listeners missing');
  }

  const seedCache = async (name: string, url: string, body: string) => {
    const cache = await caches.open(name);
    await cache.put(new Request(url), basicResponse(body));
  };
  return {
    cacheVersion,
    currentCacheName,
    stores,
    caches,
    fetchMock,
    consoleDebug,
    skipWaiting: self.skipWaiting,
    claim: self.clients.claim,
    fetchListener,
    installListener,
    activateListener,
    seedCache,
  };
};

type Harness = Awaited<ReturnType<typeof loadServiceWorker>>;

// 注入缓存写失败:让 caches.open 或其 put 抛出,模拟存储配额耗尽
// (QuotaExceededError)等真实写入异常。须在 seedCache 之后调用。
const failCacheWrites = (harness: Harness, where: 'open' | 'put'): void => {
  if (where === 'open') {
    harness.caches.open.mockImplementation(async () => {
      throw new Error('QuotaExceededError');
    });
    return;
  }
  harness.caches.open.mockImplementation(async () => ({
    put: async () => {
      throw new Error('QuotaExceededError');
    },
    match: async () => undefined,
  }));
};

const runFetchEvent = (listener: Listener, request: Request): Promise<Response> => {
  let captured: Promise<Response> | undefined;
  const until: Promise<unknown>[] = [];
  listener({
    request,
    respondWith: response => {
      captured = response;
    },
    waitUntil: promise => {
      until.push(promise);
    },
  });
  if (captured === undefined) throw new Error('respondWith missing');
  // stale-while-revalidate 的后台刷新通过 waitUntil 挂载;返回前等它完成,
  // 便于断言缓存已被刷新。透传(不 respondWith)仍同步抛错。
  return Promise.all([captured, Promise.all(until)]).then(([response]) => response);
};

const runLifecycleEvent = (listener: Listener): Promise<unknown> => {
  let captured: Promise<unknown> | undefined;
  listener({
    waitUntil: promise => {
      captured = promise;
    },
  });
  if (captured === undefined) throw new Error('waitUntil missing');
  return captured;
};

describe('service worker cache boundary', () => {
  it('never intercepts API, health, mutation, cross-origin, credentialed, or worker script requests', async () => {
    const harness = await loadServiceWorker();
    for (const request of [
      new Request(`${ORIGIN}/api/jobs/job-1`),
      new Request(`${ORIGIN}/healthz`),
      new Request(`${ORIGIN}/assets/app.js`, { method: 'POST' }),
      new Request('https://cdn.example/assets/app.js'),
      new Request(`${ORIGIN}/assets/app.js`, {
        headers: { authorization: 'Bearer synthetic-test-value' },
      }),
      new Request(`${ORIGIN}/assets/app.js`, {
        headers: { cookie: 'session=synthetic-test-value' },
      }),
      new Request(`${ORIGIN}/sw.js`),
    ]) {
      const respondWith = vi.fn();
      harness.fetchListener({ request, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it('intercepts only allowlisted same-origin static requests', async () => {
    const harness = await loadServiceWorker();
    for (const path of ['/', '/index.html', '/manifest.webmanifest', '/assets/app-abc123.js', '/icons/icon-192.png']) {
      const respondWith = vi.fn();
      harness.fetchListener({ request: new Request(`${ORIGIN}${path}`), respondWith });
      expect(respondWith).toHaveBeenCalledOnce();
    }
  });

  it('bumps the cache version away from v1 so existing clients rebuild their cache', async () => {
    const harness = await loadServiceWorker();
    expect(harness.cacheVersion).not.toBe('v1');
    expect(harness.currentCacheName).not.toBe(OLD_CACHE_NAME);
  });

  it('serves the fresh entry over the network while online and refreshes the cached copy', async () => {
    const harness = await loadServiceWorker();
    await harness.seedCache(OLD_CACHE_NAME, `${ORIGIN}/`, 'old-entry');
    harness.fetchMock.mockResolvedValue(basicResponse('new-entry'));
    const response = await runFetchEvent(harness.fetchListener, new Request(`${ORIGIN}/`));
    expect(await response.text()).toBe('new-entry');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
    const refreshed = harness.stores.get(harness.currentCacheName)?.get(`${ORIGIN}/`);
    expect(await refreshed?.text()).toBe('new-entry');
  });

  it('falls back to the cached entry when the network is unavailable', async () => {
    const harness = await loadServiceWorker();
    await harness.seedCache(OLD_CACHE_NAME, `${ORIGIN}/`, 'old-entry');
    harness.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const response = await runFetchEvent(harness.fetchListener, new Request(`${ORIGIN}/`));
    expect(await response.text()).toBe('old-entry');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates the network failure when offline and no entry is cached', async () => {
    const harness = await loadServiceWorker();
    harness.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(runFetchEvent(harness.fetchListener, new Request(`${ORIGIN}/`))).rejects.toThrow('Failed to fetch');
  });

  it('serves the network entry even when the cache write throws quota errors', async () => {
    // F2 探针场景:fetch 成功返回 NEW、cache.put 抛 QuotaExceededError、旧缓存
    // 里有 OLD。缓存写入是尽力而为,写失败不得让已成功取得的响应被旧缓存顶替。
    const harness = await loadServiceWorker();
    await harness.seedCache(OLD_CACHE_NAME, `${ORIGIN}/`, 'old-entry');
    harness.fetchMock.mockResolvedValue(basicResponse('new-entry'));
    failCacheWrites(harness, 'put');
    const response = await runFetchEvent(harness.fetchListener, new Request(`${ORIGIN}/`));
    expect(await response.text()).toBe('new-entry');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
  });

  it('still serves the network entry when no cached copy exists and the cache write throws', async () => {
    const harness = await loadServiceWorker();
    harness.fetchMock.mockResolvedValue(basicResponse('new-entry'));
    failCacheWrites(harness, 'put');
    const response = await runFetchEvent(harness.fetchListener, new Request(`${ORIGIN}/`));
    expect(await response.text()).toBe('new-entry');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
  });

  it('serves hashed assets stale-while-revalidate and refreshes the cache', async () => {
    const harness = await loadServiceWorker();
    await harness.seedCache(harness.currentCacheName, `${ORIGIN}/assets/app-abc123.js`, 'old-asset');
    harness.fetchMock.mockResolvedValue(basicResponse('new-asset'));
    const response = await runFetchEvent(
      harness.fetchListener,
      new Request(`${ORIGIN}/assets/app-abc123.js`),
    );
    // SWR:命中缓存立即返回旧值;后台以 no-store 刷新缓存(下一次重载拿到新值)
    expect(await response.text()).toBe('old-asset');
    expect(harness.fetchMock).toHaveBeenCalledWith(expect.anything(), { cache: 'no-store' });
    await new Promise(resolve => setTimeout(resolve, 300));
    const store = harness.stores.get(harness.currentCacheName);
    const updated = store?.get(`${ORIGIN}/assets/app-abc123.js`);
    expect(updated).toBeDefined();
    expect(await updated?.text()).toBe('new-asset');
  });

  it('fetches and caches hashed assets on first use', async () => {
    const harness = await loadServiceWorker();
    harness.fetchMock.mockResolvedValue(basicResponse('new-asset'));
    const response = await runFetchEvent(
      harness.fetchListener,
      new Request(`${ORIGIN}/assets/app-abc123.js`),
    );
    expect(await response.text()).toBe('new-asset');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
    const stored = harness.stores.get(harness.currentCacheName)?.get(`${ORIGIN}/assets/app-abc123.js`);
    expect(await stored?.text()).toBe('new-asset');
  });

  it('serves the fetched hashed asset when opening the cache throws', async () => {
    const harness = await loadServiceWorker();
    harness.fetchMock.mockResolvedValue(basicResponse('new-asset'));
    failCacheWrites(harness, 'open');
    const response = await runFetchEvent(
      harness.fetchListener,
      new Request(`${ORIGIN}/assets/app-abc123.js`),
    );
    expect(await response.text()).toBe('new-asset');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
  });

  it('serves the fetched hashed asset when the cache write throws', async () => {
    const harness = await loadServiceWorker();
    harness.fetchMock.mockResolvedValue(basicResponse('new-asset'));
    failCacheWrites(harness, 'put');
    const response = await runFetchEvent(
      harness.fetchListener,
      new Request(`${ORIGIN}/assets/app-abc123.js`),
    );
    expect(await response.text()).toBe('new-asset');
    expect(harness.fetchMock).toHaveBeenCalledOnce();
  });

  it('deletes caches from other versions on activation and keeps unrelated caches', async () => {
    const harness = await loadServiceWorker();
    await harness.seedCache(OLD_CACHE_NAME, `${ORIGIN}/`, 'old-entry');
    await harness.seedCache(harness.currentCacheName, `${ORIGIN}/`, 'new-entry');
    await harness.seedCache('other-origin-cache', `${ORIGIN}/assets/app-abc123.js`, 'unrelated');
    await runLifecycleEvent(harness.activateListener);
    expect(harness.stores.has(OLD_CACHE_NAME)).toBe(false);
    expect(harness.stores.has(harness.currentCacheName)).toBe(true);
    expect(harness.stores.has('other-origin-cache')).toBe(true);
    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it('skips waiting on install so the new cache version takes over promptly', async () => {
    const harness = await loadServiceWorker();
    await runLifecycleEvent(harness.installListener);
    expect(harness.skipWaiting).toHaveBeenCalledOnce();
  });
});
