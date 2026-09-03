import { describe, expect, it, vi } from 'vitest';
import { APP_ERROR_CODES, AppError } from '@playlist-exporter/contracts';
import { createTaskController } from '../src/task.js';
import type { TaskState } from '../src/task.js';

const abortError = () => new DOMException('Aborted', 'AbortError');
const pathToExporting = (controller: ReturnType<typeof createTaskController>) => {
  expect(controller.transition('validating')).toBe(true);
  expect(controller.transition('fetching')).toBe(true);
  expect(controller.transition('exporting')).toBe(true);
};

describe('createTaskController', () => {
  it('accepts the full legal path including authentication and reaches completed', () => {
    const controller = createTaskController();
    const path: TaskState[] = [
      'validating', 'authenticating', 'fetching', 'preview', 'exporting', 'completed',
    ];
    for (const state of path) expect(controller.transition(state)).toBe(true);
    expect(controller.state).toBe('completed');
    expect(controller.snapshot.state).toBe('completed');
  });

  it('accepts the no-auth fetch/export path', () => {
    const controller = createTaskController();
    pathToExporting(controller);
    expect(controller.complete()).toBe(true);
    expect(controller.state).toBe('completed');
  });

  it('accepts each legal optional-phase skip independently', () => {
    const noAuth = createTaskController();
    expect(noAuth.transition('validating')).toBe(true);
    expect(noAuth.transition('fetching')).toBe(true);
    expect(noAuth.transition('preview')).toBe(true);
    expect(noAuth.transition('exporting')).toBe(true);
    expect(noAuth.complete()).toBe(true);

    const noPreview = createTaskController();
    expect(noPreview.transition('validating')).toBe(true);
    expect(noPreview.transition('authenticating')).toBe(true);
    expect(noPreview.transition('fetching')).toBe(true);
    expect(noPreview.transition('exporting')).toBe(true);
    expect(noPreview.complete()).toBe(true);
  });

  it('rejects an illegal nonterminal transition without changing state', () => {
    const controller = createTaskController();
    expect(() => controller.transition('fetching')).toThrow(RangeError);
    expect(controller.state).toBe('idle');
    expect(() => controller.transition('authenticating')).toThrow(RangeError);
  });

  it('accepts only current-phase progress and ignores late progress', () => {
    const controller = createTaskController();
    expect(controller.updateProgress({ phase: 'idle', completed: 0, total: 1 })).toBe(false);
    expect(controller.transition('validating')).toBe(true);
    const progress = { phase: 'validating', completed: 1, total: 3, message: '检查中' };
    expect(controller.updateProgress(progress)).toBe(true);
    expect(controller.snapshot.progress).toEqual(progress);
    expect(controller.updateProgress({ phase: 'fetching', completed: 1, total: 3 })).toBe(false);
    expect(controller.transition('fetching')).toBe(true);
    expect(controller.updateProgress(progress)).toBe(false);
    expect(controller.transition('exporting')).toBe(true);
    expect(controller.complete()).toBe(true);
    expect(controller.updateProgress({ phase: 'exporting', completed: 3, total: 3 })).toBe(false);
  });

  it('copies and freezes snapshots instead of retaining mutable input', () => {
    const controller = createTaskController();
    controller.transition('validating');
    const update = { phase: 'validating', completed: 1, total: 3, message: 'before' };
    expect(controller.updateProgress(update)).toBe(true);
    update.message = 'after';
    expect(controller.snapshot.progress?.message).toBe('before');
    expect(Object.isFrozen(controller.snapshot)).toBe(true);
    expect(Object.isFrozen(controller.snapshot.progress)).toBe(true);
  });

  it('isolates listener errors and unsubscribes without synchronous initial notice', () => {
    const controller = createTaskController();
    const seen: string[] = [];
    const unsubscribeThrowing = controller.subscribe(() => { throw new Error('listener failed'); });
    const listener = vi.fn((snapshot) => { seen.push(snapshot.state); });
    const unsubscribe = controller.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
    expect(controller.transition('validating')).toBe(true);
    expect(seen).toEqual(['validating']);
    unsubscribeThrowing();
    unsubscribe();
    expect(controller.transition('fetching')).toBe(true);
    expect(seen).toEqual(['validating']);
  });

  it('commits cancellation before aborting and makes terminal methods idempotent', () => {
    const controller = createTaskController();
    let stateWhenAborted: TaskState | undefined;
    controller.signal.addEventListener('abort', () => { stateWhenAborted = controller.state; });
    expect(controller.cancel('user stop')).toBe(true);
    expect(controller.state).toBe('cancelled');
    expect(stateWhenAborted).toBe('cancelled');
    expect(controller.cancel()).toBe(false);
    expect(controller.complete()).toBe(false);
    expect(controller.fail(new Error('late'))).toBe(false);
  });

  it('wraps unknown failures as TASK_FAILED but preserves AppError identity', () => {
    const wrapped = createTaskController();
    expect(wrapped.fail(new Error('boom'))).toBe(true);
    expect(wrapped.snapshot.state).toBe('failed');
    expect(wrapped.snapshot.error).toBeInstanceOf(AppError);
    expect(wrapped.snapshot.error?.code).toBe(APP_ERROR_CODES.TASK_FAILED);

    const original = new AppError({ code: 'PROVIDER_FAILURE', message: 'provider failed' });
    const preserved = createTaskController();
    expect(preserved.fail(original)).toBe(true);
    expect(preserved.snapshot.error).toBe(original);
  });

  it('handles pre-aborted and late external signals without terminal rollback', () => {
    const before = new AbortController();
    before.abort(abortError());
    const cancelled = createTaskController({ signal: before.signal });
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.signal.aborted).toBe(true);

    const external = new AbortController();
    const completed = createTaskController({ signal: external.signal });
    pathToExporting(completed);
    expect(completed.complete()).toBe(true);
    external.abort(abortError());
    expect(completed.state).toBe('completed');
  });

  it('cancels an active task once on external abort and ignores late signals', () => {
    const external = new AbortController();
    const seen: TaskState[] = [];
    const controller = createTaskController({
      signal: external.signal,
      onStateChange: (snapshot) => seen.push(snapshot.state),
    });
    expect(controller.transition('validating')).toBe(true);
    external.abort(abortError());
    expect(controller.state).toBe('cancelled');
    expect(seen).toEqual(['validating', 'cancelled']);
    expect(controller.complete()).toBe(false);
    expect(controller.fail(new Error('late'))).toBe(false);
    expect(controller.updateProgress({
      phase: 'validating',
      completed: 1,
      total: 1,
    })).toBe(false);
    expect(controller.snapshot.state).toBe('cancelled');
  });

  it('emits immutable snapshots and rejects rollback transitions', () => {
    const snapshots: Array<{ state: TaskState }> = [];
    const controller = createTaskController({
      onStateChange: (snapshot) => snapshots.push(snapshot),
    });
    expect(controller.transition('validating')).toBe(true);
    expect(controller.transition('fetching')).toBe(true);
    expect(snapshots.map((snapshot) => snapshot.state)).toEqual(['validating', 'fetching']);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(() => controller.transition('validating')).toThrow(RangeError);
    expect(controller.state).toBe('fetching');
  });
});
