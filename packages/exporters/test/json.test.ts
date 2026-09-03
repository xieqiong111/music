import { describe, expect, it } from 'vitest';
import { exportPlaylist } from '../src/index.js';
import { playlist } from './fixtures.js';

describe('JSON exporter', () => {
  it('writes a versioned UTF-8 envelope with generation metadata and all tracks', () => {
    const artifact = exportPlaylist(playlist, {
      format: 'json',
      generatedAt: '2026-09-03T10:20:30.000Z',
      date: '2026-09-03',
    });
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes));

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-09-03T10:20:30.000Z',
      options: {
        format: 'json',
        includeIndex: false,
        order: 'title-artist',
        includeAlbum: false,
        dedupe: false,
        lineEnding: 'lf',
        csvBom: false,
      },
    });
    expect(envelope.playlist.name).toBe(playlist.name);
    expect(envelope.playlist.tracks).toHaveLength(5);
    expect(envelope.playlist.tracks[1].availability).toBe('removed');
    expect(envelope.playlist.tracks[1].artists).toEqual(['[unknown artist]']);
    expect([...artifact.bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(artifact).toMatchObject({
      format: 'json',
      encoding: 'utf-8',
      lineEnding: 'lf',
      bom: false,
      trackCount: 5,
      complete: true,
    });
    expect(artifact.filename).toMatch(/\.json$/u);
  });
});
