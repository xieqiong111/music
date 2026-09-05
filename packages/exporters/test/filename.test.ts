import { describe, expect, it } from 'vitest';
import { exportPlaylist, sanitizeFilename } from '../src/index.js';
import { playlist } from './fixtures.js';
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

  it('preserves whole Unicode characters within filesystem byte limits', () => {
    const sanitized = sanitizeFilename(`${'歌'.repeat(179)}🌙`);

    expect(new TextEncoder().encode(sanitized).length).toBeLessThanOrEqual(240);
    expect(sanitized).not.toContain('\ufffd');
    expect(sanitizeFilename('歌🌙')).toBe('歌🌙');
  });

  it('preserves date and extension for long Unicode playlist names', () => {
    const artifact = exportPlaylist({ ...playlist, name: '🌙'.repeat(180) }, {
      format: 'json', date: '2026-09-05',
    });
    expect(new TextEncoder().encode(artifact.filename).length).toBeLessThanOrEqual(255);
    expect(artifact.filename).toMatch(/_2026-09-05\.json$/u);
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
