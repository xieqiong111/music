// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Playlist } from '@playlist-exporter/contracts';
import App from './App.js';
import type { JobSnapshot, PlaylistService } from './api.js';

vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
afterEach(cleanup);

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

const service = (overrides: Partial<PlaylistService> = {}): PlaylistService => ({
  createInspection: vi.fn(async () => ({ jobId: 'job-1', status: 'running' as const })),
  getJob: vi.fn(async () => completedJob()),
  cancelJob: vi.fn(async () => undefined),
  createExport: vi.fn(async () => ({
    filename: 'netease_通勤歌单_2026-09-04.txt',
    mimeType: 'text/plain;charset=utf-8',
    bytes: new TextEncoder().encode('夜空中最亮的星 - 逃跑计划\n'),
  })),
  ...overrides,
});

describe('App', () => {
  it('shows all providers, disables unavailable ones, and auto-detects links', async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    expect(screen.getByRole('button', { name: /Apple Music/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /QQ 音乐/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /网易云音乐/ })).toBeEnabled();
    const input = screen.getByLabelText('歌单链接或 ID');
    await user.type(input, 'https://music.163.com/playlist?id=12345');
    expect(screen.getByText('已识别：网易云音乐')).toBeInTheDocument();
  });

  it('loads a playlist, preserves unavailable tracks in preview, and exports selected options', async () => {
    const mockService = service();
    const user = userEvent.setup();
    render(<App service={mockService} />);
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
    render(<App service={mockService} />);
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
    render(<App service={service({ getJob: vi.fn(async () => failed) })} />);
    await user.type(screen.getByLabelText('歌单链接或 ID'), '12345');
    await user.click(screen.getByRole('button', { name: '读取歌单' }));
    expect(await screen.findByText('平台暂时无法访问，请稍后重试')).toBeInTheDocument();
    await user.click(screen.getByText('技术详情'));
    expect(screen.getByText(/request-safe/)).toBeInTheDocument();
  });
});
