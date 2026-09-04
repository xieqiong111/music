import { describe, expect, it } from 'vitest';
import {
  QqProvider,
  parseQqPlaylistInput,
} from '@playlist-exporter/provider-qq';

describe('provider package public API', () => {
  it('exports the provider and input parser from the package name', () => {
    expect(new QqProvider().id).toBe('qq-music');
    expect(parseQqPlaylistInput({ value: '42' })).toEqual({
      kind: 'playlist-id',
      playlistId: '42',
    });
  });
});
