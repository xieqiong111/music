import { APP_ERROR_CODES, AppError } from '@playlist-exporter/contracts';

export type PaginationFinishKind = 'expected-total' | 'short-page' | 'next-absent';
export type PaginationTerminationReason = PaginationFinishKind | 'total-mismatch';

export interface PaginationGuardOptions {
  maxPages: number;
  maxEntries: number;
  allowedTerminalPolicies?: readonly Exclude<PaginationFinishKind, 'expected-total'>[];
}

export interface PaginationSnapshot {
  readonly complete: boolean;
  readonly pages: number;
  readonly entries: number;
  readonly expectedTotal?: number;
  readonly terminationReason?: PaginationTerminationReason;
}

interface PendingPage {
  readonly requestKey: string;
  readonly requestedSize: number;
}

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

const validateNonnegativeInteger = (value: unknown, name: string): number => {
  if (!isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
};

const validatePositiveInteger = (value: unknown, name: string): number => {
  if (!isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
};

const isFinishKind = (value: unknown): value is PaginationFinishKind =>
  value === 'expected-total' || value === 'short-page' || value === 'next-absent';

export class PaginationGuard {
  private readonly maxPages: number;
  private readonly maxEntries: number;
  private readonly allowedTerminalPolicies: ReadonlySet<'short-page' | 'next-absent'>;
  private readonly requestedKeys = new Set<string>();
  private pages = 0;
  private entries = 0;
  private expectedTotal: number | undefined;
  private pending: PendingPage | undefined;
  private lastRawItemCount: number | undefined;
  private lastRequestedSize: number | undefined;
  private lastNextRequestKey: string | null | undefined;
  private complete = false;
  private ended = false;
  private terminationReason: PaginationTerminationReason | undefined;

  public constructor(options: PaginationGuardOptions) {
    if (options === null || typeof options !== 'object') {
      throw new RangeError('pagination options are required');
    }
    this.maxPages = validatePositiveInteger(options.maxPages, 'maxPages');
    this.maxEntries = validatePositiveInteger(options.maxEntries, 'maxEntries');

    const policies = options.allowedTerminalPolicies ?? [];
    if (!Array.isArray(policies)) throw new RangeError('allowedTerminalPolicies must be an array');
    const set = new Set<'short-page' | 'next-absent'>();
    for (const policy of policies) {
      if (policy !== 'short-page' && policy !== 'next-absent') {
        throw new RangeError('unsupported pagination terminal policy');
      }
      if (set.has(policy)) throw new RangeError('duplicate pagination terminal policy');
      set.add(policy);
    }
    this.allowedTerminalPolicies = set;
  }

  public beforePage(input: { requestKey: string; requestedSize: number }): void {
    if (input === null || typeof input !== 'object') throw new RangeError('page request is required');
    if (typeof input.requestKey !== 'string' || input.requestKey.trim() === '') {
      throw new RangeError('requestKey must be a nonblank string');
    }
    const requestedSize = validatePositiveInteger(input.requestedSize, 'requestedSize');
    if (this.pending !== undefined) throw new RangeError('a page is already pending');
    if (this.ended) throw this.incompleteError('pagination has already ended');
    if (this.pages >= this.maxPages) throw this.failIncomplete('pagination page budget exceeded');
    if (this.requestedKeys.has(input.requestKey)) {
      throw this.failIncomplete('pagination request stalled or repeated');
    }
    this.requestedKeys.add(input.requestKey);
    this.pending = { requestKey: input.requestKey, requestedSize };
  }

  public recordPage(input: {
    rawItemCount: number;
    expectedTotal?: number;
    nextRequestKey?: string | null;
  }): PaginationSnapshot {
    if (input === null || typeof input !== 'object') throw new RangeError('page observation is required');
    if (this.ended) throw this.incompleteError('pagination has already ended');
    if (this.pending === undefined) throw new RangeError('beforePage must precede recordPage');
    const rawItemCount = validateNonnegativeInteger(input.rawItemCount, 'rawItemCount');
    if (input.expectedTotal !== undefined) {
      const expectedTotal = validateNonnegativeInteger(input.expectedTotal, 'expectedTotal');
      if (this.expectedTotal === undefined) this.expectedTotal = expectedTotal;
      else if (this.expectedTotal !== expectedTotal) {
        throw this.failIncomplete('pagination total changed between pages');
      }
    }
    if (input.nextRequestKey !== undefined && input.nextRequestKey !== null &&
        (typeof input.nextRequestKey !== 'string' || input.nextRequestKey.trim() === '')) {
      throw new RangeError('nextRequestKey must be a nonblank string or null');
    }
    const nextEntries = this.entries + rawItemCount;
    if (nextEntries > this.maxEntries) throw this.failIncomplete('pagination entry budget exceeded');
    if (this.expectedTotal !== undefined && nextEntries > this.expectedTotal) {
      throw this.failIncomplete('pagination entries exceed expected total');
    }

    this.pages += 1;
    this.entries = nextEntries;
    this.lastRawItemCount = rawItemCount;
    this.lastRequestedSize = this.pending.requestedSize;
    this.lastNextRequestKey = input.nextRequestKey;
    this.pending = undefined;
    return this.snapshot();
  }

  public finish(input: { kind: PaginationFinishKind; expectedTotal?: number }): PaginationSnapshot {
    if (input === null || typeof input !== 'object' || !isFinishKind(input.kind)) {
      throw new RangeError('invalid pagination finish kind');
    }
    if (input.expectedTotal !== undefined) {
      validateNonnegativeInteger(input.expectedTotal, 'expectedTotal');
      if (input.kind !== 'expected-total') {
        throw new RangeError('expectedTotal is only valid with expected-total');
      }
    }
    if (this.pending !== undefined) throw new RangeError('cannot finish while a page is pending');
    if (this.ended) return this.snapshot();
    if (input.kind !== 'expected-total' && !this.allowedTerminalPolicies.has(input.kind)) {
      throw new RangeError(`terminal policy ${input.kind} is not enabled`);
    }
    if (typeof this.lastNextRequestKey === 'string') {
      throw this.failIncomplete(
        'pagination finish conflicts with a continuation key',
        'CONFLICTING_CONTINUATION_EVIDENCE',
      );
    }
    if (input.expectedTotal !== undefined) {
      if (this.expectedTotal === undefined) this.expectedTotal = input.expectedTotal;
      else if (this.expectedTotal !== input.expectedTotal) return this.markMismatch();
    }

    const evidenceValid = input.kind === 'expected-total'
      ? this.expectedTotal !== undefined && this.entries === this.expectedTotal
      : input.kind === 'short-page'
        ? this.lastRawItemCount !== undefined && this.lastRequestedSize !== undefined &&
          this.lastRawItemCount < this.lastRequestedSize
        : this.lastNextRequestKey === null;
    const totalValid = this.expectedTotal === undefined || this.entries === this.expectedTotal;
    if (!evidenceValid || !totalValid) return this.markMismatch();

    this.complete = true;
    this.ended = true;
    this.terminationReason = input.kind;
    return this.snapshot();
  }

  public snapshot(): PaginationSnapshot {
    const result: PaginationSnapshot = {
      complete: this.complete,
      pages: this.pages,
      entries: this.entries,
      ...(this.expectedTotal === undefined ? {} : { expectedTotal: this.expectedTotal }),
      ...(this.terminationReason === undefined ? {} : { terminationReason: this.terminationReason }),
    };
    return Object.freeze(result);
  }

  public assertComplete(): void {
    if (this.complete) return;
    throw this.incompleteError('pagination did not prove a complete result');
  }

  private markMismatch(): PaginationSnapshot {
    this.complete = false;
    this.ended = true;
    this.terminationReason = 'total-mismatch';
    return this.snapshot();
  }

  private failIncomplete(message: string, reason?: string): AppError {
    this.complete = false;
    this.ended = true;
    this.terminationReason = 'total-mismatch';
    return this.incompleteError(message, reason);
  }

  private incompleteError(message: string, reason?: string): AppError {
    const technicalDetails: Record<string, unknown> = {
      pages: this.pages,
      entries: this.entries,
    };
    if (this.expectedTotal !== undefined) technicalDetails.expectedTotal = this.expectedTotal;
    const resolvedReason = reason ?? this.terminationReason;
    if (resolvedReason !== undefined) technicalDetails.reason = resolvedReason;
    return new AppError({ code: APP_ERROR_CODES.INCOMPLETE_PAGINATION, message, technicalDetails });
  }
}

export const createPaginationGuard = (options: PaginationGuardOptions): PaginationGuard =>
  new PaginationGuard(options);
