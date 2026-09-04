import { AppError, type PlaylistInput } from '@playlist-exporter/contracts';

export type ParsedNeteasePlaylistInput =
  | { readonly kind: 'playlist-id'; readonly playlistId: string }
  | { readonly kind: 'short-url'; readonly url: string };

const PLAYLIST_ID = /^[1-9]\d{0,19}$/;
const PLATFORM_HOSTS = new Set(['music.163.com', 'y.music.163.com']);
const SHORT_HOST = '163cn.tv';

const invalidInput = (): AppError => new AppError({
  code: 'INVALID_PLAYLIST_INPUT',
  message: '请输入有效的网易云音乐歌单链接或歌单 ID',
});

const requireSafeUrl = (url: URL): void => {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalidInput();
  if (url.username !== '' || url.password !== '' || url.port !== '') throw invalidInput();
};

const idFromPlaylistLocation = (pathname: string, search: string): string | undefined => {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const pathMatch = normalizedPath.match(/^\/(?:m\/)?playlist(?:\/(\d+))?$/);
  if (pathMatch === null) return undefined;
  const pathId = pathMatch[1];
  const queryId = new URLSearchParams(search).get('id') ?? undefined;
  const id = pathId ?? queryId;
  return id !== undefined && PLAYLIST_ID.test(id) ? id : undefined;
};

const candidateValue = (input: PlaylistInput): string => {
  const value = input.playlistId ?? input.url ?? input.value;
  if (typeof value !== 'string' || value.trim() === '') throw invalidInput();
  return value.trim();
};

export const parseNeteasePlaylistInput = (
  input: PlaylistInput,
): ParsedNeteasePlaylistInput => {
  if (input.provider !== undefined && input.provider !== 'netease') throw invalidInput();
  const candidate = candidateValue(input);
  if (PLAYLIST_ID.test(candidate)) {
    return { kind: 'playlist-id', playlistId: candidate };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidInput();
  }
  requireSafeUrl(url);
  const hostname = url.hostname.toLowerCase();

  if (hostname === SHORT_HOST) {
    if (!/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
        url.search !== '' || url.hash !== '') throw invalidInput();
    url.protocol = 'https:';
    url.hostname = SHORT_HOST;
    return { kind: 'short-url', url: url.toString().replace(/\/$/, '') };
  }
  if (!PLATFORM_HOSTS.has(hostname)) throw invalidInput();

  const directId = idFromPlaylistLocation(url.pathname, url.search);
  if (directId !== undefined) return { kind: 'playlist-id', playlistId: directId };

  if (url.hash.startsWith('#')) {
    const hashUrl = new URL(url.hash.slice(1), 'https://music.163.com');
    requireSafeUrl(hashUrl);
    if (!PLATFORM_HOSTS.has(hashUrl.hostname.toLowerCase())) throw invalidInput();
    const hashId = idFromPlaylistLocation(hashUrl.pathname, hashUrl.search);
    if (hashId !== undefined) return { kind: 'playlist-id', playlistId: hashId };
  }
  throw invalidInput();
};

export const isNeteaseRedirectHost = (url: URL): boolean => {
  try {
    requireSafeUrl(url);
    return url.hostname.toLowerCase() === SHORT_HOST ||
      PLATFORM_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
};
