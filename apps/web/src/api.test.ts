// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HttpPlaylistService, normalizeApiBaseUrl } from './api.js';

describe('HttpPlaylistService', () => {
  it('keeps the bearer token in memory and sends no browser credentials', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ jobId: 'job-1', status: 'running' }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    ));
    const service = new HttpPlaylistService({ accessToken: 'memory-only', fetchImpl });

    await expect(service.createInspection('netease', '12345')).resolves.toEqual({
      jobId: 'job-1',
      status: 'running',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/playlists/inspect', expect.objectContaining({
      cache: 'no-store',
      credentials: 'omit',
    }));
    const requestInit = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer memory-only');
    expect(headers.get('content-type')).toBe('application/json');
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('returns exact UTF-8 export bytes and decodes the RFC 5987 filename', async () => {
    const bytes = new TextEncoder().encode('夜空中最亮的星 - 逃跑计划\n');
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'text/plain;charset=utf-8',
        'content-disposition': "attachment; filename*=UTF-8''netease_%E5%A4%9C%E7%A9%BA_2026-09-04.txt",
      },
    }));
    const service = new HttpPlaylistService({ fetchImpl });

    const artifact = await service.createExport('job-1', { format: 'txt' });
    expect(new TextDecoder().decode(artifact.bytes)).toBe('夜空中最亮的星 - 逃跑计划\n');
    expect(artifact.filename).toBe('netease_夜空_2026-09-04.txt');
    expect(artifact.mimeType).toBe('text/plain;charset=utf-8');
  });

  it('maps a structured API failure without exposing response text', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 'AUTH_REQUIRED',
      message: '需要有效的访问令牌',
      technicalDetails: { requestId: 'request-safe' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.getJob('job-1')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: '需要有效的访问令牌',
      technicalDetails: { requestId: 'request-safe' },
    });
  });

  it('accepts only credential-free HTTP origins and blocks HTTPS downgrade', () => {
    expect(normalizeApiBaseUrl('https://nas.example/', 'https:')).toBe('https://nas.example');
    for (const value of [
      'https://user:pass@nas.example',
      'https://nas.example/api',
      'https://nas.example?token=secret',
      'ftp://nas.example',
    ]) {
      expect(() => normalizeApiBaseUrl(value, 'https:')).toThrow(/API/);
    }
    expect(() => normalizeApiBaseUrl('http://nas.example', 'https:')).toThrow(/API/);
  });

  it('rejects malformed job snapshots at the client boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jobId: 'job-1',
      provider: 'netease',
      status: 'completed',
      result: { tracks: 'not-an-array' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new HttpPlaylistService({ fetchImpl });
    await expect(service.getJob('job-1')).rejects.toMatchObject({
      code: 'INVALID_SERVER_RESPONSE',
    });
  });
});
