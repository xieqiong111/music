import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../src/index.js';
import { formatLocalDate } from '../src/options.js';

describe('filename sanitization', () => {
  it('removes cross-platform invalid characters, controls, and trailing separators', () => {
    const sanitized = sanitizeFilename('歌单<>:"/\\|?*\u0000名称. ');

    expect(sanitized).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/u);
    expect(sanitized).not.toMatch(/[. ]$/u);
    expect(sanitized).toContain('歌单');
    expect(sanitized).toContain('名称');
  });

  it('avoids Windows reserved device names', () => {
    for (const name of ['CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
      expect(sanitizeFilename(name).replace(/\.txt$/iu, '').toUpperCase()).not.toBe(name.replace(/\.txt$/iu, '').toUpperCase());
    }
  });

  it('preserves Unicode and limits by code points to 180', () => {
    const sanitized = sanitizeFilename(`${'歌'.repeat(179)}🌙`);

    expect(Array.from(sanitized)).toHaveLength(180);
    expect(sanitized.endsWith('🌙')).toBe(true);
  });

  it('returns a usable fallback for an empty or fully invalid name', () => {
    expect(sanitizeFilename('')).toBe('未命名');
    expect(sanitizeFilename('...')).toBe('未命名');
  });

  it('neutralizes traversal separators', () => {
    const value = sanitizeFilename('../secret\\track');
    expect(value).not.toMatch(/[\\/]/u);
    expect(value).not.toBe('..');
  });

  it('formats an injected local calendar date without using UTC date fields', () => {
    const fakeLocalDate = {
      getFullYear: () => 2026,
      getMonth: () => 8,
      getDate: () => 2,
    } as Date;

    expect(formatLocalDate(fakeLocalDate)).toBe('2026-09-02');
  });
});
