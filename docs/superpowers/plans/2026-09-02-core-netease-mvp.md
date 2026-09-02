# Core and NetEase MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested TypeScript core, UTF-8 exporters, NetEase public-playlist provider, responsive PWA, and authenticated local NAS service as the first deployable vertical slice.

**Architecture:** A pnpm workspace contains runtime-independent contracts/core/exporters and a NetEase provider behind injected HTTP transport. The React app calls a small same-origin Hono API in NAS mode and executes pure import/export logic locally; Tauri integration is deferred until this vertical slice is proven.

**Tech Stack:** Node.js 24, pnpm 11, TypeScript, Zod, Vitest, React, Vite, Hono, Playwright, Docker.

**Spec:** `docs/superpowers/specs/2026-09-02-streaming-playlist-exporter-design.md`

## Global Constraints

- Only playlist metadata; no audio, playback URL, membership bypass, DRM, or provider write operations.
- All external responses are parsed with Zod before normalization.
- No silent truncation; incomplete pagination is represented explicitly and blocks default success export.
- Credentials and full request headers are never logged.
- UTF-8 TXT defaults to LF and preserves playlist order and duplicate tracks.
- NAS binds to `127.0.0.1` by default and refuses non-loopback startup without `ACCESS_TOKEN`.
- Tests never call a real private playlist or mutate any real playlist.

---

### Task 1: Workspace, contracts, and schemas

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`
- Create: `packages/contracts/package.json`, `packages/contracts/src/index.ts`, `packages/contracts/src/models.ts`, `packages/contracts/src/provider.ts`, `packages/contracts/src/errors.ts`
- Test: `packages/contracts/test/models.test.ts`

**Interfaces:**
- Produces: `ProviderId`, `Track`, `Playlist`, `PlaylistInput`, `TaskContext`, `MusicProvider`, `AppError`, `trackSchema`, `playlistSchema`.

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { trackSchema } from '../src/index.js';

it('rejects a track without a title', () => {
  expect(() => trackSchema.parse({ artists: ['A'], source: 'netease', position: 0 })).toThrow();
});

it('accepts unicode and duplicate artist names without normalization loss', () => {
  const value = trackSchema.parse({
    title: '夜に駆ける 🌙', artists: ['YOASOBI', 'YOASOBI'], source: 'netease',
    position: 0, availability: 'available', warnings: [],
  });
  expect(value.artists).toEqual(['YOASOBI', 'YOASOBI']);
});
```

- [ ] **Step 2: Run `pnpm vitest packages/contracts/test/models.test.ts` and confirm module-not-found failure**
- [ ] **Step 3: Implement exact models and Zod schemas from the design spec; make unknown external fields strip-safe but required fields strict**
- [ ] **Step 4: Run `pnpm vitest packages/contracts/test/models.test.ts` and confirm both tests pass**
- [ ] **Step 5: Run `pnpm exec tsc -p packages/contracts/tsconfig.json --noEmit`**
- [ ] **Step 6: Commit `feat: add shared playlist contracts`**

### Task 2: TXT, CSV, JSON exporters and filenames

**Files:**
- Create: `packages/exporters/package.json`, `packages/exporters/src/index.ts`, `packages/exporters/src/options.ts`, `packages/exporters/src/txt.ts`, `packages/exporters/src/csv.ts`, `packages/exporters/src/json.ts`, `packages/exporters/src/filename.ts`, `packages/exporters/src/dedupe.ts`
- Test: `packages/exporters/test/txt.test.ts`, `packages/exporters/test/csv.test.ts`, `packages/exporters/test/filename.test.ts`, `packages/exporters/test/fixtures.ts`

**Interfaces:**
- Consumes: `Playlist`, `Track` from `@playlist-exporter/contracts`.
- Produces: `exportPlaylist(playlist, options): ExportArtifact`, `sanitizeFilename(name): string`.

- [ ] **Step 1: Write golden TXT tests for LF, no BOM, order, multi-artist, missing artist marker, numbering, reverse layout, album and opt-in dedupe**

```ts
const artifact = exportPlaylist(playlist, { format: 'txt', includeIndex: false, order: 'title-artist', includeAlbum: false, dedupe: false });
expect(new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes)).toBe('歌一 - 歌手甲、歌手乙\n下架曲 - [歌手缺失]\n');
expect([...artifact.bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
```

- [ ] **Step 2: Run exporter tests and confirm missing-exporter failures**
- [ ] **Step 3: Implement exporters with `TextEncoder`, LF joining, RFC 4180 escaping, formula-prefix neutralization, schemaVersion 1 JSON, and stable first-occurrence dedupe**
- [ ] **Step 4: Implement filename cleaning for `<>:"/\\|?*`, control chars, Windows reserved names, trailing dots/spaces, and 180-code-point maximum**
- [ ] **Step 5: Run `pnpm vitest packages/exporters/test` and confirm all golden tests pass**
- [ ] **Step 6: Commit `feat: add utf8 playlist exporters`**

### Task 3: Task state, retry, pagination integrity, and redaction

**Files:**
- Create: `packages/core/package.json`, `packages/core/src/index.ts`, `packages/core/src/task.ts`, `packages/core/src/retry.ts`, `packages/core/src/pagination.ts`, `packages/core/src/redact.ts`, `packages/core/src/http.ts`
- Test: `packages/core/test/task.test.ts`, `packages/core/test/retry.test.ts`, `packages/core/test/pagination.test.ts`, `packages/core/test/redact.test.ts`

**Interfaces:**
- Produces: `TaskController`, `fetchWithRetry`, `PaginationGuard`, `redactSensitive`, `HttpTransport`.

- [ ] **Step 1: Write tests for cancel propagation, 429 Retry-After, cursor repetition, expected-total mismatch, duplicate track IDs retained, and nested credential redaction**
- [ ] **Step 2: Use fake timers to verify retries stop after the configured attempt budget and abort immediately on `AbortSignal`**
- [ ] **Step 3: Implement a monotonic task state machine: `idle -> validating -> authenticating -> fetching -> preview -> exporting -> completed`, with terminal `cancelled|failed`**
- [ ] **Step 4: Implement `PaginationGuard.record({cursor, rawCount, accumulated, expectedTotal})`; throw `PaginationStalled` on repeated cursor and return `complete=false` on total mismatch**
- [ ] **Step 5: Implement recursive case-insensitive redaction for cookie, authorization, token, music-user-token, set-cookie and sensitive URL query parameters**
- [ ] **Step 6: Run `pnpm vitest packages/core/test` and commit `feat: add safe task orchestration`**

### Task 4: NetEase public-playlist provider

**Files:**
- Create: `packages/provider-netease/package.json`, `packages/provider-netease/src/index.ts`, `packages/provider-netease/src/input.ts`, `packages/provider-netease/src/schemas.ts`, `packages/provider-netease/src/provider.ts`, `packages/provider-netease/src/normalize.ts`
- Create: `packages/provider-netease/test/fixtures/playlist-detail.json`, `packages/provider-netease/test/fixtures/tracks-page-1.json`, `packages/provider-netease/test/fixtures/tracks-page-2.json`, `packages/provider-netease/test/fixtures/schema-drift.json`
- Test: `packages/provider-netease/test/input.test.ts`, `packages/provider-netease/test/provider.test.ts`

**Interfaces:**
- Consumes: `MusicProvider`, `HttpTransport`, `PaginationGuard`.
- Produces: `NeteaseProvider`, supporting numeric IDs and `music.163.com`, `y.music.163.com`, `163cn.tv` playlist URLs.

- [ ] **Step 1: Write input tests for numeric ID, hash URL, path URL, mobile URL, rejected song URL, rejected foreign host, and bounded short-link redirect**
- [ ] **Step 2: Write fixture tests for empty, 1001-track two-page, duplicate IDs, missing detail entry, out-of-order detail response, 429 retry, abort, and schema drift**
- [ ] **Step 3: Implement public metadata request through injected transport; never accept an arbitrary credential-bearing remote API base URL**
- [ ] **Step 4: Fetch `/playlist/track/all` pages with explicit offset/limit until a short page or verified total; preserve source positions and create placeholders for missing songs**
- [ ] **Step 5: Return ordinary Chinese error messages plus `technicalDetails` containing redacted endpoint/status/schema path**
- [ ] **Step 6: Run `pnpm vitest packages/provider-netease/test`; commit `feat: add netease public playlist provider`**

### Task 5: Local NAS API and access boundary

**Files:**
- Create: `apps/server/package.json`, `apps/server/src/config.ts`, `apps/server/src/auth.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/src/jobs.ts`
- Test: `apps/server/test/config.test.ts`, `apps/server/test/auth.test.ts`, `apps/server/test/api.test.ts`

**Interfaces:**
- Produces HTTP routes: `GET /healthz`, `POST /api/playlists/inspect`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id`, `POST /api/exports`.
- Job payload never contains credentials; errors use `{code, message, technicalDetails}`.

- [ ] **Step 1: Test that `HOST=0.0.0.0` without `ACCESS_TOKEN` throws before server listen**
- [ ] **Step 2: Test constant-time bearer-token acceptance, rejection without token, loopback token optionality, strict origin handling, 1 MiB body limit, and redacted errors**
- [ ] **Step 3: Implement an in-memory cancellable job registry with bounded concurrency and automatic terminal-job expiry**
- [ ] **Step 4: Implement routes and structured logs; never log body or headers**
- [ ] **Step 5: Run server tests and an HTTP smoke test on `127.0.0.1`; commit `feat: add authenticated local web service`**

### Task 6: React PWA workflow

**Files:**
- Create: `apps/web/package.json`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/i18n/zh-CN.ts`
- Create: `apps/web/src/components/ProviderCards.tsx`, `apps/web/src/components/PlaylistInput.tsx`, `apps/web/src/components/ProgressPanel.tsx`, `apps/web/src/components/PreviewTable.tsx`, `apps/web/src/components/ExportOptions.tsx`, `apps/web/src/components/ErrorDetails.tsx`
- Create: `apps/web/src/styles.css`, `apps/web/public/manifest.webmanifest`, `apps/web/public/icons/README.md`
- Test: `apps/web/src/App.test.tsx`, `apps/web/e2e/export.spec.ts`

**Interfaces:**
- Consumes NAS API or a test adapter implementing `PlaylistService`.
- Produces platform auto-detection, progress/cancel, count/preview, export options and browser download.

- [ ] **Step 1: Write component tests for provider detection, ordinary Chinese errors, expandable technical details, preview count, option changes, and cancel**
- [ ] **Step 2: Implement a responsive single-page workflow with three provider cards; unavailable providers are visibly disabled with capability explanation**
- [ ] **Step 3: Implement zh-CN dictionary access through message keys; no user-facing literal outside the dictionary**
- [ ] **Step 4: Add PWA manifest and service worker that caches only static assets, never API responses or credentials**
- [ ] **Step 5: Write Playwright E2E using a mocked 1001-track job; verify preview, cancel and downloaded UTF-8 TXT bytes**
- [ ] **Step 6: Run unit tests, production build and E2E; commit `feat: add playlist export pwa`**

### Task 7: Docker, Compose, healthcheck, and persistence

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`
- Create: `scripts/docker-smoke.mjs`
- Test: Docker smoke output recorded in `docs/verification/docker.md`

**Interfaces:**
- Image runs as numeric non-root user, exposes 4319, mounts `/data`, and starts server + static web assets.

- [ ] **Step 1: Create a multi-stage build that installs with frozen lockfile, builds workspaces, and copies only production output**
- [ ] **Step 2: Add `HEALTHCHECK` against `/healthz`, non-root `USER`, `HOST=127.0.0.1` default, and `/data` volume**
- [ ] **Step 3: Compose maps `127.0.0.1:4319:4319`, persists `./data:/data`, uses `read_only: true`, and adds tmpfs for `/tmp`**
- [ ] **Step 4: Make LAN mode an explicit Compose profile requiring `ACCESS_TOKEN`**
- [ ] **Step 5: Run amd64 local smoke if Docker exists; run arm64 via buildx when available. If unavailable, record the exact missing tool instead of claiming success**
- [ ] **Step 6: Commit `build: add secure nas container`**

### Task 8: CI, documentation, notices, and MVP verification

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/docker.yml`
- Create: `README.md`, `docs/security.md`, `docs/troubleshooting.md`, `docs/capabilities.md`, `docs/verification/mvp.md`
- Modify: `THIRD_PARTY_NOTICES.md`, `outputs/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- CI runs install, typecheck, unit, build, E2E, secret scan, dependency audit and Docker build without real credentials.

- [ ] **Step 1: Add CI matrices for Node 22 and 24 on Windows, macOS and Ubuntu; cache pnpm store and upload web build artifacts**
- [ ] **Step 2: Add Docker buildx workflow for linux/amd64 and linux/arm64 without publishing from pull requests**
- [ ] **Step 3: Document supported/preview/experimental/unavailable capabilities, local-only defaults, nonofficial API and terms risks, and troubleshooting for 401/403/404/429**
- [ ] **Step 4: Update notices with exact dependency versions, source URLs, license identifiers and any copied/modified files**
- [ ] **Step 5: Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm e2e`, `pnpm audit --prod`, and Docker smoke when available**
- [ ] **Step 6: Record exact commands, exit codes, pass/fail counts and platform limitations in `docs/verification/mvp.md`**
- [ ] **Step 7: Commit `docs: complete netease mvp verification`**
