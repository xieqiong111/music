import { AppError, type PlaylistInput } from '@playlist-exporter/contracts';

export interface ParsedApplePlaylistInput {
  readonly kind: 'playlist-ref';
  readonly storefront: string;
  readonly playlistId: string;
}

export interface ParseApplePlaylistInputOptions {
  /** Used only when the input carries no storefront (bare playlist ID). */
  readonly defaultStorefront?: string;
}

const DEFAULT_STOREFRONT = 'us';
const APPLE_HOST = 'music.apple.com';
// Storefronts in canonical music.apple.com links are two lowercase letters.
const STOREFRONT = /^[a-z]{2}$/;
// Catalog playlist ids look like `pl.u-abcdef` (alnum) or legacy numeric ids.
const PLAYLIST_ID = /^(?:pl\.u-[A-Za-z0-9]{1,64}|\d{1,20})$/u;
// `/<storefront>/playlist/<id>` with an optional localized display-name segment
// before the id. Song/album/artist paths intentionally never match.
const PLAYLIST_PATH =
  /^\/([a-z]{2})\/playlist\/(?:[^/]+\/)?(pl\.u-[A-Za-z0-9]{1,64}|\d{1,20})$/u;

const invalidInput = (): AppError => new AppError({
  code: 'INVALID_PLAYLIST_INPUT',
  message: '无法识别该 Apple Music 歌单链接',
});

const requireSafeUrl = (url: URL): void => {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalidInput();
  if (url.username !== '' || url.password !== '' || url.port !== '') throw invalidInput();
};

const resolveDefaultStorefront = (value: string | undefined): string => {
  const storefront = value ?? DEFAULT_STOREFRONT;
  if (!STOREFRONT.test(storefront)) {
    throw new RangeError('defaultStorefront must be a two-letter lowercase storefront');
  }
  return storefront;
};

const candidateValue = (input: PlaylistInput): string => {
  const value = input.playlistId ?? input.url ?? input.value;
  if (typeof value !== 'string' || value.trim() === '') throw invalidInput();
  return value.trim();
};

export const parseApplePlaylistInput = (
  input: PlaylistInput,
  options: ParseApplePlaylistInputOptions = {},
): ParsedApplePlaylistInput => {
  if (input.provider !== undefined && input.provider !== 'apple-music') throw invalidInput();
  const candidate = candidateValue(input);
  if (PLAYLIST_ID.test(candidate)) {
    return {
      kind: 'playlist-ref',
      storefront: resolveDefaultStorefront(options.defaultStorefront),
      playlistId: candidate,
    };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidInput();
  }
  requireSafeUrl(url);
  if (url.hostname.toLowerCase() !== APPLE_HOST) throw invalidInput();

  const normalizedPath = url.pathname.replace(/\/+$/u, '') || '/';
  const pathMatch = normalizedPath.match(PLAYLIST_PATH);
  if (pathMatch?.[1] !== undefined && pathMatch?.[2] !== undefined) {
    return {
      kind: 'playlist-ref',
      storefront: pathMatch[1],
      playlistId: pathMatch[2],
    };
  }
  throw invalidInput();
};
