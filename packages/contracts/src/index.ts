export {
  availabilitySchema,
  playlistSchema,
  providerIdSchema,
  trackSchema,
} from './models.js';
export type { Playlist, ProviderId, Track, TrackAvailability } from './models.js';

export type {
  AuthOptions,
  AuthResult,
  CredentialHandle,
  HttpTransport,
  MusicProvider,
  PlaylistInput,
  ProgressCallback,
  ProgressUpdate,
  TaskContext,
  ValidationResult,
} from './provider.js';

export { AppError, isAppError } from './errors.js';
export type { AppErrorInit, TechnicalDetails } from './errors.js';
