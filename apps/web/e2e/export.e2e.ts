import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Playlist, Track } from '@playlist-exporter/contracts';

// 用户可见文案与 src/i18n/zh-CN.ts 保持一致；E2E 以黑盒方式验证界面文本。
const L = {
  inspectButton: '读取歌单',
  cancelButton: '取消任务',
  running: '正在读取歌单…',
  completed: '歌单读取完成',
  cancelled: '任务已取消',
  detectedNetease: '已识别：网易云音乐',
  previewTitle: '导出预览',
  exportButton: '导出文件',
  totalTracks: (count: number): string => `共 ${count} 首歌曲`,
};

const PLAYLIST_INPUT =
  'https://music.163.com/#/playlist?id=2064224062&userid=test';
const TRACK_COUNT = 1001;
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
  jobId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  jobId,
  provider: 'netease',
  status,
  createdAt: ISO_TIME,
  updatedAt: ISO_TIME,
  ...extra,
});

async function mockPlaylistApi(
  page: Page,
  options: {
    readonly jobId: string;
    readonly playlist: Playlist;
    readonly filename: string;
    /** 轮询到第 N 次后返回 completed；null 表示一直保持 running。 */
    readonly completeAfterPolls: number | null;
    readonly capture: JobCapture;
  },
): Promise<void> {
  const { jobId, playlist: mocked, filename, completeAfterPolls, capture } = options;

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
      ? jobSnapshot(jobId, 'completed', {
          finishedAt: ISO_TIME,
          progress: { phase: 'completed', completed: mocked.total, total: mocked.total },
          result: mocked,
        })
      : jobSnapshot(jobId, 'running', {
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
