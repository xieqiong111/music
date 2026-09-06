// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Playlist } from '@playlist-exporter/contracts';
import App from './App.js';
import { ApiError, type JobSnapshot, type LibraryEntryPatch, type LocalLibraryEntry, type LocalLibraryState, type PlaylistService } from './api.js';

vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
afterEach(cleanup);

/** 渲染已认证状态的应用并等待主界面就绪（会话状态查询是异步的）。 */
const renderApp = async (
  mockService: PlaylistService,
  props: { libraryPollIntervalMs?: number } = {},
): Promise<void> => {
  render(<App service={mockService} {...props} />);
  await screen.findByLabelText('歌单链接或 ID');
};

const playlist: Playlist = {
  id: 'playlist-1',
  name: '通勤歌单 🌙',
  creator: '测试用户',
  source: 'netease',
  total: 2,
  complete: true,
  warnings: [],
  tracks: [
    {
      title: '夜空中最亮的星',
      artists: ['逃跑计划'],
      album: '世界',
      source: 'netease',
      availability: 'available',
      position: 0,
      warnings: [],
    },
    {
      title: '晚安',
      artists: ['甲', '乙'],
      source: 'netease',
      availability: 'unavailable',
      position: 1,
      warnings: ['地区不可用'],
    },
  ],
};

const completedJob = (): JobSnapshot => ({
  jobId: 'job-1',
  provider: 'netease',
  status: 'completed',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:01.000Z',
  result: playlist,
});

const libraryEntry = (overrides: Partial<LocalLibraryEntry> = {}): LocalLibraryEntry => ({
  id: 'entry-1',
  rootId: 'root-1',
  path: '/music/flac/夜空中最亮的星.flac',
  title: '夜空中最亮的星',
  artists: ['逃跑计划'],
  album: '世界',
  durationMs: 253000,
  mtimeMs: 1,
  ...overrides,
});

const emptyLibrary = (): LocalLibraryState => ({
  roots: [],
  entries: [],
  scan: { active: false, scannedFiles: 0 },
  truncated: false,
});

const populatedLibrary = (): LocalLibraryState => ({
  roots: [{
    id: 'root-1',
    path: '/music/flac',
    addedAt: '2026-09-01T00:00:00.000Z',
    lastScanAt: '2026-09-02T00:00:00.000Z',
    fileCount: 2,
  }],
  entries: [
    libraryEntry(),
    libraryEntry({
      id: 'entry-2',
      path: '/music/flac/晚安.flac',
      title: '晚安',
      artists: ['甲'],
      album: null,
      durationMs: null,
    }),
  ],
  scan: { active: false, scannedFiles: 2 },
  truncated: false,
});

const editedEntry = (id: string, patch: LibraryEntryPatch): LocalLibraryEntry => ({
  ...libraryEntry({ id }),
  ...(patch.title === undefined ? {} : { title: patch.title }),
  ...(patch.artists === undefined ? {} : { artists: [...patch.artists] }),
  ...(patch.album === undefined ? {} : { album: patch.album }),
});

const service = (overrides: Partial<PlaylistService> = {}): PlaylistService => ({
  createInspection: vi.fn(async () => ({ jobId: 'job-1', status: 'running' as const })),
  getJob: vi.fn(async () => completedJob()),
  cancelJob: vi.fn(async () => undefined),
  createExport: vi.fn(async () => ({
    filename: 'netease_通勤歌单_2026-09-04.txt',
    mimeType: 'text/plain;charset=utf-8',
    bytes: new TextEncoder().encode('夜空中最亮的星 - 逃跑计划\n'),
  })),
  getAuthStatus: vi.fn(async () => ({ authenticated: true as const, username: 'admin' })),
  login: vi.fn(async () => ({ username: 'admin', expiresAt: '2026-09-12T00:00:00.000Z' })),
  logout: vi.fn(async () => undefined),
  updateCredentials: vi.fn(async () => ({ username: 'admin' })),
  browseDirs: vi.fn(async () => ({ browseRoots: [] as readonly string[] })),
  getLocalLibrary: vi.fn(async () => emptyLibrary()),
  addLibraryRoot: vi.fn(async () => emptyLibrary()),
  removeLibraryRoot: vi.fn(async () => emptyLibrary()),
  rescanLibraryRoot: vi.fn(async () => emptyLibrary()),
  editLibraryEntry: vi.fn(async (id: string, patch: LibraryEntryPatch) => editedEntry(id, patch)),
  removeLibraryEntry: vi.fn(async () => emptyLibrary()),
  ...overrides,
});

describe('App', () => {
  it('cancels an online job when switching to a local import', async () => {
    const mockService = service({ getJob: vi.fn(() => new Promise<JobSnapshot>(() => undefined)) });
    const user = userEvent.setup();
    await renderApp(mockService);
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    await waitFor(() => expect(mockService.getJob).toHaveBeenCalledWith('job-1'));
    await user.upload(screen.getByLabelText('选择播放列表文件'),
      new File(['Name\tArtist\nLocal\tArtist'], 'local.txt', { type: 'text/plain' }));
    await waitFor(() => expect(mockService.cancelJob).toHaveBeenCalledWith('job-1'));
    expect(await screen.findByText('Local')).toBeInTheDocument();
  });
  it('shows all providers, disables unavailable ones, and auto-detects links', async () => {
    const user = userEvent.setup();
    await renderApp(service());

    expect(screen.getByRole('button', { name: /Apple Music/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /QQ 音乐/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /网易云音乐/ })).toBeEnabled();
    const input = screen.getByLabelText('歌单链接或 ID');
    await user.type(input, 'https://music.163.com/playlist?id=12345');
    expect(screen.getByText('已识别：网易云音乐')).toBeInTheDocument();
  });

  it('auto-detects a QQ playlist link and submits it to the qq-music provider', async () => {
    const mockService = service();
    const user = userEvent.setup();
    await renderApp(mockService);

    expect(screen.getByRole('button', { name: /Apple Music/ })).toBeDisabled();
    const input = screen.getByLabelText('歌单链接或 ID');
    await user.type(input, 'https://y.qq.com/n/ryqq/playlist/7729596131');
    expect(screen.getByText('已识别：QQ 音乐')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    expect(mockService.createInspection).toHaveBeenCalledWith(
      'qq-music',
      'https://y.qq.com/n/ryqq/playlist/7729596131',
    );
  });

  it('loads a playlist, preserves unavailable tracks in preview, and exports selected options', async () => {
    const mockService = service();
    const user = userEvent.setup();
    await renderApp(mockService);
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));

    expect(await screen.findByText('共 2 首歌曲')).toBeInTheDocument();
    expect(screen.getByText('夜空中最亮的星')).toBeInTheDocument();
    expect(screen.getByText('晚安')).toBeInTheDocument();
    expect(screen.getByText('不可用')).toBeInTheDocument();

    await user.click(screen.getByLabelText('包含序号'));
    await user.selectOptions(screen.getByLabelText('导出格式'), 'json');
    await user.click(screen.getByRole('button', { name: '导出文件' }));
    await waitFor(() => expect(mockService.createExport).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ format: 'json', includeIndex: true }),
    ));
  });

  it('cancels the active job', async () => {
    const never = new Promise<JobSnapshot>(() => undefined);
    const mockService = service({ getJob: vi.fn(() => never) });
    const user = userEvent.setup();
    await renderApp(mockService);
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    await screen.findByRole('button', { name: '取消任务' });
    await user.click(screen.getByRole('button', { name: '取消任务' }));
    await waitFor(() => expect(mockService.cancelJob).toHaveBeenCalledWith('job-1'));
    expect(screen.getByText('任务已取消')).toBeInTheDocument();
  });

  it('shows a plain Chinese error and expandable technical details', async () => {
    const failed: JobSnapshot = {
      jobId: 'job-1',
      provider: 'netease',
      status: 'failed',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:01.000Z',
      error: {
        code: 'PROVIDER_HTTP_ERROR',
        message: '平台暂时无法访问，请稍后重试',
        technicalDetails: { requestId: 'request-safe', status: 429 },
      },
    };
    const user = userEvent.setup();
    await renderApp(service({ getJob: vi.fn(async () => failed) }));
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    expect(await screen.findByText('平台暂时无法访问，请稍后重试')).toBeInTheDocument();
    await user.click(screen.getByText('技术详情'));
    expect(screen.getByText(/request-safe/)).toBeInTheDocument();
  });

  it('imports an Apple Music text file, previews it, and exports locally without the server', async () => {
    const mockService = service();
    const user = userEvent.setup();
    await renderApp(mockService);

    const tsv = ['名称\t艺术家\t专辑', '导入曲一 ✨\t歌手甲\t专辑一', '导入曲二\t歌手乙、歌手丙\t专辑二'].join('\n');
    const file = new File([tsv], '我的歌单.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText('选择播放列表文件'), file);

    expect(await screen.findByText('共 2 首歌曲')).toBeInTheDocument();
    expect(screen.getByText('导入曲一 ✨')).toBeInTheDocument();
    expect(screen.getByText('导入曲二')).toBeInTheDocument();
    expect(mockService.createInspection).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '导出文件' }));
    await waitFor(() => {
      const clickMock = HTMLAnchorElement.prototype.click as unknown as ReturnType<typeof vi.fn>;
      expect(clickMock).toHaveBeenCalled();
    });
    expect(mockService.createExport).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a plain Chinese error for unparseable files', async () => {
    const user = userEvent.setup();
    await renderApp(service());
    const file = new File(['this is not a playlist'], 'broken.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText('选择播放列表文件'), file);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/无法识别|解析失败/u);
    expect(screen.getByText('技术详情')).toBeInTheDocument();
  });

  it('shows the login view when unauthenticated and logs in with the default account', async () => {
    const mockService = service({
      getAuthStatus: vi.fn(async () => ({ authenticated: false })),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    expect(await screen.findByLabelText('用户名')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByLabelText('保持登录时长')).toHaveValue('7d');
    expect(screen.getByText(/admin \/ admin/)).toBeInTheDocument();
    expect(screen.queryByLabelText('歌单链接或 ID')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'admin');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(mockService.login).toHaveBeenCalledWith('admin', 'admin', '7d');
    expect(await screen.findByLabelText('歌单链接或 ID')).toBeInTheDocument();
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  });

  it('surfaces wrong-credential errors from the login endpoint', async () => {
    const mockService = service({
      getAuthStatus: vi.fn(async () => ({ authenticated: false })),
      login: vi.fn(async () => {
        throw new ApiError({ code: 'AUTH_REQUIRED', message: '用户名或密码不正确' });
      }),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await screen.findByLabelText('用户名');
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'wrong-pass');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码不正确');
    expect(screen.getByLabelText('用户名')).toBeInTheDocument();
    expect(mockService.login).toHaveBeenCalledWith('admin', 'wrong-pass', '7d');
  });

  it('returns to the login view when an API call reports an expired session', async () => {
    const mockService = service({
      createInspection: vi.fn(async () => {
        throw new ApiError({ code: 'AUTH_REQUIRED', message: '请先登录' });
      }),
    });
    const user = userEvent.setup();
    await renderApp(mockService);

    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));

    expect(await screen.findByLabelText('用户名')).toBeInTheDocument();
    expect(screen.getByText('会话已过期，请重新登录')).toBeInTheDocument();
    expect(screen.queryByLabelText('歌单链接或 ID')).not.toBeInTheDocument();
  });

  it('logs out from the user menu and updates credentials with Chinese error handling', async () => {
    const mockService = service({
      updateCredentials: vi.fn(async (_update: { currentPassword: string; username?: string }) => {
        throw new ApiError({ code: 'AUTH_REQUIRED', message: '当前密码不正确' });
      }),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: 'admin' }));
    await user.click(screen.getByRole('menuitem', { name: '修改账号密码' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('当前密码'), 'wrong');
    await user.type(screen.getByLabelText('新用户名（可留空）'), 'chief');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(mockService.updateCredentials).toHaveBeenCalledWith({
      currentPassword: 'wrong',
      username: 'chief',
    });
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('当前密码'));
    await user.type(screen.getByLabelText('当前密码'), 'admin');
    mockService.updateCredentials = vi.fn(async () => ({ username: 'chief' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('button', { name: 'chief' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'chief' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(mockService.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('用户名')).toBeInTheDocument();
  });

  it('switches to the local library view, filters entries, and edits one inline', async () => {
    const mockService = service({ getLocalLibrary: vi.fn(async () => populatedLibrary()) });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    expect(await screen.findByText('/music/flac')).toBeInTheDocument();
    expect(mockService.getLocalLibrary).toHaveBeenCalled();
    expect(screen.getByText('夜空中最亮的星')).toBeInTheDocument();
    expect(screen.getByText('晚安')).toBeInTheDocument();
    expect(screen.getByText('4:13')).toBeInTheDocument();
    // 缺失的专辑与时长都以“—”占位
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);

    await user.type(screen.getByLabelText('搜索本地歌曲'), '夜空');
    expect(screen.getByText('夜空中最亮的星')).toBeInTheDocument();
    expect(screen.queryByText('晚安')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑' }));
    const titleInput = screen.getByLabelText('标题');
    await user.clear(titleInput);
    await user.type(titleInput, '夜空中最亮的星 (Live)');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(mockService.editLibraryEntry).toHaveBeenCalledWith('entry-1', {
      title: '夜空中最亮的星 (Live)',
      artists: ['逃跑计划'],
      album: '世界',
    });
    expect(await screen.findByText('夜空中最亮的星 (Live)')).toBeInTheDocument();
  });

  it('adds and removes library roots', async () => {
    const mockService = service({
      addLibraryRoot: vi.fn(async () => ({
        ...populatedLibrary(),
        entries: [],
      })),
      removeLibraryRoot: vi.fn(async () => emptyLibrary()),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    expect(screen.getByText('还没有歌曲。添加文件夹后服务端会自动扫描音频文件。')).toBeInTheDocument();
    // 主入口是“选择文件夹”弹窗；手填路径折叠在“手动输入路径”入口之后
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeInTheDocument();
    expect(screen.queryByLabelText('添加音乐文件夹路径')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '手动输入路径' }));
    await user.type(screen.getByLabelText('添加音乐文件夹路径'), '/music/mp3');
    await user.click(screen.getByRole('button', { name: '添加文件夹' }));
    expect(mockService.addLibraryRoot).toHaveBeenCalledWith('/music/mp3');
    expect(await screen.findByText('/music/flac')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    // 上次扫描时间以本地时区渲染，期望值按同一时区计算
    const scanDate = new Date('2026-09-02T00:00:00.000Z');
    const pad = (value: number): string => String(value).padStart(2, '0');
    const expectedScanTime = `${scanDate.getFullYear()}-${pad(scanDate.getMonth() + 1)}-${pad(scanDate.getDate())} ${pad(scanDate.getHours())}:${pad(scanDate.getMinutes())}`;
    expect(screen.getByText(expectedScanTime)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除文件夹' }));
    expect(mockService.removeLibraryRoot).toHaveBeenCalledWith('root-1');
  });

  it('adds a folder through the browse dialog: roots, navigation, and the PUT body', async () => {
    const browseDirs = vi.fn(async (path?: string) => {
      if (path === undefined) return { browseRoots: ['/vol1', '/vol2'] as readonly string[] };
      if (path === '/vol1') {
        return {
          path: '/vol1',
          parent: null,
          dirs: [{ name: 'music', path: '/vol1/music' }] as const,
        };
      }
      return { path: '/vol1/music', parent: '/vol1', dirs: [] as const };
    });
    const mockService = service({
      browseDirs,
      addLibraryRoot: vi.fn(async () => populatedLibrary()),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    await user.click(await screen.findByRole('button', { name: '选择文件夹' }));

    const dialog = await screen.findByRole('dialog');
    // 打开时请求 browse(无参) 拿 browseRoots，并展示为入口按钮
    expect(browseDirs).toHaveBeenCalledWith(undefined, expect.anything());
    expect(await within(dialog).findByRole('button', { name: '/vol1' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '/vol2' })).toBeInTheDocument();

    // 点击 root → 加载该 path 的 dirs；根目录的“上一级”禁用
    await user.click(within(dialog).getByRole('button', { name: '/vol1' }));
    expect(await within(dialog).findByText('/vol1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '上一级' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'music' }));

    // 目录行点击 = 进入该子目录（重新请求 browse?path=...）
    expect(browseDirs).toHaveBeenCalledWith('/vol1/music', expect.anything());
    expect(await within(dialog).findByText('/vol1/music')).toBeInTheDocument();
    expect(within(dialog).getByText('此目录没有可访问的子文件夹，可直接选择当前文件夹')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '上一级' })).toBeEnabled();

    // “上一级”回到父目录
    await user.click(within(dialog).getByRole('button', { name: '上一级' }));
    expect(await within(dialog).findByRole('button', { name: 'music' })).toBeInTheDocument();

    // 回到子目录并确认添加 → PUT {path: 当前path}，弹窗关闭且库状态刷新
    await user.click(within(dialog).getByRole('button', { name: 'music' }));
    await within(dialog).findByText('/vol1/music');
    await user.click(within(dialog).getByRole('button', { name: '将当前文件夹加入音乐库' }));
    expect(mockService.addLibraryRoot).toHaveBeenCalledWith('/vol1/music');
    expect(await screen.findByText('/music/flac')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the manual-input hint in the dialog when browseRoots is empty', async () => {
    const mockService = service();
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    await user.click(await screen.findByRole('button', { name: '选择文件夹' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/手动输入/)).toBeInTheDocument();
    // 没有进入任何目录时不能确认添加
    expect(within(dialog).getByRole('button', { name: '将当前文件夹加入音乐库' })).toBeDisabled();
  });

  it('shows a Chinese browse error inside the dialog and keeps it open', async () => {
    const mockService = service({
      browseDirs: vi.fn(async () => {
        throw new ApiError({ code: 'INVALID_REQUEST', message: '路径无效或不存在' });
      }),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    await user.click(await screen.findByRole('button', { name: '选择文件夹' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('路径无效或不存在');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the browse dialog with Escape', async () => {
    const mockService = service({
      browseDirs: vi.fn(async () => ({ browseRoots: ['/vol1'] as readonly string[] })),
    });
    const user = userEvent.setup();
    render(<App service={mockService} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    await user.click(await screen.findByRole('button', { name: '选择文件夹' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables the local-exclusion checkbox when the library is empty and shows the hint', async () => {
    const user = userEvent.setup();
    await renderApp(service());
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    expect(await screen.findByText('共 2 首歌曲')).toBeInTheDocument();

    expect(await screen.findByText('本地音乐库为空')).toBeInTheDocument();
    expect(screen.getByLabelText('排除本地音乐库已有的歌曲')).toBeDisabled();
  });

  it('exports with excludeLocalDuplicates and shows the excluded count from the response header', async () => {
    const mockService = service({
      getLocalLibrary: vi.fn(async () => ({
        ...emptyLibrary(),
        entries: [libraryEntry()],
      })),
      createExport: vi.fn(async () => ({
        filename: 'netease_通勤歌单_2026-09-04.txt',
        mimeType: 'text/plain;charset=utf-8',
        bytes: new TextEncoder().encode('夜空中最亮的星 - 逃跑计划\n'),
        excludedLocalCount: 3,
      })),
    });
    const user = userEvent.setup();
    await renderApp(mockService);
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    expect(await screen.findByText('共 2 首歌曲')).toBeInTheDocument();

    const checkbox = screen.getByLabelText('排除本地音乐库已有的歌曲');
    await waitFor(() => expect(checkbox).toBeEnabled());
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: '导出文件' }));

    await waitFor(() => expect(mockService.createExport).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ excludeLocalDuplicates: true }),
    ));
    expect(await screen.findByText('已排除本地已有 3 首')).toBeInTheDocument();
  });

  it('polls the library state while a scan is running', async () => {
    const getLocalLibrary = vi.fn(async () => ({
      ...emptyLibrary(),
      scan: { active: true, scannedFiles: 5 },
    }));
    const mockService = service({ getLocalLibrary });
    const user = userEvent.setup();
    render(<App service={mockService} libraryPollIntervalMs={15} />);

    await user.click(await screen.findByRole('button', { name: '本地音乐库' }));
    expect(await screen.findByText('正在扫描音乐文件，已扫描 5 个…')).toBeInTheDocument();
    // 轮询持续刷新，短间隔下应产生多次刷新调用
    await waitFor(() => expect(getLocalLibrary.mock.calls.length).toBeGreaterThanOrEqual(4));
  });
});
