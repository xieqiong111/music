# 跨平台流媒体歌单导出工具设计规格

## 目标

构建一个 local-first、只读的跨平台歌单元数据导出工具。共享 TypeScript 核心运行于浏览器/PWA、Node/NAS 和 Tauri 2；支持网易云音乐、QQ 音乐和 Apple Music，并导出 UTF-8 TXT、CSV、JSON。

本规格继承并细化 [第一阶段技术选型报告](../../../outputs/第一阶段技术选型报告.md)。所有第三方复用必须同步更新 [THIRD_PARTY_NOTICES](../../../outputs/THIRD_PARTY_NOTICES.md)。

## 已确认的产品决策

- 使用干净 TypeScript monorepo，不 fork 现有候选仓库。
- 只读歌单元数据，不实现播放、下载、音频地址、会员或 DRM 绕过，也不修改平台歌单。
- 首个真实 Provider 是网易云公开歌单；通过完整性门后才开始 QQ 或 Apple 在线 Provider。
- Apple 官方文件导入为稳定能力；官方在线 API 采用 BYO developer credentials 的 Preview；浏览器会话适配器默认关闭并标为 Experimental。
- standalone PWA 只提供匿名能力和本地文件导入；需要凭证或绕过 CORS 的能力通过已鉴权的本地 NAS/Tauri runtime 提供。
- NAS 默认监听 `127.0.0.1`。非 loopback 监听时没有访问 token 必须拒绝启动。
- 外部响应必须经过运行时 Schema 校验。错误、截断、取消不得伪装为空歌单或完整导出。

## 能力矩阵

| 能力 | Browser/PWA | Tauri desktop/Android | NAS |
|---|---|---|---|
| 本地 TXT/CSV/JSON/XML 导入 | Supported | Supported | Supported |
| UTF-8 TXT/CSV/JSON 导出 | Browser download | Native save dialog | Download/API + mounted data dir |
| 网易公开歌单 | 通过 same-origin local service 或 CORS 可用时 | Native HTTP | Node HTTP |
| 网易私人歌单 | Unavailable in standalone PWA | Preview，安全存储 | Preview，挂载数据目录 |
| QQ 公开歌单 | 通过完整性门后决定 | 同左 | 同左 |
| Apple 官方文件 | Supported | Supported | Supported |
| Apple 官方在线 API | BYO token Preview | 逐平台实测 | BYO/self-hosted signer Preview |
| Apple 浏览器会话 | Unavailable | Experimental，默认关闭 | Experimental，仅 loopback |

## 领域模型

```ts
type ProviderId = 'apple-music' | 'netease' | 'qq-music';

interface Track {
  title: string;
  artists: string[];
  album?: string;
  trackId?: string;
  isrc?: string;
  source: ProviderId;
  availability: 'available' | 'unavailable' | 'removed' | 'unknown';
  position: number;
  warnings: string[];
}

interface Playlist {
  id: string;
  name: string;
  creator?: string;
  source: ProviderId;
  total: number;
  tracks: Track[];
  complete: boolean;
  warnings: string[];
}
```

Provider 返回 `Playlist` 之前必须完成响应校验、分页和顺序恢复。合法重复歌曲不在抓取层去重；去重只属于导出选项。

## Provider 契约

```ts
interface MusicProvider {
  readonly id: ProviderId;
  validateInput(input: PlaylistInput): Promise<ValidationResult>;
  authenticate(options: AuthOptions): Promise<AuthResult>;
  fetchPlaylist(input: PlaylistInput, context: TaskContext): Promise<Playlist>;
  fetchAllTracks(playlistId: string, context: TaskContext): Promise<Track[]>;
  logout(): Promise<void>;
}
```

`TaskContext` 提供 `AbortSignal`、进度回调、受限 HTTP transport 和临时 credential handle。Provider 不得读写文件、localStorage、keychain 或日志。

## 完整性协议

- 每页记录 cursor/offset、页大小、原始条目数、累计条目数、上游 total 与终止原因。
- cursor 不前进、重复页面、页数超出显式安全预算或累计数少于 total 时，返回 `complete=false` 并阻止默认导出为“成功”。
- 安全上限不是静默截断。若用户明确选择提前停止，导出 envelope 必须记录 `complete=false`。
- 详情接口批量返回乱序时按原始 position 重排；缺失条目生成占位 Track。
- 401/403 不自动切换到更高风险认证；429 只执行有限、可取消、尊重 `Retry-After` 的重试。

## 导出规则

- TXT 默认 `歌曲名 - 歌手1、歌手2`，UTF-8 无 BOM、LF；可选序号、反转字段、专辑和去重。
- CSV 采用 RFC 4180 转义、UTF-8，可选 BOM；以 `'` 防护以 `= + - @` 开头的公式字段。
- JSON 使用版本化 envelope：`schemaVersion: 1`、生成时间、导出选项、Playlist。
- 文件名为 `平台_歌单名_YYYY-MM-DD.ext`，清理 Windows/macOS/Linux 非法字符、保留 Unicode、避免保留名和尾部点/空格。
- 失败或取消先删除临时文件，不覆盖现有最终文件。

## 安全边界

- 日志只允许结构化错误码、Provider、阶段、HTTP 状态和 request ID；Authorization/Cookie/token/query secret 必须递归脱敏。
- Tauri 凭证通过系统 keychain/keystore；NAS 凭证只写挂载目录并限制权限；PWA 不持久化高价值凭证。
- NAS 非 loopback 监听必须配置访问 token；token 以恒定时间比较，所有 API 使用同源策略、严格 CORS 和 CSRF 防护。
- Docker 以非 root 用户运行，具有 healthcheck、显式数据卷和只读根文件系统兼容性。
- 所有 Provider capability 在 UI 显示 Supported/Preview/Experimental/Unavailable，不能用一个“平台已支持”掩盖运行时差异。

## 阶段与验收门

1. 共享 contracts/core/exporters/importers：fixtures 覆盖 Unicode、重复、缺失、分页和脱敏。
2. 网易公开歌单纵向切片：>1000、空歌单、429、取消、Web/PWA、NAS Docker 全部通过。
3. QQ：先用公开 >1000 歌单证明完整遍历；未通过则保留 Experimental/Unavailable。
4. Apple：先稳定文件导入，再验证官方 catalog/library 的 token 与 `next`；会话模式独立开关。
5. Tauri：Windows/macOS/Android 分别验证保存对话框、安全存储与构建流程。
6. 发布：安全审查、依赖许可证、CI、amd64/arm64 Docker、中文 README 和真实人工验收记录。

## 回滚点

- 每个 Provider 是独立 package 和 feature flag，接口失效可单独禁用。
- runtime 只通过接口依赖 core，可停用某运行时而不改变领域数据。
- 第三方移植代码单独提交并登记 commit/许可证/修改，允许逐块替换。
- 任何 Preview/Experimental 能力均不得成为稳定导出路径的隐式 fallback。

