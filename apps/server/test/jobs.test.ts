import { describe, expect, it } from 'vitest';
import { AppError, type Playlist } from '@playlist-exporter/contracts';
import { createJobRegistry, type JobRunContext } from '../src/jobs.js';

const playlist = (id: string): Playlist => ({
  id,
  name: `歌单 ${id}`,
  source: 'netease',
  total: 0,
  tracks: [],
  complete: true,
  warnings: [],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe('job registry', () => {
  it('runs FIFO with bounded concurrency and exposes progress without input data', async () => {
    const first = deferred<Playlist>();
    const order: string[] = [];
    let nextId = 0;
    const jobs = createJobRegistry({
      maxConcurrent: 1,
      maxQueued: 2,
      terminalTtlMs: 1_000,
      idFactory: () => `job-${++nextId}`,
    });
    const one = jobs.submit('netease', async (context) => {
      order.push('one');
      context.onProgress({ phase: 'fetching', completed: 1, total: 2 });
      return first.promise;
    });
    const two = jobs.submit('netease', async () => {
      order.push('two');
      return playlist('two');
    });

    expect(one.status).toBe('running');
    expect(two.status).toBe('queued');
    expect(jobs.get(one.jobId)?.progress).toMatchObject({ completed: 1, total: 2 });
    expect(JSON.stringify(jobs.get(one.jobId))).not.toContain('input');
    first.resolve(playlist('one'));
    await flush();
    expect(order).toEqual(['one', 'two']);
    expect(jobs.get(two.jobId)?.status).toBe('completed');
    expect(jobs.getCompletedResult(two.jobId)?.id).toBe('two');
    jobs.close();
  });

  it('rejects submissions beyond the explicit queue budget', () => {
    const blocked = deferred<Playlist>();
    const jobs = createJobRegistry({ maxConcurrent: 1, maxQueued: 1, terminalTtlMs: 1_000 });
    jobs.submit('netease', () => blocked.promise);
    jobs.submit('netease', () => blocked.promise);
    expect(() => jobs.submit('netease', () => blocked.promise)).toThrow(/队列/);
    jobs.close();
  });

  it('cancels queued work without running it', async () => {
    const blocked = deferred<Playlist>();
    let queuedCalls = 0;
    const jobs = createJobRegistry({ maxConcurrent: 1, maxQueued: 2, terminalTtlMs: 1_000 });
    jobs.submit('netease', () => blocked.promise);
    const queued = jobs.submit('netease', async () => {
      queuedCalls += 1;
      return playlist('queued');
    });
    expect(jobs.cancel(queued.jobId).kind).toBe('cancelled');
    blocked.resolve(playlist('first'));
    await flush();
    expect(queuedCalls).toBe(0);
    expect(jobs.get(queued.jobId)?.status).toBe('cancelled');
    jobs.close();
  });

  it('keeps a running job cancelled even when an ignoring runner resolves late', async () => {
    const pending = deferred<Playlist>();
    let context!: JobRunContext;
    const jobs = createJobRegistry({ maxConcurrent: 1, maxQueued: 1, terminalTtlMs: 1_000 });
    const job = jobs.submit('netease', async (received) => {
      context = received;
      return pending.promise;
    });
    expect(jobs.cancel(job.jobId).kind).toBe('cancelled');
    expect(context.signal.aborted).toBe(true);
    pending.resolve(playlist('late'));
    await flush();
    expect(jobs.get(job.jobId)?.status).toBe('cancelled');
    expect(jobs.getCompletedResult(job.jobId)).toBeUndefined();
    jobs.close();
  });

  it('does not create expiry timers when an ignoring runner settles after close', async () => {
    const pending = deferred<Playlist>();
    let timerCalls = 0;
    const jobs = createJobRegistry({
      maxConcurrent: 1,
      maxQueued: 1,
      terminalTtlMs: 1_000,
      setTimer: () => { timerCalls += 1; return timerCalls; },
      clearTimer: () => undefined,
    });
    jobs.submit('netease', () => pending.promise);
    jobs.close();
    pending.resolve(playlist('late-after-close'));
    await flush();
    expect(timerCalls).toBe(0);
  });

  it('expires terminal jobs through an injected scheduler', async () => {
    let now = 1_000;
    let expire!: () => void;
    const jobs = createJobRegistry({
      maxConcurrent: 1,
      maxQueued: 1,
      terminalTtlMs: 500,
      now: () => now,
      setTimer: callback => { expire = callback; return 1; },
      clearTimer: () => undefined,
      idFactory: () => 'expiring',
    });
    jobs.submit('netease', async () => playlist('done'));
    await flush();
    expect(jobs.get('expiring')?.status).toBe('completed');
    now = 1_500;
    expire();
    expect(jobs.get('expiring')).toBeUndefined();
    jobs.close();
  });

  it('returns safe errors and never exposes an unknown error message', async () => {
    let nextId = 0;
    const jobs = createJobRegistry({
      maxConcurrent: 1,
      maxQueued: 2,
      terminalTtlMs: 1_000,
      idFactory: () => `failure-${++nextId}`,
    });
    const known = jobs.submit('netease', async () => {
      throw new AppError({ code: 'KNOWN', message: '可重试', technicalDetails: { status: 429 } });
    });
    const unknown = jobs.submit('netease', async () => {
      throw new Error('Authorization: Bearer should-not-escape');
    });
    await flush();
    expect(jobs.get(known.jobId)?.error).toEqual({
      code: 'KNOWN', message: '可重试', technicalDetails: { status: 429 },
    });
    expect(jobs.get(unknown.jobId)?.error).toMatchObject({
      code: 'TASK_FAILED', message: '任务执行失败，请重试',
    });
    expect(JSON.stringify(jobs.get(unknown.jobId))).not.toContain('should-not-escape');
    jobs.close();
  });
});
