import { describe, expect, it } from 'vitest';
import { redactSensitive, redactUrl } from '../src/redact.js';

describe('core redaction exports', () => {
  it('re-exports the single contracts redaction implementation', () => {
    expect(redactSensitive({ token: 'secret', pageKey: 'p1' })).toEqual({
      token: '[REDACTED]',
      pageKey: 'p1',
    });
    expect(redactUrl('https://example.test/?x=1')).not.toContain('=1');
  });
});
