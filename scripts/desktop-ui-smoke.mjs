import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('@playwright/test');
const exe = resolve(process.argv[2]);
const output = resolve('desktop-smoke-results');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'playlist-webview-'));
const probe = createServer();
await new Promise(done => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise(done => probe.close(done));
const child = spawn(exe, [], { windowsHide: true, env: {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  WEBVIEW2_USER_DATA_FOLDER: profile,
} });
let browser;
let base;
try {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop exited ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
      break;
    } catch { await new Promise(done => setTimeout(done, 500)); }
  }
  assert.ok(browser, 'WebView2 debug endpoint became available');
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  if (!page) page = await context.waitForEvent('page', { timeout: 30000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//u, { timeout: 30000 });
  base = new URL(page.url()).origin;
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('admin');
  await page.locator('form button[type="submit"]').click();
  await page.locator('#import-file').waitFor({ state: 'visible' });
  await page.locator('#import-file').setInputFiles({
    name: '桌面验收.tsv', mimeType: 'text/tab-separated-values',
    buffer: Buffer.from('Name\tArtist\tAlbum\n桌面验收歌曲\t测试歌手\t测试专辑\n'),
  });
  await page.getByRole('cell', { name: '桌面验收歌曲', exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('.export-panel > button').click();
  const download = await downloadPromise;
  const saved = join(output, 'export.txt');
  await download.saveAs(saved);
  assert.match(await readFile(saved, 'utf8'), /桌面验收歌曲 - 测试歌手/u);
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  console.log('PASS: installed EXE, WebView2 UI, login, local TSV import, real TXT download');
} finally {
  // WM_CLOSE exercises normal Tauri shutdown and its backend process guard.
  if (child.exitCode === null) {
    const closed = new Promise(done => child.once('exit', done));
    const close = spawn('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
    await new Promise(done => close.once('exit', done));
    const timer = setTimeout(() => child.kill(), 10000);
    await closed;
    clearTimeout(timer);
  }
  if (browser) await browser.close().catch(() => {});
}
if (base) {
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    try { await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }); }
    catch { stopped = true; break; }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(stopped, 'Backend stops when the desktop window closes');
  console.log('PASS: desktop close terminates the backend');
}
