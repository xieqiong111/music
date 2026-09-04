import { describe, expect, it } from 'vitest';
import {
  constantTimeTokenEqual,
  hasValidBearer,
  isAllowedOrigin,
} from '../src/auth.js';

describe('server access checks', () => {
  it('compares tokens through a fixed-length digest', () => {
    expect(constantTimeTokenEqual('secret', 'secret')).toBe(true);
    expect(constantTimeTokenEqual('secret', 'Secret')).toBe(false);
    expect(constantTimeTokenEqual('secret', '')).toBe(false);
    expect(constantTimeTokenEqual('secret', 'x'.repeat(20_000))).toBe(false);
  });

  it('accepts only one strict bearer credential', () => {
    expect(hasValidBearer('Bearer secret', 'secret')).toBe(true);
    expect(hasValidBearer('bearer secret', 'secret')).toBe(true);
    for (const header of [
      undefined,
      '',
      'Basic secret',
      'Bearer',
      'Bearer secret extra',
      'Bearer  secret',
      'Bearer wrong',
    ]) {
      expect(hasValidBearer(header, 'secret')).toBe(false);
    }
  });

  it('does not require bearer auth when no token is configured', () => {
    expect(hasValidBearer(undefined, undefined)).toBe(true);
    expect(hasValidBearer('anything', undefined)).toBe(true);
  });

  it('matches origins exactly and rejects null or prefix lookalikes', () => {
    const allowed = ['https://nas.example', 'http://127.0.0.1:4319'];
    expect(isAllowedOrigin('https://nas.example', allowed)).toBe(true);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('https://nas.example.evil', allowed)).toBe(false);
    expect(isAllowedOrigin('http://nas.example', allowed)).toBe(false);
  });
});
