import type { ExportOptions } from '@playlist-exporter/exporters';
import { zhCN } from '../i18n/zh-CN.js';

export interface ExportOptionsProps {
  readonly options: ExportOptions;
  readonly exporting: boolean;
  readonly onChange: (options: ExportOptions) => void;
  readonly onExport: () => void;
}

export function ExportOptionsPanel({
  options,
  exporting,
  onChange,
  onExport,
}: ExportOptionsProps) {
  const update = (next: Partial<ExportOptions>) => onChange({ ...options, ...next });
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
            onChange={event => update({ format: event.target.value as ExportOptions['format'] })}
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
            onChange={event => update({ order: event.target.value as ExportOptions['order'] })}
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
            onChange={event => update({ lineEnding: event.target.value as ExportOptions['lineEnding'] })}
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
      </div>
      <button disabled={exporting} onClick={onExport} type="button">
        {exporting ? zhCN.exporting : zhCN.exportButton}
      </button>
    </section>
  );
}
