import { describe, expect, it } from 'vitest';
import { parseQqPlaylistInput } from '../src/input.js';

describe('parseQqPlaylistInput', () => {
  it.each([
    ['123456789', '123456789'],
    ['https://y.qq.com/n/ryqq/playlist/123456789', '123456789'],
    ['https://y.qq.com/playlist/123456789', '123456789'],
    ['https://y.qq.com/n/yqq/playlist/123456789.html', '123456789'],
    ['https://c.y.qq.com/base/fcgi-bin/diss?disstid=123456789', '123456789'],
    ['https://i.y.qq.com/n2/m/share/details/taoge.html?disstid=123456789', '123456789'],
  ])('accepts a playlist reference %s', (value, playlistId) => {
    expect(parseQqPlaylistInput({ value })).toEqual({
      kind: 'playlist-id',
      playlistId,
    });
  });

  it('rejects an input explicitly assigned to another provider', () => {
    expect(() => parseQqPlaylistInput({
      value: '123456789',
      provider: 'netease',
    })).toThrow();
  });

  it.each([
    'https://y.qq.com/n/ryqq/songDetail/T000TEST',
    'https://y.qq.com/n/ryqq/singer/002TESTSI',
    'https://y.qq.com/n/ryqq/albumDetail/001TESTAL',
    'https://evil.example/playlist/123',
    'https://y.qq.com.evil.example/playlist/123',
    'https://user:pass@y.qq.com/playlist/123',
    'https://y.qq.com:8443/playlist/123',
    'https://y.qq.com/playlist/not-a-number',
    'https://c.y.qq.com/base/fcgi-bin/diss?disstid=not-a-number',
    'https://y.qq.com/',
  ])('rejects an unsafe or non-playlist reference %s', (value) => {
    expect(() => parseQqPlaylistInput({ value })).toThrow();
  });
});
