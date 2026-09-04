import { zhCN } from '../i18n/zh-CN.js';

export interface ImportPanelProps {
  readonly onFile: (file: File) => void;
}

export function ImportPanel({ onFile }: ImportPanelProps) {
  return (
    <section aria-labelledby="import-title" className="input-panel">
      <div className="section-heading">
        <p className="eyebrow">02·B</p>
        <h2 id="import-title">{zhCN.importTitle}</h2>
      </div>
      <label htmlFor="import-file">{zhCN.importLabel}</label>
      <input
        accept=".txt,.tsv,.csv,.xml,.json"
        aria-label={zhCN.importLabel}
        id="import-file"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file !== undefined) onFile(file);
          event.target.value = '';
        }}
        type="file"
      />
      <small>{zhCN.importHint}</small>
    </section>
  );
}
