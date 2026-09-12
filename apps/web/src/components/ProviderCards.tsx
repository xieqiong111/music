import type { ProviderId } from '@playlist-exporter/contracts';
import { zhCN } from '../i18n/zh-CN.js';

const providers: ReadonlyArray<{
  id: ProviderId;
  name: string;
  hint: string;
  available: boolean;
}> = [
  {
    id: 'apple-music',
    name: zhCN.providerApple,
    hint: zhCN.providerAppleHint,
    available: false,
  },
  {
    id: 'netease',
    name: zhCN.providerNetease,
    hint: zhCN.providerNeteaseHint,
    available: true,
  },
  {
    id: 'qq-music',
    name: zhCN.providerQQ,
    hint: zhCN.providerQQHint,
    available: true,
  },
];

export interface ProviderCardsProps {
  readonly selected: ProviderId;
  readonly onSelect: (provider: ProviderId) => void;
  /** 桌面壳:没有服务端,在线平台分析整体禁用(本地导入/导出不受影响)。 */
  readonly disabled?: boolean;
}

export function ProviderCards({ selected, onSelect, disabled = false }: ProviderCardsProps) {
  return (
    <section aria-labelledby="providers-title">
      <div className="section-heading">
        <p className="eyebrow">01</p>
        <h2 id="providers-title">{zhCN.providersTitle}</h2>
      </div>
      <div className="provider-grid">
        {providers.map(provider => (
          <button
            aria-pressed={selected === provider.id}
            className="provider-card"
            disabled={!provider.available || disabled}
            key={provider.id}
            onClick={() => onSelect(provider.id)}
            type="button"
          >
            <span className="provider-card__top">
              <strong>{provider.name}</strong>
              <span className={provider.available && !disabled ? 'status status--ready' : 'status'}>
                {provider.available && !disabled ? zhCN.providerAvailable : zhCN.providerUnavailable}
              </span>
            </span>
            <span>{provider.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
