import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, AppError } from '@playlist-exporter/contracts';
import { createHttpTransport } from '../src/http.js';
import type { AbortableClock } from '../src/clock.js';

const abortError = () => new DOMException('Aborted', 'AbortError');

class ImmediateClock implements AbortableClock {
  nowMs = 0;
  readonly sleeps: number[] = [];
  now(): number { return this.nowMs; }
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? abortError();
    if (ms <= 1_000) {
      this.sleeps.push(ms);
      this.nowMs += ms;
      return;
    }
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true });
    });
  }
}

class TimeoutClock implements AbortableClock {
  private timeoutResolve: (() => void) | undefined;
  private releaseTimeout: (() => void) | undefined;
  readonly timeoutStarted: Promise<void>;
  nowMs = 0;
  constructor() {
    this.timeoutStarted = new Promise((resolve) => { this.timeoutResolve = resolve; });
  }
  now(): number { return this.nowMs; }
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? abortError();
    if (ms === 25) {
      this.timeoutResolve?.();
      await new Promise<void>((resolve, reject) => {
        this.releaseTimeout = resolve;
        signal.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true });
      });
      return;
    }
    this.nowMs += ms;
  }
  release(): void { this.releaseTimeout?.(); }
}

const hangingFetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
  if (init?.signal?.aborted) throw init.signal.reason ?? abortError();
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      'abort',
      () => reject(init.signal?.reason ?? abortError()),
      { once: true },
    );
  });
};

describe('createHttpTransport', () => {
  it('releases the FIFO gate after request start, not after a slow response completes', async () => {
    class GateClock implements AbortableClock {
      nowMs = 0;
      now(): number { return this.nowMs; }
      async sleep(ms: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted) throw signal.reason ?? abortError();
        if (ms <= 1_000) { this.nowMs += ms; return; }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true });
        });
      }
    }

    const clock = new GateClock();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      if (String(input).endsWith('/a')) {
        markFirstStarted();
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      } else {
        markSecondStarted();
      }
      return new Response('ok');
    };
    const transport = createHttpTransport({ clock, minIntervalMs: 100, timeoutMs: 10_000, maxResponseBytes: 1_024, fetchImpl });
    const first = transport.request('https://example.test/a');
    await firstStarted;
    const second = transport.request('https://example.test/b');
    const secondWasStarted = await Promise.race([
      secondStarted.then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 50); }),
    ]);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(secondWasStarted).toBe(true);
  });

  it('does not call fetch for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort(abortError());
    let calls = 0;
    const transport = createHttpTransport({
      fetchImpl: async () => { calls += 1; return new Response('bad'); },
      maxResponseBytes: 1_024,
    });
    await expect(transport.request('https://example.test/public?id=secret', {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('starts concurrent requests FIFO with one min-interval gate', async () => {
    const clock = new ImmediateClock();
    const starts: Array<{ url: string; at: number }> = [];
    const transport = createHttpTransport({
      clock,
      minIntervalMs: 100,
      timeoutMs: 10_000,
      maxResponseBytes: 1_024,
      fetchImpl: async (input) => {
        starts.push({ url: String(input), at: clock.now() });
        return new Response('ok');
      },
    });
    const [first, second] = await Promise.all([
      transport.request('https://example.test/a'),
      transport.request('https://example.test/b'),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(starts).toEqual([
      { url: 'https://example.test/a', at: 0 },
      { url: 'https://example.test/b', at: 100 },
    ]);
  });

  it('skips an aborted queued slot and lets the following request proceed', async () => {
    const clock = new ImmediateClock();
    const urls: string[] = [];
    const transport = createHttpTransport({
      clock,
      minIntervalMs: 100,
      timeoutMs: 10_000,
      maxResponseBytes: 1_024,
      fetchImpl: async (input) => { urls.push(String(input)); return new Response('ok'); },
    });
    const first = transport.request('https://example.test/a');
    const queued = new AbortController();
    const second = transport.request('https://example.test/b', { signal: queued.signal });
    queued.abort(abortError());
    const third = transport.request('https://example.test/c');
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.all([first, third]);
    expect(urls).toContain('https://example.test/a');
    expect(urls).toContain('https://example.test/c');
    expect(urls).not.toContain('https://example.test/b');
  });

  it('maps timeout-first aborts to HTTP_TIMEOUT with only safe details', async () => {
    const transport = createHttpTransport({
      clock: new ImmediateClock(), timeoutMs: 50, fetchImpl: hangingFetch,
      maxResponseBytes: 1_024,
    });
    const error = await transport
      .request('https://example.test/list?cookie=super-secret#fragment')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.HTTP_TIMEOUT);
    expect((error as AppError).technicalDetails).toEqual({ timeoutMs: 50 });
    expect(JSON.stringify(error)).not.toContain('super-secret');
    expect(JSON.stringify(error)).not.toContain('fragment');
  });

  it('preserves caller-first AbortError instead of converting it to timeout', async () => {
    const clock = new TimeoutClock();
    const caller = new AbortController();
    const transport = createHttpTransport({ clock, timeoutMs: 25, maxResponseBytes: 1_024, fetchImpl: hangingFetch });
    const pending = transport.request('https://example.test/list?token=secret', {
      signal: caller.signal,
    });
    await clock.timeoutStarted;
    caller.abort(abortError());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    clock.release();
  });

  it('preserves timeout first cause when caller aborts after a delayed fetch ignores signal', async () => {
    const clock = new TimeoutClock();
    const caller = new AbortController();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    let markTimeoutAbort!: () => void;
    const timeoutAbortObserved = new Promise<void>(resolve => { markTimeoutAbort = resolve; });
    let releaseFetch!: () => void;
    const transport = createHttpTransport({
      clock,
      timeoutMs: 25,
      maxResponseBytes: 1_024,
      fetchImpl: async (_input, init) => {
        init?.signal?.addEventListener('abort', () => markTimeoutAbort(), { once: true });
        markFetchStarted();
        return new Promise<Response>(resolve => { releaseFetch = () => resolve(new Response('ok')); });
      },
    });
    const pending = transport.request('https://example.test/list?authorization=secret', {
      signal: caller.signal,
    });

    await Promise.all([clock.timeoutStarted, fetchStarted]);
    clock.release();
    await timeoutAbortObserved;
    caller.abort(abortError());
    releaseFetch();

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.HTTP_TIMEOUT);
  });

  it('maps timeout-first race to HTTP_TIMEOUT', async () => {
    const clock = new TimeoutClock();
    const transport = createHttpTransport({ clock, timeoutMs: 25, maxResponseBytes: 1_024, fetchImpl: hangingFetch });
    const pending = transport.request('https://example.test/list?authorization=secret');
    await clock.timeoutStarted;
    clock.release();
    await expect(pending).rejects.toMatchObject({ code: APP_ERROR_CODES.HTTP_TIMEOUT });
  });

  it('returns non-2xx unchanged and does not mutate request input', async () => {
    const clock = new ImmediateClock();
    const url = new URL('https://example.test/404?x=1');
    const init: RequestInit = { headers: { 'X-Test': 'value' } };
    const beforeUrl = url.toString();
    const beforeInit = { ...init, headers: { ...(init.headers as Record<string, string>) } };
    const response = new Response('missing', { status: 404 });
    const transport = createHttpTransport({ clock, maxResponseBytes: 1_024, fetchImpl: async () => response });
    await expect(transport.request(url, init)).resolves.toBe(response);
    expect(url.toString()).toBe(beforeUrl);
    expect(init).toEqual(beforeInit);
  });

  it('requires a positive integer maxResponseBytes', () => {
    expect(() => createHttpTransport()).toThrow(RangeError);
    expect(() => createHttpTransport({ maxResponseBytes: 0 })).toThrow(RangeError);
    expect(() => createHttpTransport({ maxResponseBytes: 1.5 })).toThrow(RangeError);
  });

  it('times out while draining a never-ending cloned body and aborts the internal signal', async () => {
    const clock = new ImmediateClock();
    let internalSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
      },
    });
    const response = new Response(body);
    const transport = createHttpTransport({
      clock,
      timeoutMs: 50,
      maxResponseBytes: 1_024,
      fetchImpl: async (_input, init) => {
        internalSignal = init?.signal ?? undefined;
        return response;
      },
    });
    const error = await transport
      .request('https://example.test/never-ending')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.HTTP_TIMEOUT);
    expect(internalSignal?.aborted).toBe(true);
    expect(response.bodyUsed).toBe(false);
  });

  it('does not await a hanging clone-reader cancel after caller aborts', async () => {
    let markFetch!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetch = resolve; });
    let cancelStarted = false;
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
      cancel: () => {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
      releaseLock: () => {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const clone = { body: { getReader: () => reader } } as unknown as Response;
    const response = new Response('original');
    Object.defineProperty(response, 'clone', { configurable: true, value: () => clone });
    const caller = new AbortController();
    const transport = createHttpTransport({
      clock: new ImmediateClock(),
      timeoutMs: 10_000,
      maxResponseBytes: 1_024,
      fetchImpl: async () => {
        markFetch();
        return response;
      },
    });
    const pending = transport.request('https://example.test/cancel', { signal: caller.signal });
    await fetchStarted;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    caller.abort(abortError());
    const outcome = await Promise.race([
      pending.then(() => new Error('resolved'), (error: unknown) => error),
      new Promise<unknown>(resolve => setTimeout(() => resolve(new Error('hung')), 100)),
    ]);
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(cancelStarted).toBe(true);
  });

  it('pre-reads every status on a clone and returns the original readable response', async () => {
    for (const status of [200, 404]) {
      const response = new Response('payload', { status });
      const transport = createHttpTransport({
        clock: new ImmediateClock(),
        timeoutMs: 10_000,
        maxResponseBytes: 1_024,
        fetchImpl: async () => response,
      });
      const returned = await transport.request('https://example.test/status/' + status);
      expect(returned).toBe(response);
      expect(response.bodyUsed).toBe(false);
      await expect(returned.text()).resolves.toBe('payload');
    }
  });

  it('rejects a Content-Length above maxResponseBytes without consuming the original body', async () => {
    const response = new Response('12345', {
      headers: { 'Content-Length': '6' },
    });
    const transport = createHttpTransport({
      clock: new ImmediateClock(),
      timeoutMs: 10_000,
      maxResponseBytes: 5,
      fetchImpl: async () => response,
    });
    const error = await transport
      .request('https://example.test/content-length')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.RESPONSE_TOO_LARGE);
    expect(response.bodyUsed).toBe(false);
  });

  it('rejects a streamed body above maxResponseBytes', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'));
        controller.enqueue(new TextEncoder().encode('456'));
        controller.close();
      },
    });
    const response = new Response(body);
    const transport = createHttpTransport({
      clock: new ImmediateClock(),
      timeoutMs: 10_000,
      maxResponseBytes: 5,
      fetchImpl: async () => response,
    });
    const error = await transport
      .request('https://example.test/stream-size')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(APP_ERROR_CODES.RESPONSE_TOO_LARGE);
    expect(response.bodyUsed).toBe(false);
  });

  it('accepts a response body exactly at maxResponseBytes', async () => {
    const response = new Response(new TextEncoder().encode('12345'));
    const transport = createHttpTransport({
      clock: new ImmediateClock(),
      timeoutMs: 10_000,
      maxResponseBytes: 5,
      fetchImpl: async () => response,
    });
    const returned = await transport.request('https://example.test/exact-size');
    expect(returned).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await expect(returned.text()).resolves.toBe('12345');
  });
});
