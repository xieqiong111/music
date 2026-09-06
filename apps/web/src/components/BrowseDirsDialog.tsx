import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError,
  type BrowseDirsResult,
  type LocalLibraryState,
  type PlaylistService } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error && caught.message !== '' ? caught.message : fallback;

const isAuthExpired = (caught: unknown): boolean =>
  caught instanceof ApiError && caught.code === 'AUTH_REQUIRED';

export interface BrowseDirsDialogProps {
  readonly service: PlaylistService;
  readonly onClose: () => void;
  /**
   * 确认添加当前文件夹：父级负责 PUT /api/local-library/roots 并刷新库状态，
   * 成功后关闭弹窗；失败时抛出错误，由弹窗就地提示并保持打开。
   */
  readonly onConfirm: (path: string) => Promise<LocalLibraryState>;
  /** 会话失效（401“请先登录”）时交给外层回到登录视图。 */
  readonly onSessionExpired: () => void;
}

/**
 * “选择文件夹”弹窗：无参 browse 展示 NAS 卷根入口，点击逐级进入子目录，
 * 最终把当前目录加入本地音乐库。样式沿用 AccountDialog 的 dialog 模式。
 */
export function BrowseDirsDialog({
  service,
  onClose,
  onConfirm,
  onSessionExpired,
}: BrowseDirsDialogProps) {
  const [roots, setRoots] = useState<ReadonlyArray<string>>();
  const [listing, setListing] = useState<BrowseDirsResult>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  const browse = useCallback(async (path?: string): Promise<void> => {
    // 导航或关闭时中止上一次请求，避免过期响应覆盖新状态。
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const result = await service.browseDirs(path, controller.signal);
      if (controller.signal.aborted) return;
      if ('browseRoots' in result) {
        setRoots(result.browseRoots);
        setListing(undefined);
      } else {
        setListing(result);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (isAuthExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(errorMessage(caught, zhCN.libraryBrowseFailed));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [service, onSessionExpired]);

  useEffect(() => {
    void browse(undefined);
    return () => abortRef.current?.abort();
  }, [browse]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const addCurrent = async (): Promise<void> => {
    if (listing === undefined || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      // 成功后由父级刷新库状态并关闭弹窗。
      await onConfirm(listing.path);
    } catch (caught) {
      if (isAuthExpired(caught)) {
        onSessionExpired();
        return;
      }
      setError(errorMessage(caught, zhCN.libraryActionFailed));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="browse-dialog-title"
        aria-modal="true"
        className="dialog browse-dialog"
        role="dialog"
      >
        <div className="browse-dialog__header">
          <h2 id="browse-dialog-title">{zhCN.libraryBrowseTitle}</h2>
          <button
            aria-label={zhCN.libraryBrowseClose}
            className="button-secondary browse-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        {error !== undefined && <p role="alert" className="login-error">{error}</p>}
        {loading ? (
          <p role="status">{zhCN.libraryBrowseLoading}</p>
        ) : listing === undefined ? (
          roots === undefined ? null : roots.length === 0 ? (
            <p>{zhCN.libraryBrowseEmptyRoots}</p>
          ) : (
            <div className="browse-roots">
              {roots.map(root => (
                <button key={root} onClick={() => void browse(root)} type="button">
                  {root}
                </button>
              ))}
            </div>
          )
        ) : (
          <>
            <div className="browse-current">
              <button
                className="button-secondary browse-up"
                disabled={listing.parent === null}
                onClick={() => void browse(listing.parent ?? undefined)}
                type="button"
              >
                {zhCN.libraryBrowseUp}
              </button>
              <p className="browse-path">{listing.path}</p>
            </div>
            {listing.dirs.length === 0 ? (
              <p>{zhCN.libraryBrowseEmptyDir}</p>
            ) : (
              <ul className="browse-dirs">
                {listing.dirs.map(dir => (
                  <li key={dir.path}>
                    <button onClick={() => void browse(dir.path)} type="button">
                      {dir.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button
            disabled={listing === undefined || loading || submitting}
            onClick={() => void addCurrent()}
            type="button"
          >
            {submitting ? zhCN.libraryBrowseConfirming : zhCN.libraryBrowseConfirm}
          </button>
        </div>
      </section>
    </div>
  );
}
