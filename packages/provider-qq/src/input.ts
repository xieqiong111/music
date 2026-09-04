import { AppError, type PlaylistInput } from '@playlist-exporter/contracts';

export type ParsedQqPlaylistInput =
  | { readonly kind: 'playlist-id'; readonly playlistId: string };

const PLAYLIST_ID = /^[1-9]\d{0,19}$/;
const PLATFORM_HOSTS = new Set(['y.qq.com', 'c.y.qq.com', 'i.y.qq.com']);

const invalidInput = (): AppError => new AppError({
  code: 'INVALID_PLAYLIST_INPUT',
  message: '请输入有效的 QQ 音乐歌单链接或歌单 ID',
});

const requireSafeUrl = (url: URL): void => {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalidInput();
  if (url.username !== '' || url.password !== '' || url.port !== '') throw invalidInput();
};

const idFromPlaylistLocation = (pathname: string, search: string): string | undefined => {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const pathMatch = normalizedPath.match(/^\/(?:[\w-]+\/)*playlist\/(\d+)(?:\.html)?$/);
  const pathId = pathMatch?.[1];
  const queryId = new URLSearchParams(search).get('disstid') ?? undefined;
  const id = pathId ?? queryId;
  return id !== undefined && PLAYLIST_ID.test(id) ? id : undefined;
};

const candidateValue = (input: PlaylistInput): string => {
  const value = input.playlistId ?? input.url ?? input.value;
  if (typeof value !== 'string' || value.trim() === '') throw invalidInput();
  return value.trim();
};

export const parseQqPlaylistInput = (
  input: PlaylistInput,
): ParsedQqPlaylistInput => {
  if (input.provider !== undefined && input.provider !== 'qq-music') throw invalidInput();
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
  if (!PLATFORM_HOSTS.has(url.hostname.toLowerCase())) throw invalidInput();

  const directId = idFromPlaylistLocation(url.pathname, url.search);
  if (directId !== undefined) return { kind: 'playlist-id', playlistId: directId };
  throw invalidInput();
};
