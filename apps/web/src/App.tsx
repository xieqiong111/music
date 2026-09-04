import { useMemo, useRef, useState } from 'react';
import type { Playlist, ProviderId } from '@playlist-exporter/contracts';
import type { ExportOptions } from '@playlist-exporter/exporters';
import {
  ApiError,
  HttpPlaylistService,
  type JobError,
  type JobSnapshot,
  type JobStatus,
  type PlaylistService,
} from './api.js';
import { ErrorDetails } from './components/ErrorDetails.js';
import { ExportOptionsPanel } from './components/ExportOptions.js';
import { PlaylistInput, detectProvider } from './components/PlaylistInput.js';
import { PreviewTable } from './components/PreviewTable.js';
import { ProgressPanel } from './components/ProgressPanel.js';
import { ProviderCards } from './components/ProviderCards.js';
import { zhCN } from './i18n/zh-CN.js';

const DEFAULT_OPTIONS: ExportOptions = {
  format: 'txt',
  includeIndex: false,
  order: 'title-artist',
  dedupe: false,
  includeAlbum: false,
  lineEnding: 'lf',
  csvBom: false,
};

// Providers wired end-to-end in this build; mirrors the server's provider
// registry (netease + qq-music). Anything outside this set stays submit-locked.
const SUPPORTED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['netease', 'qq-music']);

const sleep = (delayMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, delayMs));

const fallbackError = (message: string = zhCN.failedFallback): JobError => ({
  code: 'TASK_FAILED',
  message,
});

const errorFrom = (error: unknown): JobError => {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.technicalDetails === undefined
        ? {}
        : { technicalDetails: error.technicalDetails }),
    };
  }
  return fallbackError();
};

const download = (filename: string, mimeType: string, bytes: Uint8Array): void => {
  if (typeof URL.createObjectURL !== 'function') return;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
};

export interface AppProps {
  readonly service?: PlaylistService;
  readonly pollIntervalMs?: number;
}

export default function App({ service: injectedService, pollIntervalMs = 250 }: AppProps) {
  const [provider, setProvider] = useState<ProviderId>('netease');
  const [input, setInput] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [jobId, setJobId] = useState<string>();
  const [status, setStatus] = useState<JobStatus>();
  const [snapshot, setSnapshot] = useState<JobSnapshot>();
  const [playlist, setPlaylist] = useState<Playlist>();
  const [error, setError] = useState<JobError>();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_OPTIONS);
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);
  const jobIdRef = useRef<string | undefined>(undefined);

  const service = useMemo(
    () => injectedService ?? new HttpPlaylistService({
      baseUrl: import.meta.env.VITE_API_BASE_URL,
      ...(accessToken === '' ? {} : { accessToken }),
    }),
    [accessToken, injectedService],
  );

  const detected = detectProvider(input);
  const effectiveProvider = detected ?? provider;
  const active = status === 'queued' || status === 'running';
  const canSubmit = input.trim() !== '' && SUPPORTED_PROVIDERS.has(effectiveProvider) && !active;

  const changeInput = (value: string): void => {
    setInput(value);
    const next = detectProvider(value);
    if (next !== undefined) setProvider(next);
  };

  const inspect = async (): Promise<void> => {
    if (input.trim() === '') {
      setError(fallbackError(zhCN.emptyInput));
      return;
    }
    if (!SUPPORTED_PROVIDERS.has(effectiveProvider)) {
      setError(fallbackError(zhCN.unavailableProvider));
      return;
    }
    const current = ++generation.current;
    setError(undefined);
    setPlaylist(undefined);
    setSnapshot(undefined);
    setStatus('queued');
    try {
      const created = await service.createInspection(effectiveProvider, input.trim());
      if (generation.current !== current) {
        await service.cancelJob(created.jobId).catch(() => undefined);
        return;
      }
      jobIdRef.current = created.jobId;
      setJobId(created.jobId);
      setStatus(created.status);
      while (generation.current === current) {
        const next = await service.getJob(created.jobId);
        if (generation.current !== current) return;
        setSnapshot(next);
        setStatus(next.status);
        if (next.status === 'completed') {
          if (next.result === undefined) {
            setError(fallbackError());
          } else {
            setPlaylist(next.result);
            if (!next.result.complete) setError(fallbackError(zhCN.incompleteBlocked));
          }
          return;
        }
        if (next.status === 'failed') {
          setError(next.error ?? fallbackError());
          return;
        }
        if (next.status === 'cancelled') return;
        await sleep(pollIntervalMs);
      }
    } catch (caught) {
      if (generation.current === current) {
        setStatus('failed');
        setError(errorFrom(caught));
      }
    }
  };

  const cancel = async (): Promise<void> => {
    generation.current += 1;
    const activeJobId = jobIdRef.current;
    setStatus('cancelled');
    if (activeJobId === undefined) return;
    try {
      await service.cancelJob(activeJobId);
    } catch (caught) {
      setStatus('failed');
      setError(errorFrom(caught));
    }
  };

  const exportFile = async (): Promise<void> => {
    if (jobId === undefined || playlist?.complete !== true) return;
    setExporting(true);
    setError(undefined);
    try {
      const artifact = await service.createExport(jobId, options);
      download(artifact.filename, artifact.mimeType, artifact.bytes);
    } catch (caught) {
      setError(errorFrom(caught));
    } finally {
      setExporting(false);
    }
  };

  return (
    <main>
      <header className="hero">
        <p className="hero__mark">PLAYLIST / TXT</p>
        <h1>{zhCN.appTitle}</h1>
        <p className="hero__subtitle">{zhCN.appSubtitle}</p>
        <p className="privacy-note">{zhCN.privacyNote}</p>
      </header>

      <ProviderCards onSelect={setProvider} selected={provider} />
      <PlaylistInput
        accessToken={accessToken}
        detected={detected}
        disabled={!canSubmit}
        onChange={changeInput}
        onSubmit={() => void inspect()}
        onTokenChange={setAccessToken}
        value={input}
      />

      {status !== undefined && (
        <ProgressPanel
          onCancel={() => void cancel()}
          progress={snapshot?.progress}
          status={status}
        />
      )}
      {error !== undefined && <ErrorDetails error={error} />}
      {playlist !== undefined && <PreviewTable playlist={playlist} />}
      {playlist?.complete === true && (
        <ExportOptionsPanel
          exporting={exporting}
          onChange={setOptions}
          onExport={() => void exportFile()}
          options={options}
        />
      )}
    </main>
  );
}
