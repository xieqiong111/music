# Third-Party Notices

> Status: Phase 1 research ledger plus implementation provenance, 2026-09-04.

No candidate-project source code, binary, font, fixture, credential, or user playlist has been copied into the product. The implementation now uses versioned npm dependencies; the exact runtime/build components and required MIT notices are recorded in the root `THIRD_PARTY_NOTICES.md`. The candidate entries below remain research evaluations only.

Current direct additions for the NAS service: Hono 4.13.5 (MIT), @hono/node-server 2.1.1 (MIT), Zod 4.5.4 (MIT, already used by shared packages), and esbuild 0.28.2 (MIT, build-time only). No dependency source was manually modified.
Current direct additions for the PWA checkpoint: React and React DOM 19.2.8 (MIT), Vite 8.2.2 and its React plugin 6.1.1 (MIT), plus Testing Library, jsdom, and React type packages used only for development tests. Exact versions and canonical sources are recorded in the root notice. No dependency source was manually modified.
Current direct additions for the PWA end-to-end suite: @playwright/test 1.62.1 (Apache-2.0, test-only browser automation with Chromium headless shell) and @types/node 24.13.3 (MIT, development-only types). Both are excluded from every build artifact. No dependency source was manually modified.

Before any reuse, the exact source repository, immutable commit, file/function, license text, required notices, local modifications, and verification tests must be recorded here.

## Approved for scoped evaluation

| Project | Source | License observed | Possible scoped reuse | Current status |
|---|---|---|---|---|
| music-likes-sync | https://github.com/HomoLand/music-likes-sync | MIT | NetEase pagination and test ideas only | Evaluated; no code copied |
| Listen1 Chrome Extension | https://github.com/listen1/listen1_chrome_extension | MIT | URL parsing and field-normalization ideas only | Evaluated; no code copied |
| ncm-cli | https://github.com/MiaowCham/ncm-cli | MIT; separate OFL/BSD notices exist for bundled assets/native helper | Pure NetEase pagination, export, redaction, and tests; exclude font/native helper unless separately approved | Evaluated; no code copied |
| backup_playlists | https://github.com/danissimov/backup_playlists | MIT | Apple pagination and metadata mapping ideas only | Evaluated; no code copied |
| applemusic-mcp | https://github.com/epheterson/applemusic-mcp | MIT | Apple official API implementation reference | Evaluated; no code copied |
| SongMirror | https://github.com/ahnafnafee/songmirror | MIT | Versioned backup schema ideas | Evaluated; no code copied |
| halo_music | https://github.com/zhoujungis/halo_music | Apache-2.0 | Provider normalization and pagination-test ideas | Evaluated; no code copied |
| NetEase Playlist Exporter | https://github.com/LwhJesse/Netease-Playlist-Exporter | MIT | Completeness checks and export schema ideas | Evaluated; no code copied |
| NeteaseCloudMusicApi Enhanced | https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced | MIT | Protocol behavior reference at commit `f5ce55bcb46e29c8e5350ca796fb1cc9d9914acd`, `module/playlist_track_all.js` | Request sequence inspected; no code copied and no dependency installed |

## Excluded or blocked

| Project | Source | Reason |
|---|---|---|
| musicdl | https://github.com/CharlesPikachu/musicdl | PolyForm Noncommercial is incompatible with potential commercial distribution; also has known Apple playlist limits |
| go-music-dl / music-lib | https://github.com/guohuiyuan/go-music-dl | AGPL-3.0 obligations are not accepted for the proposed product at this stage |
| copws/qq-music-api | https://github.com/copws/qq-music-api | No clear repository license; source code must not be copied |
| Listen1 network/auth layer | https://github.com/listen1/listen1_chrome_extension | Browser-global/cookie coupling, unproven QQ completeness, and platform-interface risk make direct reuse unsuitable |
| music-likes-sync write/AI/server layer | https://github.com/HomoLand/music-likes-sync | Out of scope for a read-only exporter and lacks required LAN authentication boundary |

## Notice procedure for future changes

For every incorporated component, add an entry containing:

1. Project name and canonical source URL.
2. Immutable commit or released version.
3. Exact files/functions/assets incorporated.
4. SPDX license identifier and a bundled copy of the required license/NOTICE.
5. Whether the code is copied, modified, linked as a dependency, or used only to derive a test fixture.
6. A concise description of local modifications.
7. Verification that no credential, real playlist, audio URL, DRM logic, or restricted/noncommercial code was included.

