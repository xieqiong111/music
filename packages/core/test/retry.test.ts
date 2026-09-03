import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, AppError } from '@playlist-exporter/contracts';
import { fetchWithRetry } from '../src/retry.js';
import type { AbortableClock } from '../src/clock.js';

const abortError = () => new DOMException('Aborted', 'AbortError');

class RecordingClock implements AbortableClock {
  nowMs: number;
  readonly sleeps: number[] = [];
  constructor(nowMs = 1_700_000_000_000) { this.nowMs = nowMs; }
  now(): number { return this.nowMs; }
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? abortError();
    this.sleeps.push(ms);
    this.nowMs += ms;
  }
}

class BlockingClock implements AbortableClock {
  private resolveStarted!: () => void;
  readonly started: Promise<void>;
  now(): number { return 1_700_000_000_000; }
  constructor() {
    this.started = new Promise((resolve) => { this.resolveStarted = resolve; });
  }
  async sleep(_ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? abortError();
    this.resolveStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true });
    });
  }
}

describe('fetchWithRetry', () => {
  it('uses 1-based attempts and Retry-After seconds before the next attempt', async () => {
    const clock = new RecordingClock();
    const attempts: number[] = [];
    const result = await fetchWithRetry(async ({ attempt, signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      attempts.push(attempt);
      return attempt === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : new Response('ok', { status: 200 });
    }, { clock, maxAttempts: 3 });
    expect(result.status).toBe(200);
    expect(attempts).toEqual([1, 2]);
    expect(clock.sleeps).toEqual([2_000]);
  });

  it('parses an HTTP-date Retry-After using the injected clock', async () => {
    const now = 1_700_000_000_000;
    const clock = new RecordingClock(now);
    const result = await fetchWithRetry(async ({ attempt }) => attempt === 1
      ? new Response('', {
          status: 429,
          headers: { 'Retry-After': new Date(now + 5_000).toUTCString() },
        })
      : new Response('ok'), { clock, maxAttempts: 2 });
    expect(result.status).toBe(200);
    expect(clock.sleeps).toEqual([5_000]);
  });

  it('falls back for invalid Retry-After and caps the delay', async () => {
    const clock = new RecordingClock();
    let call = 0;
    await fetchWithRetry(async () => {
      call += 1;
      return call === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': 'not-a-delay' } })
        : new Response('ok');
    }, { clock, maxAttempts: 2, maxDelayMs: 100 });
    expect(clock.sleeps).toEqual([100]);
  });

  it('caps a valid Retry-After seconds delay', async () => {
    const clock = new RecordingClock();
    let calls = 0;
    await fetchWithRetry(async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '999999' } })
        : new Response('ok');
    }, { clock, maxAttempts: 2, maxDelayMs: 100 });
    expect(clock.sleeps).toEqual([100]);
  });

  it('caps a valid future HTTP-date Retry-After delay', async () => {
    const now = 1_700_000_000_000;
    const clock = new RecordingClock(now);
    let calls = 0;
    await fetchWithRetry(async () => {
      calls += 1;
      return calls === 1
        ? new Response('', {
            status: 429,
            headers: { 'Retry-After': new Date(now + 10_000).toUTCString() },
          })
        : new Response('ok');
    }, { clock, maxAttempts: 2, maxDelayMs: 100 });
    expect(clock.sleeps).toEqual([100]);
  });

  it('returns the final 429 response after the attempt budget', async () => {
    const clock = new RecordingClock();
    const last = new Response('last', { status: 429 });
    let calls = 0;
    const result = await fetchWithRetry(async () => {
      calls += 1;
      return calls === 3 ? last : new Response('', { status: 429 });
    }, { clock, maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe(last);
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([1, 2]);
  });

  it('wraps exhausted TypeError retries as NETWORK_ERROR', async () => {
    const clock = new RecordingClock();
    let calls = 0;
    await expect(fetchWithRetry(async () => {
      calls += 1;
      throw new TypeError('socket failed');
    }, { clock })).rejects.toMatchObject({ code: APP_ERROR_CODES.NETWORK_ERROR });
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([500, 1_000]);
  });

  it('retries HTTP_TIMEOUT but preserves the final AppError', async () => {
    const clock = new RecordingClock();
    const timeout = new AppError({
      code: APP_ERROR_CODES.HTTP_TIMEOUT,
      message: '请求超时',
      technicalDetails: { timeoutMs: 10 },
    });
    let calls = 0;
    await expect(fetchWithRetry(async () => {
      calls += 1;
      throw timeout;
    }, { clock, maxAttempts: 2, baseDelayMs: 1 })).rejects.toBe(timeout);
    expect(calls).toBe(2);
  });

  it('does not retry 401, 403, or 404 by default', async () => {
    for (const status of [401, 403, 404]) {
      const clock = new RecordingClock();
      let calls = 0;
      const result = await fetchWithRetry(async () => {
        calls += 1;
        return new Response('', { status });
      }, { clock });
      expect(result.status).toBe(status);
      expect(calls).toBe(1);
      expect(clock.sleeps).toEqual([]);
    }
  });

  it('uses custom shouldRetry in place of the default strategy', async () => {
    const clock = new RecordingClock();
    let calls = 0;
    const result = await fetchWithRetry(async () => {
      calls += 1;
      return new Response('', { status: 429 });
    }, { clock, shouldRetry: () => false });
    expect(result.status).toBe(429);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('honors pre-abort and never retries AbortError', async () => {
    const before = new AbortController();
    before.abort(abortError());
    let calls = 0;
    await expect(fetchWithRetry(async () => {
      calls += 1;
      return new Response('bad', { status: 429 });
    }, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);

    const clock = new RecordingClock();
    await expect(fetchWithRetry(async () => {
      calls += 1;
      throw abortError();
    }, { clock })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('aborts a pending attempt without retrying or sleeping', async () => {
    const clock = new RecordingClock();
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let calls = 0;
    const pending = fetchWithRetry(async ({ signal }) => {
      calls += 1;
      resolveStarted();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? abortError()),
          { once: true },
        );
      });
      throw new Error('unreachable');
    }, { clock, signal: controller.signal, maxAttempts: 3 });
    await started;
    controller.abort(abortError());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('aborts a retry delay without starting another attempt', async () => {
    const clock = new BlockingClock();
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchWithRetry(async () => {
      calls += 1;
      return new Response('', { status: 429 });
    }, { clock, signal: controller.signal, maxAttempts: 2 });
    await clock.started;
    controller.abort(abortError());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('never resolves undefined when the request rejects with undefined', async () => {
    const clock = new RecordingClock();
    let calls = 0;
    const pending = fetchWithRetry(async () => {
      calls += 1;
      throw undefined;
    }, { clock, maxAttempts: 1 });

    await expect(pending).rejects.toBeUndefined();
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('aborts while cancelling a retry body without retry callbacks or another attempt', async () => {
    const clock = new RecordingClock();
    const controller = new AbortController();
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    let releaseCancel!: () => void;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel: () => {
        markCancelStarted();
        return new Promise<void>((resolve) => { releaseCancel = resolve; });
      },
    }), { status: 429, headers: { 'Retry-After': '0' } });
    let attempts = 0;
    let retries = 0;
    const pending = fetchWithRetry(async () => {
      attempts += 1;
      return response;
    }, {
      clock,
      signal: controller.signal,
      maxAttempts: 3,
      onRetry: () => { retries += 1; },
    });

    await cancelStarted;
    controller.abort(abortError());

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let outcome!: 'resolved' | 'rejected' | 'timeout';
    try {
      outcome = await Promise.race([
        pending.then(() => 'resolved' as const, () => 'rejected' as const),
        new Promise<'timeout'>((resolve) => {
          timeoutId = setTimeout(() => resolve('timeout'), 50);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      releaseCancel();
    }

    expect(outcome).toBe('rejected');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
    expect(retries).toBe(0);
    expect(clock.sleeps).toEqual([]);
  });

  it('does not retry a RESPONSE_TOO_LARGE AppError', async () => {
    const clock = new RecordingClock();
    const tooLarge = new AppError({
      code: APP_ERROR_CODES.RESPONSE_TOO_LARGE,
      message: '响应体过大',
      technicalDetails: { maxResponseBytes: 5 },
    });
    let calls = 0;
    await expect(fetchWithRetry(async () => {
      calls += 1;
      throw tooLarge;
    }, { clock, maxAttempts: 3 })).rejects.toBe(tooLarge);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});
