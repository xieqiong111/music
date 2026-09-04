# Docker/NAS 阶段验证记录（2026-09-04）

记录人：Docker/NAS 阶段工程师。只记录实际执行过的命令与真实结果；未执行的项目一律列入"未验证清单"。

## 环境

| 项目 | 值 |
|---|---|
| 宿主机 | Windows 10.0.26200 x64（amd64），Git Bash |
| Node | v24.20.0 |
| pnpm（本机） | 11.19.0（corepack 按 `packageManager` 解析；Dockerfile 内另行固定安装 pnpm@11.19.0） |
| Docker | **不可用**：`docker` 命令不存在（bash: docker: command not found） |
| Docker Buildx | **不可用**（同上） |

## 命令与结果

### 1. Docker 可用性探测

| 命令 | 退出码 | 结果 |
|---|---|---|
| `docker --version` | 127 | bash: docker: command not found |
| `docker buildx version` | 127 | bash: docker: command not found |
| `docker info` | 127 | bash: docker: command not found |

结论：本机未安装 Docker（或不在 PATH）。所有 Docker 相关验证（镜像构建、容器运行、healthcheck、compose）**均未执行**，不得声称通过。

### 2. 冒烟脚本实际执行

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node scripts/docker-smoke.mjs` | 1 | 按设计快速失败：`[docker-smoke] ✗ docker-version 失败: 无法执行 docker 命令（ENOENT）。请确认 Docker Desktop/Engine 已安装并正在运行。` |

冒烟脚本完整流程（构建镜像 → 受限运行 → /healthz 轮询 → 401/403 边界检查 → JSON 结果 → 清理容器）整体标为**未验证**；已验证的只有"Docker 不可用时明确报错并以非零码退出"这一分支。

### 3. 交付文件的静态校验（替代性验证）

| 检查 | 结果 |
|---|---|
| docker-compose.yml 语法人工复查（x-app-common 锚点 + `<<:` 合并、引号、`${...:?}` 插值） | 通过（人工复查）；`docker compose config` **未执行** |

### 4. 非 Docker 的本机验证（支撑静态托管能力）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm --filter @playlist-exporter/server test` | 0 | 6 个测试文件、**51 个测试全部通过**（含新增 `test/static.test.ts` 6 个用例） |
| `pnpm --filter @playlist-exporter/server typecheck` | 0 | tsc --noEmit 无错误 |
| `pnpm --filter @playlist-exporter/server build` | 0 | esbuild 产出 `apps/server/dist/index.js`（约 900.8 kB，单文件 bundle） |

### 5. WEB_DIST 静态托管实机验证（Node 直跑 bundle，非 Docker）

命令：`PORT=4391 WEB_DIST=apps/web/dist node apps/server/dist/index.js`（未设 HOST，默认 127.0.0.1，无 ACCESS_TOKEN，符合 loopback 安全不变量），随后 curl 探测：

| 请求 | 状态码 | 关键响应头/结果 |
|---|---|---|
| `GET /healthz` | 200 | application/json；`x-content-type-options: nosniff`；未被静态路由拦截 |
| `GET /` | 200 | text/html; charset=utf-8；`cache-control: no-cache`；返回真实 apps/web/dist/index.html；nosniff |
| `GET /sw.js` | 200 | text/javascript；`cache-control: no-cache`（Service Worker 更新需要） |
| `GET /manifest.webmanifest` | 200 | application/manifest+json；`cache-control: no-cache` |
| `GET /assets/index-DjYbsmka.js` | 200 | text/javascript；`cache-control: public, max-age=31536000, immutable` |
| `GET /icons/<icon-192.png>` | 200 | image/png；`cache-control: public, max-age=604800` |
| `GET /assets/` | 404 | application/json; charset=UTF-8（与现有 NOT_FOUND JSON 风格一致） |
| `GET /assets/..%2F..%2Fpackage.json` | 404 | application/json; charset=UTF-8；未泄漏任何目录外文件内容 |

新增测试 `apps/server/test/static.test.ts` 另覆盖：未设置 WEB_DIST 时 `GET /` 为 404 JSON、临时目录假文件的静态服务、`/healthz` 与 `/api/*` 不被拦截（`/api/jobs/:id` 无令牌仍 401）、多种编码/字面目录穿越均 404 且无内容泄漏、启动时 WEB_DIST 指向不存在路径立即抛错。

## 未验证清单

以下项目因 Docker 不可用**未执行**，需要后续在装有 Docker 的机器上补验：

1. `docker build -t playlist-exporter:smoke .` — 镜像构建（含 pnpm@11.19.0 固定安装、`pnpm install --frozen-lockfile`、server/web 构建）未执行。
2. `node scripts/docker-smoke.mjs` 完整流程 — 容器运行、`/healthz` 轮询、无令牌 401、错 Origin 403、结果 JSON 与容器清理，全部未执行（仅验证 Docker 缺失时的快速失败分支）。
3. `docker compose config` 与 `docker compose up` — compose 文件（默认 app / lan profile / read_only / tmpfs / cap_drop / healthcheck）未在真实 compose 中解析或运行。
4. 容器内非 root（UID 10001）、只读根文件系统、`/data` 挂载可写性、HEALTHCHECK 状态 — 未执行。
5. amd64 平台镜像 — 未执行。计划命令：
   `docker buildx build --platform linux/amd64 -t playlist-exporter:amd64 . --load`
6. arm64 平台镜像 — 未执行（本机无 Docker，亦无 buildx+QEMU）。计划命令：
   `docker buildx build --platform linux/arm64 -t playlist-exporter:arm64 . --load`
   注意：arm64 下 Vite/Rollup/esbuild 均有 musl 原生变体（pnpm 锁文件包含全部平台），但构建速度受 QEMU 模拟影响，未实测。
7. LAN 模式（`docker compose --profile lan up -d app-lan`）的实际端口暴露与鉴权行为 — 未执行。

## 已知风险与说明

- compose 下 `ACCESS_TOKEN` 使用 `${ACCESS_TOKEN:?...}`：未设置或为空都会让 compose 直接报错，符合"非 loopback 必须令牌"的安全不变量。
- 镜像单独 `docker run` 时未设置 HOST，服务端默认绑定 127.0.0.1；容器外无法访问属预期行为（需要 `-p` + compose 或显式 `-e HOST=0.0.0.0` + ACCESS_TOKEN）。
- 冒烟脚本在容器环境变量里注入 `ALLOWED_ORIGINS=http://127.0.0.1:<随机端口>`，用于让无令牌请求越过 403 origin 检查从而验证 401 路径；错误 origin 的 403 用 `https://evil.example` 单独验证。
