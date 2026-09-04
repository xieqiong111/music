import { redactSensitive } from '@playlist-exporter/contracts';
import type { JobError } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

const safeDetails = (error: JobError): string => JSON.stringify({
  code: error.code,
  ...(error.technicalDetails === undefined
    ? {}
    : { technicalDetails: redactSensitive(error.technicalDetails) }),
}, null, 2).slice(0, 8_000);

export function ErrorDetails({ error }: { readonly error: JobError }) {
  return (
    <section className="error-panel" role="alert">
      <p>{error.message}</p>
      <details>
        <summary>{zhCN.technicalDetails}</summary>
        <pre>{safeDetails(error)}</pre>
      </details>
    </section>
  );
}
