# 跨平台流媒体歌单导出工具

本地优先的歌单元数据导出工具：在浏览器、Node 本地服务和（规划中的）Tauri 桌面/Android 环境中读取流媒体平台的**公开歌单元数据**，并导出为 UTF-8 的 TXT / CSV / JSON 文件。

- **本地优先**：核心逻辑运行在你自己的设备上；不存在云端后端，歌单数据只经过你的设备。
- **只读元数据**：只读取歌单名称、创建者、曲目顺序、歌名、歌手、专辑等文本信息。
- **不下载音频、不绕过 DRM**：本工具永远不获取音频流，也不实现播放、下载、会员或 DRM 相关能力，不修改任何平台上的歌单。
- **不上传歌单与凭证**：读取到的歌单与导出结果只留在你的设备上；本工具不需要任何平台账号、Cookie 或私人令牌。
- **TXT 默认 UTF-8 / LF**：无 BOM、LF 换行，中文与 Emoji 正确保存；CSV / JSON 同样默认 UTF-8。

## 功能支持矩阵（当前真实状态）

| 能力 | 状态 |
|---|---|
| 网易云音乐公开歌单读取 | **可用**（经本地服务读取，支持超过 1000 首的分页读取） |
| QQ 音乐公开歌单读取 | **可用**（公开歌单，经本地服务读取） |
| Apple Music | **暂不可用**（官方文件导入与 BYO Token 在线 API 预览在规划中） |
| 本地文件导入（TXT/CSV/JSON） | **规划中** |
| 桌面 / Android 打包（Tauri） | **规划中** |

详细的三态矩阵（Supported / Planned / Unavailable，含浏览器 PWA、NAS Docker、桌面、Android 维度）见 [docs/capabilities.md](docs/capabilities.md)；能力目标与边界以[设计规格](docs/superpowers/specs/2026-09-02-streaming-playlist-exporter-design.md)为准。

## 安装

前置要求：

- Node.js **≥ 24**（`package.json` 的 `engines` 限制）
- pnpm **11.19.0**（由根 `package.json` 的 `packageManager` 字段锁定）

```bash
# 启用 corepack 后会自动按 packageManager 字段使用 pnpm 11.19.0
corepack enable
# 若你的 Node 发行版未附带 corepack，可改用：npm install -g pnpm@11

git clone <本仓库地址>
cd <仓库目录>
pnpm install --frozen-lockfile
```

## 快速开始

### 方式一：开发模式（本地服务 + Web 界面）

仓库分为两个可运行部分：`apps/server`（Node 本地服务，Hono）与 `apps/web`（React PWA 界面）。

```bash
# 终端 1：构建并启动本地服务
# 默认监听 http://127.0.0.1:4319（仅回环地址）
pnpm --filter @playlist-exporter/server build
pnpm --filter @playlist-exporter/server start

# 终端 2：启动 Web 开发服务器
# 访问 http://127.0.0.1:4320（/api 与 /healthz 会代理到 4319）
pnpm --filter @playlist-exporter/web dev
```

也可以用生产构建的静态文件做预览（Playwright E2E 使用的就是该方式，端口 4321，`/api` 同样被代理到 4319）：

```bash
pnpm --filter @playlist-exporter/web build
pnpm --filter @playlist-exporter/web exec vite preview --host 127.0.0.1 --port 4321
```

本地服务支持的环境变量（均有默认值，回环场景零配置即可使用）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。**非回环地址（如 LAN IP）时必须同时设置 `ACCESS_TOKEN`，否则服务拒绝启动** |
| `PORT` | `4319` | 监听端口 |
| `ACCESS_TOKEN` | 未设置 | Bearer 访问令牌。回环监听可不设置；令牌长度不超过 4096 字节 |
| `ALLOWED_ORIGINS` | 回环来源 | 逗号分隔的完整 origin 白名单（协议 + 域名 + 端口）。非回环监听且未设置时默认为空（拒绝所有跨源请求） |
| `MAX_BODY_BYTES` | `1048576` | 请求体上限，固定 1 MiB，不可调大 |
| `MAX_CONCURRENT_JOBS` | `2` | 同时执行的歌单读取任务数 |
| `MAX_QUEUED_JOBS` | `100` | 排队任务上限，超出返回 429 |
| `JOB_TTL_MS` | `900000` | 已结束任务在内存中的保留时长（15 分钟），过期后任务 ID 失效 |

### 方式二：Docker（NAS）

使用仓库自带的 `docker-compose.yml`、`.env.example` 与 `Dockerfile`（多阶段构建、非 root、只读根文件系统、自带健康检查；实机 Docker 验证记录见 [docs/verification/docker.md](docs/verification/docker.md)）：

```bash
cp .env.example .env
# 编辑 .env：必须设置 ACCESS_TOKEN（强随机值）
docker compose up -d --build
```

要求与风险提示：

- **必须设置 `ACCESS_TOKEN`**：这是容器场景下访问 API 的唯一凭证。
- **默认仅映射 `127.0.0.1`**：即只有宿主机本机可以访问。
- 提供 **LAN profile** 用于把服务暴露到局域网（便于从其它设备访问）。这属于高风险操作：局域网内的任何设备都能尝试访问该服务。启用 LAN profile 前请确认你理解风险，并务必使用足够长的随机令牌；不要将端口直接映射到 `0.0.0.0` 而不设置令牌。

## 使用说明

1. 打开 Web 界面（开发模式为 `http://127.0.0.1:4320`）。
2. 粘贴网易云或 QQ 音乐的**公开**歌单链接，或纯数字歌单 ID：
   - 网易云：如 `https://music.163.com/#/playlist?id=XXXXX`；
   - QQ 音乐：分享链接形如 `https://y.qq.com/n/ryqq/playlist/<数字>`，或直接填数字 disstid。
3. 点击读取：界面显示进度，任务可随时取消。
4. 读取完成后进入预览：显示歌单名、创建者、曲目总数与曲目列表。
5. 选择导出选项：
   - 格式：TXT / CSV / JSON（TXT 默认 `歌曲名 - 歌手1、歌手2`，UTF-8 无 BOM、LF）；
   - 是否带序号；
   - 是否包含专辑列；
   - 是否按导出去重；
   - 换行符：LF / CRLF（CSV 另可选 BOM）。
6. 点击导出：文件名形如 `平台_歌单名_YYYY-MM-DD.ext`，由浏览器直接下载到本地。

> QQ 音乐说明：QQ 公开接口对已下架/地区不可用曲目的标识暂未提供，工具会以占位与告警标注无法解析的条目。

访问令牌只在你以非回环（LAN）模式运行服务时才需要；令牌只保存在浏览器内存中，不写入 localStorage，也不会进入 Service Worker 缓存，刷新页面后需要重新输入。

## 安全与登录风险（请务必阅读）

- **只读公开数据**：本工具仅请求网易云与 QQ 音乐的公开歌单元数据接口，不读取、不存储任何私人数据。
- **本工具不需要任何平台账号或 Cookie**：正常使用全程无需登录网易云或 QQ 音乐。请不要在界面或配置中粘贴任何平台的 Cookie、登录态或私人令牌——本工具的任何环节都不会用到它们。
- **服务默认只监听 `127.0.0.1`**：不暴露到网络。只有你显式修改 `HOST` / Docker 端口映射时，其它设备才可能访问。
- **日志脱敏**：服务端日志只记录请求 ID 与 HTTP 状态码；错误响应中的技术细节仅含请求 ID，不包含令牌、Cookie 或查询参数。
- **Service Worker 只缓存同源静态资源**：界面外壳（HTML/JS/CSS/图标）可离线加载；`/api` 请求与任何带 `Authorization`/`Cookie` 头的请求一律不进入缓存。
- **导出文件的隐私提示**：导出文件包含歌单名称、创建者与完整曲目列表等元数据，可能反映你的音乐偏好。分享前请自行确认内容。
- 完整的威胁模型与安全控制清单见 [docs/security.md](docs/security.md)。

## 故障排查

界面与 API 返回的错误都带有结构化错误码（`code`）与请求 ID（`technicalDetails.requestId`）。常见错误码速查（逐条的现象、原因与处理步骤见 [docs/troubleshooting.md](docs/troubleshooting.md)）：

| HTTP / 错误码 | 含义 |
|---|---|
| 401 `AUTH_REQUIRED` | 需要有效的访问令牌 |
| 403 `ORIGIN_NOT_ALLOWED` | 请求来源（Origin）不在白名单 |
| 404 `JOB_NOT_FOUND` | 任务不存在或已过期 |
| 409 `JOB_TERMINAL` / `JOB_NOT_READY` / `JOB_NOT_EXPORTABLE` | 任务已结束无法取消 / 尚未完成不能导出 / 任务结果不可导出 |
| 413 `PAYLOAD_TOO_LARGE` | 请求体超过 1 MiB 限制 |
| 422 `INCOMPLETE_PLAYLIST` | 歌单读取不完整，已阻止导出 |
| 429 `QUEUE_FULL` | 任务队列已满或达到并发上限 |
| `EGRESS_NOT_ALLOWED` | 上游请求被出站白名单拦截 |

## 开发

| 命令 | 作用 |
|---|---|
| `pnpm test` | 运行全部工作区的 Vitest 单元测试 |
| `pnpm typecheck` | 递归执行各工作区 TypeScript 类型检查（`--noEmit`） |
| `pnpm --filter @playlist-exporter/web build` | 构建 Web 生产包（PWA 静态资源） |
| `pnpm --filter @playlist-exporter/web e2e` | 运行 Playwright 端到端测试（自动构建并启动 vite preview，端口 4321） |

CI 在 push 到 `main` 与所有 Pull Request 时运行：类型检查、测试与双端构建跑在 Node 22/24 × Linux/Windows/macOS 矩阵上，另有独立的 E2E job 与安全 job（gitleaks 密钥扫描、生产依赖审计）；Docker 镜像的多架构（amd64/arm64）构建由 `.github/workflows/docker.yml` 验证（仅构建不推送）。

## 许可与第三方

第三方依赖清单、许可证与协议行为参考见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 未签名构建提示

后续阶段提供的 Tauri 桌面（Windows/macOS）与 Android 安装包**不会附带代码签名证书**：

- Windows 可能弹出 SmartScreen"未识别的应用"提示，macOS 可能提示"无法验证开发者"，Android 需要允许安装未知来源应用。
- 这类提示意味着系统无法确认发布者身份，不代表文件一定有问题；请始终从本仓库的正式 Release 页面获取安装包，并在安装前核对版本说明。
- 目前尚未提供任何下载链接；相关构建随 Tauri 阶段交付。
