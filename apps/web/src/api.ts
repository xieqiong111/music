import {
  playlistSchema,
  providerIdSchema,
  type Playlist,
  type ProgressUpdate,
  type ProviderId,
} from '@playlist-exporter/contracts';
import type { ExportOptions } from '@playlist-exporter/exporters';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobError {
  readonly code: string;
  readonly message: string;
  readonly technicalDetails?: Readonly<Record<string, unknown>>;
}

export interface JobSnapshot {
  readonly jobId: string;
  readonly provider: ProviderId;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly progress?: ProgressUpdate;
  readonly result?: Playlist;
  readonly error?: JobError;
}

export interface ExportDownload {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface PlaylistService {
  createInspection(provider: ProviderId, input: string): Promise<{
    readonly jobId: string;
    readonly status: JobStatus;
  }>;
  getJob(jobId: string): Promise<JobSnapshot>;
  cancelJob(jobId: string): Promise<void>;
  createExport(jobId: string, options: ExportOptions): Promise<ExportDownload>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly technicalDetails?: Readonly<Record<string, unknown>>;

  constructor(error: JobError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.technicalDetails = error.technicalDetails;
  }
}

export interface HttpPlaylistServiceOptions {
  readonly baseUrl?: string;
  readonly accessToken?: string;
  readonly fetchImpl?: typeof fetch;
}

const invalidServerResponse = (): ApiError =>
  new ApiError({ code: 'INVALID_SERVER_RESPONSE', message: '服务返回了无法识别的数据' });

export const normalizeApiBaseUrl = (
  raw: string | undefined,
  pageProtocol = globalThis.location?.protocol,
): string => {
  if (raw === undefined || raw === '') return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API 基址无效');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' || url.password !== '' || url.pathname !== '/' ||
      url.search !== '' || url.hash !== '' ||
      (pageProtocol === 'https:' && url.protocol !== 'https:')) {
    throw new Error('API 基址无效');
  }
  return url.origin;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jobStatuses = new Set<JobStatus>(['queued', 'running', 'completed', 'failed', 'cancelled']);

const parseJobSnapshot = (raw: unknown): JobSnapshot => {
  if (!isRecord(raw) || typeof raw.jobId !== 'string' ||
      !providerIdSchema.safeParse(raw.provider).success ||
      typeof raw.status !== 'string' || !jobStatuses.has(raw.status as JobStatus) ||
      typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    throw invalidServerResponse();
  }
  const result = raw.result === undefined ? undefined : playlistSchema.safeParse(raw.result);
  if (result !== undefined && !result.success) throw invalidServerResponse();
  if (raw.progress !== undefined && !isRecord(raw.progress)) throw invalidServerResponse();
  if (raw.error !== undefined &&
      (!isRecord(raw.error) || typeof raw.error.code !== 'string' ||
       typeof raw.error.message !== 'string')) {
    throw invalidServerResponse();
  }
  return {
    jobId: raw.jobId,
    provider: raw.provider as ProviderId,
    status: raw.status as JobStatus,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(typeof raw.finishedAt === 'string' ? { finishedAt: raw.finishedAt } : {}),
    ...(raw.progress === undefined ? {} : { progress: raw.progress as unknown as ProgressUpdate }),
    ...(result?.success === true ? { result: result.data } : {}),
    ...(raw.error === undefined ? {} : { error: raw.error as unknown as JobError }),
  };
};

const safeFilename = (header: string | null): string => {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded === undefined) return 'playlist.txt';
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded !== '' && !/[\\/\u0000-\u001f]/u.test(decoded)
      ? decoded
      : 'playlist.txt';
  } catch {
    return 'playlist.txt';
  }
};

const structuredError = async (response: Response): Promise<ApiError> => {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return new ApiError({ code: 'HTTP_ERROR', message: '服务暂时不可用' });
  }
  if (typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as Record<string, unknown>).code === 'string' &&
      typeof (parsed as Record<string, unknown>).message === 'string') {
    const value = parsed as Record<string, unknown>;
    return new ApiError({
      code: value.code as string,
      message: value.message as string,
      ...(typeof value.technicalDetails === 'object' && value.technicalDetails !== null
        ? { technicalDetails: value.technicalDetails as Readonly<Record<string, unknown>> }
        : {}),
    });
  }
  return new ApiError({ code: 'HTTP_ERROR', message: '服务暂时不可用' });
};

export class HttpPlaylistService implements PlaylistService {
  readonly #baseUrl: string;
  readonly #accessToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpPlaylistServiceOptions = {}) {
    this.#baseUrl = normalizeApiBaseUrl(options.baseUrl);
    this.#accessToken = options.accessToken;
    // fetch must keep the global receiver; a detached call throws
    // "Illegal invocation" in Chromium.
    this.#fetch = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#accessToken !== undefined) {
      headers.set('authorization', `Bearer ${this.#accessToken}`);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) throw await structuredError(response);
    return response;
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, init);
    return response.json() as Promise<T>;
  }

  createInspection(provider: ProviderId, input: string) {
    return this.#json<{ readonly jobId: string; readonly status: JobStatus }>(
      '/api/playlists/inspect',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, input: { value: input } }),
      },
    );
  }

  async getJob(jobId: string): Promise<JobSnapshot> {
    return parseJobSnapshot(
      await this.#json<unknown>(`/api/jobs/${encodeURIComponent(jobId)}`),
    );
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.#request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  async createExport(jobId: string, options: ExportOptions): Promise<ExportDownload> {
    const response = await this.#request('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, options }),
    });
    return {
      filename: safeFilename(response.headers.get('content-disposition')),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }
}
