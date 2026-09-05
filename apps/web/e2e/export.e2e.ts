import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Playlist, ProviderId, Track } from '@playlist-exporter/contracts';

// 用户可见文案与 src/i18n/zh-CN.ts 保持一致；E2E 以黑盒方式验证界面文本。
const L = {
  inspectButton: '读取歌单',
  cancelButton: '取消任务',
  running: '正在读取歌单…',
  completed: '歌单读取完成',
  cancelled: '任务已取消',
  detectedNetease: '已识别：网易云音乐',
  detectedQQ: '已识别：QQ 音乐',
  previewTitle: '导出预览',
  exportButton: '导出文件',
  totalTracks: (count: number): string => `共 ${count} 首歌曲`,
  loginUsername: '用户名',
  loginPassword: '密码',
  loginButton: '登录',
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

const PLAYLIST_INPUT =
  'https://music.163.com/#/playlist?id=2064224062&userid=test';
const QQ_PLAYLIST_INPUT = 'https://y.qq.com/n/ryqq/playlist/7729596131';
const TRACK_COUNT = 1001;
const QQ_TRACK_COUNT = 12;
const ISO_TIME = '2026-01-01T00:00:00.000Z';

const track = (title: string, artists: string[], position: number): Track => ({
  title,
  artists,
  source: 'netease',
  position,
  availability: 'available',
  warnings: [],
});

function makeTracks(count: number): Track[] {
  const tracks: Track[] = [];
  for (let position = 0; position < count; position += 1) {
    if (position === 0) {
      tracks.push(track('第1首 · 序曲 ✨', ['歌手一', '歌手二'], position));
    } else if (position === count - 1) {
      tracks.push(track(`第${count}首 · 终曲 🎵`, ['歌手一千零一'], position));
    } else if (position === 8 || position === 9) {
      // 重复歌曲放在前 20 首内，保证预览表与导出内容都能验证其按原顺序保留。
      tracks.push(track('重复曲目 🔁', ['同一歌手'], position));
    } else {
      tracks.push(track(`第${position + 1}首 - 测试曲目`, [`歌手${position + 1}`], position));
    }
  }
  return tracks;
}

const playlist = (name: string): Playlist => ({
  id: '2064224062',
  name,
  creator: '测试创建者',
  source: 'netease',
  total: TRACK_COUNT,
  tracks: makeTracks(TRACK_COUNT),
  complete: true,
  warnings: [],
});

const qqTrack = (title: string, artists: string[], position: number): Track => ({
  title,
  artists,
  source: 'qq-music',
  position,
  availability: 'available',
  warnings: [],
});

// 12 首合成 QQ 歌单：含 1 个重复曲（占位 3/4 两行）与带 Emoji 的歌名。
function makeQqTracks(): Track[] {
  const tracks: Track[] = [];
  for (let position = 0; position < QQ_TRACK_COUNT; position += 1) {
    if (position === 0) {
      tracks.push(qqTrack('QQ 序曲 🎶', ['歌手甲', '歌手乙'], position));
    } else if (position === 3 || position === 4) {
      tracks.push(qqTrack('重复曲目 🔁', ['同一歌手'], position));
    } else if (position === QQ_TRACK_COUNT - 1) {
      tracks.push(qqTrack(`第${QQ_TRACK_COUNT}首 · 终曲 🎵`, ['歌手十二'], position));
    } else {
      tracks.push(qqTrack(`第${position + 1}首 - 测试曲目 🎧`, [`歌手${position + 1}`], position));
    }
  }
  return tracks;
}

const qqPlaylist = (name: string): Playlist => ({
  id: '7729596131',
  name,
  creator: '测试创建者',
  source: 'qq-music',
  total: QQ_TRACK_COUNT,
  tracks: makeQqTracks(),
  complete: true,
  warnings: [],
});

// 与 packages/exporters TXT 规则一致的独立期望构造，避免与被测实现共享代码。
const txtBody = (tracks: readonly Track[]): string =>
  `${tracks.map(item => `${item.title} - ${item.artists.join('、')}`).join('\n')}\n`;

const localDate = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

// 非法文件名字符替换为下划线；与 packages/exporters 的 filename 规则一致。
const expectSanitized = (name: string): string =>
  name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_');

// 复刻服务端 Content-Disposition 的 filename*=UTF-8'' 编码。
const encodeFilename = (filename: string): string =>
  encodeURIComponent(filename).replace(
    /['()*]/gu,
    character => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  );

// 登录门 mock：会话已认证 + 空的本地音乐库（导出面板的“排除本地重复”依赖它）。
// Playwright 路由按注册的逆序匹配，需要覆盖更早注册的 **/api/** 通配路由时，
// 在其后再次注册本函数即可。
async function mockAuthenticatedSession(page: Page): Promise<void> {
  await page.route('**/api/auth/status', async route => {
    await route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ authenticated: true, username: 'admin' }),
    });
  });
  await page.route('**/api/local-library', async route => {
    await route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        roots: [],
        entries: [],
        scan: { active: false, scannedFiles: 0 },
        truncated: false,
      }),
    });
  });
}

interface JobCapture {
  inspectBodies: Array<{ provider?: string; input?: { value?: string } }>;
  exportBodies: Array<{ jobId?: string; options?: { format?: string; lineEnding?: string } }>;
  deletePaths: string[];
  polls: number;
}

const newCapture = (): JobCapture => ({
  inspectBodies: [],
  exportBodies: [],
  deletePaths: [],
  polls: 0,
});

const jobSnapshot = (
  provider: ProviderId,
  jobId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  jobId,
  provider,
  status,
  createdAt: ISO_TIME,
  updatedAt: ISO_TIME,
  ...extra,
});

async function mockPlaylistApi(
  page: Page,
  options: {
    readonly provider: ProviderId;
    readonly jobId: string;
    readonly playlist: Playlist;
    readonly filename: string;
    /** 轮询到第 N 次后返回 completed；null 表示一直保持 running。 */
    readonly completeAfterPolls: number | null;
    readonly capture: JobCapture;
  },
): Promise<void> {
  const { provider, jobId, playlist: mocked, filename, completeAfterPolls, capture } = options;

  await mockAuthenticatedSession(page);

  await page.route('**/api/playlists/inspect', async route => {
    capture.inspectBodies.push(
      route.request().postDataJSON() as JobCapture['inspectBodies'][number],
    );
    await route.fulfill({
      status: 202,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ jobId, status: 'queued' }),
    });
  });

  await page.route('**/api/jobs/*', async route => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      capture.deletePaths.push(new URL(request.url()).pathname);
      await route.fulfill({
        status: 202,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ jobId, status: 'cancelled' }),
      });
      return;
    }
    capture.polls += 1;
    const completed = completeAfterPolls !== null && capture.polls >= completeAfterPolls;
    const snapshot = completed
      ? jobSnapshot(provider, jobId, 'completed', {
          finishedAt: ISO_TIME,
          progress: { phase: 'completed', completed: mocked.total, total: mocked.total },
          result: mocked,
        })
      : jobSnapshot(provider, jobId, 'running', {
          progress: {
            phase: 'fetching',
            completed: Math.min(capture.polls * 251, mocked.total),
            total: mocked.total,
          },
        });
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(snapshot),
    });
  });

  await page.route('**/api/exports', async route => {
    capture.exportBodies.push(
      route.request().postDataJSON() as JobCapture['exportBodies'][number],
    );
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/plain;charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeFilename(filename)}`,
        'cache-control': 'no-store',
      },
      body: txtBody(mocked.tracks),
    });
  });
}

test('导出 1001 首歌单：分页进度、顺序、首末条、UTF-8 无 BOM LF、文件名与真实下载', async ({ page }) => {
  const name = '深夜放送 🎧 夜に駆ける';
  const mocked = playlist(name);
  const filename = `netease_${name}_${localDate()}.txt`;
  const capture = newCapture();
  await mockPlaylistApi(page, {
    provider: 'netease',
    jobId: 'job-1001',
    playlist: mocked,
    filename,
    completeAfterPolls: 3,
    capture,
  });

  await page.goto('/');
  const input = page.locator('#playlist-input');
  await input.fill(PLAYLIST_INPUT);
  await expect(page.getByText(L.detectedNetease)).toBeVisible();
  await page.getByRole('button', { name: L.inspectButton }).click();

  await expect(page.getByText(L.completed)).toBeVisible();
  await expect(page.locator('.progress-panel')).toContainText('1001 / 1001');
  await expect(page.getByText(L.totalTracks(TRACK_COUNT))).toBeVisible();
  await expect(page.getByText('显示前 20 首')).toBeVisible();
  await expect(page.getByRole('cell', { name: '第1首 · 序曲 ✨' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '重复曲目 🔁' })).toHaveCount(2);

  expect(capture.inspectBodies[0]).toEqual({
    provider: 'netease',
    input: { value: PLAYLIST_INPUT },
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: L.exportButton }).click();
  const download = await downloadPromise;

  // 文件名包含平台、歌单名与日期
  expect(download.suggestedFilename()).toBe(filename);
  expect(filename).toMatch(/^netease_.+_\d{4}-\d{2}-\d{2}\.txt$/u);
  expect(filename).toContain(name);
  expect(capture.exportBodies[0]?.jobId).toBe('job-1001');
  expect(capture.exportBodies[0]?.options?.format).toBe('txt');
  expect(capture.exportBodies[0]?.options?.lineEnding).toBe('lf');

  const savedPath = test.info().outputPath('downloaded-playlist.txt');
  await download.saveAs(savedPath);
  const bytes = await readFile(savedPath);

  // 无 BOM
  expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  // 严格 UTF-8 解码成功（含 Emoji 与 CJK）
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // LF 换行：无 CR 且以 LF 结尾
  expect(text).not.toContain('\r');
  expect(text.endsWith('\n')).toBe(true);

  const lines = text.split('\n');
  expect(lines).toHaveLength(TRACK_COUNT + 1);
  expect(lines.at(-1)).toBe('');
  expect(lines[0]).toBe('第1首 · 序曲 ✨ - 歌手一、歌手二');
  expect(lines[TRACK_COUNT - 1]).toBe(`第${TRACK_COUNT}首 · 终曲 🎵 - 歌手一千零一`);
  expect(lines[299]).toBe('第300首 - 测试曲目 - 歌手300');
  // 重复歌曲按原顺序连续保留两行
  expect(lines[8]).toBe('重复曲目 🔁 - 同一歌手');
  expect(lines[9]).toBe('重复曲目 🔁 - 同一歌手');
  // 下载字节与响应一致，全部 1001 行按歌单原始顺序排列
  expect(text).toBe(txtBody(mocked.tracks));
});

test('取消运行中的任务会调用 DELETE，且不会导出部分结果', async ({ page }) => {
  const mocked = playlist('深夜放送 🎧 夜に駆ける');
  const capture = newCapture();
  await mockPlaylistApi(page, {
    provider: 'netease',
    jobId: 'job-cancel',
    playlist: mocked,
    filename: 'unused.txt',
    completeAfterPolls: null,
    capture,
  });

  await page.goto('/');
  await page.locator('#playlist-input').fill('2064224062');
  await page.getByRole('button', { name: L.inspectButton }).click();
  await expect(page.getByText(L.running)).toBeVisible();

  await page.getByRole('button', { name: L.cancelButton }).click();
  await expect(page.getByText(L.cancelled)).toBeVisible();

  expect(capture.deletePaths).toEqual(['/api/jobs/job-cancel']);
  expect(capture.exportBodies).toHaveLength(0);
  // 取消后没有导出入口，也没有任何部分结果被渲染
  await expect(page.getByRole('button', { name: L.exportButton })).toHaveCount(0);
  await expect(page.getByText(L.previewTitle)).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(capture.exportBodies).toHaveLength(0);
});

test('导出文件名清理非法字符并保留平台、歌单名与日期', async ({ page }) => {
  const rawName = '我的:歌单/上*最?棒<|"';
  const mocked: Playlist = {
    id: '2064224062',
    name: rawName,
    creator: '测试创建者',
    source: 'netease',
    total: 3,
    tracks: [
      track('第一首 🎵', ['歌手甲', '歌手乙'], 0),
      track('第二首', ['歌手乙'], 1),
      track('第三首', ['歌手丙'], 2),
    ],
    complete: true,
    warnings: [],
  };
  const filename = `netease_${expectSanitized(rawName)}_${localDate()}.txt`;
  const capture = newCapture();
  await mockPlaylistApi(page, {
    provider: 'netease',
    jobId: 'job-sanitize',
    playlist: mocked,
    filename,
    completeAfterPolls: 2,
    capture,
  });

  await page.goto('/');
  await page.locator('#playlist-input').fill(PLAYLIST_INPUT);
  await page.getByRole('button', { name: L.inspectButton }).click();
  await expect(page.getByText(L.completed)).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: L.exportButton }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(filename);
  expect(filename).toMatch(/^netease_.+_\d{4}-\d{2}-\d{2}\.txt$/u);
  expect(filename).toContain('我的');
  expect(filename).toContain('歌单');
  for (const character of '<>:"/\\|?*') {
    expect(filename).not.toContain(character);
  }

  const savedPath = test.info().outputPath('downloaded-sanitized.txt');
  await download.saveAs(savedPath);
  const bytes = await readFile(savedPath);
  expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  expect(text).toBe(txtBody(mocked.tracks));
});

test('导出 QQ 音乐 12 首歌单：链接识别、顺序、重复曲、UTF-8 无 BOM LF、文件名与真实下载', async ({ page }) => {
  const name = '深夜 QQ 放送 🎶';
  const mocked = qqPlaylist(name);
  const filename = `qq-music_${name}_${localDate()}.txt`;
  const capture = newCapture();
  await mockPlaylistApi(page, {
    provider: 'qq-music',
    jobId: 'job-qq-12',
    playlist: mocked,
    filename,
    completeAfterPolls: 2,
    capture,
  });

  await page.goto('/');
  const input = page.locator('#playlist-input');
  await input.fill(QQ_PLAYLIST_INPUT);
  await expect(page.getByText(L.detectedQQ)).toBeVisible();
  await page.getByRole('button', { name: L.inspectButton }).click();

  await expect(page.getByText(L.completed)).toBeVisible();
  await expect(page.getByText(L.totalTracks(QQ_TRACK_COUNT))).toBeVisible();
  await expect(page.getByRole('cell', { name: 'QQ 序曲 🎶' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '重复曲目 🔁' })).toHaveCount(2);

  expect(capture.inspectBodies[0]).toEqual({
    provider: 'qq-music',
    input: { value: QQ_PLAYLIST_INPUT },
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: L.exportButton }).click();
  const download = await downloadPromise;

  // 文件名包含平台、歌单名与日期
  expect(download.suggestedFilename()).toBe(filename);
  expect(filename).toMatch(/^qq-music_.+_\d{4}-\d{2}-\d{2}\.txt$/u);
  expect(filename).toContain(name);
  expect(capture.exportBodies[0]?.jobId).toBe('job-qq-12');
  expect(capture.exportBodies[0]?.options?.format).toBe('txt');
  expect(capture.exportBodies[0]?.options?.lineEnding).toBe('lf');

  const savedPath = test.info().outputPath('downloaded-qq-playlist.txt');
  await download.saveAs(savedPath);
  const bytes = await readFile(savedPath);

  // 无 BOM
  expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  // 严格 UTF-8 解码成功（含 Emoji 与 CJK）
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // LF 换行：无 CR 且以 LF 结尾
  expect(text).not.toContain('\r');
  expect(text.endsWith('\n')).toBe(true);

  const lines = text.split('\n');
  expect(lines).toHaveLength(QQ_TRACK_COUNT + 1);
  expect(lines.at(-1)).toBe('');
  expect(lines[0]).toBe('QQ 序曲 🎶 - 歌手甲、歌手乙');
  expect(lines[QQ_TRACK_COUNT - 1]).toBe(`第${QQ_TRACK_COUNT}首 · 终曲 🎵 - 歌手十二`);
  // 重复歌曲按原顺序连续保留两行
  expect(lines[3]).toBe('重复曲目 🔁 - 同一歌手');
  expect(lines[4]).toBe('重复曲目 🔁 - 同一歌手');
  // 下载字节与响应一致，全部 12 行按歌单原始顺序排列
  expect(text).toBe(txtBody(mocked.tracks));
});

test('导入 Apple Music 导出文件：本机解析、预览、本机导出且不经过服务端', async ({ page }) => {
  // 业务 API 一律中止：导入→导出路径必须完全不产生业务网络请求；
  // 仅放行应用加载时的登录态查询（/api/auth/status，登录门必需）。
  const abortedRequests: string[] = [];
  await page.route('**/api/**', async route => {
    abortedRequests.push(route.request().url());
    await route.abort();
  });
  // 后注册的路由优先匹配，因此登录态查询不会被上面的通配路由中止。
  await mockAuthenticatedSession(page);

  const tsv = [
    '名称\t艺术家\t专辑',
    '第1首 · 导入曲 ✨\t歌手甲\t专辑一',
    '第2首\t歌手乙、歌手丙\t专辑二',
  ].join('\n');
  await page.goto('/');
  await page.getByLabel('选择播放列表文件').setInputFiles({
    buffer: Buffer.from(tsv, 'utf-8'),
    mimeType: 'text/plain',
    name: '我的导入歌单.txt',
  });

  await expect(page.getByText('共 2 首歌曲')).toBeVisible();
  await expect(page.getByRole('cell', { name: '第1首 · 导入曲 ✨' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '第2首' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: L.exportButton }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`apple-music_我的导入歌单_${localDate()}.txt`);

  const savedPath = test.info().outputPath('downloaded-import.txt');
  await download.saveAs(savedPath);
  const bytes = await readFile(savedPath);
  expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  expect(text).toBe('第1首 · 导入曲 ✨ - 歌手甲\n第2首 - 歌手乙、歌手丙\n');
  // 本机导出路径不得触碰任何业务 API
  expect(abortedRequests).toEqual([]);
});

test('登录门：未认证显示登录视图，默认账号 admin/admin 登录成功后进入主界面', async ({ page }) => {
  let authenticated = false;
  const loginBodies: Array<{ username?: string; password?: string; duration?: string }> = [];
  await page.route('**/api/auth/status', async route => {
    await route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(
        authenticated
          ? { authenticated: true, username: 'admin' }
          : { authenticated: false },
      ),
    });
  });
  await page.route('**/api/auth/login', async route => {
    loginBodies.push(
      route.request().postDataJSON() as { username?: string; password?: string; duration?: string },
    );
    authenticated = true;
    await route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        authenticated: true,
        username: 'admin',
        expiresAt: ISO_TIME,
      }),
    });
  });

  await page.goto('/');
  // 未认证：只显示登录视图，主界面不可见
  await expect(page.getByLabel(L.loginUsername)).toBeVisible();
  await expect(page.getByLabel(L.loginPassword)).toBeVisible();
  await expect(page.getByText(/admin \/ admin/)).toBeVisible();
  await expect(page.getByRole('button', { name: L.inspectButton })).toHaveCount(0);

  await page.getByLabel(L.loginUsername).fill('admin');
  await page.getByLabel(L.loginPassword).fill('admin');
  // 默认会话时长为 7 天
  await expect(page.getByLabel('保持登录时长')).toHaveValue('7d');
  await page.getByRole('button', { name: L.loginButton }).click();

  expect(loginBodies).toEqual([{ username: 'admin', password: 'admin', duration: '7d' }]);
  // 登录成功：进入主界面，右上角显示当前用户名
  await expect(page.getByRole('button', { name: L.inspectButton })).toBeVisible();
  await expect(page.getByRole('button', { name: 'admin' })).toBeVisible();
});
