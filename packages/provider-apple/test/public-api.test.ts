import { describe, expect, it } from 'vitest';
import {
  AppleProvider,
  appleCatalogPlaylistResponseSchema,
  appleCatalogTracksResponseSchema,
  normalizeAppleTracks,
  parseApplePlaylistInput,
} from '@playlist-exporter/provider-apple';

describe('provider package public API', () => {
  it('exports the provider, schemas, normalizer, and input parser from the package name', () => {
    expect(new AppleProvider(() => 'test-developer-token').id).toBe('apple-music');
    expect(parseApplePlaylistInput({ value: 'pl.u-synth01' })).toEqual({
      kind: 'playlist-ref',
      storefront: 'us',
      playlistId: 'pl.u-synth01',
    });
    expect(appleCatalogPlaylistResponseSchema.safeParse({
      data: [{
        id: 'pl.u-synth01',
        type: 'playlists',
        attributes: { name: '合成歌单', trackCount: 1 },
        relationships: { tracks: { data: [{ id: '1', type: 'songs' }] } },
      }],
    }).success).toBe(true);
    expect(appleCatalogTracksResponseSchema.safeParse({ data: [] }).success).toBe(true);
    expect(normalizeAppleTracks([], 0)).toEqual([]);
  });
});
