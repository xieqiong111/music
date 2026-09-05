# 项目交接文档（供 GPT 审查与补充）

- 交接日期：2026-09-05
- 交接对象：审查/补充代理（GPT）
- 本文档自包含：阅读本文即可了解项目全貌、验证状态、边界约束与续作建议。

## 1. 项目是什么

本地优先的跨平台流媒体歌单**元数据**导出工具：读取 Apple Music、网易云音乐、QQ 音乐的公开歌单（或 Apple 官方导出文件），按原始顺序导出 UTF-8 TXT（默认）/CSV/JSON。

**硬边界（产品与安全红线，任何修改不得越过）：**

- 只读歌单元数据；**不下载音频、不提取试听地址、不绕过 DRM/会员/地区限制**、不修改平台数据。
- 不上传歌单、Cookie、Token；凭证不入 URL/查询参数/`VITE_` 变量/浏览器持久存储。
- 日志只允许 requestId + 状态码；Authorization/Cookie/token 必须递归脱敏。
- 缺失歌手、下架/不可用、分页不完整必须**显式标记**；禁止把部分结果伪装成完整成功。
- 外部响应必须经运行时 Zod schema 校验；平台接口必须在独立 Provider/Adapter 内，UI 不直接调用。
- 测试/fixture 禁止使用真实用户歌单、真实凭证；仓库禁止提交证书/私钥/真实配置。
- 复用第三方代码必须确认许可证并登记 `THIRD_PARTY_NOTICES.md`。

## 2. 当前基线

- git worktree：`.worktrees/core-netease-mvp`（相对主仓库 `D:/gpt/2026-09-02/apple-music-qq-utf-8-txt`）
- 分支：`codex/core-netease-mvp`，HEAD：`67b09ef`
- 本轮代理完成的提交链（早于其上还有 8 个前置提交，完整历史见压缩包内的 git bundle）：

| 提交 | 内容 |
|---|---|
| `282bc69` | React/Vite PWA + Playwright E2E（1001 首/取消/UTF-8 下载）；修复 `api.ts` detached fetch（"Illegal invocation"） |
| `5a9c3b8` | Docker/NAS：多阶段 Dockerfile、compose（回环默认 + LAN profile + 强制令牌）、WEB_DIST 静态托管、冒烟脚本 |
| `f48d9a5` | CI（Node 22/24 × 三平台 + E2E + gitleaks + audit，action 以 SHA 固定）、中文 README、安全/排查/能力文档 |
| `c851401` | QQ 音乐公开歌单 Provider（门禁实测 1240 首完整分页；`songids` 全序哨兵） |
| `f20c22b` | Apple：官方文件本地导入（稳定）+ MusicKit v1 BYO Token 预览（Preview，未实测） |
| `67b09ef` | Tauri 2 打包脚手架（Windows/macOS/Android 配置；本机无工具链，全部未构建） |

- 运行环境记录：Windows 11（10.0.26200）、Node 24.20.0、pnpm 11.19.0（corepack，`packageManager` 字段锁定）。

## 3. 能力与验证状态总表

| 能力 | 状态 | 证据 |
|---|---|---|
| 网易云公开歌单（>1000 首分页） | 可用 | 单测（1001 首两页 fixture）+ E2E + 交接前实测（53 首歌单全链路） |
| QQ 公开歌单 | 可用 | 线上门禁实测（1240 首，累计 == songnum，`songids` 逐位一致）+ 本机真实服务端冒烟（1240 首 → 导出 TXT 1240 行、无 BOM/LF）+ 45 项单测 |
| Apple 文件导入（TXT/TSV/XML/JSON） | 可用（本机解析，零网络） | 58 项单测 + E2E（真实浏览器上传 → 本机导出，零 API 请求） |
| Apple 在线 API（MusicKit v1） | **Preview，未实测**（无真实开发者令牌） | 63 项合成 fixture 单测 + server 集成测试（令牌注入/401 不重试/egress） |
| Apple 浏览器会话解析 | 未实现（设计规定 Unavailable/默认关闭） | — |
| NAS Docker | 脚手架完成，**容器构建/运行未验证**（本机无 Docker） | `docs/verification/docker.md` |
| CI | workflow 完成，**未在 GitHub Actions 实跑** | `.github/workflows/ci.yml`、`docker.yml` |
| Tauri 打包 | 脚手架完成，**全部构建目标未构建**（无 Rust/Android SDK） | `docs/verification/tauri.md` |

全仓自动化验证（2026-09-05 实测）：`pnpm test` **38 文件 / 374 用例全部通过**；`pnpm typecheck` 9 个工作区全过；`pnpm install --frozen-lockfile` 通过；server/web 构建通过；`pnpm --filter @playlist-exporter/web e2e` **5 用例全过**；`git diff --check` 通过。

分阶段详细验证记录（命令、退出码、未验证清单）：
- `docs/verification/mvp.md`（MVP 全量）
- `docs/verification/qq.md`（QQ 门禁 + 真实冒烟）
- `docs/verification/apple.md`（导入 + Preview）
- `docs/verification/docker.md`（Docker 未验证清单）
- `docs/verification/tauri.md`（Tauri 未验证清单）
- `outputs/research/2026-09-05-qq-public-api-probe.md`（QQ 端点 40 次实测记录）

## 4. 如何运行与验证（在本机复现）

```bash
pnpm install --frozen-lockfile   # Node >=24，pnpm 11.19.0（corepack enable）
pnpm test                        # 38 文件 / 374 用例
pnpm typecheck                   # 9 个工作区
pnpm --filter @playlist-exporter/web build
pnpm --filter @playlist-exporter/server build
pnpm --filter @playlist-exporter/web e2e   # 首次需安装浏览器：
#   pnpm --filter @playlist-exporter/web exec playwright install --only-shell chromium
#   （若 cdn.playwright.dev 卡住：PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright）
git diff --check
```

手动起服（回环零配置）：

```bash
pnpm --filter @playlist-exporter/server build
pnpm --filter @playlist-exporter/server start     # 127.0.0.1:4319
pnpm --filter @playlist-exporter/web build
pnpm --filter @playlist-exporter/web exec vite preview --host 127.0.0.1 --port 4321
# 或开发模式：pnpm --filter @playlist-exporter/web dev（4320，/api 代理到 4319）
```

服务端环境变量：`HOST`（默认 127.0.0.1；非回环必须配 `ACCESS_TOKEN` 否则拒绝启动）、`PORT`、`ACCESS_TOKEN`、`ALLOWED_ORIGINS`、`WEB_DIST`（设置后同源托管 PWA）、`APPLE_DEVELOPER_TOKEN`（可选，启用 Apple Preview）、`MAX_BODY_BYTES`（固定 1MiB）、`MAX_CONCURRENT_JOBS`/`MAX_QUEUED_JOBS`/`JOB_TTL_MS`。

Docker：`cp .env.example .env`（必须设 `ACCESS_TOKEN`）→ `docker compose up -d --build`；LAN 模式 `docker compose --profile lan up -d app-lan`。容器冒烟：`node scripts/docker-smoke.mjs`（需 Docker）。

## 5. 仓库结构导览

```
packages/contracts        Track/Playlist/Provider 合约、Zod schema、AppError、redactSensitive
packages/core             任务状态机、fetchWithRetry(429+Retry-After)、PaginationGuard、受限 HTTP transport
packages/exporters        TXT/CSV/JSON 渲染、文件名清理（非法字符/保留名/180 码点）、去重
packages/provider-netease 网易云公开歌单 Provider（两阶段：detail + song 批量）
packages/provider-qq      QQ Provider（i.y.qq.com GET 端点、songids 哨兵、GBK 防御解码）
packages/provider-apple   MusicKit v1 预览 Provider（BYO JWT；trackCount/next 双重完整性）
packages/importers        Apple 文件解析（TSV 编码嗅探/plist XML 防XXE/JSON envelope）
apps/server               Hono 本地服务：鉴权（恒定时间 Bearer）、Origin 白名单、1MiB body 限制、
                          内存任务 TTL/取消/限速、egress 白名单（music.163.com,y.music.163.com,
                          163cn.tv,i.y.qq.com,api.music.apple.com）、WEB_DIST 静态托管
apps/web                  React PWA（平台卡片/输入/进度取消/预览/导出选项/文件导入）、i18n zh-CN、
                          SW 仅缓存同源静态资源；Playwright E2E（e2e/export.e2e.ts，5 用例）
apps/desktop              Tauri 2 脚手架（未构建）
.github/workflows         ci.yml（三平台矩阵+E2E+gitleaks+audit）、docker.yml（amd64/arm64，不推送）
docs/                     specs/plans/verification/security/troubleshooting/capabilities/handoff
outputs/                  THIRD_PARTY_NOTICES（研究台账）、research（QQ 探测记录）
Dockerfile / docker-compose.yml / .env.example / scripts/docker-smoke.mjs
```

## 6. 已知未验证项与风险（审查重点）

1. **Apple Preview 从未打真实 API**：schema 依官方文档实现；最可能的漂移点是续页 envelope 与 `trackCount` 语义。漂移会以 `PROVIDER_SCHEMA_DRIFT` 或 `complete=false` 诚实呈现，不会导出错误数据。审查可重点核对其 `schemas.ts` 与 Apple 文档差异。
2. **真实 Music.app 导出文件未获得**：importers 的表头同义词表（名称/Name、艺术家/Artist、专辑/Album、总时间/Total Time）与 UTF-16 导出建议用真实文件人工复核一次。
3. **Docker 全链路零实测**：`node scripts/docker-smoke.mjs` 已就绪，需有 Docker 的机器执行；容器内 pnpm 11 对依赖 lifecycle 脚本默认拦截，esbuild/rollup 依赖 optional-deps 兜底，需实测确认。
4. **CI 未上 GitHub 实跑**；action SHA 于 2026-09-04 核对。
5. **Tauri 未构建**：`tauri.conf.json` 启用 JSON5 注释（依赖 `config-json5` feature 组合）；Android identifier 覆盖方案未验证；图标为占位；dialog/安全存储（Keychain/Keystore）接入为后续任务。
6. QQ/网易上游为非官方公开端点，存在失效风险（QQ 同族端点已有 404 先例）；失效时以结构化中文错误呈现，不会静默截断。
7. 预存在的小问题：`apps/server` 有一个曾偶发的 flaky 断言已被修复（时间戳含 "42"）；QQ 真实读取的节流依赖 transport `minIntervalMs=250ms`，低于人工探测建议的 1.5s，如遇风控需调大。

## 7. 审查与补充建议（可直接执行的下一步）

优先级从高到低：

1. **在 GitHub 上让 CI 跑起来**并按结果修 workflow（唯一未验证的自动化防线）。
2. **有 Docker 的机器执行 `node scripts/docker-smoke.mjs`**，回填 `docs/verification/docker.md`；确认容器内 pnpm install 与 healthcheck。
3. **申请 Apple 开发者令牌后实测 Preview**：重点核对 tracks 续页 envelope、`trackCount`；回填 `docs/verification/apple.md`。
4. **真实 Music.app 导出文件人工导入验证**（浏览器拖入即可）；必要时扩充 `packages/importers/src/apple-text.ts` 的 `HEADER_SYNONYMS`。
5. **Tauri 构建验证**（Windows x64 先行）：按 `apps/desktop/README.md` 命令执行，回填 `docs/verification/tauri.md`；随后接入 plugin-dialog 保存对话框与安全存储（Keychain/Keystore/stronghold）。
6. 可选补充：桌面端安全存储落地；网易云私人歌单 Preview；`docs/verification/mvp.md` 的 M3（真实 >1000 首网易云歌单人工读取）与 M6（导出选项逐项人工验证）。

## 8. 约束（审查/补充时必须遵守）

- 不要大规模重写已验证的核心（contracts/core/exporters/providers 的对外契约与测试是回归基线）。
- 每个平台接口保持独立 Provider；UI 不直接调用平台接口；外部响应必经 Zod。
- 新增第三方依赖必须登记 `THIRD_PARTY_NOTICES.md`（根 + outputs 台账）。
- 永远遵守第 1 节的安全红线；测试不触网（E2E 走网络层 mock）。
- 修完必须重跑第 4 节命令并在对应 `docs/verification/*.md` 回填真实结果；不通过就如实记录。

## 9. Git 历史恢复（压缩包内含 bundle）

```bash
git clone playlist-exporter-branch.bundle playlist-exporter
cd playlist-exporter && git checkout codex/core-netease-mvp
pnpm install --frozen-lockfile && pnpm test
```

## 10. 压缩包内容说明

`playlist-exporter-handoff-2026-09-05.tar.gz` 包含：完整工作树源码（排除 node_modules/dist/构建产物/.git）+ `docs/GLM-5.3-FLASH-HANDOFF.md`（本文档）+ `playlist-exporter-branch.bundle`（分支全部提交历史）。解压后先读本文档第 4、8 节。
