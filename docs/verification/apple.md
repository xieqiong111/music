# Apple Music 阶段验证记录（2026-09-05）

执行人：GLM-5.3-Flash 代理（ZCode 会话，Windows 本机）。第五阶段按既定优先级交付：①官方导出文件本地导入（稳定能力）→ ②官方在线 API 的 BYO developer token 预览（**Preview**）。浏览器会话解析维持设计规定的 Unavailable/Experimental，未实现。

## 能力一：官方导出文件本地导入（packages/importers）

覆盖三种格式：Apple Music/iTunes 导出的制表符文本（UTF-8 / UTF-16LE/BE BOM 自适应）、plist XML（资料库与单播放列表布局、防 XXE：DOCTYPE 一律拒绝）、本工具导出的 JSON envelope（schemaVersion 1 校验）。

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm --filter @playlist-exporter/importers test` | 4 文件 / **58 用例全过**（编码三态、中英文表头、缺表头/缺列、缺歌手占位与计数、顺序保持、占位不塌缩、DOCTYPE 拒绝、实体解码、data 容错、envelope round-trip、未知格式拒绝） | 0 |
| `pnpm --filter @playlist-exporter/importers typecheck` | 通过 | 0 |

**端到端（PWA 实测）**：`pnpm --filter @playlist-exporter/web e2e` **5 passed (7.0s)**，其中新增用例验证：合成 Apple 中文表头 TSV 在真实浏览器中上传 → 预览（共 2 首）→ 本机导出下载，文件名 `apple-music_我的导入歌单_<日期>.txt`，字节无 BOM、严格 UTF-8、LF，且**全程零 API 请求**（导入与导出完全不经过服务端）。

**未验证项**：真实 Music.app / iTunes 导出文件未在本机获得（Windows 环境无 Music.app），fixtures 全为合成数据；zh-CN Music.app 的实际表头名与老版 iTunes 的 UTF-16 导出建议人工复核（解析器已内置同义词表：名称/Name、艺术家/Artist、专辑/Album、总时间/Total Time）。

## 能力二：官方在线 API BYO Token 预览（packages/provider-apple，Preview）

- 实现为 MusicKit API v1 文档化形状：`GET https://api.music.apple.com/v1/catalog/{storefront}/playlists/{id}?limit=100` + `relationships.tracks.next` 续页；PaginationGuard 终止策略 `next-absent`；`trackCount` 存在时交叉校验（少读 → complete=false，多读/漂移 → 硬失败）。
- 令牌仅经服务端环境变量 `APPLE_DEVELOPER_TOKEN` 注入（trim 后空串视为未配置、上限 8192 字节、控制字符拒绝），只放入 `Authorization: Bearer` 请求头；**绝不入 URL/查询参数/日志**（测试断言错误 JSON 与任务快照均不含令牌串）。401 不重试、不自动升级认证。
- server：仅在配置令牌时注册 `apple-music` provider；egress 白名单新增 `api.music.apple.com`；未配置时 inspect 返回 422 `UNSUPPORTED_PROVIDER`。`previewUrl`/artwork 等音频与冗余字段 schema 不建模，试听地址不可能越过包边界。

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm --filter @playlist-exporter/provider-apple test` | 3 文件 / **63 用例全过**（单页/三页 next 链/next 停滞/trackCount 漂移/占位条目/401/403/404/429+Retry-After/5xx/无令牌/abort/schema 漂移/令牌不透出） | 0 |
| `pnpm --filter @playlist-exporter/server test` | 7 文件 / **66 用例全过**（含 startServer 级别：配置令牌 202 且上游收到 Bearer、未配置 422、401 任务失败且无泄漏、egress 边界） | 0 |

**未实测（如实声明）**：真实 Apple API 从未被调用——开发者 JWT 需 Apple 开发者账号签发，本机不存在真实令牌且禁止真实网络。所有响应形状基于 Apple 官方文档与合成 fixtures；实测时最可能的漂移点是续页 envelope 与 trackCount 语义，将以 `PROVIDER_SCHEMA_DRIFT` 或 `complete=false` 诚实呈现，不会导出错误数据。**该能力按 Preview 发布，不标记为稳定支持。**

## 能力三：浏览器会话适配

按设计规格保持 Unavailable（standalone PWA）/ Experimental 默认关闭（本地服务与桌面），本阶段未实现任何会话解析代码。

## 汇总（本阶段全仓）

`pnpm test`：**38 文件 / 374 用例全部通过**；`pnpm typecheck` 9 个工作区全部通过；`pnpm --filter @playlist-exporter/web build`、`pnpm --filter @playlist-exporter/server build` 成功；`git diff --check` 通过。
