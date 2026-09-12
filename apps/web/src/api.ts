import {
  playlistSchema,
  providerIdSchema,
  type Playlist,
  type ProgressUpdate,
  type ProviderId,
} from '@playlist-exporter/contracts';
import type { ExportOptions } from '@playlist-exporter/exporters';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type SessionDuration = '12h' | '7d' | '30d' | 'forever';

export interface AuthStatus {
  readonly authenticated: boolean;
  readonly username?: string;
}

export interface LoginResult {
  readonly username: string;
  readonly expiresAt: string;
}

export interface CredentialsUpdate {
  readonly currentPassword: string;
  readonly username?: string;
  readonly password?: string;
}

export interface LocalLibraryRoot {
  readonly id: string;
  readonly path: string;
  readonly addedAt: string;
  readonly lastScanAt?: string;
  readonly fileCount?: number;
}

export interface LocalLibraryEntry {
  readonly id: string;
  readonly rootId: string;
  readonly path: string;
  readonly title: string;
  readonly artists: ReadonlyArray<string>;
  readonly album: string | null;
  readonly durationMs: number | null;
  readonly mtimeMs: number;
}

export interface LocalLibraryState {
  readonly roots: ReadonlyArray<LocalLibraryRoot>;
  readonly entries: ReadonlyArray<LocalLibraryEntry>;
  readonly scan: { readonly active: boolean; readonly scannedFiles: number };
  readonly truncated: boolean;
}

export interface LibraryEntryPatch {
  readonly title?: string;
  readonly artists?: ReadonlyArray<string>;
  readonly album?: string | null;
}

/** NAS 上可浏览的一个子目录项。 */
export interface BrowseDirEntry {
  readonly name: string;
  readonly path: string;
}

/** GET /api/local-library/browse（无参）：NAS 卷根列表，可能为空。 */
export interface BrowseRootsResult {
  readonly browseRoots: ReadonlyArray<string>;
}

/** GET /api/local-library/browse?path=...：某个目录下的可读子目录。 */
export interface BrowseDirsResult {
  readonly path: string;
  readonly parent: string | null;
  readonly dirs: ReadonlyArray<BrowseDirEntry>;
}

export type BrowseResult = BrowseRootsResult | BrowseDirsResult;

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
  /** 仅当服务端响应带 x-excluded-local-count 时存在（本地去重管道实际执行）。 */
  readonly excludedLocalCount?: number;
}

/** 导出选项：在 packages/exporters 的 ExportOptions 上追加服务端本地去重开关。 */
export type AppExportOptions = ExportOptions & {
  readonly excludeLocalDuplicates?: boolean;
};

export interface PlaylistService {
  createInspection(provider: ProviderId, input: string): Promise<{
    readonly jobId: string;
    readonly status: JobStatus;
  }>;
  getJob(jobId: string): Promise<JobSnapshot>;
  cancelJob(jobId: string): Promise<void>;
  createExport(jobId: string, options: AppExportOptions): Promise<ExportDownload>;
  getAuthStatus(): Promise<AuthStatus>;
  login(username: string, password: string, duration: SessionDuration): Promise<LoginResult>;
  logout(): Promise<void>;
  updateCredentials(update: CredentialsUpdate): Promise<{ readonly username: string }>;
  getLocalLibrary(): Promise<LocalLibraryState>;
  addLibraryRoot(path: string): Promise<LocalLibraryState>;
  /** 浏览服务端可访问的目录；不传 path 返回卷根列表，传 path 返回其子目录。 */
  browseDirs(path?: string, signal?: AbortSignal): Promise<BrowseResult>;
  removeLibraryRoot(id: string): Promise<LocalLibraryState>;
  rescanLibraryRoot(id: string): Promise<LocalLibraryState>;
  editLibraryEntry(id: string, patch: LibraryEntryPatch): Promise<LocalLibraryEntry>;
  removeLibraryEntry(id: string): Promise<LocalLibraryState>;
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

const parseProgressUpdate = (raw: unknown): ProgressUpdate => {
  if (!isRecord(raw) || typeof raw.phase !== 'string' ||
      (raw.completed !== undefined &&
       (typeof raw.completed !== 'number' || !Number.isFinite(raw.completed))) ||
      (raw.total !== undefined &&
       (typeof raw.total !== 'number' || !Number.isFinite(raw.total))) ||
      (raw.message !== undefined && typeof raw.message !== 'string')) {
    throw invalidServerResponse();
  }
  return {
    phase: raw.phase,
    ...(raw.completed === undefined ? {} : { completed: raw.completed }),
    ...(raw.total === undefined ? {} : { total: raw.total }),
    ...(raw.message === undefined ? {} : { message: raw.message }),
  };
};

const parseJobError = (raw: unknown): JobError => {
  if (!isRecord(raw) || typeof raw.code !== 'string' || typeof raw.message !== 'string' ||
      (raw.technicalDetails !== undefined && !isRecord(raw.technicalDetails))) {
    throw invalidServerResponse();
  }
  return {
    code: raw.code,
    message: raw.message,
    ...(raw.technicalDetails === undefined ? {} : { technicalDetails: raw.technicalDetails }),
  };
};

const parseJobCreation = (raw: unknown): { readonly jobId: string; readonly status: JobStatus } => {
  if (!isRecord(raw) || typeof raw.jobId !== 'string' ||
      typeof raw.status !== 'string' || !jobStatuses.has(raw.status as JobStatus)) {
    throw invalidServerResponse();
  }
  return { jobId: raw.jobId, status: raw.status as JobStatus };
};

const parseAuthStatus = (raw: unknown): AuthStatus => {
  if (!isRecord(raw) || typeof raw.authenticated !== 'boolean') throw invalidServerResponse();
  if (raw.authenticated === false) return { authenticated: false };
  if (typeof raw.username !== 'string' || raw.username === '') throw invalidServerResponse();
  return { authenticated: true, username: raw.username };
};

const parseLoginResult = (raw: unknown): LoginResult => {
  if (!isRecord(raw) || typeof raw.username !== 'string' || raw.username === '' ||
      typeof raw.expiresAt !== 'string') {
    throw invalidServerResponse();
  }
  return { username: raw.username, expiresAt: raw.expiresAt };
};

const parseCredentialsResult = (raw: unknown): { readonly username: string } => {
  if (!isRecord(raw) || typeof raw.username !== 'string' || raw.username === '') {
    throw invalidServerResponse();
  }
  return { username: raw.username };
};

const parseLibraryRoot = (raw: unknown): LocalLibraryRoot => {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.path !== 'string' ||
      typeof raw.addedAt !== 'string') {
    throw invalidServerResponse();
  }
  return {
    id: raw.id,
    path: raw.path,
    addedAt: raw.addedAt,
    ...(typeof raw.lastScanAt === 'string' ? { lastScanAt: raw.lastScanAt } : {}),
    ...(typeof raw.fileCount === 'number' && Number.isFinite(raw.fileCount)
      ? { fileCount: raw.fileCount }
      : {}),
  };
};

const parseLibraryEntry = (raw: unknown): LocalLibraryEntry => {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.rootId !== 'string' ||
      typeof raw.path !== 'string' || typeof raw.title !== 'string' ||
      !Array.isArray(raw.artists) || raw.artists.some(artist => typeof artist !== 'string') ||
      !(raw.album === null || typeof raw.album === 'string') ||
      !(raw.durationMs === null ||
        (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs))) ||
      typeof raw.mtimeMs !== 'number' || !Number.isFinite(raw.mtimeMs)) {
    throw invalidServerResponse();
  }
  return {
    id: raw.id,
    rootId: raw.rootId,
    path: raw.path,
    title: raw.title,
    artists: [...raw.artists as ReadonlyArray<string>],
    album: raw.album,
    durationMs: raw.durationMs,
    mtimeMs: raw.mtimeMs,
  };
};

const parseLibraryState = (raw: unknown): LocalLibraryState => {
  if (!isRecord(raw) || !Array.isArray(raw.roots) || !Array.isArray(raw.entries) ||
      !isRecord(raw.scan) || typeof raw.scan.active !== 'boolean' ||
      typeof raw.scan.scannedFiles !== 'number' || !Number.isFinite(raw.scan.scannedFiles) ||
      typeof raw.truncated !== 'boolean') {
    throw invalidServerResponse();
  }
  return {
    roots: raw.roots.map(parseLibraryRoot),
    entries: raw.entries.map(parseLibraryEntry),
    scan: { active: raw.scan.active, scannedFiles: raw.scan.scannedFiles },
    truncated: raw.truncated,
  };
};

const parseBrowseDirEntry = (raw: unknown): BrowseDirEntry => {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.path !== 'string') {
    throw invalidServerResponse();
  }
  return { name: raw.name, path: raw.path };
};

const parseBrowseResult = (raw: unknown): BrowseResult => {
  if (isRecord(raw) && Array.isArray(raw.browseRoots) &&
      raw.browseRoots.every(root => typeof root === 'string')) {
    return { browseRoots: [...raw.browseRoots as ReadonlyArray<string>] };
  }
  if (isRecord(raw) && typeof raw.path === 'string' &&
      (raw.parent === null || typeof raw.parent === 'string') &&
      Array.isArray(raw.dirs)) {
    return {
      path: raw.path,
      parent: raw.parent,
      dirs: raw.dirs.map(parseBrowseDirEntry),
    };
  }
  throw invalidServerResponse();
};

const parseJobSnapshot = (raw: unknown): JobSnapshot => {
  if (!isRecord(raw) || typeof raw.jobId !== 'string' ||
      !providerIdSchema.safeParse(raw.provider).success ||
      typeof raw.status !== 'string' || !jobStatuses.has(raw.status as JobStatus) ||
      typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    throw invalidServerResponse();
  }
  const result = raw.result === undefined ? undefined : playlistSchema.safeParse(raw.result);
  if (result !== undefined && !result.success) throw invalidServerResponse();
  const progress = raw.progress === undefined ? undefined : parseProgressUpdate(raw.progress);
  const error = raw.error === undefined ? undefined : parseJobError(raw.error);
  return {
    jobId: raw.jobId,
    provider: raw.provider as ProviderId,
    status: raw.status as JobStatus,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(typeof raw.finishedAt === 'string' ? { finishedAt: raw.finishedAt } : {}),
    ...(progress === undefined ? {} : { progress }),
    ...(result?.success === true ? { result: result.data } : {}),
    ...(error === undefined ? {} : { error }),
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
    // 响应体不是 JSON(如桌面壳对缺失路径返回的 HTML)。
    return new ApiError({
      code: 'HTTP_ERROR',
      message: `服务暂时不可用(HTTP ${response.status})`,
    });
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
  return new ApiError({
    code: 'HTTP_ERROR',
    message: `服务暂时不可用(HTTP ${response.status})`,
  });
};

const excludedLocalCountFrom = (header: string | null): number | undefined => {
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
};

export class HttpPlaylistService implements PlaylistService {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpPlaylistServiceOptions = {}) {
    this.#baseUrl = normalizeApiBaseUrl(options.baseUrl);
    // fetch must keep the global receiver; a detached call throws
    // "Illegal invocation" in Chromium.
    this.#fetch = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: new Headers(init.headers),
      cache: 'no-store',
      // Session travels in a SameSite HttpOnly cookie set by the server; send
      // it explicitly so the intent stays visible on every request.
      credentials: 'same-origin',
    });
    if (!response.ok) throw await structuredError(response);
    return response;
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, init);
    // 非 JSON 响应(如桌面壳对缺失的 /api 路径返回的 HTML)一律转成结构化
    // 错误,绝不让 SyntaxError("Unexpected token '<'")裸抛到界面。
    const contentType = response.headers.get('content-type') ?? '';
    if (!/application\/json/i.test(contentType)) {
      throw invalidServerResponse();
    }
    try {
      return await response.json() as Promise<T>;
    } catch {
      throw invalidServerResponse();
    }
  }

  createInspection(provider: ProviderId, input: string) {
    return this.#json<unknown>('/api/playlists/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, input: { value: input } }),
    }).then(parseJobCreation);
  }

  async getJob(jobId: string): Promise<JobSnapshot> {
    return parseJobSnapshot(
      await this.#json<unknown>(`/api/jobs/${encodeURIComponent(jobId)}`),
    );
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.#request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  async createExport(jobId: string, options: AppExportOptions): Promise<ExportDownload> {
    const response = await this.#request('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, options }),
    });
    const excludedLocalCount = excludedLocalCountFrom(
      response.headers.get('x-excluded-local-count'),
    );
    return {
      filename: safeFilename(response.headers.get('content-disposition')),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: new Uint8Array(await response.arrayBuffer()),
      ...(excludedLocalCount === undefined ? {} : { excludedLocalCount }),
    };
  }

  getAuthStatus(): Promise<AuthStatus> {
    return this.#json<unknown>('/api/auth/status').then(parseAuthStatus);
  }

  login(username: string, password: string, duration: SessionDuration): Promise<LoginResult> {
    return this.#json<unknown>('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, duration }),
    }).then(parseLoginResult);
  }

  async logout(): Promise<void> {
    await this.#request('/api/auth/logout', { method: 'POST' });
  }

  async updateCredentials(update: CredentialsUpdate): Promise<{ readonly username: string }> {
    const body: Record<string, string> = { currentPassword: update.currentPassword };
    const username = update.username?.trim();
    if (username !== undefined && username !== '') body.username = username;
    if (update.password !== undefined && update.password !== '') body.password = update.password;
    return parseCredentialsResult(await this.#json<unknown>('/api/auth/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  getLocalLibrary(): Promise<LocalLibraryState> {
    return this.#json<unknown>('/api/local-library').then(parseLibraryState);
  }

  addLibraryRoot(path: string): Promise<LocalLibraryState> {
    return this.#json<unknown>('/api/local-library/roots', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then(parseLibraryState);
  }

  browseDirs(path?: string, signal?: AbortSignal): Promise<BrowseResult> {
    const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
    return this.#json<unknown>(`/api/local-library/browse${query}`, { signal })
      .then(parseBrowseResult);
  }

  removeLibraryRoot(id: string): Promise<LocalLibraryState> {
    return this.#json<unknown>(`/api/local-library/roots/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(parseLibraryState);
  }

  rescanLibraryRoot(id: string): Promise<LocalLibraryState> {
    return this.#json<unknown>(`/api/local-library/roots/${encodeURIComponent(id)}/rescan`, {
      method: 'POST',
    }).then(parseLibraryState);
  }

  async editLibraryEntry(
    id: string,
    patch: LibraryEntryPatch,
  ): Promise<LocalLibraryEntry> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.artists !== undefined) body.artists = [...patch.artists];
    if (patch.album !== undefined) body.album = patch.album;
    return parseLibraryEntry(await this.#json<unknown>(
      `/api/local-library/entries/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ));
  }

  removeLibraryEntry(id: string): Promise<LocalLibraryState> {
    return this.#json<unknown>(`/api/local-library/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(parseLibraryState);
  }
}
