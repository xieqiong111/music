import { expect, test, type Page } from '@playwright/test';

// 本文件验证真实浏览器中的 Service Worker 行为(sw.test.ts 的内存 VM 无法
// 覆盖 CacheStorage、SW 生命周期与浏览器网络栈语义)。全局配置禁用了 SW,
// 这里必须显式放行;SW 仅在 Chromium 上受支持,默认 project 即 chromium。
test.use({ serviceWorkers: 'allow' });

// 与 playwright.config.ts 的 baseURL 一致。
const ORIGIN = 'http://127.0.0.1:4321';
// 上一版本缓存名(见 public/sw.js 的 CACHE_PREFIX 与历史 CACHE_VERSION)。
const OLD_CACHE_NAME = 'playlist-exporter-static-v1';

// 用户可见文案与 src/i18n/zh-CN.ts 保持一致(同 export.e2e.ts 的做法)。
const INSPECT_BUTTON = '读取歌单';

const MARKER_TEXT = 'SW-NETWORK-FIRST-MARKER-新入口已部署';
const MARKER_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>marker-entry</title></head>
  <body><div id="root">${MARKER_TEXT}</div></body>
</html>`;

// 等待当前页面存在已激活的 Service Worker。active.state 变为 activated 表示
// activate 事件的 waitUntil(含旧缓存清理)已经完成。
const waitForActivated = async (page: Page): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.active?.state ?? 'none';
        }),
      { timeout: 15_000 },
    )
    .toBe('activated');
};

test('SW 激活后清理上一版本缓存:v1 被删除,当前版本缓存保留', async ({ page }) => {
  await page.goto('/');
  await waitForActivated(page);
  // 首次加载时 SW 尚未接管,入口不经过 SW;联网重载一次,让 SW 把入口写入
  // 当前版本缓存,这样清理断言能同时观察到"旧版被删、当前版保留"。
  await page.reload();
  let names = await page.evaluate(async () => caches.keys());
  expect(names.some(name => name.startsWith('playlist-exporter-static-'))).toBe(true);

  // 注入上一版本的假缓存条目,模拟升级前遗留的 v1 缓存。
  await page.evaluate(async cacheName => {
    const cache = await caches.open(cacheName);
    await cache.put('/', new Response('old-entry', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
  }, OLD_CACHE_NAME);
  expect(await page.evaluate(async () => caches.keys())).toContain(OLD_CACHE_NAME);

  // 注销当前 SW 并重载:应用在页面 load 时重新注册 sw.js,新注册的激活流程
  // 会删除不属于当前版本的缓存。
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.unregister();
  });
  await page.reload();
  await waitForActivated(page);

  await expect
    .poll(() => page.evaluate(async () => caches.keys()), { timeout: 15_000 })
    .not.toContain(OLD_CACHE_NAME);
  names = await page.evaluate(async () => caches.keys());
  expect(names.some(name => name.startsWith('playlist-exporter-static-'))).toBe(true);
});

test('入口 network-first:SW 联网取回标记的新 HTML,而不是回退旧缓存', async ({ page, context }) => {
  let serveMarker = false;
  // 路由必须在 SW 创建之前经 context.route 注册,才能拦截 SW 发起的网络请求;
  // 第一轮放行真实页面以完成 SW 注册,之后对入口返回"部署后的标记内容"。
  await context.route(
    url => url.origin === ORIGIN && (url.pathname === '/' || url.pathname === '/index.html'),
    async route => {
      if (serveMarker) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: MARKER_HTML,
        });
        return;
      }
      await route.continue();
    },
  );

  await page.goto('/');
  await waitForActivated(page);

  serveMarker = true;
  await page.reload();
  await expect(page.getByText(MARKER_TEXT)).toBeVisible();
});

test('断网时回退到缓存的入口并正常渲染', async ({ page, context }) => {
  const blocked: string[] = [];
  let offline = false;
  await context.route(
    url => url.origin === ORIGIN,
    async route => {
      if (offline) {
        blocked.push(route.request().url());
        await route.abort('internetdisconnected');
        return;
      }
      await route.continue();
    },
  );

  await page.goto('/');
  await waitForActivated(page);
  // 首次加载时 SW 尚未接管,入口与静态资源不经过 SW;联网重载一次,让 SW 以
  // network-first 取回入口,并把入口与 hash 静态资源写入当前版本缓存。
  await page.reload();
  await expect(page.getByRole('button', { name: INSPECT_BUTTON })).toBeVisible();

  offline = true;
  await page.reload();
  // 断网后仍能加载缓存的入口并完整渲染应用。
  await expect(page.getByRole('button', { name: INSPECT_BUTTON })).toBeVisible();
  // 入口确实发起过联网请求并被断开:渲染内容来自缓存回退,而非真实网络。
  expect(blocked).toContainEqual(`${ORIGIN}/`);
});
