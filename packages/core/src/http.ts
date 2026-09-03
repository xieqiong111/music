import type { HttpTransport } from '@playlist-exporter/contracts';
import { APP_ERROR_CODES, AppError } from '@playlist-exporter/contracts';
import type { AbortableClock } from './clock.js';
import { systemClock } from './clock.js';

export interface HttpTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly maxResponseBytes: number;
  readonly clock?: AbortableClock;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT_REASON = Symbol('http-timeout');
const SIZE_REASON = Symbol('response-too-large');

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
const isAbortError = (value: unknown): boolean =>
  value instanceof DOMException ? value.name === 'AbortError' :
    typeof value === 'object' && value !== null && 'name' in value &&
    (value as { name?: unknown }).name === 'AbortError';
const abortReason = (signal: AbortSignal): unknown => {
  const reason = signal.reason;
  return isAbortError(reason) ? reason : abortError();
};
const validNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const cloneHeaders = (headers: HeadersInit | undefined): HeadersInit | undefined => {
  if (headers === undefined) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return new Headers(headers);
  if (Array.isArray(headers)) return headers.map(([key, value]) => [key, value] as [string, string]);
  return { ...headers };
};
const cloneInit = (init: RequestInit | undefined, signal: AbortSignal): RequestInit => ({
  ...(init ?? {}),
  ...(init?.headers === undefined ? {} : { headers: cloneHeaders(init.headers) }),
  signal,
});

type RequestCause =
  | { readonly kind: 'caller'; readonly reason: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'size' };

const timeoutError = (timeoutMs: number): AppError => new AppError({
  code: APP_ERROR_CODES.HTTP_TIMEOUT,
  message: '请求超时',
  technicalDetails: { timeoutMs },
});
const responseTooLargeError = (maxResponseBytes: number): AppError => new AppError({
  code: APP_ERROR_CODES.RESPONSE_TOO_LARGE,
  message: '响应体过大',
  technicalDetails: { maxResponseBytes },
});

const drainClonedBody = async (
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
  onSizeExceeded: () => never,
): Promise<void> => {
  const clone = response.clone();
  if (clone.body === null) return;

  const reader = clone.body.getReader();
  let cancelled = false;
  let removeAbortListener: (() => void) | undefined;
  const cancelReader = (): void => {
    if (cancelled) return;
    cancelled = true;
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      // Cancellation is best effort and must not delay the caller.
    }
  };
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      cancelReader();
      reject(abortReason(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  let bytes = 0;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortPromise]);
      if (signal.aborted) throw abortReason(signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxResponseBytes) {
        cancelReader();
        onSizeExceeded();
      }
    }
  } finally {
    removeAbortListener?.();
    if (signal.aborted) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // A pending reader may reject release; the response itself is not consumed.
    }
  }
};

export const createHttpTransport = (options: HttpTransportOptions): HttpTransport => {
  if (options === undefined || !validPositiveInteger(options.maxResponseBytes)) {
    throw new RangeError('maxResponseBytes must be a positive integer');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minIntervalMs = options.minIntervalMs ?? 0;
  if (!validNonnegative(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  if (!validNonnegative(minIntervalMs)) throw new RangeError('minIntervalMs must be non-negative');
  const clock = options.clock ?? systemClock;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt: number | undefined;

  const request = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const callerSignal = init?.signal ?? undefined;
    if (callerSignal?.aborted) return Promise.reject(abortReason(callerSignal));

    const manualController = new AbortController();
    let timerController: AbortController | undefined;
    let firstCause: RequestCause | undefined;
    const abortWith = (cause: RequestCause, reason: unknown): boolean => {
      if (firstCause !== undefined) return false;
      firstCause = cause;
      if (!manualController.signal.aborted) manualController.abort(reason);
      return true;
    };
    const relayCallerAbort = (): void => {
      const reason = abortReason(callerSignal!);
      abortWith({ kind: 'caller', reason }, reason);
      timerController?.abort();
    };
    callerSignal?.addEventListener('abort', relayCallerAbort, { once: true });
    if (callerSignal?.aborted) relayCallerAbort();

    const previous = tail;
    let releaseGate!: () => void;
    const gateReleased = new Promise<void>(resolve => { releaseGate = resolve; });
    tail = gateReleased;

    const causeError = (cause: RequestCause): unknown => {
      if (cause.kind === 'caller') return cause.reason;
      if (cause.kind === 'timeout') return timeoutError(timeoutMs);
      return responseTooLargeError(options.maxResponseBytes);
    };

    const internal = (async (): Promise<Response> => {
      let timeoutWait: Promise<void> | undefined;
      try {
        try {
          await previous;
          if (manualController.signal.aborted) throw abortReason(manualController.signal);
          const now = clock.now();
          const waitMs = lastStartedAt === undefined
            ? 0
            : Math.max(0, minIntervalMs - Math.max(0, now - lastStartedAt));
          if (waitMs > 0) await clock.sleep(waitMs, manualController.signal);
          if (manualController.signal.aborted) throw abortReason(manualController.signal);
          lastStartedAt = clock.now();
        } finally {
          // Only the start gate is serialized; response completion is independent.
          releaseGate();
        }

        timerController = new AbortController();
        timeoutWait = clock.sleep(timeoutMs, timerController.signal).then(() => {
          if (timerController?.signal.aborted || manualController.signal.aborted) return;
          abortWith({ kind: 'timeout' }, TIMEOUT_REASON);
        }).catch(() => undefined);

        try {
          const response = await fetchImpl(input, cloneInit(init, manualController.signal));
          if (firstCause !== undefined) throw causeError(firstCause);
          if (manualController.signal.aborted) throw abortReason(manualController.signal);

          const rawLength = response.headers.get('content-length');
          const contentLength = rawLength === null ? undefined : Number(rawLength);
          if (contentLength !== undefined &&
              Number.isFinite(contentLength) &&
              contentLength >= 0 &&
              contentLength > options.maxResponseBytes) {
            abortWith({ kind: 'size' }, SIZE_REASON);
            throw SIZE_REASON;
          }

          const onSizeExceeded = (): never => {
            abortWith({ kind: 'size' }, SIZE_REASON);
            throw SIZE_REASON;
          };
          await drainClonedBody(
            response,
            manualController.signal,
            options.maxResponseBytes,
            onSizeExceeded,
          );
          if (firstCause !== undefined) throw causeError(firstCause);
          if (manualController.signal.aborted) throw abortReason(manualController.signal);
          return response;
        } catch (error) {
          if (firstCause !== undefined) throw causeError(firstCause);
          if (manualController.signal.aborted) throw abortReason(manualController.signal);
          throw error;
        } finally {
          timerController.abort();
          await timeoutWait;
        }
      } finally {
        callerSignal?.removeEventListener('abort', relayCallerAbort);
      }
    })();

    let removeCallerAbort: (() => void) | undefined;
    if (callerSignal === undefined) return internal;
    const callerAbort = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(
        firstCause === undefined ? abortReason(callerSignal) : causeError(firstCause),
      );
      removeCallerAbort = () => callerSignal.removeEventListener('abort', onAbort);
      callerSignal.addEventListener('abort', onAbort, { once: true });
    });
    const exposed = Promise.race([internal, callerAbort]);
    return exposed.finally(() => { removeCallerAbort?.(); });
  };

  return { request };
};
