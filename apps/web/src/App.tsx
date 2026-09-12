import { useCallback, useEffect, useMemo, useState } from 'react';
import { HttpPlaylistService, type PlaylistService, type SessionDuration } from './api.js';
import { isDesktopShell } from './desktop.js';
import { ExportWorkspace } from './components/ExportWorkspace.js';
import { LocalLibraryView } from './components/LocalLibraryView.js';
import { LoginView } from './components/LoginView.js';
import { UserMenu } from './components/UserMenu.js';
import { getDefaultClientLibrary, type ClientLibrary } from './localLibraryClient.js';
import { zhCN } from './i18n/zh-CN.js';

type AuthState = 'checking' | 'authenticated' | 'unauthenticated';
type MainView = 'export' | 'library';

export interface AppProps {
  readonly service?: PlaylistService;
  readonly pollIntervalMs?: number;
  /** 本地音乐库扫描状态的轮询间隔；默认 1 秒（测试可调小）。 */
  readonly libraryPollIntervalMs?: number;
  /** 注入本机音乐库客户端（测试用；默认 IndexedDB/内存回退实现）。 */
  readonly clientLibrary?: ClientLibrary;
}

export default function App({
  service: injectedService,
  pollIntervalMs = 250,
  libraryPollIntervalMs = 1000,
  clientLibrary: injectedClientLibrary,
}: AppProps) {
  // 桌面壳(Tauri 静态壳)没有任何 /api/* 后端:不做会话探测,直接进入主界面。
  const desktop = isDesktopShell();
  const [authState, setAuthState] = useState<AuthState>(desktop ? 'authenticated' : 'checking');
  const [username, setUsername] = useState<string>();
  const [sessionNotice, setSessionNotice] = useState<string>();
  const [view, setView] = useState<MainView>('export');
  // 初始会话探测失败(服务不可达)或桌面壳运行时的降级标记:
  // 放行进入主界面,但明确显示"本地模式"而不是伪造"已登录"。
  const [serverUnreachable, setServerUnreachable] = useState(desktop);

  const playlistService = useMemo(
    () => injectedService ?? new HttpPlaylistService({
      baseUrl: import.meta.env.VITE_API_BASE_URL,
    }),
    [injectedService],
  );

  const clientLibrary = useMemo(
    () => injectedClientLibrary ?? getDefaultClientLibrary(),
    [injectedClientLibrary],
  );

  // 应用加载先查会话状态。查询本身失败（服务不可达等）时放行进入主界面：
  // 会话真正失效时任何 /api/* 调用都会返回 401 并回到登录视图。
  // 桌面壳完全跳过该探测,不产生任何 /api 调用(根除"服务返回了无法识别的数据")。
  useEffect(() => {
    if (desktop) return undefined;
    let cancelled = false;
    playlistService.getAuthStatus()
      .then(status => {
        if (cancelled) return;
        if (status.authenticated && status.username !== undefined) {
          setUsername(status.username);
          setAuthState('authenticated');
        } else {
          setAuthState('unauthenticated');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setServerUnreachable(true);
        setAuthState('authenticated');
      });
    return () => {
      cancelled = true;
    };
  }, [playlistService, desktop]);

  const handleSessionExpired = useCallback((): void => {
    if (desktop) return; // 桌面模式没有会话,不可能过期。
    setAuthState('unauthenticated');
    setUsername(undefined);
    setSessionNotice(zhCN.sessionExpired);
    setView('export');
  }, [desktop]);

  const handleLogin = useCallback(async (
    name: string,
    password: string,
    duration: SessionDuration,
  ): Promise<void> => {
    const result = await playlistService.login(name, password, duration);
    setUsername(result.username);
    setSessionNotice(undefined);
    setAuthState('authenticated');
  }, [playlistService]);

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await playlistService.logout();
    } catch {
      // 登出失败也回到登录视图：会话视作已结束。
    }
    setUsername(undefined);
    setSessionNotice(undefined);
    setAuthState('unauthenticated');
  }, [playlistService]);

  if (authState === 'checking') {
    return (
      <main>
        <p role="status">{zhCN.authChecking}</p>
      </main>
    );
  }

  if (authState === 'unauthenticated') {
    return (
      <main>
        <LoginView notice={sessionNotice} onLogin={handleLogin} />
      </main>
    );
  }

  return (
    <main>
      <div className="top-bar">
        <nav aria-label={zhCN.viewSwitchLabel} className="view-tabs">
          <button
            aria-pressed={view === 'export'}
            onClick={() => setView('export')}
            type="button"
          >
            {zhCN.tabExport}
          </button>
          <button
            aria-pressed={view === 'library'}
            onClick={() => setView('library')}
            type="button"
          >
            {zhCN.tabLibrary}
          </button>
        </nav>
        {serverUnreachable ? (
          <span className="local-mode-badge" role="status">{zhCN.localModeBadge}</span>
        ) : (
          <UserMenu
            onCredentialsChanged={nextUsername => setUsername(nextUsername)}
            onLogout={() => void handleLogout()}
            onSessionExpired={handleSessionExpired}
            service={playlistService}
            username={username}
          />
        )}
      </div>

      {serverUnreachable && (
        <p className="offline-banner" role="alert">
          {desktop ? zhCN.desktopOnlineHint : zhCN.offlineBanner}
        </p>
      )}

      {view === 'export' ? (
        <>
          <header className="hero">
            <p className="hero__mark">PLAYLIST / TXT</p>
            <h1>{zhCN.appTitle}</h1>
            <p className="hero__subtitle">{zhCN.appSubtitle}</p>
            <p className="privacy-note">{zhCN.privacyNote}</p>
          </header>
          <ExportWorkspace
            clientLibrary={clientLibrary}
            onSessionExpired={handleSessionExpired}
            onlineDisabled={desktop}
            pollIntervalMs={pollIntervalMs}
            service={playlistService}
          />
        </>
      ) : (
        <LocalLibraryView
          clientLibrary={clientLibrary}
          clientOnly={desktop || serverUnreachable}
          onSessionExpired={handleSessionExpired}
          pollIntervalMs={libraryPollIntervalMs}
          service={playlistService}
        />
      )}
    </main>
  );
}
