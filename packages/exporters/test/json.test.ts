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
    expect(envelope.sourceTrackCount).toBe(5);
    expect(envelope.exportedTrackCount).toBe(5);
    expect(envelope.complete).toBe(true);
    expect(envelope.tracks).toHaveLength(5);
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
    expect(new TextDecoder().decode(artifact.bytes).endsWith('\n')).toBe(true);
  });

  it('deduplicates only the exported view without mutating canonical source metadata', () => {
    const before = structuredClone(playlist);
    const artifact = exportPlaylist(playlist, {
      format: 'json', dedupe: true,
      generatedAt: '2026-09-03T10:20:30.000Z', date: '2026-09-03',
    });
    const envelope = JSON.parse(new TextDecoder().decode(artifact.bytes));

    expect(envelope.playlist.total).toBe(5);
    expect(envelope.playlist.tracks).toHaveLength(5);
    expect(envelope.sourceTrackCount).toBe(5);
    expect(envelope.exportedTrackCount).toBe(4);
    expect(envelope.complete).toBe(true);
    expect(envelope.tracks).toHaveLength(4);
    expect(envelope.tracks.map((track: { position: number }) => track.position)).toEqual(
      [0, 1, 2, 3],
    );
    expect(playlist).toEqual(before);
  });

  it('preserves partial state, warnings, positions, availability, and explicit CRLF', () => {
    const partial = {
      ...playlist,
      total: 6,
      complete: false,
      warnings: ['分页未完成'],
    };
    const artifact = exportPlaylist(partial, {
      format: 'json', lineEnding: 'crlf',
      generatedAt: '2026-09-03T10:20:30.000Z', date: '2026-09-03',
    });
    const text = new TextDecoder().decode(artifact.bytes);
    const envelope = JSON.parse(text);

    expect(text.endsWith('\r\n')).toBe(true);
    expect(envelope.complete).toBe(false);
    expect(envelope.playlist.total).toBe(6);
    expect(envelope.playlist.warnings).toEqual(['分页未完成']);
    expect(envelope.sourceTrackCount).toBe(5);
    expect(envelope.exportedTrackCount).toBe(5);
    expect(envelope.tracks[2]).toMatchObject({ position: 2, availability: 'unavailable' });
    expect(artifact.complete).toBe(false);
  });
});
