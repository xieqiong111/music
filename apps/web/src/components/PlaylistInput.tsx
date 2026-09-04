import type { ProviderId } from '@playlist-exporter/contracts';
import { zhCN } from '../i18n/zh-CN.js';

export const detectProvider = (input: string): ProviderId | undefined => {
  const value = input.trim().toLowerCase();
  if (/(?:music\.163\.com|163cn\.tv)/u.test(value)) return 'netease';
  if (/(?:music\.apple\.com)/u.test(value)) return 'apple-music';
  if (/(?:y\.qq\.com|c\.y\.qq\.com|i\.y\.qq\.com)/u.test(value)) return 'qq-music';
  return undefined;
};

const detectionLabel = (provider: ProviderId | undefined): string => {
  switch (provider) {
    case 'netease': return zhCN.detectedNetease;
    case 'apple-music': return zhCN.detectedApple;
    case 'qq-music': return zhCN.detectedQQ;
    default: return zhCN.detectedUnknown;
  }
};

export interface PlaylistInputProps {
  readonly value: string;
  readonly detected: ProviderId | undefined;
  readonly disabled: boolean;
  readonly accessToken: string;
  readonly onChange: (value: string) => void;
  readonly onTokenChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export function PlaylistInput({
  value,
  detected,
  disabled,
  accessToken,
  onChange,
  onTokenChange,
  onSubmit,
}: PlaylistInputProps) {
  return (
    <section aria-labelledby="input-title" className="input-panel">
      <div className="section-heading">
        <p className="eyebrow">02</p>
        <h2 id="input-title">{zhCN.inputTitle}</h2>
      </div>
      <label htmlFor="playlist-input">{zhCN.inputLabel}</label>
      <div className="input-row">
        <input
          autoComplete="off"
          id="playlist-input"
          onChange={event => onChange(event.target.value)}
          placeholder={zhCN.inputPlaceholder}
          spellCheck={false}
          type="text"
          value={value}
        />
        <button disabled={disabled} onClick={onSubmit} type="button">
          {zhCN.inspectButton}
        </button>
      </div>
      <details className="token-field">
        <summary>{zhCN.tokenLabel}</summary>
        <input
          aria-label={zhCN.tokenLabel}
          autoComplete="off"
          onChange={event => onTokenChange(event.target.value)}
          placeholder={zhCN.tokenPlaceholder}
          type="password"
          value={accessToken}
        />
        <small>{zhCN.tokenHint}</small>
      </details>
      {value.trim() !== '' && <p className="detection-note">{detectionLabel(detected)}</p>}
    </section>
  );
}
