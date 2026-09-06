// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HttpPlaylistService, normalizeApiBaseUrl } from './api.js';

const jsonResponse = (body: string, status = 200): Response => new Response(body, {
  status,
  headers: { 'content-type': 'application/json' },
});

const recordedFetch = (handler: (url: string, init: RequestInit | undefined) => Promise<Response>) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));

describe('HttpPlaylistService', () => {
  it('sends same-origin cookies and never sets an authorization header', async () => {
    const fetchImpl = recordedFetch(async () => jsonResponse(
      JSON.stringify({ jobId: 'job-1', status: 'running' }),
      202,
    ));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.createInspection('netease', '12345')).resolves.toEqual({
      jobId: 'job-1',
      status: 'running',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/playlists/inspect', expect.objectContaining({
      cache: 'no-store',
      credentials: 'same-origin',
    }));
    const requestInit = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('rejects malformed inspection responses at the client boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jobId: 'job-1',
      status: 'not-a-job-status',
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.createInspection('netease', '12345')).rejects.toMatchObject({
      code: 'INVALID_SERVER_RESPONSE',
    });
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

  it('rejects progress updates whose counters are not numbers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jobId: 'job-1',
      provider: 'netease',
      status: 'running',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      progress: { phase: 'fetching', completed: { value: 1 }, total: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.getJob('job-1')).rejects.toMatchObject({
      code: 'INVALID_SERVER_RESPONSE',
    });
  });

  it('checks auth status and logs in with the selected session duration', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = recordedFetch(async (url, init) => {
      requests.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      if (url.endsWith('/api/auth/status')) {
        return jsonResponse(JSON.stringify({ authenticated: true, username: 'admin' }));
      }
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse(JSON.stringify({
          authenticated: true,
          username: 'admin',
          expiresAt: '2026-09-12T00:00:00.000Z',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.getAuthStatus()).resolves.toEqual({
      authenticated: true,
      username: 'admin',
    });
    await expect(service.login('admin', 'admin', '7d')).resolves.toEqual({
      username: 'admin',
      expiresAt: '2026-09-12T00:00:00.000Z',
    });
    expect(requests[0]).toEqual({ url: '/api/auth/status' });
    expect(requests[1]).toEqual({
      url: '/api/auth/login',
      body: { username: 'admin', password: 'admin', duration: '7d' },
    });
  });

  it('reports unauthenticated status without a username', async () => {
    const fetchImpl = recordedFetch(async () =>
      jsonResponse(JSON.stringify({ authenticated: false })));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.getAuthStatus()).resolves.toEqual({ authenticated: false });
  });

  it('updates credentials and logs out via the session cookie', async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = recordedFetch(async (url, init) => {
      requests.push({
        url,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      if (url.endsWith('/api/auth/credentials')) {
        return jsonResponse(JSON.stringify({ authenticated: true, username: 'root' }));
      }
      if (url.endsWith('/api/auth/logout')) {
        return jsonResponse(JSON.stringify({ authenticated: false }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.updateCredentials({
      currentPassword: 'admin',
      username: 'root',
      password: 'new-password',
    })).resolves.toEqual({ username: 'root' });
    await expect(service.logout()).resolves.toBeUndefined();
    expect(requests[0]).toEqual({
      url: '/api/auth/credentials',
      method: 'POST',
      body: { currentPassword: 'admin', username: 'root', password: 'new-password' },
    });
    expect(requests[1]).toEqual({ url: '/api/auth/logout', method: 'POST' });
  });

  it('omits empty credential fields instead of sending them', async () => {
    const requests: Array<{ body?: unknown }> = [];
    const fetchImpl = recordedFetch(async (url, init) => {
      requests.push({ ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      return jsonResponse(JSON.stringify({ authenticated: true, username: 'admin' }));
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await service.updateCredentials({ currentPassword: 'admin', username: '  ' });
    expect(requests[0]).toEqual({ body: { currentPassword: 'admin' } });
  });

  it('reads the local library state from GET /api/local-library', async () => {
    const fetchImpl = recordedFetch(async url => {
      expect(url).toBe('/api/local-library');
      return jsonResponse(JSON.stringify({
        roots: [{
          id: 'root-1',
          path: '/music/flac',
          addedAt: '2026-09-01T00:00:00.000Z',
          lastScanAt: '2026-09-02T00:00:00.000Z',
          fileCount: 2,
        }],
        entries: [{
          id: 'entry-1',
          rootId: 'root-1',
          path: '/music/flac/a.flac',
          title: '夜空中最亮的星',
          artists: ['逃跑计划'],
          album: '世界',
          durationMs: 253000,
          mtimeMs: 1,
        }],
        scan: { active: true, scannedFiles: 1 },
        truncated: false,
      }));
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.getLocalLibrary()).resolves.toEqual({
      roots: [{
        id: 'root-1',
        path: '/music/flac',
        addedAt: '2026-09-01T00:00:00.000Z',
        lastScanAt: '2026-09-02T00:00:00.000Z',
        fileCount: 2,
      }],
      entries: [{
        id: 'entry-1',
        rootId: 'root-1',
        path: '/music/flac/a.flac',
        title: '夜空中最亮的星',
        artists: ['逃跑计划'],
        album: '世界',
        durationMs: 253000,
        mtimeMs: 1,
      }],
      scan: { active: true, scannedFiles: 1 },
      truncated: false,
    });
  });

  it('rejects malformed local library payloads at the client boundary', async () => {
    const fetchImpl = recordedFetch(async () => jsonResponse(JSON.stringify({
      roots: 'not-an-array',
      entries: [],
      scan: { active: false, scannedFiles: 0 },
      truncated: false,
    })));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.getLocalLibrary()).rejects.toMatchObject({
      code: 'INVALID_SERVER_RESPONSE',
    });
  });

  it('adds, rescans and removes roots with the documented verbs and bodies', async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const emptyState = { roots: [], entries: [], scan: { active: false, scannedFiles: 0 }, truncated: false };
    const fetchImpl = recordedFetch(async (url, init) => {
      requests.push({
        url,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return jsonResponse(JSON.stringify(emptyState));
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await service.addLibraryRoot('/music/flac');
    await service.rescanLibraryRoot('root-1');
    await service.removeLibraryRoot('root-1');
    expect(requests).toEqual([
      { url: '/api/local-library/roots', method: 'PUT', body: { path: '/music/flac' } },
      { url: '/api/local-library/roots/root-1/rescan', method: 'POST' },
      { url: '/api/local-library/roots/root-1', method: 'DELETE' },
    ]);
  });

  it('edits and removes entries with PATCH and DELETE', async () => {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const emptyState = { roots: [], entries: [], scan: { active: false, scannedFiles: 0 }, truncated: false };
    const fetchImpl = recordedFetch(async (url, init) => {
      requests.push({
        url,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      if (init?.method === 'PATCH') {
        return jsonResponse(JSON.stringify({
          id: 'entry-1',
          rootId: 'root-1',
          path: '/music/flac/a.flac',
          title: '新标题',
          artists: ['歌手甲'],
          album: null,
          durationMs: null,
          mtimeMs: 1,
        }));
      }
      return jsonResponse(JSON.stringify(emptyState));
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.editLibraryEntry('entry-1', {
      title: '新标题',
      artists: ['歌手甲'],
      album: null,
    })).resolves.toEqual({
      id: 'entry-1',
      rootId: 'root-1',
      path: '/music/flac/a.flac',
      title: '新标题',
      artists: ['歌手甲'],
      album: null,
      durationMs: null,
      mtimeMs: 1,
    });
    await service.removeLibraryEntry('entry-1');
    expect(requests).toEqual([
      {
        url: '/api/local-library/entries/entry-1',
        method: 'PATCH',
        body: { title: '新标题', artists: ['歌手甲'], album: null },
      },
      { url: '/api/local-library/entries/entry-1', method: 'DELETE' },
    ]);
  });

  it('browses NAS roots without a path and encodes the path query parameter', async () => {
    const requests: string[] = [];
    const fetchImpl = recordedFetch(async url => {
      requests.push(url);
      if (url === '/api/local-library/browse') {
        return jsonResponse(JSON.stringify({ browseRoots: ['/vol1', '/vol2'] }));
      }
      if (url === '/api/local-library/browse?path=%2Fvol1%2F%E9%9F%B3%E4%B9%90') {
        return jsonResponse(JSON.stringify({
          path: '/vol1/音乐',
          parent: '/vol1',
          dirs: [{ name: 'flac', path: '/vol1/音乐/flac' }],
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.browseDirs()).resolves.toEqual({
      browseRoots: ['/vol1', '/vol2'],
    });
    await expect(service.browseDirs('/vol1/音乐')).resolves.toEqual({
      path: '/vol1/音乐',
      parent: '/vol1',
      dirs: [{ name: 'flac', path: '/vol1/音乐/flac' }],
    });
    expect(requests).toEqual([
      '/api/local-library/browse',
      '/api/local-library/browse?path=%2Fvol1%2F%E9%9F%B3%E4%B9%90',
    ]);
  });

  it('forwards the abort signal on browse requests', async () => {
    let seenSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse(JSON.stringify({ browseRoots: [] }));
    });
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.browseDirs(undefined, controller.signal))
      .resolves.toEqual({ browseRoots: [] });
    expect(seenSignal).toBe(controller.signal);
  });

  it('passes 401 auth failures through from the browse endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 'AUTH_REQUIRED',
      message: '请先登录',
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.browseDirs('/vol1')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: '请先登录',
    });
  });

  it('rejects malformed browse payloads at the client boundary', async () => {
    const fetchImpl = recordedFetch(async () => jsonResponse(JSON.stringify({
      path: '/vol1',
      parent: null,
      dirs: [{ name: 42, path: '/vol1/flac' }],
    })));
    const service = new HttpPlaylistService({ fetchImpl });

    await expect(service.browseDirs('/vol1')).rejects.toMatchObject({
      code: 'INVALID_SERVER_RESPONSE',
    });
  });

  it('surfaces x-excluded-local-count only when the export response carries it', async () => {
    const baseHeaders = {
      'content-type': 'text/plain;charset=utf-8',
      'content-disposition': "attachment; filename*=UTF-8''export.txt",
    };
    const withHeader = recordedFetch(async () => new Response('kept\n', {
      status: 200,
      headers: { ...baseHeaders, 'x-excluded-local-count': '3' },
    }));
    const withoutHeaderImpl = recordedFetch(async () => new Response('kept\n', {
      status: 200,
      headers: baseHeaders,
    }));

    await expect(new HttpPlaylistService({ fetchImpl: withHeader })
      .createExport('job-1', { format: 'txt', excludeLocalDuplicates: true }))
      .resolves.toMatchObject({ excludedLocalCount: 3 });
    const withoutHeader = new HttpPlaylistService({ fetchImpl: withoutHeaderImpl });
    const artifact = await withoutHeader.createExport('job-1', { format: 'txt' });
    expect(artifact.filename).toBe('export.txt');
    expect(artifact.mimeType).toBe('text/plain;charset=utf-8');
    expect(artifact.excludedLocalCount).toBeUndefined();
  });
});
