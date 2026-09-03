import { APP_ERROR_CODES, AppError, isAppError } from '@playlist-exporter/contracts';
import type { AbortableClock } from './clock.js';
import { systemClock } from './clock.js';

export interface RetryAttemptContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
}

export interface RetryDecisionContext {
  readonly response?: Response;
  readonly error?: unknown;
  readonly attempt: number;
}

export interface RetryOptions {
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly clock?: AbortableClock;
  readonly shouldRetry?: (context: RetryDecisionContext) => boolean;
  readonly onRetry?: (event: { attempt: number; delayMs: number; status?: number }) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
const isAbortError = (value: unknown): boolean =>
  value instanceof DOMException ? value.name === 'AbortError' :
    typeof value === 'object' && value !== null && 'name' in value &&
    (value as { name?: unknown }).name === 'AbortError';
const abortReason = (signal: AbortSignal): unknown => {
  const reason = signal.reason;
  return isAbortError(reason) ? reason : abortError();
};
const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const retryAfterMs = (response: Response, now: number): number | undefined => {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date) && date > now) return date - now;
  return undefined;
};

const defaultShouldRetry = (context: RetryDecisionContext): boolean =>
  context.response?.status === 429 || context.error instanceof TypeError ||
  (isAppError(context.error) && context.error.code === APP_ERROR_CODES.HTTP_TIMEOUT);

const networkFailure = (error: unknown, attempts: number): AppError =>
  new AppError({
    code: APP_ERROR_CODES.NETWORK_ERROR,
    message: '网络请求失败',
    technicalDetails: { attempts },
    cause: error,
  });

const cancelBodyWithAbort = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> => {
  let cancellation: Promise<void>;
  try {
    cancellation = body.cancel().catch(() => undefined);
  } catch {
    return;
  }
  if (signal.aborted) throw abortReason(signal);

  let removeAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    removeAbort = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([cancellation, aborted]);
  } finally {
    removeAbort?.();
  }
};

export const fetchWithRetry = async (
  request: (context: RetryAttemptContext) => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> => {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (!isPositiveInteger(maxAttempts)) throw new RangeError('maxAttempts must be positive');
  if (!isFiniteNonnegative(baseDelayMs)) throw new RangeError('baseDelayMs must be non-negative');
  if (!isFiniteNonnegative(maxDelayMs)) throw new RangeError('maxDelayMs must be non-negative');

  const clock = options.clock ?? systemClock;
  const controller = new AbortController();
  const callerSignal = options.signal;
  const relayCallerAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(abortReason(callerSignal!));
  };
  if (callerSignal !== undefined) {
    callerSignal.addEventListener('abort', relayCallerAbort, { once: true });
    if (callerSignal.aborted) relayCallerAbort();
  }

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      let response: Response | undefined;
      let error: unknown;
      let hasError = false;
      try {
        response = await request({ signal: controller.signal, attempt });
      } catch (caught) {
        hasError = true;
        error = caught;
        if (controller.signal.aborted || isAbortError(caught)) {
          throw controller.signal.aborted ? abortReason(controller.signal) : caught;
        }
      }

      const decision: RetryDecisionContext = { response, error, attempt };
      const retry = options.shouldRetry?.(decision) ?? defaultShouldRetry(decision);
      if (!retry || attempt >= maxAttempts) {
        if (hasError) {
          if (error instanceof TypeError) throw networkFailure(error, attempt);
          throw error;
        }
        return response!;
      }

      if (response?.body !== null && response?.body !== undefined) {
        await cancelBodyWithAbort(response.body, controller.signal);
      }
      if (controller.signal.aborted) throw abortReason(controller.signal);
      const retryAfter = response === undefined ? undefined : retryAfterMs(response, clock.now());
      const exponential = baseDelayMs * (2 ** (attempt - 1));
      const uncappedDelay = retryAfter ?? (Number.isFinite(exponential) ? exponential : maxDelayMs);
      const delayMs = Math.min(maxDelayMs, Math.max(0, uncappedDelay));
      if (controller.signal.aborted) throw abortReason(controller.signal);
      options.onRetry?.({ attempt, delayMs, ...(response === undefined ? {} : { status: response.status }) });
      if (controller.signal.aborted) throw abortReason(controller.signal);
      await clock.sleep(delayMs, controller.signal);
    }
    throw new Error('retry loop exhausted');
  } finally {
    callerSignal?.removeEventListener('abort', relayCallerAbort);
  }
};
