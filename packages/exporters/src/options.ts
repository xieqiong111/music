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
  /**
   * 曲目指纹列表(冻结格式见 contracts 的 trackKey):用于“排除与本机音乐库
   * 重复的曲目”。渲染器不使用该字段 —— 过滤由服务端(或调用方)在导出前完成,
   * 这里仅做选项合法化与透传。
   */
  readonly excludeTrackKeys?: string[];
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
  /** 原样透传,渲染器不读取;未提供时为 undefined。 */
  readonly excludeTrackKeys?: string[];
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

export function formatLocalDate(
  date: Pick<Date, 'getFullYear' | 'getMonth' | 'getDate'>,
): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function normalizeExportOptions(options: ExportOptions): NormalizedExportOptions {
  const now = new Date();
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

  const date = options.date ?? formatLocalDate(now);
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
    generatedAt: options.generatedAt ?? now.toISOString(),
    excludeTrackKeys: options.excludeTrackKeys,
  };
}

export function lineEndingValue(options: Pick<NormalizedExportOptions, 'lineEnding'>): string {
  return options.lineEnding === 'crlf' ? '\r\n' : '\n';
}
