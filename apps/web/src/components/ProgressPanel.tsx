import type { ProgressUpdate } from '@playlist-exporter/contracts';
import type { JobStatus } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

const statusLabel = (status: JobStatus): string => {
  switch (status) {
    case 'queued': return zhCN.queued;
    case 'running': return zhCN.running;
    case 'completed': return zhCN.completed;
    case 'cancelled': return zhCN.cancelled;
    case 'failed': return zhCN.failedFallback;
  }
};

export interface ProgressPanelProps {
  readonly status: JobStatus;
  readonly progress?: ProgressUpdate;
  readonly onCancel: () => void;
}

export function ProgressPanel({ status, progress, onCancel }: ProgressPanelProps) {
  const active = status === 'queued' || status === 'running';
  const maximum = progress?.total;
  const completed = progress?.completed ?? 0;
  return (
    <section aria-live="polite" className="progress-panel">
      <div>
        <p className="eyebrow">{zhCN.progressTitle}</p>
        <strong>{statusLabel(status)}</strong>
        {maximum !== undefined && (
          <p>{completed} / {maximum}</p>
        )}
      </div>
      {maximum !== undefined && (
        <progress max={maximum} value={Math.min(completed, maximum)}>
          {completed} / {maximum}
        </progress>
      )}
      {active && (
        <button className="button-secondary" onClick={onCancel} type="button">
          {zhCN.cancelButton}
        </button>
      )}
    </section>
  );
}
