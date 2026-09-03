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
  IncompletePaginationErrorCode,
  MusicProvider,
  PlaylistInput,
  ProgressCallback,
  ProgressUpdate,
  TaskContext,
  ValidationResult,
} from './provider.js';

export { APP_ERROR_CODES, AppError, isAppError } from './errors.js';
export type { AppErrorCode, AppErrorInit, TechnicalDetails } from './errors.js';
export { redactSensitive, redactUrl } from './redact.js';
