import { randomUUID } from 'node:crypto';
import {
  AppError,
  type Playlist,
  type ProgressUpdate,
  type ProviderId,
} from '@playlist-exporter/contracts';

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

export interface JobRunContext {
  readonly signal: AbortSignal;
  readonly onProgress: (update: ProgressUpdate) => void;
}

export type JobRunner = (context: JobRunContext) => Promise<Playlist>;
export type TimerHandle = unknown;

export interface JobRegistryOptions {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly terminalTtlMs: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

export type CancelResult =
  | { readonly kind: 'cancelled'; readonly job: JobSnapshot }
  | { readonly kind: 'terminal'; readonly job: JobSnapshot }
  | { readonly kind: 'not-found' };

export interface JobRegistry {
  submit(provider: ProviderId, runner: JobRunner): JobSnapshot;
  get(jobId: string): JobSnapshot | undefined;
  getCompletedResult(jobId: string): Playlist | undefined;
  cancel(jobId: string): CancelResult;
  sweep(): void;
  close(): void;
}

interface JobRecord {
  readonly jobId: string;
  readonly provider: ProviderId;
  status: JobStatus;
  readonly createdAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  expiresAtMs?: number;
  progress?: ProgressUpdate;
  result?: Playlist;
  error?: JobError;
  runner?: JobRunner;
  controller?: AbortController;
  timer?: TimerHandle;
}

const positiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
};

const safeError = (error: unknown): JobError => {
  if (error instanceof AppError) {
    const value = error.toJSON();
    return {
      code: String(value.code),
      message: value.message,
      ...(value.technicalDetails === undefined ? {} : { technicalDetails: value.technicalDetails }),
    };
  }
  return { code: 'TASK_FAILED', message: '任务执行失败，请重试' };
};

const abortReason = (): DOMException => new DOMException('Cancelled', 'AbortError');

export const createJobRegistry = (options: JobRegistryOptions): JobRegistry => {
  const maxConcurrent = positiveInteger(options.maxConcurrent, 'maxConcurrent');
  const maxQueued = positiveInteger(options.maxQueued, 'maxQueued');
  const terminalTtlMs = positiveInteger(options.terminalTtlMs, 'terminalTtlMs');
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const records = new Map<string, JobRecord>();
  const queue: JobRecord[] = [];
  let activeCount = 0;
  let closed = false;

  const snapshot = (record: JobRecord): JobSnapshot => ({
    jobId: record.jobId,
    provider: record.provider,
    status: record.status,
    createdAt: new Date(record.createdAtMs).toISOString(),
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    ...(record.finishedAtMs === undefined ? {} : {
      finishedAt: new Date(record.finishedAtMs).toISOString(),
    }),
    ...(record.progress === undefined ? {} : { progress: { ...record.progress } }),
    ...(record.status === 'completed' && record.result !== undefined ? { result: record.result } : {}),
    ...(record.status === 'failed' && record.error !== undefined ? { error: record.error } : {}),
  });

  const deleteIfExpired = (record: JobRecord): void => {
    if (record.expiresAtMs === undefined || now() < record.expiresAtMs) return;
    if (record.timer !== undefined) clearTimer(record.timer);
    records.delete(record.jobId);
  };

  const scheduleExpiry = (record: JobRecord): void => {
    record.expiresAtMs = now() + terminalTtlMs;
    const expire = (): void => {
      if (!records.has(record.jobId)) return;
      if (record.expiresAtMs !== undefined && now() < record.expiresAtMs) {
        record.timer = setTimer(expire, record.expiresAtMs - now());
        return;
      }
      records.delete(record.jobId);
    };
    record.timer = setTimer(expire, terminalTtlMs);
    const maybeUnref = record.timer as { unref?: () => void } | undefined;
    maybeUnref?.unref?.();
  };

  const markTerminal = (record: JobRecord, status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>): void => {
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') return;
    record.status = status;
    record.updatedAtMs = now();
    record.finishedAtMs = record.updatedAtMs;
    record.runner = undefined;
    scheduleExpiry(record);
  };

  let drain = (): void => undefined;

  const start = (record: JobRecord): void => {
    if (record.status !== 'queued' || record.runner === undefined) return;
    activeCount += 1;
    record.status = 'running';
    record.updatedAtMs = now();
    const controller = new AbortController();
    record.controller = controller;
    const runner = record.runner;
    let pending: Promise<Playlist>;
    try {
      pending = Promise.resolve(runner({
        signal: controller.signal,
        onProgress: (update) => {
          if (record.status !== 'running') return;
          record.progress = { ...update };
          record.updatedAtMs = now();
        },
      }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (result) => {
        if (record.status !== 'running') return;
        record.result = result;
        markTerminal(record, 'completed');
      },
      (error: unknown) => {
        if (record.status !== 'running') return;
        record.error = safeError(error);
        markTerminal(record, 'failed');
      },
    ).finally(() => {
      record.controller = undefined;
      activeCount -= 1;
      drain();
    });
  };

  drain = (): void => {
    if (closed) return;
    while (activeCount < maxConcurrent) {
      const record = queue.shift();
      if (record === undefined) break;
      if (record.status === 'queued') start(record);
    }
  };

  const get = (jobId: string): JobSnapshot | undefined => {
    const record = records.get(jobId);
    if (record === undefined) return undefined;
    deleteIfExpired(record);
    return records.has(jobId) ? snapshot(record) : undefined;
  };

  return {
    submit(provider, runner) {
      if (closed) throw new AppError({ code: 'JOB_REGISTRY_CLOSED', message: '任务服务已停止' });
      if (activeCount >= maxConcurrent && queue.length >= maxQueued) {
        throw new AppError({ code: 'QUEUE_FULL', message: '任务队列已满，请稍后重试' });
      }
      const createdAtMs = now();
      const jobId = idFactory();
      if (records.has(jobId)) throw new Error('idFactory returned a duplicate job id');
      const record: JobRecord = {
        jobId,
        provider,
        status: 'queued',
        createdAtMs,
        updatedAtMs: createdAtMs,
        runner,
      };
      records.set(jobId, record);
      queue.push(record);
      drain();
      return snapshot(record);
    },
    get,
    getCompletedResult(jobId) {
      const record = records.get(jobId);
      if (record === undefined) return undefined;
      deleteIfExpired(record);
      // The local `record` still holds `result` after deleteIfExpired removed
      // the Map entry, so validity must be re-confirmed against the Map
      // instead of trusting the stale snapshot.
      if (!records.has(jobId)) return undefined;
      return record.status === 'completed' ? record.result : undefined;
    },
    cancel(jobId) {
      const record = records.get(jobId);
      if (record === undefined) return { kind: 'not-found' };
      deleteIfExpired(record);
      if (!records.has(jobId)) return { kind: 'not-found' };
      if (record.status === 'completed' || record.status === 'failed') {
        return { kind: 'terminal', job: snapshot(record) };
      }
      if (record.status === 'cancelled') return { kind: 'cancelled', job: snapshot(record) };
      if (record.status === 'queued') {
        const index = queue.indexOf(record);
        if (index >= 0) queue.splice(index, 1);
      }
      markTerminal(record, 'cancelled');
      record.controller?.abort(abortReason());
      return { kind: 'cancelled', job: snapshot(record) };
    },
    sweep() {
      for (const record of records.values()) deleteIfExpired(record);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const record of records.values()) {
        if (record.timer !== undefined) clearTimer(record.timer);
        if (record.status === 'queued' || record.status === 'running') {
          record.status = 'cancelled';
          record.runner = undefined;
        }
        record.controller?.abort(abortReason());
      }
      queue.length = 0;
      records.clear();
    },
  };
};
