export interface AbortableClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Aborted', 'AbortError');

export const systemClock: AbortableClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(new RangeError('sleep duration must be non-negative'));
    }
    if (signal.aborted) return Promise.reject(abortReason(signal));

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const rejectOnce = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(reason);
      };
      function onAbort(): void {
        rejectOnce(abortReason(signal));
      }

      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(resolveOnce, ms);
      if (signal.aborted) onAbort();
    });
  },
};
