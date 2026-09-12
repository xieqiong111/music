import { useEffect, useRef, useState } from 'react';
import { AppError } from '@playlist-exporter/contracts';
import type { Playlist, ProviderId } from '@playlist-exporter/contracts';
import { exportPlaylist } from '@playlist-exporter/exporters';
import { importPlaylistFile } from '@playlist-exporter/importers';
import {
  ApiError,
  type AppExportOptions,
  type JobError,
  type JobSnapshot,
  type JobStatus,
  type PlaylistService,
} from '../api.js';
import {
  EXCLUDE_TRACK_KEYS_LIMIT,
  type ClientLibrary,
  getDefaultClientLibrary,
} from '../localLibraryClient.js';
import { ErrorDetails } from './ErrorDetails.js';
import { ExportOptionsPanel } from './ExportOptions.js';
import { ImportPanel } from './ImportPanel.js';
import { PlaylistInput, detectProvider } from './PlaylistInput.js';
import { PreviewTable } from './PreviewTable.js';
import { ProgressPanel } from './ProgressPanel.js';
import { ProviderCards } from './ProviderCards.js';
import { zhCN } from '../i18n/zh-CN.js';

const DEFAULT_OPTIONS: AppExportOptions = {
  format: 'txt',
  includeIndex: false,
  order: 'title-artist',
  dedupe: false,
  includeAlbum: false,
  lineEnding: 'lf',
  csvBom: false,
  excludeLocalDuplicates: false,
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
  if (error instanceof AppError) {
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

const isAuthExpired = (error: JobError): boolean => error.code === 'AUTH_REQUIRED';

export interface ExportWorkspaceProps {
  readonly service: PlaylistService;
  readonly pollIntervalMs?: number;
  readonly onSessionExpired: () => void;
  /** 桌面壳:没有服务端,在线分析入口禁用,服务端音乐库查询跳过。 */
  readonly onlineDisabled?: boolean;
  /** 注入本机音乐库客户端(测试用;默认 IndexedDB/内存回退实现)。 */
  readonly clientLibrary?: ClientLibrary;
}

export function ExportWorkspace({
  service,
  pollIntervalMs = 250,
  onSessionExpired,
  onlineDisabled = false,
  clientLibrary: injectedClientLibrary,
}: ExportWorkspaceProps) {
  const [provider, setProvider] = useState<ProviderId>('netease');
  const [input, setInput] = useState('');
  const [jobId, setJobId] = useState<string>();
  const [status, setStatus] = useState<JobStatus>();
  const [snapshot, setSnapshot] = useState<JobSnapshot>();
  const [playlist, setPlaylist] = useState<Playlist>();
  const [error, setError] = useState<JobError>();
  const [options, setOptions] = useState<AppExportOptions>(DEFAULT_OPTIONS);
  const [exporting, setExporting] = useState(false);
  const [excludedLocalCount, setExcludedLocalCount] = useState<number>();
  // 服务端导出时本地音乐库的条目数：0 → 复选框禁用并提示“本地音乐库为空”。
  const [libraryEntryCount, setLibraryEntryCount] = useState<number>();
  // 本机音乐库(纯客户端,IndexedDB):条目数与导出排除指纹。
  const [clientLibraryCount, setClientLibraryCount] = useState<number>();
  const [clientTrackKeys, setClientTrackKeys] = useState<readonly string[]>([]);
  const [excludeClientTracks, setExcludeClientTracks] = useState(false);
  const [excludedTrackCount, setExcludedTrackCount] = useState<number>();
  // true when the previewed playlist came from a local file import; those
  // exports are generated in the browser and never hit the server.
  const [imported, setImported] = useState(false);
  const generation = useRef(0);
  const jobIdRef = useRef<string | undefined>(undefined);
  const clientLibrary = injectedClientLibrary ?? getDefaultClientLibrary();

  const detected = detectProvider(input);
  const effectiveProvider = detected ?? provider;
  const active = status === 'queued' || status === 'running';
  const canSubmit = !onlineDisabled &&
    input.trim() !== '' &&
    SUPPORTED_PROVIDERS.has(effectiveProvider) &&
    !active;

  const changeInput = (value: string): void => {
    setInput(value);
    const next = detectProvider(value);
    if (next !== undefined) setProvider(next);
  };

  // 服务端歌单预览完成后查询一次本地音乐库条目数，用于“排除本地已有歌曲”复选框。
  // 桌面壳(onlineDisabled)没有服务端:跳过该 /api 调用。
  useEffect(() => {
    if (playlist?.complete !== true || imported || onlineDisabled) {
      setLibraryEntryCount(undefined);
      return undefined;
    }
    let cancelled = false;
    setLibraryEntryCount(undefined);
    service.getLocalLibrary()
      .then(state => {
        if (!cancelled) setLibraryEntryCount(state.entries.length);
      })
      .catch(() => {
        // 查询失败按未知处理：复选框保持禁用，不显示“库为空”提示。
        if (!cancelled) setLibraryEntryCount(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [playlist, imported, service, onlineDisabled]);

  // 歌单就绪后读取本机音乐库条目数与排除指纹(纯 IndexedDB,零网络)。
  useEffect(() => {
    if (playlist?.complete !== true || imported) {
      setClientLibraryCount(undefined);
      setClientTrackKeys([]);
      return undefined;
    }
    let cancelled = false;
    setClientLibraryCount(undefined);
    setClientTrackKeys([]);
    clientLibrary.trackKeys()
      .then(result => {
        if (cancelled) return;
        setClientLibraryCount(result.total);
        setClientTrackKeys(result.keys);
      })
      .catch(() => {
        // 读取失败(如 IndexedDB 不可用)按空库处理:复选框禁用并提示“为空”。
        if (!cancelled) {
          setClientLibraryCount(0);
          setClientTrackKeys([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [playlist, imported, clientLibrary]);

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
    setImported(false);
    setExcludedLocalCount(undefined);
    setExcludedTrackCount(undefined);
    setExcludeClientTracks(false);
    jobIdRef.current = undefined;
    setJobId(undefined);
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
        const jobError = errorFrom(caught);
        if (isAuthExpired(jobError)) {
          onSessionExpired();
          return;
        }
        setStatus('failed');
        setError(jobError);
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
      const jobError = errorFrom(caught);
      if (isAuthExpired(jobError)) {
        onSessionExpired();
        return;
      }
      setStatus('failed');
      setError(jobError);
    }
  };

  const importFile = async (file: File): Promise<void> => {
    const previousJob = active ? jobIdRef.current : undefined;
    const current = ++generation.current;
    setError(undefined);
    setPlaylist(undefined);
    setSnapshot(undefined);
    setStatus(undefined);
    setJobId(undefined);
    setExcludedLocalCount(undefined);
    setExcludedTrackCount(undefined);
    setExcludeClientTracks(false);
    jobIdRef.current = undefined;
    if (previousJob !== undefined) {
      void service.cancelJob(previousJob).catch(caught => {
        if (generation.current === current &&
            !(caught instanceof ApiError && caught.code === 'JOB_TERMINAL')) {
          const jobError = errorFrom(caught);
          if (isAuthExpired(jobError)) {
            onSessionExpired();
            return;
          }
          setError(jobError);
        }
      });
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await importPlaylistFile(bytes, { filename: file.name });
      if (generation.current !== current) return;
      setImported(true);
      setPlaylist(parsed);
    } catch (caught) {
      if (generation.current !== current) return;
      setError(errorFrom(caught));
    }
  };

  const exportFile = async (): Promise<void> => {
    if (playlist?.complete !== true) return;
    if (!imported && jobId === undefined) return;
    setExporting(true);
    setError(undefined);
    setExcludedLocalCount(undefined);
    setExcludedTrackCount(undefined);
    // 勾选“排除本机音乐库已有的歌曲”时,把全部本机条目指纹(契约上限 5000 项)
    // 作为 excludeTrackKeys 交给服务端过滤。
    const exportOptions: AppExportOptions =
      excludeClientTracks && clientTrackKeys.length > 0
        ? { ...options, excludeTrackKeys: clientTrackKeys.slice(0, EXCLUDE_TRACK_KEYS_LIMIT) }
        : options;
    try {
      if (imported) {
        const artifact = exportPlaylist(playlist, exportOptions);
        download(artifact.filename, artifact.mimeType, artifact.bytes);
      } else {
        const artifact = await service.createExport(jobId as string, exportOptions);
        download(artifact.filename, artifact.mimeType, artifact.bytes);
        setExcludedLocalCount(artifact.excludedLocalCount);
        setExcludedTrackCount(artifact.excludedTrackCount);
      }
    } catch (caught) {
      const jobError = errorFrom(caught);
      if (isAuthExpired(jobError)) {
        onSessionExpired();
        return;
      }
      setError(jobError);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <ProviderCards disabled={onlineDisabled} onSelect={setProvider} selected={provider} />
      <PlaylistInput
        detected={detected}
        disabled={!canSubmit}
        onChange={changeInput}
        onSubmit={() => void inspect()}
        value={input}
      />
      <ImportPanel onFile={file => void importFile(file)} />

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
          clientLibraryCount={clientLibraryCount}
          clientTrackKeysTruncated={clientTrackKeys.length > EXCLUDE_TRACK_KEYS_LIMIT}
          excludeClientTracks={excludeClientTracks}
          excludedLocalCount={excludedLocalCount}
          excludedTrackCount={excludedTrackCount}
          exporting={exporting}
          libraryEntryCount={libraryEntryCount}
          onChange={setOptions}
          onExcludeClientTracksChange={setExcludeClientTracks}
          onExport={() => void exportFile()}
          options={options}
        />
      )}
    </>
  );
}
