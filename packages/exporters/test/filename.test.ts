import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../src/index.js';

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
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('...')).toBe('untitled');
  });
});
