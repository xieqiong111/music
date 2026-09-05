# GLM 修复任务单：歌单导出工具审查遗留问题

日期：2026-09-05。请直接依据本任务单修复已有项目，不从零重写。本文是交接任务，不表示以下问题已经修复。

## 1. 工作目录与交接基线

实际开发工作树：

    D:/gpt/2026-09-02/apple-music-qq-utf-8-txt/.worktrees/core-netease-mvp

分支：codex/core-netease-mvp。
审查 HEAD：1d23c53d98e6439823bcf40560f364d05a1302ba。
所有下列相对路径均相对该工作树；行号来自审查时版本，编辑前以函数名重新定位。

进入工作树后先执行：

    git status --short
    git log --oneline -5
    pnpm test
    pnpm typecheck

最近一次已执行结果：38 个测试文件、380 个用例通过；类型检查、Web/Server 构建、5 个 E2E 和 git diff --check 通过。这是历史验证证据，接手后必须复现。

工作树存在未提交改动，必须保留：
- apps/web/src/App.tsx、App.test.tsx：切换本地导入取消旧任务，重置任务引用。
- apps/web/src/api.ts、api.test.ts：创建任务、进度和错误对象的运行时字段校验。
- packages/exporters/src/{filename,index,txt,csv}.ts 及相关测试：UTF-8 文件名字节预算、保留日期、TXT 一曲一行、CSV 列顺序。
- docs/verification/ 下三份新审查报告，以及本任务单。

这些内容不要覆盖或重复实现。禁止 reset --hard、clean -fd、强推或改写历史。

## 2. 修复顺序与验收要求

先修 P1，再修 P2。每项先用合成数据复现，再最小修复并运行相关测试。

### 01 / P1：Apple 相对分页 next 无法解析

位置：packages/provider-apple/src/provider.ts:163，parseNextUrl；fetchAllPages 调用处约 :356。
问题：new URL(next) 只接受绝对地址，官方分页 next 可以是 /v1/catalog/... 子路径，第二页之前即抛错。

要求：
- 基于固定 API_ORIGIN 解析相对 next，同时兼容现有合法绝对地址。
- 保留 HTTPS、禁止用户信息、主机/端口白名单；把续页路径限制到当前 storefront 和当前歌单的 tracks 路径，防止跳转到其他资源。
- 保留重定向禁用、分页预算和重复游标检测。
- 覆盖相对/绝对 next、多页及超过 1000 首、跨域地址、不同歌单路径、重复/不前进游标。

官方依据：https://developer.apple.com/documentation/applemusicapi/fetching-resources-by-page
仍标记 Apple 在线 API 为 Preview；合成测试不等于真实 Token 实测。

### 02 / P1：标准 plist DOCTYPE 被整体拒绝

位置：packages/importers/src/apple-xml.ts:152，rejectBangNode。
现有 fixtures.ts:138 与 apple-xml.test.ts:138 已包含并拒绝标准声明：

    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">

要求：
- 允许标准 plist 声明作为无副作用声明被跳过，不读取 DTD、不解析外部实体、不发网络请求。
- 只允许受控位置与已知声明格式；继续拒绝内部子集、自定义实体、未知外部声明及畸形声明。
- 不要以删除全部 DOCTYPE 检查作为修复。
- 测试标准声明成功导入、无声明仍可用、内部实体/外部实体/嵌套或重复声明被拒绝；保持顺序、重复曲目和缺失引用占位。
- 若更换解析库，先核对许可证、登记 THIRD_PARTY_NOTICES.md，再使用。

### 03 / P1：Docker 安装层缺失工作区清单

位置：Dockerfile:12-20。
问题：安装前未复制 packages/importers、provider-apple、provider-qq 等新增工作区 package.json，但 server/web 已依赖这些 workspace 包。

要求：
- 核对 pnpm-workspace.yaml 和锁文件，补齐安装阶段实际需要的全部工作区清单；同时考虑 apps/desktop 是否应包含在安装范围。
- 保持 frozen-lockfile、多阶段构建、非 root、最小运行镜像。
- 有 Docker 时实际构建 amd64 并运行 smoke；arm64 只有执行成功才记通过。
- Docker 不可用时保留“未验证”，不能用本机 Node 构建代替容器构建结论。

### 04 / P1：Compose 浏览器请求全部被 Origin 拒绝

位置：docker-compose.yml:19-28；apps/server/src/config.ts 的 defaultOrigins；app.ts 的 Origin 检查。
问题：容器 HOST=0.0.0.0 时默认白名单为空，Compose 又未传 ALLOWED_ORIGINS，浏览器 POST 即使有正确令牌也返回 403。

要求：
- 默认服务显式传入与宿主映射端口一致的 127.0.0.1 / localhost origins。
- LAN 模式要求显式配置实际 UI origin，并将配置传入容器；不要放宽为 *，不要绕过 Origin 检查。
- 同步 .env.example、README 和 LAN 使用说明。
- 测试默认端口、自定义宿主端口、合法/非法 origin、正确/错误令牌。
- smoke 不能只检查 healthz：增加带正确令牌与合法 Origin 的 API 请求，用无效歌单输入验证可达请求校验层，避免访问真实平台。

### 05 / P1：Service Worker 使旧 HTML 长期驻留

位置：apps/web/public/sw.js:1-2、32-42；src/main.tsx 注册点。
问题：固定 v1 缓存与入口 HTML cache-first 组合，让部署新版本后的客户端继续使用旧 HTML/旧 hash 资源。

要求：
- HTML 入口采用联网优先、离线回退缓存；带 hash 的静态资源可以保留缓存优先。
- 明确缓存升级/清理策略，确保已有 v1 客户端能升级。
- 保留 /api/、/healthz、非 GET、跨源及凭证请求的缓存排除规则。
- 测试：先缓存旧入口，再模拟新部署，联网获取新入口；断网仍加载缓存；资源更新与上述排除规则不回归。
- 不要声称 SW 拦截了浏览器自身的更新机制；缺陷是入口响应策略与缓存失效不足。

### 06 / P2：Apple 缺失 data 被误判为完整空歌单

位置：packages/provider-apple/src/schemas.ts:36-42、75-80；provider.ts:415-418。
问题：data 的 nullish 默认 []，首屏关系也可缺失；没有 trackCount/next 时可返回 total=0、complete=true。

要求：
- 区分合法空数组与缺失/null/错误类型字段。
- 缺失曲目关系或续页数据必须明确失败，或按已核实的官方合同补请求；不能当作空歌单成功。
- 测试首屏关系缺失、tracks.data 缺失/null、续页 data 缺失/null、有无 trackCount，以及合法空歌单。
- 同时验证不完整结果不能导出。
- 尽管审查评级为 P2，这是数据完整性问题，建议紧跟第 01 项修复。

### 07 / P2：跨源下载读不到文件名

位置：apps/server/src/app.ts:298-313，导出响应头。
问题：未设置 Access-Control-Expose-Headers，真正跨 origin 的浏览器 fetch 无法读取 Content-Disposition，下载名回退 playlist.txt。通过同源 Vite 代理的请求不属于此场景。

要求：
- 向已授权 origin 暴露 Content-Disposition；仅按实际需求增加导出元数据响应头。
- 不放宽 Origin 或 Bearer 校验。
- 添加响应头契约测试，最好再用两个本地端口做真实浏览器跨源下载测试，验证中文文件名可读。
- 直接读取 Hono Response 的测试不能代替浏览器 CORS 验证。

### 08 / P2：TTL 过期后仍可取出已删除结果

位置：apps/server/src/jobs.ts:235-240，getCompletedResult。
问题：deleteIfExpired 删除 Map 条目后仍返回本地 record.result；API 两次查找跨过过期时间也可能触发。

要求：
- 删除过期记录后立即返回 undefined，或再次确认 Map 中记录有效。
- 使用可控时钟验证过期前、恰好到期、过期后的 get/getCompletedResult。
- 测试导出两次查询跨 TTL 边界时不能生成文件；避免依赖真实 sleep 的易抖测试。
- 保持取消、关闭、并发队列和清扫行为。

### 09 / P2：CI 缺少运行时与桌面验证

位置：.github/workflows/ci.yml、docker.yml、scripts/docker-smoke.mjs。
问题：现有 CI 只构建镜像，不运行 smoke，也未构建桌面壳。

要求：
- 增加受限 Docker smoke，涵盖健康检查、鉴权、Origin 与成功到达 API 校验层；不调用真实歌单。
- 保持 actions 使用 commit SHA 固定。
- 检查 Node 矩阵与根 engines.node>=24、pnpm 版本是否兼容；Node 22 是否失败需要实际证据，不直接宣称已证实。
- 桌面构建可作为后续独立项：有 Rust 的 runner 至少验证一个目标；未执行前保持 Planned，不能声称安装包可用。
- 写 workflow 不代表 GitHub Actions 已跑通；未授权不推送、不创建发布、不上传构建产物。

## 3. 最终回归

每项运行相关测试，全部修完后在工作树执行：

    pnpm test
    pnpm typecheck
    pnpm --filter @playlist-exporter/web build
    pnpm --filter @playlist-exporter/server build
    pnpm --filter @playlist-exporter/web e2e
    git diff --check

有 Docker 时另执行：

    node scripts/docker-smoke.mjs
    docker compose config
    docker buildx build --platform linux/amd64 -t playlist-exporter:amd64 . --load

不要把 docker compose config 的真实令牌值粘贴进报告或日志。可用合成配置进行验证。arm64、macOS、Android 仅记录真实执行结果，缺工具则写明原因。

## 4. 安全、文档与交付

- 仅元数据；不下载音频、不提取试听地址、不绕过 DRM/会员/地区权限，不修改平台歌单。
- 测试只用合成/脱敏 Fixture，不调用真实用户歌单。
- 不把 Cookie、Token、JWT、证书或私钥写入仓库、错误详情、日志或测试。
- 新依赖须更新许可证台账；不要在 UI 中直接访问平台接口。
- 本轮生产依赖 audit 曾被自动审批拒绝，原因是依赖清单发送到外部注册表；未获得相应授权前不要换工具绕过。
- 真实 Apple Token/真实导出文件、Docker、Tauri 和远程 CI 的实测限制仍然存在。
- 将实际命令、退出码、测试数字、修复/未修复项写回 docs/verification/；更新交接文档的当前状态，保留历史记录。
- 分清：已有修复、此次修复、待修复、环境未验证。不要把测试全绿解释为所有平台已可发布。
- 提交前检查所有未提交文件的归属；未经确认不要把前一代理的改动混入单一提交。不要推送或发布。

审查来源：
- docs/verification/provider-review-2026-09-05.md
- docs/verification/server-review-2026-09-05.md
- docs/verification/web-review-2026-09-05.md

这些是有限审查报告，不是“全部文件安全审计通过”的证明。

## 5. 可直接发送给 GLM 的启动提示

请在本任务单指定工作树继续修复。先核对 git status 并复现 380 项测试基线，保留 apps/web 和 packages/exporters 现有未提交改动。按第 2 节逐项复现、最小修复、增加有效回归测试，优先处理 P1 和 Apple 数据完整性问题。保持元数据只读、分页完整性、凭证脱敏和许可证边界。最终运行第 3 节命令，回填验证文档，逐项报告问题是否修复及实际证据。缺少工具或真实凭证时明确写未验证，不伪造支持或测试结果。

## 6. 当前状态(2026-09-05 修复轮完成后追加,历史记录保持原样)

第 2 节 01–09 全部完成代码修复与回归测试,最终回归(第 3 节)全绿:pnpm test 39 文件/424 用例(基线 380 + 净增 44)、typecheck 9 包通过、web/server build 通过、5 个 E2E 通过、git diff --check 通过。逐项修复内容、测试与证据见 docs/verification/repair-2026-09-05.md。

Docker 三连已在 192.168.1.49(fnOS,Docker 28.5.2/buildx 0.29.1/Compose v2.40.3,x86_64)实际执行并全部通过:`docker compose config` exit 0、`docker buildx build --platform linux/amd64 --load` exit 0、`node scripts/docker-smoke.mjs` 默认模式 exit 0(两组容器各 7 项检查全过)。容器实测暴露并修复了 2 个静态检查无法发现的缺陷:pnpm 11 非交互安装的 ERR_PNPM_IGNORED_BUILDS(改为 pnpm-workspace.yaml 的 allowBuilds 映射,pnpm 11 已移除 onlyBuiltDependencies)与运行镜像 bundle 权限 0660 不可读(运行阶段 chmod -R a+rX /app)。修复后本地全量回归复跑同数全绿。

未验证项(不因测试全绿而宣称可发布):
- arm64 镜像、GitHub Actions 实跑(workflow 未推送)、macOS、Android、Tauri 桌面构建(Planned)、真实 Apple Token 实测、pnpm audit、Node 22 实际运行。

执行模型:5 个并行子任务(按文件归属切分:provider-apple / importers / server / web SW / Docker+CI)+ 主控统一回归、浏览器跨源实测与远程 Docker 实测。第一轮因并发上限被取消的执行在 importers 留有部分改动,已由后续执行核对任务单后保留补全。所有改动保持未提交,未推送;提交归属要求见第 4 节与 repair-2026-09-05.md 第 5 节。

## 7. 独立验收跟进(2026-09-05,接第 6 节)

独立 GPT 审查(docs/verification/INDEPENDENT-ACCEPTANCE-2026-09-05.md)判定"需修复后合并",新发现 F1(P1 烟测误删非自有容器)+ F2/F3/F4(P2:SW 缓存写失败回退旧页、DOCTYPE 前导未贯通统一入口、PORT=80 派生 Origin 被拒)。四项均已修复,每项先写测试在旧实现上变红再转绿;附带修正 Dockerfile 注释精度、ci.yml Node 22 拆为非阻塞探测 job、smoke 错误输出令牌脱敏。修复后回归 40 文件/456 用例 + e2e 8/8 全绿,并在 192.168.1.49 用 F1–F4 后源码重建镜像(BUILD_EXIT=0)、新版 smoke 默认模式实跑 SMOKE_EXIT=0(唯一容器名/按 ID 登记/按 ID 清理在真实 Docker 下生效)、PORT=80 compose 插值验证通过。逐项证据见 repair-2026-09-05.md 第 6 节。仍未验证:GitHub Actions 实跑、arm64、Tauri 桌面、真实 Apple Token、Node 22 实际运行。

