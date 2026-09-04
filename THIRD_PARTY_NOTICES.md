# Third-Party Notices

No third-party source code, binary, font, fixture, credential, or user playlist has been incorporated at the start of implementation.

The Phase 1 candidate ledger is preserved in `outputs/THIRD_PARTY_NOTICES.md`. Before any reuse, this file must record the exact repository, immutable commit or package version, incorporated files/functions/assets, SPDX license, required license/NOTICE text, local modifications, and verification performed.

## Protocol behavior references (no code incorporated)

The NetEase public-playlist adapter was implemented independently. It uses only fixed
`music.163.com` metadata endpoints and does not distribute, link, or install any third-party
API server. The following source was inspected to corroborate request sequencing only:

- NeteaseCloudMusicApi Enhanced, commit `f5ce55bcb46e29c8e5350ca796fb1cc9d9914acd`,
  `module/playlist_track_all.js`, MIT. Observed behavior: obtain ordered track IDs from
  `/api/v6/playlist/detail`, batch IDs, then request `/api/v3/song/detail`. No source code,
  fixture, binary, credential, or license text was copied into this repository. Local work
  consists of a new TypeScript adapter with runtime schemas, injected transport, cancellation,
  retry, bounded batching, completeness checks, and synthetic test fixtures.

## Excluded sources

- PolyForm Noncommercial code is excluded from a potentially commercial distribution.
- AGPL-3.0 code is excluded unless the project explicitly accepts its network copyleft obligations.
- Source code without an explicit compatible license must not be copied.
- Playback, audio downloading, DRM, membership bypass, and provider write-operation code is out of scope regardless of license.

