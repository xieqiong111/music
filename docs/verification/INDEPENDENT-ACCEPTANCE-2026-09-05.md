# 修复轮独立验收与 GLM 后续修复清单

审查日期：2026-09-05。工作树：`D:/gpt/2026-09-02/apple-music-qq-utf-8-txt/.worktrees/core-netease-mvp`。
实际 HEAD：`1d23c53d98e6439823bcf40560f364d05a1302ba`，分支 `codex/core-netease-mvp`。
本文是独立审查结果，不是修复者简报的转述。仅新增本文；未修改源码、测试、配置，未提交或推送。构建与测试产生的忽略目录产物不作为源代码改动。

## 1. 总体结论

**需修复后合并**：【已验证】424 项单测及 5 项 E2E 虽然通过，仍发现 1 个 P1、3 个 P2：烟测误清理容器、SW 回退旧页面、XML 入口识别不一致和 PORT=80 配置被拒绝；Docker 运行结果未在本机复现。

## 2. 逐项判定表

路径均相对于上述工作树；行号来自本次实际文件，而非简报标注。

| 项目 | 判定 | 独立理由 |
| --- | --- | --- |
| 01 Apple 相对分页 next | 认可 | 【已验证】`packages/provider-apple/src/provider.ts:168` 用固定 API origin 解析并在 :177 限定当前 tracks 路径，配合主机、协议及 userinfo 校验；本次全量测试包含其恶意 next 与 1005 首多页测试，但不代表真实平台兼容性已证实。 |
| 02 标准 plist DOCTYPE | 有保留认可 | 【已验证】`packages/importers/src/apple-xml.ts:222` 的精确声明白名单不解析 DTD，但 `packages/importers/src/index.ts:24` 的实际导入入口不识别 DOCTYPE 起始文件，见 F3；带 XML 声明的标准导出路径通过。 |
| 03 Docker workspace 清单 | 有保留认可 | 【静态审查】`Dockerfile:21` 至 :31 包含根清单及十个子工作区清单，desktop 仅进入构建阶段；【存疑】本机无 Docker，未复现镜像中的 frozen install 和启动。 |
| 04 Compose Origin/端口 | 不认可 | 【已验证】`docker-compose.yml:35` 在 PORT=80 时派生的白名单被 `apps/server/src/config.ts:90` 拒绝，见 F4；【存疑】本次没有成功执行 compose-go 和容器启动。 |
| 05 SW 页面更新 | 不认可 | 【已验证】`apps/web/public/sw.js:75` 把成功 fetch 后的缓存写异常也当作网络故障，:77 回退旧 HTML；F2 已用实际源码的内存 VM 复现。 |
| 06 Apple 缺失 data | 认可 | 【已验证】`packages/provider-apple/src/schemas.ts:45`、:61、:81 要求关系和 data 数组，缺失不再默认为空；全量测试中的空数组与字段漂移测试通过。 |
| 07 跨源导出文件名 | 认可 | 【已验证】`apps/server/src/app.ts:318`–:322 补回已通过 :180 附近 Origin/Bearer 检查的 origin 并暴露文件名头，`apps/server/test/cors-export.test.ts:160` 附近正负测试通过；本次没有重演简报声称的双端口真实浏览器实验。 |
| 08 TTL 取回 | 认可 | 【已验证】`apps/server/src/jobs.ts:125` 在到期等号边界删除，:242 再查 Map，过期结果不会因局部引用仍存活而返回；注入时钟测试通过且两次路由取回之间到期会被拒绝。 |
| 09 CI/烟测交付 | 不认可 | 【已验证】`scripts/docker-smoke.mjs:398` 先登记待清理名称，:435 在创建失败后仍强制删除，见 F1；【静态审查】`.github/workflows/docker.yml:106` 已把该脚本接入 CI，配置存在不等于 CI 已跑通。 |
| Docker 追加 1：allowBuilds | 有保留认可 | 【已验证】`pnpm-workspace.yaml:9` 仅允许 esbuild，本机 CI 冻锁安装退出 0 且锁文件哈希不变；【存疑】已有依赖环境不能代替干净容器 postinstall 验证，授权名称也不是授权单个版本。 |
| Docker 追加 2：产物权限 | 有保留认可 | 【静态审查】`Dockerfile:49`–:57 仅对复制的运行产物补读及必要执行位、仍以 :67 非 root 运行；【存疑】未验证真实镜像 mode/挂载，且 :54“只对目录补执行位”的注释不精确，X 也适用于本已有任一执行位的普通文件。 |

## 3. 新发现问题

“新发现”指本次审查发现，不表示全部由本轮首次引入。未发现可据现有证据确立的 P0。

### F1 — P1：烟测创建失败仍可能强制删除既有同名容器

- 【已验证】位置：`scripts/docker-smoke.mjs:398`、:408、:435；固定名称定义在 :41–42 附近。
- 缺陷：在 docker run 成功之前把固定容器名放入清理队列。如果已有同名容器，run 因名称冲突失败，finally 仍执行 `docker rm -f <同名容器>`，删除的可能是先前任务或另一个并行烟测创建的容器。
- 最小复现：把脚本导入内存，将唯一的 child_process.spawnSync 替换成 mock：version 返回成功、run 返回 125/name conflict、rm 只记录参数。执行 runMain，实际记录到 `run conflict → rm -f playlist-exporter-smoke`，进程退出 1。**未执行真实 Docker 删除，也不要用真实业务容器复现。**
- 归属：【已验证】HEAD 旧脚本已有按固定名清理的同类问题；B 类重写保留了该问题并增加第二个固定名。不是 A 类 Web/exporter 改动污染。
- GLM 修复边界：只清理由本次调用成功创建且已记录 ID 的容器；使用唯一名称或所有权标记，不通过名称猜测所有权。覆盖 run 冲突、并发调用、创建成功后健康失败和清理失败；失败退出码仍须保留。
- 验收：模拟名称冲突时清理调用为零；成功创建后只清理返回的自身容器 ID。

### F2 — P2：SW 把缓存写失败误判为网络失败

- 【已验证】位置：`apps/web/public/sw.js:58`–:63、:75–79、:84–86。
- 缺陷：cacheResponse 等待 caches.open/cache.put；其异常落入入口的网络故障 catch，导致已取得的新 HTML 被旧缓存替代。静态资源路径也会因缓存写失败拒绝已成功取得的资源。
- 亲自运行的内存 VM 结果：fetch 返回 NEW、cache.put 抛 QuotaExceededError、cache.match 返回 OLD，最终输出 `successful network + failed cache write => OLD`（exit 0，表示成功复现缺陷）。
- 归属：B 类 SW 重写中的入口行为回归；不涉及 A 类 App/API 变更。`apps/web/src/sw.test.ts:51` 附近的写缓存 mock 始终成功，遗漏此场景。
- GLM 修复边界：缓存写入应是尽力而为，不能丢弃成功网络响应；只在 fetch 真正失败时使用入口离线回退。不要放宽 API、跨源和凭证请求排除规则。
- 验收：入口“有旧缓存/无旧缓存”、hash 资源的 open/put 失败均仍返回成功网络响应；真正断网仍能回退；补真实 SW 浏览器升级测试。

可在工作树中用 Node 执行以下 JS（PowerShell 可赋给单引号 here-string 后 `node --input-type=module -e $probe`），只读源码、无网络：

```js
import fs from 'node:fs';
import vm from 'node:vm';
const listeners = {};
const fresh = { tag: 'NEW', ok: true, type: 'basic', clone() { return this; } };
const context = {
  URL,
  self: {
    location: { origin: 'http://localhost' },
    addEventListener: (name, fn) => listeners[name] = fn,
  },
  caches: {
    open: async () => ({ put: async () => { throw Error('QuotaExceededError'); } }),
    match: async () => ({ tag: 'OLD' }),
  },
  fetch: async () => fresh,
};
vm.runInNewContext(fs.readFileSync('apps/web/public/sw.js', 'utf8'), context);
let result;
listeners.fetch({
  request: {
    url: 'http://localhost/', method: 'GET', mode: 'navigate',
    headers: new Headers(),
  },
  respondWith: promise => result = promise,
});
console.log((await result).tag); // 当前 OLD；修复后应 NEW
```

### F3 — P2：允许的 plist prolog 没有贯通实际文件导入入口

- 【已验证】位置：`packages/importers/src/index.ts:24`–:28、:62；对应底层 `packages/importers/src/apple-xml.ts:178`。
- 缺陷：底层现在接受标准 DOCTYPE 前导，但统一入口仅识别 `<?xml` 和 `<plist`。没有 XML declaration、以标准 DOCTYPE 开头的合法 plist，即便提供 Library.xml 文件名，也在到达解析器之前被拒绝。
- 最小输入如下；通过内存 esbuild（write:false）分别调用实际导出函数，得到：低层 tracks=0；importPlaylistFile=IMPORT_UNKNOWN_FORMAT；加 `<?xml version="1.0"?>` 后统一入口 tracks=0。首次探索用的缺少 Playlists 的探针只得到 IMPORT_XML_NO_PLAYLIST，不作为成功导入证据。
- 归属：统一入口识别规则为既有代码，B 类扩展 DOCTYPE 后未补齐入口集成。不是 XXE 绕过，亦不否认带 XML 声明的标准官方导出已可用。
- GLM 修复边界：让合法 XML prolog 能路由到同一个严格解析器，不通过任意正则删除 DOCTYPE 或引入外部实体解析。补统一入口测试，而非只测底层 parser。
- 验收：带/不带声明、注释前导的受支持 plist 可导入；内部子集、重复声明、未知 DTD 仍被严格拒绝。

```xml
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Tracks</key><dict/>
<key>Playlists</key><array><dict>
<key>Name</key><string>Review</string>
<key>Playlist ID</key><integer>1</integer>
<key>Playlist Items</key><array/>
</dict></array>
</dict></plist>
```

### F4 — P2：宿主端口 80 的自动 Origin 配置被拒绝

- 【已验证】位置：`docker-compose.yml:35`、:61 与 `apps/server/src/config.ts:90`–:94。
- PORT=80 会派生 `http://127.0.0.1:80,http://localhost:80`；URL.origin 去掉默认端口，严格配置校验认为它与原字符串不同并拒绝。主审内存编译实际 loadServerConfig，以容器内 PORT=4319、合成 token 测试：4319 accepted，4567 accepted，80 rejected ALLOWED_ORIGINS 必须只包含完整 HTTP(S) origin，进程 exit 0。没有执行真实 Compose 或容器启动。
- 归属：B 类自动派生白名单与既有校验不兼容，不是 A 类改动污染。端口是否占用与该配置解析错误无关。
- GLM：统一派生白名单与浏览器 Origin 的规范形式，不要放宽路径、userinfo、通配符边界；增加 4319、4567、80 的配置测试，有 Docker 后重跑对应 Compose。现有默认 compose config 和手工 docker run 未覆盖这个边界。
- 最终判定补充：04 从“有保留认可”调整为“不认可”；总体仍为“需修复后合并”，最终共 1 个 P1、3 个 P2。将 F4 纳入后续修复与回归。

## 4. 简报盲区与证据限制

- 【已验证】开始审查时实际为 30 个修改文件 + 8 个未跟踪文件，不是简报的 30+6；本文新增后预期是 30+9。简报与另一个 review prompt 本身也在未跟踪清单中。
- 【存疑】未提交 diff 只能与 HEAD 比较，不能从 Git 证明 A/B/C 各代理的写入时间与“本轮未触碰 A”；没有修复前的独立树对象/哈希快照，不将归属声明当作密码学证明。本次未找到 B/C 破坏 A 的直接证据；F1 已明确区分 HEAD 既有遗漏与 B 重写保留。
- 【已验证】`apps/web/playwright.config.ts:18` 禁用了 Service Worker，因此 5/5 E2E 不证明 v1→v2 真实浏览器升级、CacheStorage 配额或 cookie 可见性；VM 测试不能替代这些浏览器语义。
- 【静态审查】SW 的静态路径允许列表使 /API/、//api/、/%61pi/ 等变体不匹配缓存入口，未发现它们能缓存 API 的实际证据；浏览器自动附带 cookie 与手工设置 Cookie header 不同，本次未把 header mock 当作完整凭据缓存证明。当前服务静态内容不是按 Cookie 个性化，不能仅凭这一差异宣称泄露歌单。
- 【已验证】本机缺 Docker，Docker smoke 和 compose 命令均退出 1；不能确认简报中的 NAS amd64 镜像、加固容器及实际权限记录。未联系 NAS、未读取或复用 SSH 凭据。arm64、Actions、Tauri、真实 Apple Token 仍未复现。
- 【存疑】Action SHA 的远端真实性本次没有重新查询；仅看到了固定 SHA 的配置，不认可“已独立核实所有 SHA”的表述。Node 22 的所谓探测腿没有独立运行证据，且矩阵没有将其设为可失败；需明确这是支持要求还是非阻塞探测。
- 【已验证】本次冻结安装确实触发 pnpm 的 supply-chain policies 检查，输出包含访问 npm registry 的 Playwright 包元数据请求。未执行 pnpm audit，也未请求真实音乐平台；但不能声称本次完全无外网。锁文件不变不等于安装完全离线。
- 【静态审查】`scripts/docker-smoke.mjs:295` 在 docker run 失败时拼接完整参数，内存 mock 已显示合成 ACCESS_TOKEN 被打印；这里不是已证实真实用户凭证泄露，但“所有 Token 均不进日志”的笼统主张不成立，建议与 F1 一并脱敏。
- 【静态审查】合法 Origin 的错误响应仍可能因 raw Response 缺少 ACAO 而被浏览器当作网络错误，位置 `apps/server/src/app.ts:73` 附近。这是简报已经提示的既有兼容性限制，不是此次越权绕过；不要把拒绝非法 Origin 与隐藏合法客户端的错误信息混为一谈。
- 【存疑】未对整个 Git 历史、NAS 会话或所有外部日志做秘密扫描，不能独立证实历史“凭据从未落盘”声明；本次所跑适配器/服务器测试使用 mock/合成数据，没有执行真实歌单请求。禁止将测试通过写成全仓库无秘密/无缺陷证明。

## 5. 实际执行的验证命令与退出码

主审亲自执行，工作目录均为本文开头的工作树。只列实际执行项目；“未复现”不等同于产品测试失败。

| 命令 | 退出码 | 实际结果 |
| --- | --- | --- |
| `git status --short`、`git rev-parse HEAD` | 0 | HEAD 与目标一致；开始时 30M+8?? |
| `pnpm test` | 0 | 39 文件，424 项通过，23.58 秒 |
| `pnpm typecheck` | 0 | 9 个有 typecheck 脚本的包通过，不含 Tauri 原生构建 |
| `$env:CI='1'; pnpm install --frozen-lockfile` | 0 | 已有依赖环境成功；出现 supply-chain 元数据联网检查 |
| `Get-FileHash pnpm-lock.yaml`（安装前后） | 0 | 均为 `440AC20662886D4F36E60751412E88971B0A3E91E6637272EA6BF212C6F3D112` |
| `pnpm --filter @playlist-exporter/web build` | 0 | Vite 构建成功 |
| `pnpm --filter @playlist-exporter/server build` | 0 | esbuild 构建成功，约 941.4 KB |
| `pnpm --filter @playlist-exporter/web e2e` | 0 | 5/5，7.8 秒；真实浏览器但平台接口为 mock，SW 禁用 |
| `git diff --check` | 0 | 只有 LF→CRLF 提示 |
| `node scripts/docker-smoke.mjs --skip-build --image playlist-exporter:amd64` | 1 | ENOENT，无 Docker；容器验证未复现 |
| 设置合成 ACCESS_TOKEN/ALLOWED_ORIGINS 后 `docker compose config --quiet` | 1 | docker 命令不存在；插值未复现 |
| `node --input-type=module -e $reviewProbe`：F2 内存 VM | 0 | 成功网络响应被替换成 OLD，缺陷复现 |
| 同上：F3 初始 XML 探针 | 0 | 缺 Playlists，只证明两入口不同错误；不作为有效文件通过证据 |
| 同上：F3 完整空歌单探针 | 0 | 低层 0 首，统一入口拒绝；加 XML 声明后 0 首 |
| 同上：F1 内存 spawnSync mock | 1 | run=125 后记录 rm -f 固定名；故意失败，未运行真实 Docker 操作 |
| 同上：F4 实际 loadServerConfig 内存编译 | 0 | 4319/4567 通过，80 被拒绝；未运行容器 |
| `git diff --stat`、`git diff --numstat`、目标文件 `git diff -- ...`、`git show HEAD:scripts/docker-smoke.mjs` | 0 | 核对改动范围及 F1 历史归属 |
| 多次 `Get-Content` / `rg -n` 定向读码组合命令 | 0 | 核对简报、实现、测试和引用位置 |

普通沙箱读取首次因 helper setup 错误未启动（无进程退出码）；随后以获准的只读/测试命令执行。未运行 pnpm audit、git commit/push/reset/clean；未写任何修复代码。

交给 GLM：先处理 F1，再处理 F2/F3，每项添加能在旧实现变红的合成回归测试；不要大规模重写，不要以真实平台请求或真实容器误删验证反例。完成后重新输出真实命令/退出码及仍未验证项，保留 A/B/C 的来源区分。
