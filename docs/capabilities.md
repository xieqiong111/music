# 能力矩阵（Supported / Planned / Unavailable）

本文档是当前仓库的**真实能力状态**快照，与[设计规格](superpowers/specs/2026-09-02-streaming-playlist-exporter-design.md)中的目标能力矩阵（"能力矩阵"与"阶段与验收门"两节）对照阅读：

- 设计规格描述各能力的**目标形态**；
- 本文档描述**当前版本**每项能力在四种运行环境下的三态状态。

状态定义：

| 状态 | 含义 |
|---|---|
| **Supported** | 当前代码已实现、有对应自动化验证、且用户现在就可以使用 |
| **Planned** | 在设计规格与路线图中有明确位置，但当前尚未实现或尚未通过对应验收门 |
| **Unavailable** | 当前不提供。部分是设计上的永久边界（如独立 PWA 处理私人歌单），部分是"通过完整性验收门之前"的临时状态 |

随着阶段推进，各能力会按验收门从 Planned 升级为 Supported；已列入规格但未过验收门的能力**不会**被标记为 Supported。

## 当前能力矩阵

| 能力 | 浏览器（PWA 界面） | NAS（Docker） | 桌面（Tauri） | Android（Tauri） |
|---|---|---|---|---|
| 网易云公开歌单读取 | **Supported**（经同源本地服务；服务需在运行） | Planned | Planned | Planned |
| 网易云私人歌单读取 | Unavailable（设计规定：独立 PWA 不处理需凭证的能力） | Planned（Preview，挂载数据目录） | Planned（Preview，安全存储） | Planned（Preview，安全存储） |
| QQ 音乐公开歌单 | **Supported**（经同源本地服务；仅公开歌单，匿名只读，服务需在运行） | Planned（Docker 交付后可用） | Planned | Planned |
| Apple 官方文件导入 | Planned | Planned | Planned | Planned |
| Apple 官方在线 API（BYO developer credentials） | Planned（Preview） | Planned（BYO/self-hosted signer，Preview） | Planned（逐平台实测） | Planned（逐平台实测） |
| Apple 浏览器会话适配 | Unavailable（设计规定） | Planned（Experimental，仅 loopback） | Planned（Experimental，默认关闭） | Unavailable（设计规定） |
| 本地文件导入（TXT/CSV/JSON/XML） | Planned | Planned | Planned | Planned |
| UTF-8 TXT/CSV/JSON 导出 | **Supported**（浏览器下载） | Planned（下载/API + 挂载数据目录） | Planned（原生保存对话框） | Planned |
| 静态外壳离线加载（Service Worker 缓存） | **Supported**（仅缓存同源静态资源，见[安全文档](security.md)） | 不适用（服务端渲染分发静态资源） | 不适用 | 不适用 |
| 桌面/Android 安装包分发 | 不适用 | 不适用 | Planned（未签名，见 README"未签名构建提示"） | Planned（未签名，见 README"未签名构建提示"） |

说明：

- **QQ 音乐公开歌单**已在浏览器（PWA 界面）升级为 Supported：2026-09-05 的公开端点探测以 1240 首公开歌单证明了完整分页（`outputs/research/2026-09-05-qq-public-api-probe.md`），适配器经同源本地服务接入；NAS（Docker）、桌面与 Android 维度随对应交付节奏保持 Planned。当前边界见下节。
- **网易云私人歌单 / Apple 浏览器会话**在独立 PWA 中 Unavailable 是**设计上的永久边界**：standalone PWA 只提供匿名能力；需要凭证的能力必须经已鉴权的本地服务或 Tauri 运行时。

## 网易云公开歌单的具体边界

当前 Supported 的网易云能力有以下明确边界，均由代码强制：

1. **超过 1000 首支持分页读取**：上游接口每页最多返回 1000 首；工具自动分页读取整张歌单，并受页数预算、条目预算、游标前进与总数一致性等多重校验保护。
2. **不完整结果不导出**：任何完整性校验失败都会使任务以 `INCOMPLETE_PAGINATION` 失败，或将结果标记为 `complete=false`；导出接口随后以 409 / 422（`INCOMPLETE_PLAYLIST`）阻止生成文件。**绝不静默截断**成"看似完整"的导出。详见[故障排查手册](troubleshooting.md)。
3. **仅公开歌单、只读元数据**：不读取私人歌单，不获取音频，不修改平台数据。
4. **上游仅限固定元数据接口**：出站请求受 HTTPS 域名白名单约束（`music.163.com`、`y.music.163.com`、`163cn.tv`），禁重定向，详见[安全文档](security.md)。

## QQ 音乐公开歌单的具体边界

当前 Supported 的 QQ 音乐能力（浏览器 PWA 界面，经同源本地服务）有以下明确边界：

1. **仅公开歌单、匿名只读**：只读取对未登录访客可见的公开歌单，不读取私人歌单，不获取音频，不修改平台数据；全程不需要 QQ 账号、Cookie 或登录态。
2. **"已下架/不可用"判定缺失**：匿名公开接口不提供已下架或地区不可用曲目的可靠标识；`pay` / `switch` 等可用性字段的语义**未实证**，因此不用于下架判定。详情解析失败的条目按占位保留，并在歌单 `warnings` 中告警，不会被静默丢弃。
3. **超过 1000 首支持分页读取**：1240 首公开歌单已于 2026-09-05 实测完整分页（推荐 500 首/页，1000 首/页亦被上游完整尊重），分页顺序与上游全序表逐位一致；与网易云一样受分页完整性校验保护，不完整结果不导出（见[故障排查手册](troubleshooting.md)）。
4. **上游仅限固定元数据接口**：出站请求受 HTTPS 域名白名单约束，QQ 端点仅允许 `i.y.qq.com`（探测确认的端点主机；`u.y.qq.com` / `c.y.qq.com` 未被本项目使用），禁重定向，详见[安全文档](security.md)。

## 相关文档

- 设计规格与目标能力矩阵：[docs/superpowers/specs/2026-09-02-streaming-playlist-exporter-design.md](superpowers/specs/2026-09-02-streaming-playlist-exporter-design.md)
- 安全边界与威胁模型：[docs/security.md](security.md)
- 错误码与完整性阻止的排查：[docs/troubleshooting.md](troubleshooting.md)
- 验证记录（待主代理执行回填）：[docs/verification/mvp.md](verification/mvp.md)
