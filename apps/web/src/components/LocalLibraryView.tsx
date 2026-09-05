import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError,
  type LibraryEntryPatch,
  type LocalLibraryEntry,
  type LocalLibraryState,
  type PlaylistService } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

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

export interface LocalLibraryViewProps {
  readonly service: PlaylistService;
  readonly onSessionExpired: () => void;
  /** 扫描进行中的状态轮询间隔；默认 1 秒。 */
  readonly pollIntervalMs?: number;
}

export function LocalLibraryView({
  service,
  onSessionExpired,
  pollIntervalMs = 1000,
}: LocalLibraryViewProps) {
  const [state, setState] = useState<LocalLibraryState>();
  const [loadError, setLoadError] = useState<string>();
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<EntryDraft>();

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

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const scanActive = state?.scan.active === true;
  useEffect(() => {
    if (!scanActive) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [scanActive, refresh, pollIntervalMs]);

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

  if (state === undefined && loadError === undefined) {
    return (
      <section aria-labelledby="library-title">
        <LibraryHeading />
        <p role="status">{zhCN.libraryLoading}</p>
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
      </section>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = normalizedQuery === ''
    ? state.entries
    : state.entries.filter(entry =>
      entry.title.toLowerCase().includes(normalizedQuery) ||
      entry.artists.some(artist => artist.toLowerCase().includes(normalizedQuery)) ||
      (entry.album ?? '').toLowerCase().includes(normalizedQuery) ||
      entry.path.toLowerCase().includes(normalizedQuery));

  return (
    <section aria-labelledby="library-title">
      <LibraryHeading />
      {scanActive && (
        <p role="status" className="library-scan">
          {zhCN.libraryScanActive(state.scan.scannedFiles)}
        </p>
      )}
      {state.truncated && <p className="library-warning">{zhCN.libraryTruncated}</p>}

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
