import { describe, expect, it } from 'vitest';
import { exportPlaylist, sanitizeFilename } from '@playlist-exporter/exporters';
import { playlist } from './fixtures.js';

describe('exporters package public API', () => {
  it('exports the exporter and sanitizer through the package map', () => {
    expect(exportPlaylist).toBeTypeOf('function');
    expect(sanitizeFilename).toBeTypeOf('function');
    expect(sanitizeFilename('a/b')).toBe('a_b');
    expect(
      exportPlaylist(playlist, { format: 'txt', date: '2026-09-03' }).format,
    ).toBe('txt');
  });
});
