import { describe, expect, it } from 'vitest';
import { parseNeteasePlaylistInput } from '../src/input.js';

describe('parseNeteasePlaylistInput', () => {
  it.each([
    ['123456789', '123456789'],
    ['https://music.163.com/playlist?id=123456789', '123456789'],
    ['https://music.163.com/#/playlist?id=123456789', '123456789'],
    ['https://music.163.com/playlist/123456789', '123456789'],
    ['https://y.music.163.com/m/playlist?id=123456789', '123456789'],
  ])('accepts a playlist reference %s', (value, playlistId) => {
    expect(parseNeteasePlaylistInput({ value })).toEqual({
      kind: 'playlist-id',
      playlistId,
    });
  });

  it('accepts only a syntactically safe 163cn.tv short link before resolution', () => {
    expect(parseNeteasePlaylistInput({ value: 'https://163cn.tv/a1B_-' })).toEqual({
      kind: 'short-url',
      url: 'https://163cn.tv/a1B_-',
    });
    expect(parseNeteasePlaylistInput({ value: 'http://163cn.tv/a1B_-' })).toEqual({
      kind: 'short-url',
      url: 'https://163cn.tv/a1B_-',
    });
  });

  it('rejects an input explicitly assigned to another provider', () => {
    expect(() => parseNeteasePlaylistInput({
      value: '123456789',
      provider: 'qq-music',
    })).toThrow();
  });

  it.each([
    'https://music.163.com/song?id=123',
    'https://music.163.com/#//evil.example/playlist?id=123',
    'https://evil.example/playlist?id=123',
    'https://music.163.com.evil.example/playlist?id=123',
    'https://user:pass@music.163.com/playlist?id=123',
    'https://music.163.com:8443/playlist?id=123',
    'https://music.163.com/playlist?id=not-a-number',
    'https://163cn.tv/',
  ])('rejects an unsafe or non-playlist reference %s', (value) => {
    expect(() => parseNeteasePlaylistInput({ value })).toThrow();
  });
});
