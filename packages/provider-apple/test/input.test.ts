import { describe, expect, it } from 'vitest';
import { parseApplePlaylistInput } from '../src/input.js';

describe('parseApplePlaylistInput', () => {
  it.each([
    ['pl.u-2o6x0lp6vko9d2', 'us', 'pl.u-2o6x0lp6vko9d2'],
    ['pl.u-ABCDEFGH123', 'us', 'pl.u-ABCDEFGH123'],
    ['123456789', 'us', '123456789'],
  ])('accepts a bare playlist id %s with the default storefront', (value, storefront, playlistId) => {
    expect(parseApplePlaylistInput({ value })).toEqual({
      kind: 'playlist-ref',
      storefront,
      playlistId,
    });
  });

  it('honors a custom default storefront for bare ids', () => {
    expect(parseApplePlaylistInput({ value: 'pl.u-synth01' }, { defaultStorefront: 'cn' }))
      .toEqual({ kind: 'playlist-ref', storefront: 'cn', playlistId: 'pl.u-synth01' });
  });

  it.each([
    ['https://music.apple.com/us/playlist/pl.u-synth01', 'us', 'pl.u-synth01'],
    ['https://music.apple.com/us/playlist/todays-hits/pl.u-synth01', 'us', 'pl.u-synth01'],
    ['https://music.apple.com/cn/playlist/%E5%90%88%E6%88%90%E6%AD%8C%E5%8D%95/pl.u-synth01', 'cn', 'pl.u-synth01'],
    ['https://music.apple.com/gb/playlist/123456', 'gb', '123456'],
    ['https://music.apple.com/us/playlist/name/pl.u-synth01?ls=1&itsct=tool', 'us', 'pl.u-synth01'],
    ['http://music.apple.com/us/playlist/pl.u-synth01', 'us', 'pl.u-synth01'],
  ])('accepts a playlist link %s', (value, storefront, playlistId) => {
    expect(parseApplePlaylistInput({ value })).toEqual({
      kind: 'playlist-ref',
      storefront,
      playlistId,
    });
  });

  it('rejects an input explicitly assigned to another provider', () => {
    expect(() => parseApplePlaylistInput({
      value: 'https://music.apple.com/us/playlist/pl.u-synth01',
      provider: 'netease',
    })).toThrow();
  });

  it.each([
    // Non-Apple or spoofed hosts.
    'https://evil.example/us/playlist/pl.u-synth01',
    'https://music.apple.com.evil.example/us/playlist/pl.u-synth01',
    'https://api.music.apple.com/us/playlist/pl.u-synth01',
    // Unsafe URL parts.
    'https://user:pass@music.apple.com/us/playlist/pl.u-synth01',
    'https://music.apple.com:8443/us/playlist/pl.u-synth01',
    // Singer/album/song and other non-playlist paths.
    'https://music.apple.com/us/song/pl.u-synth01',
    'https://music.apple.com/us/album/1600/synth-album',
    'https://music.apple.com/us/artist/1234-singer',
    'https://music.apple.com/us/station/pl.u-synth01',
    'https://music.apple.com/us/playlist/',
    'https://music.apple.com/us/playlist/pl.u-',
    'https://music.apple.com/us/playlist/not-a-playlist-id',
    // Storefronts are two lowercase letters only.
    'https://music.apple.com/US/playlist/pl.u-synth01',
    'https://music.apple.com/usa/playlist/pl.u-synth01',
    'https://music.apple.com/u1/playlist/pl.u-synth01',
    // Trailing garbage after the id.
    'https://music.apple.com/us/playlist/pl.u-synth01/extra',
    // Not a URL at all.
    'hello world',
    '',
  ])('rejects an unsafe or non-playlist reference %s', (value) => {
    expect(() => parseApplePlaylistInput({ value })).toThrow();
  });

  it('rejects an invalid defaultStorefront option with a RangeError', () => {
    for (const storefront of ['US', 'usa', 'u1', '']) {
      expect(() => parseApplePlaylistInput(
        { value: 'pl.u-synth01' },
        { defaultStorefront: storefront },
      )).toThrow(RangeError);
    }
  });
});
