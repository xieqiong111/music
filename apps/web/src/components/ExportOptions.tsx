import type { AppExportOptions } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

export interface ExportOptionsProps {
  readonly options: AppExportOptions;
  readonly exporting: boolean;
  /**
   * 服务端本地音乐库条目数；undefined 表示未知（加载中或本机导入导出路径），
   * 0 表示库为空（复选框禁用并提示），>0 才允许勾选。
   */
  readonly libraryEntryCount?: number;
  /** 本机音乐库（浏览器 IndexedDB）条目数；undefined 表示加载中，0 提示为空。 */
  readonly clientLibraryCount?: number;
  /** 本机条目指纹超过契约上限（5000 项）时给出提示。 */
  readonly clientTrackKeysTruncated?: boolean;
  readonly onChange: (options: AppExportOptions) => void;
  readonly onExport: () => void;
  /** 上一次导出响应头 x-excluded-local-count 的值；仅 >0 时展示提示。 */
  readonly excludedLocalCount?: number;
  /** 上一次导出响应头 x-excluded-track-count 的值；仅 >0 时展示提示。 */
  readonly excludedTrackCount?: number;
  readonly excludeClientTracks: boolean;
  readonly onExcludeClientTracksChange: (checked: boolean) => void;
}

export function ExportOptionsPanel({
  options,
  exporting,
  libraryEntryCount,
  clientLibraryCount,
  clientTrackKeysTruncated = false,
  onChange,
  onExport,
  excludedLocalCount,
  excludedTrackCount,
  excludeClientTracks,
  onExcludeClientTracksChange,
}: ExportOptionsProps) {
  const update = (next: Partial<AppExportOptions>) => onChange({ ...options, ...next });
  const excludeEnabled = libraryEntryCount !== undefined && libraryEntryCount > 0;
  const clientExcludeEnabled = clientLibraryCount !== undefined && clientLibraryCount > 0;
  return (
    <section aria-labelledby="export-title" className="export-panel">
      <div className="section-heading">
        <p className="eyebrow">04</p>
        <h2 id="export-title">{zhCN.exportTitle}</h2>
      </div>
      <div className="option-grid">
        <label>
          <span>{zhCN.formatLabel}</span>
          <select
            aria-label={zhCN.formatLabel}
            onChange={event => update({ format: event.target.value as AppExportOptions['format'] })}
            value={options.format}
          >
            <option value="txt">{zhCN.formatTxt}</option>
            <option value="csv">{zhCN.formatCsv}</option>
            <option value="json">{zhCN.formatJson}</option>
          </select>
        </label>
        <label>
          <span>{zhCN.orderLabel}</span>
          <select
            aria-label={zhCN.orderLabel}
            onChange={event => update({ order: event.target.value as AppExportOptions['order'] })}
            value={options.order}
          >
            <option value="title-artist">{zhCN.titleArtist}</option>
            <option value="artist-title">{zhCN.artistTitle}</option>
          </select>
        </label>
        <label>
          <span>{zhCN.lineEndingLabel}</span>
          <select
            aria-label={zhCN.lineEndingLabel}
            onChange={event => update({ lineEnding: event.target.value as AppExportOptions['lineEnding'] })}
            value={options.lineEnding}
          >
            <option value="lf">{zhCN.lineEndingLf}</option>
            <option value="crlf">{zhCN.lineEndingCrlf}</option>
          </select>
        </label>
      </div>
      <div className="check-grid">
        <label><input checked={options.includeIndex} onChange={event => update({ includeIndex: event.target.checked })} type="checkbox" />{zhCN.includeIndex}</label>
        <label><input checked={options.includeAlbum} onChange={event => update({ includeAlbum: event.target.checked })} type="checkbox" />{zhCN.includeAlbum}</label>
        <label><input checked={options.dedupe} onChange={event => update({ dedupe: event.target.checked })} type="checkbox" />{zhCN.dedupe}</label>
        <div className="check-item">
          <label>
            <input
              aria-label={zhCN.excludeLocalDuplicates}
              checked={excludeEnabled && options.excludeLocalDuplicates === true}
              disabled={exporting || !excludeEnabled}
              onChange={event => update({ excludeLocalDuplicates: event.target.checked })}
              type="checkbox"
            />
            {zhCN.excludeLocalDuplicates}
          </label>
          {libraryEntryCount === 0 && <p className="check-hint">{zhCN.excludeLocalEmptyHint}</p>}
        </div>
        <div className="check-item">
          <label>
            <input
              aria-label={zhCN.excludeClientLibraryTracks}
              checked={clientExcludeEnabled && excludeClientTracks}
              disabled={exporting || !clientExcludeEnabled}
              onChange={event => onExcludeClientTracksChange(event.target.checked)}
              type="checkbox"
            />
            {zhCN.excludeClientLibraryTracks}
          </label>
          {clientLibraryCount === 0 && <p className="check-hint">{zhCN.excludeClientEmptyHint}</p>}
          {clientTrackKeysTruncated && <p className="check-hint">{zhCN.excludeClientCapHint}</p>}
        </div>
      </div>
      {excludedLocalCount !== undefined && excludedLocalCount > 0 && (
        <p className="export-notice" role="status">{zhCN.excludedLocalNotice(excludedLocalCount)}</p>
      )}
      {excludedTrackCount !== undefined && excludedTrackCount > 0 && (
        <p className="export-notice" role="status">{zhCN.excludedTrackNotice(excludedTrackCount)}</p>
      )}
      <button disabled={exporting} onClick={onExport} type="button">
        {exporting ? zhCN.exporting : zhCN.exportButton}
      </button>
    </section>
  );
}
