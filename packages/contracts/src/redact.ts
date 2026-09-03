const REDACTED_VALUE = '[REDACTED]';
const CIRCULAR_VALUE = '[Circular]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'cookies',
  'setcookie',
  'setcookies',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'musicusertoken',
  'apikey',
  'privatekey',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

export function redactUrl(value: string | URL): string {
  const url = new URL(value instanceof URL ? value.toString() : value);
  const redactedSearch = new URLSearchParams();
  for (const [key] of url.searchParams) {
    redactedSearch.append(key, REDACTED_VALUE);
  }
  url.search = redactedSearch.toString();
  url.hash = '';
  return url.toString();
}

function redactError(error: Error, active: WeakSet<object>): Record<string, unknown> | string {
  if (active.has(error)) {
    return CIRCULAR_VALUE;
  }

  active.add(error);
  try {
    const result: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
    for (const [key, child] of Object.entries(error)) {
      result[key] = isSensitiveKey(key)
        ? REDACTED_VALUE
        : redactValue(child, active);
    }
    if ('cause' in error && !Object.prototype.propertyIsEnumerable.call(error, 'cause')) {
      result.cause = redactValue(error.cause, active);
    }
    return result;
  } finally {
    active.delete(error);
  }
}

function redactValue(value: unknown, active: WeakSet<object>): unknown {
  if (value instanceof URL) {
    return redactUrl(value);
  }
  if (value instanceof Error) {
    return redactError(value, active);
  }
  if (typeof value === 'string') {
    return /^https?:\/\//iu.test(value) ? redactUrl(value) : value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (active.has(value)) {
    return CIRCULAR_VALUE;
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, active));
    }
    if (value instanceof Date) {
      return value.toISOString();
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSensitiveKey(key)
        ? REDACTED_VALUE
        : redactValue(child, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
