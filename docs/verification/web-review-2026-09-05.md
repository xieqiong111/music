# Web / Desktop / Docker / CI 审查记录

- 日期：2026-09-05
- 目标：`codex/core-netease-mvp`，HEAD `1d23c53`，并包含审查时工作树中的未提交改动。
- 范围：`apps/web/**`、`apps/desktop/**`、`Dockerfile`、`docker-compose.yml`、`.github/workflows/**`、`scripts/**`。
- 限制：未访问真实歌单、未推送、未上传审计结果；Tauri 构建工具链按仓库验证记录仍不可用。

## Findings

### P1 — Docker 依赖安装层漏复制 workspace manifests

- 位置：`Dockerfile:12-20`。
- 触发：构建阶段先按 `pnpm-workspace.yaml` 安装，但只复制了 server/web、contracts、core、exporters、provider-netease 六个 `package.json`。锁文件仍包含 `packages/importers`、`packages/provider-apple`、`packages/provider-qq` 的 workspace importer（`pnpm-lock.yaml:140-198`），且 server/web 的依赖分别引用这些包。
- 影响：`docker build` 在源码复制前无法得到完整 workspace 清单，`pnpm install --frozen-lockfile` 不能按锁文件解析完整工作区，镜像构建被阻断或无法稳定复用安装层。
- 建议：安装层复制所有 workspace `package.json`（或采用受控的 manifest 复制脚本），并在 Docker smoke/CI 中实际执行 frozen install + build。

### P1 — Compose 默认部署的浏览器 POST 被 Origin 白名单拒绝

- 位置：`docker-compose.yml:19-28`（`HOST=0.0.0.0`，未设置 `ALLOWED_ORIGINS`）；`apps/server/src/config.ts:97-111,114-126`；`apps/server/src/app.ts:180-183`。
- 触发：非 loopback host 的 `defaultOrigins()` 返回空数组；因此 compose 没有 `ALLOWED_ORIGINS` 时白名单为空。浏览器从默认映射的 `http://127.0.0.1:${PORT}` 打开 UI 后，`POST /api/playlists/inspect` 携带 Origin，服务端返回 `403 ORIGIN_NOT_ALLOWED`，读取流程无法开始。
- 建议：为默认 loopback origin 显式设置与宿主端口一致的白名单（至少 `127.0.0.1`，按文档需要同时支持 `localhost`）；LAN profile 要求用户显式填写实际 UI origin，避免用 `*` 放宽。

### P1 — Service Worker 的固定 v1 + cache-first 使入口 HTML 长期不刷新

- 位置：`apps/web/public/sw.js:1-2,10-15,32-42`；注册点 `apps/web/src/main.tsx:18-20`。
- 触发：`/`、`/index.html`、`/sw.js` 与静态资源均进入 allowlist，fetch handler 先返回缓存；缓存名永远是 `playlist-exporter-static-v1`，没有按发布版本生成或变更。
- 影响：部署新版本后，受旧 SW 控制的客户端继续拿缓存中的旧入口 HTML，因而继续引用旧 hash 资源；修复和新功能不会到达已有客户端，且现有 `sw.test.ts` 没覆盖更新/失效场景。
- 建议：入口导航采用 network-first（离线再回退缓存），版本化/构建时生成 cache name，并确保 SW 脚本更新检查不被固定内容掩盖；补充“新部署后获得新 HTML”的测试。

### P2 — CI 没有执行 Docker smoke，也没有构建桌面壳

- 位置：`.github/workflows/ci.yml:25-75` 只验证各 Node/OS 矩阵的 workspace typecheck、test、web/server build；`.github/workflows/docker.yml:33-58` 只做多架构 image build；现成的 `scripts/docker-smoke.mjs:1-5,103-174` 未被任何 workflow 调用。
- 触发：镜像能完成静态构建但 compose 运行时仍可因 Origin 配置失败；桌面 `tauri.conf.json`/Rust 配置也没有持续构建覆盖。
- 影响：上述部署/桌面回归可在 CI 全绿时进入主分支。
- 建议：在 Docker job 中增加受限容器 smoke（或单独 job）；在具备 Rust 的 runner 上至少运行 `tauri build --no-bundle`/配置校验，或明确把桌面能力保持为 Planned 并在 CI 状态中标注未验证。

## 本次已修复

此前 `apps/web/src/api.ts` 的 `createInspection` 直接把 JSON 断言成成功类型，`progress` 只检查 object，错误对象的 `technicalDetails` 也未做边界校验。本次只在该文件增加运行时字段检查：

- create response 校验 `jobId` 与允许的 job status；
- progress 校验 `phase`、可选 `completed`/`total` 数字及 `message` 字符串；
- job error 校验 `code`/`message` 与 record 形态的 `technicalDetails`。

## 桌面端状态与残余风险

`apps/desktop` 当前由仓库文档明确标为 Tauri 脚手架/Planned，且 `docs/verification/tauri.md` 记录未执行 cargo/Tauri/Android 构建；因此本审查未把“未接入 server sidecar、原生保存对话框仍属后续任务”列为本阶段缺陷，但它们在桌面能力升级为 Supported 前必须补齐并实测。

## 验证结果

以下命令均在目标工作树执行，未调用真实 Provider：

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run apps/web/src/api.test.ts` | 7/7 tests passed |
| `pnpm test` | 38/38 files，380/380 tests passed |
| `pnpm typecheck` | 10/11 workspace projects（desktop 无 typecheck script）通过 |
| `pnpm --filter @playlist-exporter/web build` | 通过，135 modules transformed |
| `pnpm --filter @playlist-exporter/server build` | 通过，bundle 940.9 kB |
| `pnpm --filter @playlist-exporter/web e2e` | 5/5 passed |
| `git diff --check` | 通过（无 whitespace 错误） |

Docker/Tauri 实机验证未在本轮执行；Docker smoke 脚本存在但未接入 CI 是上述 P2 覆盖缺口的一部分。
