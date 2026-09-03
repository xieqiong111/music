import { redactSensitive } from './redact.js';

export const APP_ERROR_CODES = Object.freeze({
  HTTP_TIMEOUT: 'HTTP_TIMEOUT',
  INCOMPLETE_PAGINATION: 'INCOMPLETE_PAGINATION',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TASK_FAILED: 'TASK_FAILED',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
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
      this.technicalDetails = technicalDetails === undefined
        ? undefined
        : redactSensitive(technicalDetails) as TechnicalDetails;
    } else {
      super(initOrCode.message, { cause: initOrCode.cause });
      this.code = initOrCode.code;
      this.technicalDetails = initOrCode.technicalDetails === undefined
        ? undefined
        : redactSensitive(initOrCode.technicalDetails) as TechnicalDetails;
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
        : { technicalDetails: redactSensitive(this.technicalDetails) as TechnicalDetails }),
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
