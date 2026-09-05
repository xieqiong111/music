import type { Playlist } from '@playlist-exporter/contracts';
import { dedupeTracks } from './dedupe.js';
import { renderCsv } from './csv.js';
import { renderJson } from './json.js';
import { sanitizeFilename } from './filename.js';
import {
  normalizeExportOptions,
  type ExportArtifact,
  type ExportOptions,
  type NormalizedExportOptions,
} from './options.js';
import { renderTxt } from './txt.js';

export type {
  ExportArtifact,
  ExportFormat,
  ExportOptions,
  LineEnding,
  TrackOrder,
} from './options.js';
export { CSV_COLUMNS, escapeCsvField } from './csv.js';
export { dedupeTracks } from './dedupe.js';
export { createJsonEnvelope, type JsonExportEnvelope } from './json.js';
export { sanitizeFilename } from './filename.js';

function mimeTypeFor(format: NormalizedExportOptions['format']): string {
  switch (format) {
    case 'txt':
      return 'text/plain;charset=utf-8';
    case 'csv':
      return 'text/csv;charset=utf-8';
    case 'json':
      return 'application/json;charset=utf-8';
  }
}

function render(playlist: Playlist, tracks: Playlist['tracks'], options: NormalizedExportOptions): string {
  switch (options.format) {
    case 'txt':
      return renderTxt(tracks, options);
    case 'csv':
      return renderCsv(tracks, options);
    case 'json':
      return renderJson(playlist, tracks, options);
  }
}

export function exportPlaylist(playlist: Playlist, options: ExportOptions): ExportArtifact {
  const normalized = normalizeExportOptions(options);
  const tracks = normalized.dedupe ? dedupeTracks(playlist.tracks) : [...playlist.tracks];
  const text = render(playlist, tracks, normalized);
  const encoded = new TextEncoder().encode(text);
  const bom = normalized.format === 'csv' && normalized.csvBom;
  const bytes = bom
    ? Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded])
    : encoded;
  // Reserve space for the date and longest extension before truncating the name.
  const prefix = sanitizeFilename(`${playlist.source}_${playlist.name}`);
  const baseName = `${prefix}_${normalized.date}`;

  return {
    format: normalized.format,
    filename: `${baseName}.${normalized.format}`,
    mimeType: mimeTypeFor(normalized.format),
    bytes,
    encoding: 'utf-8',
    lineEnding: normalized.lineEnding,
    bom,
    trackCount: tracks.length,
    complete: playlist.complete,
  };
}
