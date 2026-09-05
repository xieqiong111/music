# GPT 独立审查简报:歌单导出工具修复轮(2026-09-05)

> 本文档是交给独立 AI/审查者做代码检测的交接简报。审查者应带着怀疑复核下述每一条主张:所有结论都以"文件:行号 + 可复现命令"给出,请逐条打开代码验证,不要信任本文的描述本身。本文由执行修复的代理撰写,天然存在"自己查自己"的盲区,这正是需要你的原因。

## 1. 审查对象

- 仓库:apple-music-qq-utf-8-txt(跨平台流媒体歌单**元数据**导出工具:读取网易云音乐 / QQ 音乐 / Apple Music 公开歌单,导出 TXT/CSV/JSON)。
- 工作树:`D:/gpt/2026-09-02/apple-music-qq-utf-8-txt/.worktrees/core-netease-mvp`,分支 `codex/core-netease-mvp`,审查基线 HEAD `1d23c53`。
- 状态:**全部改动保持未提交**(30 个修改文件 + 6 个未跟踪文件)。基线(HEAD)为 38 个测试文件 380 用例;当前工作树为 39 文件 424 用例。

### 技术栈与包结构

- TypeScript + pnpm workspace(pnpm 11.19.0,Node >=24),Vitest 单测,Playwright e2e,Hono(server),Vite + React(web),Tauri(desktop 壳,Planned)。
- `packages/contracts`(共享类型/错误)、`packages/core`(分页守卫/重试/脱敏/受限 fetch)、`packages/exporters`(TXT/CSV/JSON 导出)、`packages/importers`(Apple Library XML 解析)、`packages/provider-netease|provider-qq|provider-apple`(平台元数据只读 provider)、`apps/server`(API)、`apps/web`(前端)、`apps/desktop`(Tauri,未验证)。

### 安全红线(审查时请验证代码确实遵守)

仅元数据;不下载音频、不提取试听地址(previewUrl 在 schema 层不建模)、不绕过 DRM/会员/地区;不改平台数据;测试只用合成 fixture;凭证只存在于环境变量/Authorization 头,不落日志/错误/仓库;UI 不直连平台接口。

## 2. 未提交改动清单与归属

审查时必须分清三类归属,避免"一个代理的修复被另一个的改动污染"的误判:

**A. 前一代理遗留(修复轮开始前已存在,本轮未触碰)**:`apps/web/src/App.tsx`、`App.test.tsx`、`api.ts`、`api.test.ts`;`packages/exporters/**`(src+test 共 7 文件);`docs/verification/{provider,server,web}-review-2026-09-05.md`;`docs/GLM-REPAIR-TASKS-2026-09-05.md`。

**B. 本轮 5 个并行子任务的修复**:见第 3 节逐项。

**C. Docker 实测阶段追加(晚于 B)**:`pnpm-workspace.yaml`(allowBuilds)、`Dockerfile`(运行阶段 chmod)、以及 `docs/verification/repair-2026-09-05.md`、`docs/verification/GPT-REVIEW-BRIEF-2026-09-05.md`(本文件)。

完整文件清单:`git status --short`(30 M + 6 ??,含 B/C 全部)。

## 3. 修复项逐条审查指南

每项给出:问题(审查轮发现)→ 修复位置 → **你应当重点审查什么**。

### 01/P1 + 06/P2 Apple provider:相对分页 next + 缺失 data 误判空歌单

文件:`packages/provider-apple/src/provider.ts`、`src/schemas.ts`、`test/provider.test.ts`。

- `parseNextUrl(next, tracksPath)`(provider.ts:168):用 `new URL(next, API_ORIGIN)` 解析,官方 `next` 可为 `/v1/catalog/...` 相对路径;保留 HTTPS/userinfo/port/host 校验;路径检查升级为 `url.pathname !== tracksPath` **精确相等**(:177),`tracksPath` 由当前 storefront+playlistId 构成(:337)。
- schema 收紧:`applePlaylistTracksSchema.data`(:45)与续页信封 `data`(:81)改为必填数组(原为 nullish→[]);`relationships`(:61)改必填。缺失关系/续页数据 → `PROVIDER_SCHEMA_DRIFT`,只有真实 `data: []` 是合法空页。

**审查要点**:
1. 精确路径匹配是否过严?官方文档(fetching-resources-by-page)中续页 `next` 是否恒为同一 tracks 路径?(若 Apple 会返回带不同路径的合法 next,这里会误拒——给出证据。)
2. `new URL(next, base)` 的解析边界:协议相对 `//evil.com/...`、无前导斜杠、`?query-only`、编码差异(percent-encoding 大小写)是否都被 pathname 精确匹配挡住?
3. `playlistId` 经 `encodeURIComponent` 后与 Apple 返回的 href 中已编码形式是否一致(双编码/未解码差异)?
4. schema 收紧是否存在"官方合法但被误拒"的响应形态(如字段顺序、`meta` 环绕)?
5. 测试覆盖:相对/绝对混用、11 页 1005 首、9 类投毒 next、6 类首屏漂移 + 2 类续页漂移、合法空歌单不回归(test/provider.test.ts 新增 20 例)。

### 02/P1 Apple Library XML:标准 plist DOCTYPE 被整体拒绝

文件:`packages/importers/src/apple-xml.ts`(:196 skipStandardPlistDoctype,:222)、`test/apple-xml.test.ts`、`test/fixtures.ts`。

- 仅接受文档 prolog 中至多一条、FPI 与系统标识符精确匹配的标准声明,整体跳过:不读 DTD、不解析外部实体、零网络。
- 其余一切 DOCTYPE 形态(内部子集、参数/外部实体、未知标识符、SYSTEM 形式、畸形、重复、错位)→ `IMPORT_XML_DOCTYPE_FORBIDDEN`(:208)。未换解析库,零新依赖。

**审查要点**:
1. 接受面是否真的最小(大小写、引号、空白容错边界)?
2. 跳过实现是否可能被构造绕过(声明切在 CDATA/注释边界、超长 token、嵌套 `<!`)?
3. 原"DOCTYPE 一律拒绝"测试被改为"标准声明跳过"——这是唯一一处语义反转的既有断言,判断反转是否合理且其余断言未被放松。
4. 零网络是否有强制保证(注入 fetch 监视的测试是否真能捕获违规)。

### 05/P1 Service Worker:旧 HTML 长期驻留

文件:`apps/web/public/sw.js`(CACHE_VERSION v2 :10;入口 network-first :38 附近)、`src/sw.test.ts`。

- HTML 入口 network-first、离线回退;hash 资源 cache-first;activate 清非当前版本缓存;`/api/`、`/healthz`、非 GET、跨源、带凭证、`/sw.js` 不拦截;保留 skipWaiting/clients.claim 并注明理由。
- 注释如实声明:浏览器对 sw.js 自身的更新检查不经 fetch 拦截,本缺陷是入口策略与缓存失效不足。

**审查要点**:排除规则的正则/前缀匹配是否可被路径变形绕过(`/API/`、`//api/`、`/%61pi/`);network-first 对非导航 HTML 请求(如 iframe/旧标签预取)的行为;v1→v2 升级路径中旧缓存清理时机是否有竞态;测试是否真驱动了真实 sw.js 源码(vm + 受控 mock)而非测了个假实现。

### 08/P2 + 07/P2 server:TTL 过期取回 + 跨源文件名

文件:`apps/server/src/jobs.ts`(:125 deleteIfExpired,:235 getCompletedResult)、`apps/server/src/app.ts`(:322 expose-headers)、`test/jobs.test.ts`、`test/cors-export.test.ts`(新增)。

- getCompletedResult:过期删除后重新确认 Map 中记录有效,失效即返回 undefined(与 get/cancel 语义一致)。
- 导出路由为 raw Response 补齐 `access-control-allow-origin`(回显已过校验的 origin)、`vary: Origin`、`access-control-expose-headers: Content-Disposition`。实证背景:Hono 4.13.5 对直接返回的 raw Response 不合并中间件暂存头——**原响应连 ACAO 都没有**,真跨源会被整体阻断,不只是读不到文件名。

**审查要点**:
1. TTL 修复是否覆盖所有取回路径(两步查找跨过期边界、清扫器与取回并发)?
2. ACAO 回显逻辑:origin 缺失(同源/curl)时不加是否正确;是否存在通过伪造 Origin 头让服务端回显任意 origin 的可能(必须仍受白名单约束)?
3. 错误响应(401/403/404)不带 ACAO 是"失败即关闭"的既有行为——评估该行为是否有兼容性风险。
4. 测试是否用可控时钟而非真实 sleep;负向验证(还原缺陷版代码测试应变红)是否真实做过。

### 03/P1 + 04/P1 + 09/P2 Docker/Compose/CI

文件:`Dockerfile`、`docker-compose.yml`(:35 默认服务,:81 app-lan)、`.env.example`、`README.md`、`scripts/docker-smoke.mjs`(重写,:67 parseArgs/:142 buildCheckPlan/:220 runChecks)、`.github/workflows/{ci,docker}.yml`(docker.yml :69 新增 smoke job)。

- Dockerfile 按 pnpm-lock importers 补齐全部 10 个 workspace 清单(desktop 纳入安装、排除出运行镜像);compose 显式传 `ALLOWED_ORIGINS`(默认端口映射一致;LAN 要求显式配置,不放宽 `*`);smoke 检查矩阵 7 项全合成输入;action SHA 逐个经 GitHub API 核对(**修复了 ci.yml 中一个上游不存在的错误 actions/cache SHA**);Node 矩阵 [22,24] 与 engines >=24 的关系如实记录(22 为探测腿,未宣称结果)。

**审查要点**:
1. Dockerfile 清单与 `pnpm-lock.yaml` importers 是否严格一致(多一个少一个都会炸 frozen-lockfile)。
2. compose 单层插值 `${PORT:-4319}` 与 `${ALLOWED_ORIGINS:-...}` 是否会在 compose-go 下按预期解析;app-lan 的回退值是否与固定端口映射一致。
3. smoke 矩阵是否覆盖任务单要求(默认端口/自定义端口/合法非法 origin/正确错误令牌),且绝无真实平台请求。
4. workflow YAML 语法、SHA 真实性(自行抽查 1-2 个)、Node 22 腿的定位说明是否诚实。

## 4. Docker 实测追加的 2 项修复(容器专属,静态检查不可见)

1. **pnpm 11 非交互安装硬错误**:首次容器构建在 `pnpm install --frozen-lockfile` 报 `ERR_PNPM_IGNORED_BUILDS`(exit 1)。pnpm 11 移除了 `onlyBuiltDependencies`,改为 `allowBuilds` 映射。修复:`pnpm-workspace.yaml` 声明 `allowBuilds: { esbuild: true }`(:9)。验证:本地 `CI=1 pnpm install --frozen-lockfile` exit 0 且 lockfile 不变;容器内小实验确认 postinstall 获批执行。**审查要点**:esbuild postinstall 获批的供应链风险是否可接受(它是 lockfile 内固定版本;是否存在更好的免脚本路径);allowBuilds 写法与 pnpm 11 文档一致性。
2. **运行镜像 bundle 不可读**:构建产物 0660(root:root),非 root 运行用户启动即 `EACCES`。修复:运行阶段 `RUN chmod -R a+rX /app`(Dockerfile:57)。**审查要点**:a+rX 是否会给非预期文件加执行位(文件不应有 x);是否还有其他敏感文件权限问题;web 静态资源可读性。注意过程记录:曾试 `COPY --chmod=0644` 失败(目录丢遍历位),现方案已规避。

## 5. 验证证据总表(全部实际执行,退出码 0)

| 验证 | 结果 |
| --- | --- |
| `pnpm test` | 39 文件 / 424 用例全过(基线 380,净增 44) |
| `pnpm typecheck` | 9 包全过 |
| `pnpm --filter @playlist-exporter/web build` / `server build` | 成功 |
| `pnpm --filter @playlist-exporter/web e2e` | 5/5 |
| `git diff --check` | 通过(仅 autocrlf 提示) |
| `CI=1 pnpm install --frozen-lockfile` | exit 0,lockfile 不变 |
| 真实浏览器跨源实测(Playwright Chromium,双本地端口,平台请求经 fetchImpl 注入本地 stub) | PASS:跨源 fetch 读到 Content-Disposition,中文文件名解码 `netease_跨源下载验证歌单_2026-09-05.txt` |
| `docker compose config --quiet`(合成令牌) | exit 0(192.168.1.49,fnOS,Docker 28.5.2/buildx 0.29.1/Compose v2.40.3) |
| `docker buildx build --platform linux/amd64 --load` | exit 0(镜像 sha256:8d3b29b1…) |
| `node scripts/docker-smoke.mjs --skip-build --image playlist-exporter:amd64` | exit 0:随机端口 39463 + 默认 4319 两组容器,各 7 项检查全过;另以加固参数手工复跑 4319/4567 两端口矩阵均过 |

分包子任务结果:provider-apple 83 用例(63 基线+20 新增)、importers 68、server 72(66+6)、web 25(sw 2→10)。

## 6. 如实声明:未验证项(不因测试全绿宣称可发布)

- arm64 镜像未构建;GitHub Actions 实跑未发生(workflow 未推送);macOS/Android/Tauri 桌面(Planned)未执行。
- 真实 Apple Developer Token、真实平台歌单导出未触碰;apple-music provider 仍标 Preview——合成测试 ≠ 真实 Token 实测。
- `pnpm audit` 未执行(前轮因依赖清单外发被拒);Node 22 实际可运行性无证据。
- sw.js 的 CACHE_VERSION 为手工递增,发布流程需人工遵守。
- 凭据边界:测试/smoke 全程合成令牌;NAS SSH 凭据仅在会话内经环境变量使用,未写入任何文件/日志/文档。
- 所有改动未提交、未推送;`git diff --check` 干净。

## 7. 复现指南(在审查环境逐条执行)

```bash
cd <工作树>
git status --short          # 核对第 2 节清单
pnpm test                   # 期待 39 文件/424 用例
pnpm typecheck
CI=1 pnpm install --frozen-lockfile
pnpm --filter @playlist-exporter/web build
pnpm --filter @playlist-exporter/server build
pnpm --filter @playlist-exporter/web e2e
# 有 Docker 时(本仓库实际已在 192.168.1.49 执行):
node scripts/docker-smoke.mjs --skip-build --image playlist-exporter:amd64
docker compose config --quiet   # 需 ACCESS_TOKEN/ALLOWED_ORIGINS 合成环境变量
```

重点阅读顺序(性价比从高到低):`packages/provider-apple/src/provider.ts:160-380` → `apps/server/src/app.ts:271-335` → `packages/importers/src/apple-xml.ts:180-260` → `apps/web/public/sw.js` → `apps/server/src/jobs.ts:200-260` → `Dockerfile` → `docker-compose.yml` → `scripts/docker-smoke.mjs` → `.github/workflows/docker.yml`。

## 8. 审查红线

- 不要 `reset --hard`/`clean -fd`/改写历史;不要提交或推送;不要合并三类归属为单一提交。
- 不要运行任何真实平台请求;不要把真实令牌/cookie 写入任何输出。
- pnpm audit 涉及把依赖清单发往外部注册表,未获授权前不要代为执行。
- 你的结论应区分:已验证 / 静态审查发现 / 存疑待证据。发现缺陷时给出最小复现(文件+行+输入),不要泛泛而谈。

## 9. 期望的审查输出格式

1. 总体结论(可合并提交 / 需修复后合并 / 需重做某项)。
2. 逐项判定表:01–09 + Docker 追加 2 项,各标 `认可 / 有保留认可 / 不认可` + 一句理由。
3. 新发现问题列表(P 级 + 文件:行 + 复现思路)。
4. 对第 6 节"未验证"清单的补充(你发现了哪些我们没声明的盲区)。
