import type { Playlist, ProviderId, Track } from './models.js';

/** A caller-supplied playlist reference before provider-specific parsing. */
export interface PlaylistInput {
  readonly value: string;
  readonly provider?: ProviderId;
  readonly playlistId?: string;
  readonly url?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly message?: string;
  readonly technicalDetails?: Readonly<Record<string, unknown>>;
}

/** Options are intentionally opaque so providers can accept safe runtime-specific settings. */
export interface AuthOptions {
  readonly credentialHandle?: CredentialHandle;
  readonly [key: string]: unknown;
}

export interface CredentialHandle {
  /** An opaque, temporary identifier; credential material must never be stored here. */
  readonly id: string;
  readonly expiresAt?: string;
}

export interface AuthResult {
  readonly authenticated: boolean;
  readonly credentialHandle?: CredentialHandle;
  readonly warnings?: readonly string[];
}

export interface ProgressUpdate {
  readonly phase: string;
  readonly completed?: number;
  readonly total?: number;
  readonly message?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => void;

/** Minimal request surface exposed to providers by an injected, restricted transport. */
export interface HttpTransport {
  request(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface TaskContext {
  readonly signal: AbortSignal;
  readonly onProgress?: ProgressCallback;
  readonly http: HttpTransport;
  readonly credentialHandle?: CredentialHandle;
}

export interface MusicProvider {
  readonly id: ProviderId;
  validateInput(input: PlaylistInput): Promise<ValidationResult>;
  authenticate(options: AuthOptions): Promise<AuthResult>;
  fetchPlaylist(input: PlaylistInput, context: TaskContext): Promise<Playlist>;
  fetchAllTracks(playlistId: string, context: TaskContext): Promise<Track[]>;
  logout(): Promise<void>;
}
