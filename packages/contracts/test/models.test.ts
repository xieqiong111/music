import { describe, expect, it } from 'vitest';
import { trackSchema } from '../src/index.js';

describe('trackSchema', () => {
  it('rejects a track without a title', () => {
    expect(() => trackSchema.parse({ artists: ['A'], source: 'netease', position: 0 })).toThrow();
  });

  it('accepts unicode and duplicate artist names without normalization loss', () => {
    const value = trackSchema.parse({
      title: '夜に駆ける 🌙',
      artists: ['YOASOBI', 'YOASOBI'],
      source: 'netease',
      position: 0,
      availability: 'available',
      warnings: [],
    });
    expect(value.artists).toEqual(['YOASOBI', 'YOASOBI']);
  });
});
