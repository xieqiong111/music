import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError,
  type LibraryEntryPatch,
  type LocalLibraryEntry,
  type LocalLibraryState,
  type PlaylistService } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';
import {
  DirectoryPickCancelled,
  MAX_CLIENT_LIBRARY_ENTRIES,
  canPickDirectories,
  type ClientLibrary,
  type ClientLibraryEntry,
  type ClientLibrarySnapshot,
} from '../localLibraryClient.js';
import { BrowseDirsDialog } from './BrowseDirsDialog.js';

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return zhCN.noAlbum;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatDateTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error && caught.message !== '' ? caught.message : fallback;

const isAuthExpired = (caught: unknown): boolean =>
  caught instanceof ApiError && caught.code === 'AUTH_REQUIRED';

interface EntryDraft {
  title: string;
  artists: string;
  album: string;
}

const matchesQuery = (
  entry: {
    readonly title: string;
    readonly artists: ReadonlyArray<string>;
    readonly album: string | null;
    readonly path: string;
  },
  normalizedQuery: string,
): boolean =>
  entry.title.toLowerCase().includes(normalizedQuery) ||
  entry.artists.some(artist => artist.toLowerCase().includes(normalizedQuery)) ||
  (entry.album ?? '').toLowerCase().includes(normalizedQuery) ||
  entry.path.toLowerCase().includes(normalizedQuery);

export interface LocalLibraryViewProps {
  readonly service: PlaylistService;
  readonly onSessionExpired: () => void;
  /** 扫描进行中的状态轮询间隔；默认 1 秒。 */
  readonly pollIntervalMs?: number;
  /**
   * 桌面壳或服务不可达:只显示纯客户端的本机音乐库,不产生任何
   * /api/local-library/* 调用(桌面壳没有服务端)。
   */
  readonly clientOnly?: boolean;
  /** 注入本机音乐库客户端(测试用;默认 IndexedDB/内存回退实现)。 */
  readonly clientLibrary?: ClientLibrary;
}

export function LocalLibraryView({
  service,
  onSessionExpired,
  pollIntervalMs = 1000,
  clientOnly = false,
  clientLibrary: injectedClientLibrary,
}: LocalLibraryViewProps) {
  const clientLibrary = injectedClientLibrary;
  const [state, setState] = useState<LocalLibraryState>();
  const [loadError, setLoadError] = useState<string>();
  const [pathInput, setPathInput] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<EntryDraft>();

  const closeDialog = useCallback((): void => setDialogOpen(false), []);

  // 弹窗“将当前文件夹加入音乐库”：与手动输入一样走 PUT /api/local-library/roots，
  // 成功后刷新库状态并关闭弹窗；失败时抛回弹窗就地提示。
  const confirmBrowse = useCallback(async (path: string): Promise<LocalLibraryState> => {
    const next = await service.addLibraryRoot(path);
    setState(next);
    setLoadError(undefined);
    setDialogOpen(false);
    return next;
  }, [service]);

  const refresh = useCallback(async (): Promise<LocalLibraryState | undefined> => {
    try {
      const next = await service.getLocalLibrary();
      setState(next);
      setLoadError(undefined);
      return next;
    } catch (caught) {
      if (isAuthExpired(caught)) {
        onSessionExpired();
        return undefined;
      }
      setLoadError(errorMessage(caught, zhCN.libraryLoadFailed));
      return undefined;
    }
  }, [service, onSessionExpired]);

  // 服务端音乐库仅在联网模式加载;clientOnly(桌面/离线)下零 /api 调用。
  useEffect(() => {
    if (clientOnly) return undefined;
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh, clientOnly]);

  const scanActive = state?.scan.active === true;
  useEffect(() => {
    if (clientOnly || !scanActive) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [clientOnly, scanActive, refresh, pollIntervalMs]);

  const run = async (action: () => Promise<LocalLibraryState>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      setState(await action());
    } catch (caught) {
      if (isAuthExpired(caught)) {
        onSessionExpired();
        return;
      }
      setActionError(errorMessage(caught, zhCN.libraryActionFailed));
    } finally {
      setBusy(false);
    }
  };

  const addRoot = (): Promise<void> => {
    const path = pathInput.trim();
    if (path === '') return Promise.resolve();
    return run(async () => {
      const next = await service.addLibraryRoot(path);
      setPathInput('');
      return next;
    });
  };

  const removeRoot = (id: string): Promise<void> => run(() => service.removeLibraryRoot(id));
  const rescanRoot = (id: string): Promise<void> => run(() => service.rescanLibraryRoot(id));
  const removeEntry = (id: string): Promise<void> => run(() => service.removeLibraryEntry(id));

  const startEdit = (entry: LocalLibraryEntry): void => {
    setEditingId(entry.id);
    setActionError(undefined);
    setDraft({
      title: entry.title,
      artists: entry.artists.join('、'),
      album: entry.album ?? '',
    });
  };

  const cancelEdit = (): void => {
    setEditingId(undefined);
    setDraft(undefined);
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (editingId === undefined || draft === undefined || busy) return;
    setBusy(true);
    setActionError(undefined);
    const patch: LibraryEntryPatch = {
      title: draft.title.trim(),
      artists: draft.artists.split('、').map(artist => artist.trim()).filter(artist => artist !== ''),
      album: draft.album.trim() === '' ? null : draft.album.trim(),
    };
    try {
      const updated = await service.editLibraryEntry(editingId, patch);
      setState(prev => prev === undefined
        ? prev
        : {
          ...prev,
          entries: prev.entries.map(entry => (entry.id === updated.id ? updated : entry)),
        });
      cancelEdit();
    } catch (caught) {
      if (isAuthExpired(caught)) {
        onSessionExpired();
        return;
      }
      setActionError(errorMessage(caught, zhCN.libraryActionFailed));
    } finally {
      setBusy(false);
    }
  };

  const clientSection = (clientLibrary !== undefined || clientOnly) && (
    <ClientLibrarySection
      clientLibrary={clientLibrary}
      standalone={clientOnly}
    />
  );

  // 桌面壳/离线:只显示本机音乐库,不渲染服务端 roots/scan 表单。
  if (clientOnly) {
    return (
      <section aria-labelledby="library-title">
        <LibraryHeading />
        {clientSection}
      </section>
    );
  }

  if (state === undefined && loadError === undefined) {
    return (
      <section aria-labelledby="library-title">
        <LibraryHeading />
        <p role="status">{zhCN.libraryLoading}</p>
        {clientSection}
      </section>
    );
  }

  if (state === undefined) {
    return (
      <section aria-labelledby="library-title">
        <LibraryHeading />
        <div className="error-panel" role="alert">
          <p>{loadError}</p>
        </div>
        {clientSection}
      </section>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = normalizedQuery === ''
    ? state.entries
    : state.entries.filter(entry => matchesQuery(entry, normalizedQuery));

  return (
    <section aria-labelledby="library-title">
      <LibraryHeading />

      <div className="section-heading section-heading--split">
        <h3>{zhCN.serverLibrarySectionTitle}</h3>
      </div>
      <p className="library-hint">{zhCN.libraryIntro}</p>
      {scanActive && (
        <p role="status" className="library-scan">
          {zhCN.libraryScanActive(state.scan.scannedFiles)}
        </p>
      )}
      {state.truncated && <p className="library-warning">{zhCN.libraryTruncated}</p>}

      <div className="library-add-row library-add-actions">
        <button onClick={() => setDialogOpen(true)} type="button">
          {zhCN.libraryBrowseButton}
        </button>
        <button
          aria-expanded={manualOpen}
          className="button-secondary"
          onClick={() => setManualOpen(value => !value)}
          type="button"
        >
          {zhCN.libraryManualToggle}
        </button>
      </div>
      {manualOpen && (
        <div className="input-row library-add-row">
          <input
            aria-label={zhCN.libraryAddLabel}
            onChange={event => setPathInput(event.target.value)}
            placeholder={zhCN.libraryAddPlaceholder}
            spellCheck={false}
            type="text"
            value={pathInput}
          />
          <button disabled={busy || pathInput.trim() === ''} onClick={() => void addRoot()} type="button">
            {zhCN.libraryAddButton}
          </button>
        </div>
      )}
      {dialogOpen && (
        <BrowseDirsDialog
          onClose={closeDialog}
          onConfirm={confirmBrowse}
          onSessionExpired={onSessionExpired}
          service={service}
        />
      )}
      {actionError !== undefined && <p role="alert" className="library-error">{actionError}</p>}

      {state.roots.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{zhCN.libraryRootPathColumn}</th>
                <th>{zhCN.libraryFileCountColumn}</th>
                <th>{zhCN.libraryLastScanColumn}</th>
                <th>{zhCN.libraryActionsColumn}</th>
              </tr>
            </thead>
            <tbody>
              {state.roots.map(root => (
                <tr key={root.id}>
                  <td className="library-path">{root.path}</td>
                  <td>{root.fileCount ?? zhCN.noAlbum}</td>
                  <td>
                    {root.lastScanAt === undefined
                      ? zhCN.libraryNeverScanned
                      : formatDateTime(root.lastScanAt)}
                  </td>
                  <td>
                    <button
                      className="button-secondary library-button"
                      disabled={busy}
                      onClick={() => void rescanRoot(root.id)}
                      type="button"
                    >
                      {zhCN.libraryRescan}
                    </button>
                    <button
                      className="button-secondary library-button"
                      disabled={busy}
                      onClick={() => void removeRoot(root.id)}
                      type="button"
                    >
                      {zhCN.libraryDeleteRoot}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-heading section-heading--split library-entries-heading">
        <h3>{zhCN.libraryEntriesTitle}</h3>
        <span className="status">{zhCN.libraryEntryCount(state.entries.length)}</span>
      </div>
      <div className="input-row library-search-row">
        <input
          aria-label={zhCN.librarySearchLabel}
          onChange={event => setQuery(event.target.value)}
          placeholder={zhCN.librarySearchPlaceholder}
          spellCheck={false}
          type="search"
          value={query}
        />
      </div>

      {state.entries.length === 0 ? (
        <p>{zhCN.libraryEmpty}</p>
      ) : visibleEntries.length === 0 ? (
        <p>{zhCN.libraryNoMatch}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{zhCN.libraryTitleColumn}</th>
                <th>{zhCN.libraryArtistColumn}</th>
                <th>{zhCN.libraryAlbumColumn}</th>
                <th>{zhCN.libraryDurationColumn}</th>
                <th>{zhCN.libraryPathColumn}</th>
                <th>{zhCN.libraryActionsColumn}</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map(entry => (
                <EntryRow
                  busy={busy}
                  entry={entry}
                  editing={editingId === entry.id}
                  draft={draft}
                  key={entry.id}
                  onCancelEdit={cancelEdit}
                  onDelete={() => void removeEntry(entry.id)}
                  onEdit={() => startEdit(entry)}
                  onSave={event => void saveEdit(event)}
                  onDraftChange={setDraft}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state.entries.length > 0 && (
        <p className="library-hint">{zhCN.libraryEntryDeleteHint}</p>
      )}

      {clientSection}
    </section>
  );
}

function LibraryHeading() {
  return (
    <div className="section-heading">
      <p className="eyebrow">05</p>
      <h2 id="library-title">{zhCN.libraryTitle}</h2>
    </div>
  );
}

interface ClientLibrarySectionProps {
  /** 注入的客户端;undefined 时使用默认单例(仅 standalone 渲染时才会出现)。 */
  readonly clientLibrary?: ClientLibrary;
  /** 桌面壳/离线模式:即使浏览器不支持选文件夹也渲染区块并给出提示。 */
  readonly standalone: boolean;
}

function ClientLibrarySection({ clientLibrary: injectedClientLibrary, standalone }: ClientLibrarySectionProps) {
  // 浏览器不支持 showDirectoryPicker(非 Chromium)时:standalone 仍渲染提示,
  // 联网页面则整个隐藏本机区块。
  const supported = useMemo(() => canPickDirectories(), []);
  const clientLibrary = injectedClientLibrary;
  const [snapshot, setSnapshot] = useState<ClientLibrarySnapshot>();
  const [scan, setScan] = useState<{ readonly active: boolean; readonly scannedFiles: number }>();
  const [truncated, setTruncated] = useState(false);
  const [skippedRoots, setSkippedRoots] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<EntryDraft>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (clientLibrary === undefined) return undefined;
    let cancelled = false;
    clientLibrary.snapshot()
      .then(next => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) setError(zhCN.clientScanFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [clientLibrary]);

  const runScan = async (action: () => Promise<{ readonly truncated: boolean; readonly skippedRoots: readonly string[] }>): Promise<void> => {
    if (clientLibrary === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    setSkippedRoots(false);
    setScan({ active: true, scannedFiles: 0 });
    try {
      const result = await action();
      const next = await clientLibrary.snapshot();
      setSnapshot(next);
      setTruncated(result.truncated);
      setSkippedRoots(result.skippedRoots.length > 0);
    } catch (caught) {
      if (!(caught instanceof DirectoryPickCancelled)) {
        setError(errorMessage(caught, zhCN.clientScanFailed));
      }
    } finally {
      setScan(undefined);
      setBusy(false);
    }
  };

  const removeEntry = async (id: string): Promise<void> => {
    if (clientLibrary === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await clientLibrary.removeEntry(id));
    } catch (caught) {
      setError(errorMessage(caught, zhCN.libraryActionFailed));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (entry: ClientLibraryEntry): void => {
    setEditingId(entry.id);
    setError(undefined);
    setDraft({
      title: entry.title,
      artists: entry.artists.join('、'),
      album: entry.album ?? '',
    });
  };

  const cancelEdit = (): void => {
    setEditingId(undefined);
    setDraft(undefined);
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (clientLibrary === undefined || editingId === undefined || draft === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await clientLibrary.editEntry(editingId, {
        title: draft.title.trim(),
        artists: draft.artists.split('、').map(artist => artist.trim()).filter(artist => artist !== ''),
        album: draft.album.trim() === '' ? null : draft.album.trim(),
      });
      setSnapshot(prev => prev === undefined
        ? prev
        : {
          ...prev,
          entries: prev.entries.map(entry => (entry.id === updated.id ? updated : entry)),
        });
      cancelEdit();
    } catch (caught) {
      setError(errorMessage(caught, zhCN.libraryActionFailed));
    } finally {
      setBusy(false);
    }
  };

  if (clientLibrary === undefined || (!supported && !standalone)) return null;

  const entries = snapshot?.entries ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = normalizedQuery === ''
    ? entries
    : entries.filter(entry => matchesQuery(entry, normalizedQuery));

  return (
    <div className="client-library">
      <div className="section-heading section-heading--split">
        <h3>{zhCN.clientLibrarySectionTitle}</h3>
      </div>
      <p className="library-hint">{zhCN.clientLibraryIntro}</p>

      {!supported && <p className="library-warning">{zhCN.clientUnsupported}</p>}
      {truncated && <p className="library-warning">{zhCN.clientTruncated(MAX_CLIENT_LIBRARY_ENTRIES)}</p>}
      {skippedRoots && <p className="library-warning">{zhCN.clientPermissionNeeded}</p>}
      {error !== undefined && <p role="alert" className="library-error">{error}</p>}
      {scan?.active === true && (
        <p role="status" className="library-scan">{zhCN.clientScanActive(scan.scannedFiles)}</p>
      )}

      {supported && (
        <div className="library-add-row library-add-actions">
          <button disabled={busy} onClick={() => void runScan(() => clientLibrary.pickAndScanDirectory(progress => {
            setScan({ active: true, scannedFiles: progress.scannedFiles });
          }))} type="button">
            {zhCN.clientPickButton}
          </button>
          {(snapshot?.roots.length ?? 0) > 0 && (
            <button
              className="button-secondary"
              disabled={busy}
              onClick={() => void runScan(() => clientLibrary.rescanStoredRoots(progress => {
                setScan({ active: true, scannedFiles: progress.scannedFiles });
              }))}
              type="button"
            >
              {zhCN.clientRescanButton}
            </button>
          )}
        </div>
      )}

      <div className="section-heading section-heading--split library-entries-heading">
        <h4>{zhCN.clientEntriesTitle}</h4>
        <span className="status">{zhCN.clientEntryCount(entries.length)}</span>
      </div>
      <div className="input-row library-search-row">
        <input
          aria-label={zhCN.clientSearchLabel}
          onChange={event => setQuery(event.target.value)}
          placeholder={zhCN.librarySearchPlaceholder}
          spellCheck={false}
          type="search"
          value={query}
        />
      </div>

      {entries.length === 0 ? (
        <p>{zhCN.clientEmpty}</p>
      ) : visibleEntries.length === 0 ? (
        <p>{zhCN.libraryNoMatch}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{zhCN.libraryTitleColumn}</th>
                <th>{zhCN.libraryArtistColumn}</th>
                <th>{zhCN.libraryAlbumColumn}</th>
                <th>{zhCN.libraryDurationColumn}</th>
                <th>{zhCN.libraryPathColumn}</th>
                <th>{zhCN.libraryActionsColumn}</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map(entry => (
                <ClientEntryRow
                  busy={busy}
                  entry={entry}
                  editing={editingId === entry.id}
                  draft={draft}
                  key={entry.id}
                  onCancelEdit={cancelEdit}
                  onDelete={() => void removeEntry(entry.id)}
                  onEdit={() => startEdit(entry)}
                  onSave={event => void saveEdit(event)}
                  onDraftChange={setDraft}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entries.length > 0 && (
        <p className="library-hint">{zhCN.clientPersistenceHint}</p>
      )}
    </div>
  );
}

interface ClientEntryRowProps {
  readonly entry: ClientLibraryEntry;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly draft: EntryDraft | undefined;
  readonly onEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSave: (event: FormEvent<HTMLFormElement>) => void;
  readonly onDelete: () => void;
  readonly onDraftChange: (draft: EntryDraft) => void;
}

function ClientEntryRow({
  entry,
  editing,
  busy,
  draft,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onDraftChange,
}: ClientEntryRowProps) {
  return editing && draft !== undefined ? (
    <tr className="library-edit-row">
      <td colSpan={6}>
        <form className="library-edit-form" onSubmit={onSave}>
          <label>
            <span>{zhCN.libraryEditTitle}</span>
            <input
              aria-label={zhCN.libraryEditTitle}
              onChange={event => onDraftChange({ ...draft, title: event.target.value })}
              value={draft.title}
            />
          </label>
          <label>
            <span>{zhCN.libraryEditArtists}</span>
            <input
              aria-label={zhCN.libraryEditArtists}
              onChange={event => onDraftChange({ ...draft, artists: event.target.value })}
              value={draft.artists}
            />
            <small>{zhCN.libraryArtistsHint}</small>
          </label>
          <label>
            <span>{zhCN.libraryEditAlbum}</span>
            <input
              aria-label={zhCN.libraryEditAlbum}
              onChange={event => onDraftChange({ ...draft, album: event.target.value })}
              value={draft.album}
            />
          </label>
          <button disabled={busy} type="submit">{zhCN.librarySave}</button>
          <button className="button-secondary" onClick={onCancelEdit} type="button">
            {zhCN.libraryCancel}
          </button>
        </form>
      </td>
    </tr>
  ) : (
    <tr>
      <td>{entry.title}</td>
      <td>{entry.artists.join('、') || zhCN.unknownArtist}</td>
      <td>{entry.album ?? zhCN.noAlbum}</td>
      <td>{formatDuration(entry.durationMs)}</td>
      <td className="library-path">{entry.path}</td>
      <td>
        <button
          className="button-secondary library-button"
          disabled={busy}
          onClick={onEdit}
          type="button"
        >
          {zhCN.libraryEdit}
        </button>
        <button
          className="button-secondary library-button"
          disabled={busy}
          onClick={onDelete}
          type="button"
        >
          {zhCN.libraryDeleteEntry}
        </button>
      </td>
    </tr>
  );
}

interface EntryRowProps {
  readonly entry: LocalLibraryEntry;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly draft: EntryDraft | undefined;
  readonly onEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSave: (event: FormEvent<HTMLFormElement>) => void;
  readonly onDelete: () => void;
  readonly onDraftChange: (draft: EntryDraft) => void;
}

function EntryRow({
  entry,
  editing,
  busy,
  draft,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onDraftChange,
}: EntryRowProps) {
  return editing && draft !== undefined ? (
    <tr className="library-edit-row">
      <td colSpan={6}>
        <form className="library-edit-form" onSubmit={onSave}>
          <label>
            <span>{zhCN.libraryEditTitle}</span>
            <input
              onChange={event => onDraftChange({ ...draft, title: event.target.value })}
              value={draft.title}
            />
          </label>
          <label>
            <span>{zhCN.libraryEditArtists}</span>
            <input
              onChange={event => onDraftChange({ ...draft, artists: event.target.value })}
              value={draft.artists}
            />
            <small>{zhCN.libraryArtistsHint}</small>
          </label>
          <label>
            <span>{zhCN.libraryEditAlbum}</span>
            <input
              onChange={event => onDraftChange({ ...draft, album: event.target.value })}
              value={draft.album}
            />
          </label>
          <button disabled={busy} type="submit">{zhCN.librarySave}</button>
          <button className="button-secondary" onClick={onCancelEdit} type="button">
            {zhCN.libraryCancel}
          </button>
        </form>
      </td>
    </tr>
  ) : (
    <tr>
      <td>{entry.title}</td>
      <td>{entry.artists.join('、') || zhCN.unknownArtist}</td>
      <td>{entry.album ?? zhCN.noAlbum}</td>
      <td>{formatDuration(entry.durationMs)}</td>
      <td className="library-path">{entry.path}</td>
      <td>
        <button
          className="button-secondary library-button"
          disabled={busy}
          onClick={onEdit}
          type="button"
        >
          {zhCN.libraryEdit}
        </button>
        <button
          className="button-secondary library-button"
          disabled={busy}
          onClick={onDelete}
          type="button"
        >
          {zhCN.libraryDeleteEntry}
        </button>
      </td>
    </tr>
  );
}
