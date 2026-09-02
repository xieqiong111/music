export type TechnicalDetails = Readonly<Record<string, unknown>>;

export interface AppErrorInit {
  readonly code: string;
  readonly message: string;
  readonly technicalDetails?: TechnicalDetails;
  readonly cause?: unknown;
}

/** Structured, user-safe application error with optional redacted diagnostics. */
export class AppError extends Error {
  readonly code: string;
  readonly technicalDetails?: TechnicalDetails;

  constructor(init: AppErrorInit);
  constructor(code: string, message: string, technicalDetails?: TechnicalDetails);
  constructor(
    initOrCode: AppErrorInit | string,
    message?: string,
    technicalDetails?: TechnicalDetails,
  ) {
    if (typeof initOrCode === 'string') {
      super(message ?? initOrCode);
      this.code = initOrCode;
      this.technicalDetails = technicalDetails;
    } else {
      super(initOrCode.message, { cause: initOrCode.cause });
      this.code = initOrCode.code;
      this.technicalDetails = initOrCode.technicalDetails;
    }

    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { code: string; message: string; technicalDetails?: TechnicalDetails } {
    return {
      code: this.code,
      message: this.message,
      ...(this.technicalDetails === undefined ? {} : { technicalDetails: this.technicalDetails }),
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
