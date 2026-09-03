import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, AppError } from '@playlist-exporter/contracts';
import { createPaginationGuard } from '../src/pagination.js';

const all = {
  maxPages: 10,
  maxEntries: 100,
  allowedTerminalPolicies: ['short-page', 'next-absent'] as const,
};

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected throw');
}

describe('PaginationGuard', () => {
  it('finishes an empty known-total traversal without a request', () => {
    const guard = createPaginationGuard(all);
    const result = guard.finish({ kind: 'expected-total', expectedTotal: 0 });
    expect(result).toMatchObject({
      complete: true,
      pages: 0,
      entries: 0,
      expectedTotal: 0,
      terminationReason: 'expected-total',
    });
  });

  it('completes exactly at an immutable expected total', () => {
    const guard = createPaginationGuard(all);
    guard.beforePage({ requestKey: 'offset:0', requestedSize: 2 });
    guard.recordPage({ rawItemCount: 2, expectedTotal: 3, nextRequestKey: 'offset:2' });
    guard.beforePage({ requestKey: 'offset:2', requestedSize: 2 });
    guard.recordPage({ rawItemCount: 1, nextRequestKey: null });
    const complete = {
      complete: true,
      pages: 2,
      entries: 3,
      expectedTotal: 3,
      terminationReason: 'expected-total',
    };
    expect(guard.finish({ kind: 'expected-total' })).toEqual(complete);
    expect(guard.snapshot()).toEqual(complete);
    expect(() => guard.assertComplete()).not.toThrow();
  });

  it('allows a short page only when no total is known', () => {
    const guard = createPaginationGuard(all);
    guard.beforePage({ requestKey: 'page-1', requestedSize: 3 });
    guard.recordPage({ rawItemCount: 2, nextRequestKey: null });
    expect(guard.finish({ kind: 'short-page' })).toEqual({
      complete: true, pages: 1, entries: 2, terminationReason: 'short-page',
    });
  });

  it('rejects a short-page finish when a next request key exists', () => {
    const guard = createPaginationGuard(all);
    guard.beforePage({ requestKey: 'page-1', requestedSize: 3 });
    guard.recordPage({ rawItemCount: 2, nextRequestKey: 'page-2' });

    const error = thrownBy(() => guard.finish({ kind: 'short-page' })) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
    expect(error.technicalDetails).toMatchObject({ reason: 'CONFLICTING_CONTINUATION_EVIDENCE' });
  });

  it.each(['short-page', 'next-absent'] as const)(
    'does not let %s override a known mismatch',
    (kind) => {
      const guard = createPaginationGuard(all);
      guard.beforePage({ requestKey: 'offset:0', requestedSize: 3 });
      guard.recordPage({ rawItemCount: 2, expectedTotal: 5, nextRequestKey: null });
      expect(guard.finish({ kind })).toMatchObject({
        complete: false, entries: 2, expectedTotal: 5, terminationReason: 'total-mismatch',
      });
      const error = thrownBy(() => guard.assertComplete()) as AppError;
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
    },
  );

  it('rejects repeated request keys and self loops as incomplete pagination', () => {
    const guard = createPaginationGuard(all);
    const error = thrownBy(() => {
      guard.beforePage({ requestKey: 'offset:0', requestedSize: 2 });
      guard.recordPage({ rawItemCount: 2, expectedTotal: 4, nextRequestKey: 'offset:0' });
      guard.beforePage({ requestKey: 'offset:0', requestedSize: 2 });
    }) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
  });

  it('rejects total drift without exposing request keys', () => {
    const guard = createPaginationGuard(all);
    guard.beforePage({ requestKey: 'offset:0', requestedSize: 2 });
    guard.recordPage({ rawItemCount: 2, expectedTotal: 4, nextRequestKey: 'offset:2' });
    guard.beforePage({ requestKey: 'offset:2', requestedSize: 2 });
    const error = thrownBy(() => guard.recordPage({
      rawItemCount: 2, expectedTotal: 5, nextRequestKey: null,
    })) as AppError;
    expect(error.code).toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
    expect(JSON.stringify(error.toJSON())).not.toContain('offset:');
  });

  it('treats a conflicting finish total as an incomplete mismatch', () => {
    const guard = createPaginationGuard(all);
    guard.beforePage({ requestKey: 'p1', requestedSize: 2 });
    guard.recordPage({ rawItemCount: 2, expectedTotal: 2, nextRequestKey: null });
    expect(guard.finish({ kind: 'expected-total', expectedTotal: 3 })).toMatchObject({
      complete: false, expectedTotal: 2, terminationReason: 'total-mismatch',
    });
    expect(() => guard.assertComplete()).toThrow(AppError);
  });

  it('enforces page and entry budgets before unproven completion', () => {
    const pages = createPaginationGuard({ maxPages: 1, maxEntries: 100 });
    pages.beforePage({ requestKey: 'p1', requestedSize: 10 });
    pages.recordPage({ rawItemCount: 10, expectedTotal: 20, nextRequestKey: 'p2' });
    expect((thrownBy(() => pages.beforePage({ requestKey: 'p2', requestedSize: 10 })) as AppError).code)
      .toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);

    const entries = createPaginationGuard({ maxPages: 10, maxEntries: 2 });
    entries.beforePage({ requestKey: 'p1', requestedSize: 3 });
    expect((thrownBy(() => entries.recordPage({ rawItemCount: 3, expectedTotal: 3 })) as AppError).code)
      .toBe(APP_ERROR_CODES.INCOMPLETE_PAGINATION);
  });

  it('counts duplicate positions rather than deduplicating them', () => {
    const guard = createPaginationGuard(all);
    guard.beforePage({ requestKey: 'p1', requestedSize: 2 });
    guard.recordPage({ rawItemCount: 2, expectedTotal: 2, nextRequestKey: null });
    expect(guard.finish({ kind: 'expected-total' })).toMatchObject({ complete: true, entries: 2 });
  });

  it('rejects invalid limits and requests', () => {
    expect(() => createPaginationGuard({ maxPages: 0, maxEntries: 1 })).toThrow(RangeError);
    expect(() => createPaginationGuard({ maxPages: 1, maxEntries: 0 })).toThrow(RangeError);
    const guard = createPaginationGuard(all);
    expect(() => guard.beforePage({ requestKey: '', requestedSize: 1 })).toThrow(RangeError);
    expect(() => guard.beforePage({ requestKey: 'p1', requestedSize: 0 })).toThrow(RangeError);
  });
});
