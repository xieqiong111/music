import type { Playlist, Track } from '@playlist-exporter/contracts';
import type { NormalizedExportOptions } from './options.js';
import { lineEndingValue } from './options.js';

export interface JsonExportEnvelope {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly options: {
    readonly format: 'json';
    readonly includeIndex: boolean;
    readonly order: NormalizedExportOptions['order'];
    readonly includeAlbum: boolean;
    readonly dedupe: boolean;
    readonly lineEnding: NormalizedExportOptions['lineEnding'];
    readonly csvBom: boolean;
    readonly date: string;
  };
  readonly sourceTrackCount: number;
  readonly exportedTrackCount: number;
  readonly complete: Playlist['complete'];
  readonly playlist: Playlist;
  readonly tracks: readonly Track[];
}

export function createJsonEnvelope(
  playlist: Playlist,
  tracks: readonly Track[],
  options: NormalizedExportOptions,
): JsonExportEnvelope {
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    options: {
      format: 'json',
      includeIndex: options.includeIndex,
      order: options.order,
      includeAlbum: options.includeAlbum,
      dedupe: options.dedupe,
      lineEnding: options.lineEnding,
      csvBom: options.csvBom,
      date: options.date,
    },
    sourceTrackCount: playlist.tracks.length,
    exportedTrackCount: tracks.length,
    complete: playlist.complete,
    playlist: {
      ...playlist,
      tracks: [...playlist.tracks],
      warnings: [...playlist.warnings],
    },
    tracks: [...tracks],
  };
}

export function renderJson(
  playlist: Playlist,
  tracks: readonly Track[],
  options: NormalizedExportOptions,
): string {
  const json = JSON.stringify(createJsonEnvelope(playlist, tracks, options), null, 2);
  const eol = lineEndingValue(options);
  return `${json.replaceAll('\n', eol)}${eol}`;
}
