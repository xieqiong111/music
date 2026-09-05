import { useCallback, useEffect, useMemo, useState } from 'react';
import { HttpPlaylistService, type PlaylistService, type SessionDuration } from './api.js';
import { ExportWorkspace } from './components/ExportWorkspace.js';
import { LocalLibraryView } from './components/LocalLibraryView.js';
import { LoginView } from './components/LoginView.js';
import { UserMenu } from './components/UserMenu.js';
import { zhCN } from './i18n/zh-CN.js';

type AuthState = 'checking' | 'authenticated' | 'unauthenticated';
type MainView = 'export' | 'library';

export interface AppProps {
  readonly service?: PlaylistService;
  readonly pollIntervalMs?: number;
  /** 本地音乐库扫描状态的轮询间隔；默认 1 秒（测试可调小）。 */
  readonly libraryPollIntervalMs?: number;
}

export default function App({
  service: injectedService,
  pollIntervalMs = 250,
  libraryPollIntervalMs = 1000,
}: AppProps) {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [username, setUsername] = useState<string>();
  const [sessionNotice, setSessionNotice] = useState<string>();
  const [view, setView] = useState<MainView>('export');

  const playlistService = useMemo(
    () => injectedService ?? new HttpPlaylistService({
      baseUrl: import.meta.env.VITE_API_BASE_URL,
    }),
    [injectedService],
  );

  // 应用加载先查会话状态。查询本身失败（服务不可达等）时放行进入主界面：
  // 会话真正失效时任何 /api/* 调用都会返回 401 并回到登录视图。
  useEffect(() => {
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
        if (!cancelled) setAuthState('authenticated');
      });
    return () => {
      cancelled = true;
    };
  }, [playlistService]);

  const handleSessionExpired = useCallback((): void => {
    setAuthState('unauthenticated');
    setUsername(undefined);
    setSessionNotice(zhCN.sessionExpired);
    setView('export');
  }, []);

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
        <UserMenu
          onCredentialsChanged={nextUsername => setUsername(nextUsername)}
          onLogout={() => void handleLogout()}
          onSessionExpired={handleSessionExpired}
          service={playlistService}
          username={username}
        />
      </div>

      {view === 'export' ? (
        <>
          <header className="hero">
            <p className="hero__mark">PLAYLIST / TXT</p>
            <h1>{zhCN.appTitle}</h1>
            <p className="hero__subtitle">{zhCN.appSubtitle}</p>
            <p className="privacy-note">{zhCN.privacyNote}</p>
          </header>
          <ExportWorkspace
            onSessionExpired={handleSessionExpired}
            pollIntervalMs={pollIntervalMs}
            service={playlistService}
          />
        </>
      ) : (
        <LocalLibraryView
          onSessionExpired={handleSessionExpired}
          pollIntervalMs={libraryPollIntervalMs}
          service={playlistService}
        />
      )}
    </main>
  );
}
