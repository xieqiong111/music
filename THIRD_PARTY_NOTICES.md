# Third-Party Notices

This project uses the direct dependencies listed below. No real credential, user playlist,
audio asset, font, or third-party fixture has been incorporated.

The Phase 1 candidate ledger is preserved in `outputs/THIRD_PARTY_NOTICES.md`. Before any reuse, this file must record the exact repository, immutable commit or package version, incorporated files/functions/assets, SPDX license, required license/NOTICE text, local modifications, and verification performed.

## Direct dependencies

| Component | Version | Source | SPDX | Use and distribution |
|---|---:|---|---|---|
| Hono | 4.13.5 | https://github.com/honojs/hono | MIT | HTTP routing and body-limit middleware; bundled into the NAS server artifact |
| @hono/node-server | 2.1.1 | https://github.com/honojs/node-server | MIT | Node HTTP adapter; bundled into the NAS server artifact |
| Zod | 4.5.4 | https://github.com/colinhacks/zod | MIT | Runtime schema validation; bundled into packages and the NAS server artifact |
| music-metadata | 11.15.0 | https://github.com/Borewit/music-metadata | MIT | Audio file tag/duration parsing for the NAS local music library scanner and the web client's on-device (IndexedDB) music library; bundled into the NAS server artifact and the web PWA bundle (browser-safe `core` entry, lazy-loaded) |
| esbuild | 0.28.2 | https://github.com/evanw/esbuild | MIT | Build-time bundler only; its executable/source is not included in the server artifact |
| React | 19.2.8 | https://github.com/facebook/react | MIT | Web UI runtime; bundled into the PWA |
| React DOM | 19.2.8 | https://github.com/facebook/react | MIT | Browser renderer; bundled into the PWA |
| Vite | 8.2.2 | https://github.com/vitejs/vite | MIT | PWA build and development tooling |
| @vitejs/plugin-react | 6.1.1 | https://github.com/vitejs/vite-plugin-react | MIT | React transform used at build time |
| Testing Library React | 16.3.3 | https://github.com/testing-library/react-testing-library | MIT | Test-only UI assertions |
| Testing Library jest-dom | 7.0.1 | https://github.com/testing-library/jest-dom | MIT | Test-only DOM matchers |
| Testing Library user-event | 14.6.7 | https://github.com/testing-library/user-event | MIT | Test-only user interaction simulation |
| jsdom | 30.0.1 | https://github.com/jsdom/jsdom | MIT | Test-only browser DOM implementation |
| @types/react | 19.2.18 | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT | Development-only React type declarations |
| @types/react-dom | 19.2.7 | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT | Development-only React DOM type declarations |
| @playwright/test | 1.62.1 | https://github.com/microsoft/playwright | Apache-2.0 | Test-only end-to-end browser testing (Chromium headless shell); not part of any build artifact |
| @types/node | 24.13.3 | https://github.com/DefinitelyTyped/DefinitelyTyped | MIT | Development-only Node.js type declarations for e2e tooling |
| @tauri-apps/cli | 2.11.4 | https://github.com/tauri-apps/tauri | Apache-2.0 or MIT | Build-time only desktop/mobile packaging CLI for apps/desktop; its code is not bundled into any product artifact |

### Apache-2.0 license notice (@playwright/test)

Copyright Microsoft Corporation. Licensed under the Apache License, Version 2.0.
You may obtain a copy of the license at https://www.apache.org/licenses/LICENSE-2.0.

No dependency source was manually copied or modified. Versions are locked in `pnpm-lock.yaml`.
The generated server bundle is a transformation of this project's TypeScript and the three
runtime dependencies above. Local integration adds strict Origin/Bearer checks, a 1 MiB input
limit, a fixed HTTPS egress allowlist, cancellable jobs, and safe error/logging boundaries.

### MIT license text

Copyright (c) 2021-present Yusuke Wada and Hono contributors (Hono)

Copyright (c) 2022-present Yusuke Wada and Hono contributors (@hono/node-server)

Copyright (c) 2025 Colin McDonnell (Zod)

Copyright (c) 2016-present Borewit and music-metadata contributors

Copyright (c) 2020 Evan Wallace (esbuild)

Copyright (c) Meta Platforms, Inc. and affiliates (React and React DOM)

Copyright (c) 2019-present Evan You and Vite contributors (Vite)

Copyright respective Testing Library and jsdom contributors

Copyright respective DefinitelyTyped contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

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

