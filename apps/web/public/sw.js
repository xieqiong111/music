// 缓存命名:前缀固定,版本号在每次发布前端资源时递增(本处曾固定 v1,是旧
// HTML 长期驻留的成因之一,现升为 v2);activate 阶段删除不属于当前版本的
// 旧缓存,已有 v1 客户端升级后旧缓存随之清除。
//
// 策略边界:浏览器对 sw.js 自身的更新检查(脚本字节比对、安装/等待/激活)
// 由浏览器独立进行,本脚本的 fetch 拦截不参与、也无法拦截;这里能控制的只是
// 入口响应策略与缓存的命名、清理。旧缺陷正是入口 HTML cache-first 加上固定
// 缓存版本,导致部署新版本后客户端继续使用旧 HTML 与旧 hash 资源。
const CACHE_PREFIX = 'playlist-exporter-static-';
const CACHE_VERSION = 'v2';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// 可拦截的同源静态请求:仅 GET、同源;/api/、/healthz、跨源以及带
// authorization/cookie 凭证的请求一律放行,不进入缓存逻辑。
// sw.js 本身不列入清单:页面对脚本的需求由浏览器的更新机制处理,与本拦截无关。
const isCacheableRequest = (request, origin) => {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return false;
  if (request.headers.has('authorization') || request.headers.has('cookie')) return false;
  return url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/');
};

// 入口文档:浏览器导航请求(mode 为 navigate),以及按路径识别的 '/' 与
// '/index.html'(覆盖显式 fetch 入口的场景)。
const isEntryDocumentRequest = request => {
  if (request.mode === 'navigate') return true;
  const url = new URL(request.url);
  return url.pathname === '/' || url.pathname === '/index.html';
};

// skipWaiting/clients.claim 取舍:这里选择新 SW 立即接管。原因:入口已是
// network-first,立即激活不会把旧入口重新钉回缓存,反而能让新缓存版本马上
// 生效并在 activate 中及时清理旧版本缓存。若不用 skipWaiting,新 SW 会等待
// 所有旧标签页关闭后才激活,期间旧缓存保留(入口仍走网络,内容不会陈旧,
// 只是清理被推迟)。两者都不影响浏览器自身的 SW 更新检查。
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

// 仅缓存成功且同源(basic)的响应;服务端错误响应原样返回,不回退缓存,
// 避免用旧入口掩盖部署故障。
//
// 缓存写入是尽力而为(best-effort):caches.open/cache.put 的异常(如存储
// 配额 QuotaExceededError)属于缓存层故障而非网络故障,只降级为"本次不写
// 缓存",绝不影响已经成功取得的网络响应。旧实现把写异常与网络失败混在同一
// 个 catch 里,导致部署后已到达的新 HTML 被旧缓存顶替(F2)。
const cacheResponse = async (request, response) => {
  if (response.ok && response.type === 'basic') {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    } catch (error) {
      console.debug('cache write skipped, serving network response uncached:', error);
    }
  }
  return response;
};

self.addEventListener('fetch', event => {
  const request = event.request;
  if (!isCacheableRequest(request, self.location.origin)) return;
  event.respondWith((async () => {
    if (isEntryDocumentRequest(request)) {
      // 入口 HTML 联网优先:只有 fetch 本身失败(离线)才回退到缓存副本;
      // 缓存写入在 cacheResponse 内部已尽力而为,其失败不会进入此 catch,
      // 因此网络成功时新 HTML 必定原样返回。回退匹配全部缓存,升级中途
      // (旧缓存尚未清理)仍可离线;无缓存时继续抛出原始失败,不伪造响应。
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        const cached = await caches.match(request);
        if (cached !== undefined) return cached;
        throw error;
      }
      return cacheResponse(request, response);
    }
    // 其余静态资源(带 hash 的构建产物、图标、manifest)内容不可变,保留
    // 缓存优先,未命中才联网并写入缓存;写缓存同样尽力而为。
    const cached = await caches.match(request);
    if (cached !== undefined) return cached;
    return cacheResponse(request, await fetch(request));
  })());
});
