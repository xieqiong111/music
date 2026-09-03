import { APP_ERROR_CODES, AppError, isAppError } from '@playlist-exporter/contracts';
import type { ProgressUpdate } from '@playlist-exporter/contracts';

export type TaskState =
  | 'idle'
  | 'validating'
  | 'authenticating'
  | 'fetching'
  | 'preview'
  | 'exporting'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface TaskSnapshot {
  readonly state: TaskState;
  readonly progress?: ProgressUpdate;
  readonly error?: AppError;
}

export interface TaskControllerOptions {
  readonly signal?: AbortSignal;
  readonly onStateChange?: (snapshot: TaskSnapshot) => void;
}

export interface TaskController {
  readonly signal: AbortSignal;
  readonly state: TaskState;
  readonly snapshot: TaskSnapshot;
  transition(next: TaskState): boolean;
  updateProgress(update: ProgressUpdate): boolean;
  cancel(reason?: string): boolean;
  fail(error: unknown): boolean;
  complete(): boolean;
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void;
}

const TASK_STATES: ReadonlySet<string> = new Set([
  'idle', 'validating', 'authenticating', 'fetching', 'preview',
  'exporting', 'completed', 'cancelled', 'failed',
]);
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'cancelled', 'failed']);
const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  idle: ['validating', 'cancelled', 'failed'],
  validating: ['authenticating', 'fetching', 'cancelled', 'failed'],
  authenticating: ['fetching', 'cancelled', 'failed'],
  fetching: ['preview', 'exporting', 'cancelled', 'failed'],
  preview: ['exporting', 'cancelled', 'failed'],
  exporting: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

const cloneProgress = (update: ProgressUpdate): ProgressUpdate =>
  Object.freeze({ ...update });
const standardAbortError = (reason?: string): DOMException =>
  new DOMException(reason?.trim() || 'Aborted', 'AbortError');
const isTaskState = (value: unknown): value is TaskState =>
  typeof value === 'string' && TASK_STATES.has(value);

export const createTaskController = (options: TaskControllerOptions = {}): TaskController => {
  const abortController = new AbortController();
  const listeners = new Set<(snapshot: TaskSnapshot) => void>();
  let state: TaskState = 'idle';
  let progress: ProgressUpdate | undefined;
  let error: AppError | undefined;
  let snapshot: TaskSnapshot = Object.freeze({ state });
  let terminal = false;
  let externalAbortHandler: (() => void) | undefined;

  const detachExternalSignal = (): void => {
    if (externalAbortHandler !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener('abort', externalAbortHandler);
      externalAbortHandler = undefined;
    }
  };
  const refreshSnapshot = (): void => {
    snapshot = Object.freeze({
      state,
      ...(progress === undefined ? {} : { progress }),
      ...(error === undefined ? {} : { error }),
    });
  };
  const notify = (): void => {
    const current = snapshot;
    try { options.onStateChange?.(current); } catch { /* listener isolation */ }
    for (const listener of [...listeners]) {
      try { listener(current); } catch { /* listener isolation */ }
    }
  };
  const commitNonterminal = (next: TaskState): void => {
    state = next;
    refreshSnapshot();
    notify();
  };
  const commitTerminal = (
    next: 'completed' | 'cancelled' | 'failed',
    nextError?: AppError,
    abortReason?: unknown,
  ): void => {
    state = next;
    terminal = true;
    error = nextError;
    detachExternalSignal();
    refreshSnapshot();
    notify();
    if (next === 'cancelled') abortController.abort(abortReason ?? standardAbortError());
    if (next === 'failed') abortController.abort(abortReason ?? nextError);
  };

  function cancel(reason?: string): boolean {
    if (terminal) return false;
    commitTerminal('cancelled', undefined, standardAbortError(reason));
    return true;
  }
  function fail(failure: unknown): boolean {
    if (terminal) return false;
    const appError = isAppError(failure)
      ? failure
      : new AppError({ code: APP_ERROR_CODES.TASK_FAILED, message: '任务失败', cause: failure });
    commitTerminal('failed', appError, appError);
    return true;
  }
  function complete(): boolean {
    if (terminal) return false;
    if (!LEGAL_TRANSITIONS[state].includes('completed')) {
      throw new RangeError(`cannot complete task from ${state}`);
    }
    commitTerminal('completed');
    return true;
  }
  function transition(next: TaskState): boolean {
    if (!isTaskState(next)) throw new RangeError('invalid task state');
    if (terminal) return false;
    if (!LEGAL_TRANSITIONS[state].includes(next)) {
      throw new RangeError(`invalid task transition ${state} -> ${next}`);
    }
    if (next === 'cancelled') return cancel();
    if (next === 'failed') return fail(new AppError({
      code: APP_ERROR_CODES.TASK_FAILED,
      message: '任务失败',
    }));
    if (next === 'completed') return complete();
    commitNonterminal(next);
    return true;
  }
  function updateProgress(update: ProgressUpdate): boolean {
    if (terminal || state === 'idle' || update === null || typeof update !== 'object' ||
        typeof update.phase !== 'string' || update.phase !== state) return false;
    progress = cloneProgress(update);
    refreshSnapshot();
    notify();
    return true;
  }
  function subscribe(listener: (nextSnapshot: TaskSnapshot) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  if (options.signal !== undefined) {
    externalAbortHandler = () => {
      if (!terminal) cancel();
    };
    options.signal.addEventListener('abort', externalAbortHandler, { once: true });
    if (options.signal.aborted) externalAbortHandler();
  }

  return {
    get signal(): AbortSignal { return abortController.signal; },
    get state(): TaskState { return state; },
    get snapshot(): TaskSnapshot { return snapshot; },
    transition,
    updateProgress,
    cancel,
    fail,
    complete,
    subscribe,
  };
};
