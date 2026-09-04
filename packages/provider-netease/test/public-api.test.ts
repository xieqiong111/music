import { describe, expect, it } from 'vitest';
import {
  NeteaseProvider,
  parseNeteasePlaylistInput,
} from '@playlist-exporter/provider-netease';

describe('provider package public API', () => {
  it('exports the provider and input parser from the package name', () => {
    expect(new NeteaseProvider().id).toBe('netease');
    expect(parseNeteasePlaylistInput({ value: '42' })).toEqual({
      kind: 'playlist-id',
      playlistId: '42',
    });
  });
});
