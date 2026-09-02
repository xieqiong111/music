export const APP_ERROR_CODES = Object.freeze({
  INCOMPLETE_PAGINATION: 'INCOMPLETE_PAGINATION',
} as const);

export type AppErrorCode =
  | (typeof APP_ERROR_CODES)[keyof typeof APP_ERROR_CODES]
  | (string & {});

export type TechnicalDetails = Readonly<Record<string, unknown>>;

export interface AppErrorInit {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly technicalDetails?: TechnicalDetails;
  readonly cause?: unknown;
}

const REDACTED_VALUE = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (normalized === 'authorization') {
    return true;
  }

  if (/^(?:set)?cookies?$/.test(normalized)) {
    return true;
  }

  return /^(?:access|refresh|id|musicuser)?tokens?$/.test(normalized);
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing;
    }

    const redacted: unknown[] = [];
    seen.set(value, redacted);
    for (const item of value) {
      redacted.push(redactValue(item, seen));
    }
    return redacted;
  }

  if (value !== null && typeof value === 'object') {
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing;
    }

    const redacted: Record<string, unknown> = {};
    seen.set(value, redacted);
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key)
        ? REDACTED_VALUE
        : redactValue(child, seen);
    }
    return redacted;
  }

  return value;
}

function redactTechnicalDetails(details: TechnicalDetails | undefined): TechnicalDetails | undefined {
  if (details === undefined) {
    return undefined;
  }

  return redactValue(details, new WeakMap<object, unknown>()) as TechnicalDetails;
}

/** Structured, user-safe application error with redacted diagnostics. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly technicalDetails?: TechnicalDetails;

  constructor(init: AppErrorInit);
  constructor(code: AppErrorCode, message: string, technicalDetails?: TechnicalDetails);
  constructor(
    initOrCode: AppErrorInit | AppErrorCode,
    message?: string,
    technicalDetails?: TechnicalDetails,
  ) {
    if (typeof initOrCode === 'string') {
      super(message ?? initOrCode);
      this.code = initOrCode;
      this.technicalDetails = redactTechnicalDetails(technicalDetails);
    } else {
      super(initOrCode.message, { cause: initOrCode.cause });
      this.code = initOrCode.code;
      this.technicalDetails = redactTechnicalDetails(initOrCode.technicalDetails);
    }

    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { code: AppErrorCode; message: string; technicalDetails?: TechnicalDetails } {
    return {
      code: this.code,
      message: this.message,
      ...(this.technicalDetails === undefined
        ? {}
        : { technicalDetails: redactTechnicalDetails(this.technicalDetails) }),
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
