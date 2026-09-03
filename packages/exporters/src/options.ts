import type { Playlist } from '@playlist-exporter/contracts';

export type ExportFormat = 'txt' | 'csv' | 'json';
export type LineEnding = 'lf' | 'crlf';
export type TrackOrder = 'title-artist' | 'artist-title';

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly includeIndex?: boolean;
  readonly order?: TrackOrder;
  readonly includeAlbum?: boolean;
  readonly dedupe?: boolean;
  readonly lineEnding?: LineEnding;
  readonly csvBom?: boolean;
  readonly date?: string;
  readonly generatedAt?: string;
}

export interface NormalizedExportOptions {
  readonly format: ExportFormat;
  readonly includeIndex: boolean;
  readonly order: TrackOrder;
  readonly includeAlbum: boolean;
  readonly dedupe: boolean;
  readonly lineEnding: LineEnding;
  readonly csvBom: boolean;
  readonly date: string;
  readonly generatedAt: string;
}

export interface ExportArtifact {
  readonly format: ExportFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly encoding: 'utf-8';
  readonly lineEnding: LineEnding;
  readonly bom: boolean;
  readonly trackCount: number;
  readonly complete: Playlist['complete'];
}

export function normalizeExportOptions(options: ExportOptions): NormalizedExportOptions {
  if (options.format !== 'txt' && options.format !== 'csv' && options.format !== 'json') {
    throw new RangeError(`Unsupported export format: ${String(options.format)}`);
  }

  const order = options.order ?? 'title-artist';
  if (order !== 'title-artist' && order !== 'artist-title') {
    throw new RangeError(`Unsupported track order: ${String(order)}`);
  }

  const lineEnding = options.lineEnding ?? 'lf';
  if (lineEnding !== 'lf' && lineEnding !== 'crlf') {
    throw new RangeError(`Unsupported line ending: ${String(lineEnding)}`);
  }

  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new RangeError(`Invalid export date: ${date}`);
  }

  return {
    format: options.format,
    includeIndex: options.includeIndex ?? false,
    order,
    includeAlbum: options.includeAlbum ?? false,
    dedupe: options.dedupe ?? false,
    lineEnding,
    csvBom: options.csvBom ?? false,
    date,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export function lineEndingValue(options: Pick<NormalizedExportOptions, 'lineEnding'>): string {
  return options.lineEnding === 'crlf' ? '\r\n' : '\n';
}
