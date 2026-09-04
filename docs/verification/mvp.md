# MVP 验证记录

> 回填日期：2026-09-05；执行人：GLM-5.3-Flash 代理（ZCode 会话，Windows 本机）。
> 本文档记录 MVP 阶段在本机实际执行的验证；未执行的条目如实标注"未执行/未验证"，不构成结论。

## 执行环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11（10.0.26200 x64，Git Bash） |
| Node 版本 | 24.20.0 |
| pnpm 版本 | 11.19.0（corepack 按 `packageManager` 字段解析） |
| 执行日期 | 2026-09-04 ～ 2026-09-05 |
| 分支 / 提交 | codex/core-netease-mvp（基线 49c4f16，本次验证对应 PWA/Docker/CI 三个新提交） |

## 自动化命令清单

| # | 命令 | 预期 | 实际结果 | 退出码 |
|---|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 依赖严格按 `pnpm-lock.yaml` 安装成功，lockfile 无变更 | 成功（基线安装 + 后续新增 `@playwright/test`、`@types/node` 时再次执行） | 0 |
| 2 | `pnpm typecheck` | 全部工作区（contracts / core / exporters / provider-netease / server / web）类型检查通过 | 全部 Done（含新增 `apps/web/e2e` 与 `playwright.config.ts`） | 0 |
| 3 | `pnpm test` | 全部工作区 Vitest 单元测试通过 | **27 个测试文件、190 个测试全部通过**（含新增 `apps/server/test/static.test.ts` 6 例） | 0 |
| 4 | `pnpm --filter @playlist-exporter/web build` | Web 生产构建成功，产出 PWA 静态资源（含 `sw.js`、`manifest.webmanifest`） | 成功（122 modules；dist 含 manifest 与 sw.js） | 0 |
| 5 | `pnpm --filter @playlist-exporter/server build` | Server 打包成功，产出 `apps/server/dist/index.js` | 成功（esbuild 单文件 bundle，约 900 kB，运行时无需 node_modules） | 0 |
| 6 | `pnpm --filter @playlist-exporter/web e2e` | Playwright E2E 全部通过（覆盖 1001 首歌单读取、任务取消、UTF-8 TXT 下载） | **3 passed (6.5s)**：1001 首导出、取消调用 DELETE、非法文件名清理。Chromium headless shell 151.0.7922.34 | 0 |
| 7 | `git diff --check` | 无空白错误 | 通过（仅 CRLF 提示性 warning） | 0 |

E2E 补充说明：本机访问 `cdn.playwright.dev` 长时间 0% 卡死，改用 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` 后下载成功。E2E 首次运行暴露并修复了 `apps/web/src/api.ts` 中 detached `fetch`（"Illegal invocation"）的真实缺陷；另确认上次运行泄漏的 4321 preview 进程会让 `reuseExistingServer` 复用旧产物，现改为仅非 CI 复用并在启动前清理端口。

## 手动验收场景

| # | 场景 | 预期 | 实际结果 | 退出码 / 结论 |
|---|---|---|---|---|
| M1 | 开发模式起服后访问 `/healthz` | 返回 `{"status":"ok"}`，服务仅监听回环 | `PORT=4391 WEB_DIST=apps/web/dist node apps/server/dist/index.js`：`/healthz` 200 `{"status":"ok"}`；netstat 确认仅 `127.0.0.1:4391` LISTENING；同源静态 `/`、`/assets/*`、`/sw.js` 均 200 且缓存策略正确（交接前 4319 亦验证过一次） | 0 / 通过 |
| M2 | 粘贴网易云公开歌单链接或数字 ID 并读取 | 显示进度，完成后进入预览 | 真实链路（curl + Bearer）：POST inspect 202 → 轮询 completed，歌单 `Coco (Original Motion Picture Soundtrack` 共 53 首、`complete=true`、首末条曲名与顺序正确、无 warnings | 0 / 通过 |
| M3 | 读取超过 1000 首的公开歌单 | 分页读取完整 | **真实 >1000 歌单未人工执行**；该行为由单元测试（1001 首两页 fixture）与 E2E（模拟 1001 首、进度到 1001/1001、导出 1001 行）覆盖 | — / 部分验证 |
| M4 | 读取过程中取消 | 任务 cancelled，无导出文件 | 由 E2E 覆盖：点击取消后收到 DELETE `/api/jobs/:id`，导出面板不出现、无任何 POST `/api/exports` | 0 / 通过（E2E） |
| M5 | 导出 TXT（默认选项） | UTF-8 无 BOM、LF、`歌曲名 - 歌手` | 真实服务端导出 3759 字节：严格 UTF-8 解码成功、无 BOM、无 CR、以 LF 结尾、53 行、首末行正确、文件名 `netease_Coco (Original Motion Picture Soundtrack_2026-09-05.txt`（上游歌单名本身缺右括号） | 0 / 通过 |
| M6 | 导出选项：序号 / 专辑 / 去重 / CRLF / CSV / JSON | 各选项生效 | 未逐项人工执行；由 `packages/exporters` 单元测试（golden TXT/CSV/JSON/文件名）覆盖，E2E 额外覆盖默认 TXT 与文件名规则 | — / 部分验证 |
| M7 | `HOST=0.0.0.0` 且不设 `ACCESS_TOKEN` | 拒绝启动 | 由 `apps/server/test/config.test.ts` 单元测试覆盖（`ACCESS_TOKEN 在非 loopback 监听时必须配置`）；本机未另行手工执行 | — / 单元测试覆盖 |
| M8 | 配置令牌后不带/带错误/带正确令牌请求 API | 401 / 401 / 202 | 实测：无令牌 401 `AUTH_REQUIRED`；`Bearer wrong` 401；`Bearer smoke-token-123` 202 并返回 jobId | 0 / 通过 |
| M9 | 未列入白名单的 Origin 请求 API | 403 `ORIGIN_NOT_ALLOWED` | 实测：`origin: https://evil.example` 与 `origin: http://127.0.0.1:4321`（非白名单）均 403，响应含 requestId 且无 CORS 头 | 0 / 通过 |
| M10 | 服务日志检查 | 仅 requestId 与状态码 | 实测日志行形如 `{"requestId":"…","status":403}`，无令牌/Cookie/查询参数 | 0 / 通过 |
| M11 | 服务重启后旧任务 ID | 404 `JOB_NOT_FOUND` | 未人工执行；由 `apps/server/test/api.test.ts`、`runtime.test.ts` 单元测试覆盖（内存注册表 + TTL） | — / 单元测试覆盖 |
| M12 | Docker 镜像（amd64/arm64）构建与运行 | 构建并健康检查通过 | **未验证：本机无 Docker/Buildx（`docker --version` 退出码 127）**。详见 `docs/verification/docker.md` 与 `scripts/docker-smoke.mjs`（待有 Docker 的环境执行） | — / 未验证 |

## 回填说明

- 回填完成后，请在本节顶部注明回填日期与执行人。（已完成，见顶部）
- 任一命令失败时，保留失败输出与退出码，不要删除失败记录；后续修复应在新增行中记录复测结果。
- 本文档只记录 MVP 阶段验证；后续阶段（QQ、Apple、Tauri、发布）各自建立独立验证记录。
