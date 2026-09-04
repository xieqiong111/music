# 安全文档

本文档描述本工具的威胁模型、已实现的安全控制边界，以及**明确不做**的事情。能力目标以[设计规格](superpowers/specs/2026-09-02-streaming-playlist-exporter-design.md)为准。

## 威胁模型

部署形态以两个场景为基准：

1. **本地单用户**：服务监听 `127.0.0.1`，同一台设备上的浏览器是唯一客户端。
2. **NAS（局域网）**：服务运行在 NAS Docker 中，可能通过 LAN profile 暴露给局域网内的少量受信设备。

需要防御的攻击者与风险：

| 攻击者 / 载体 | 风险 | 主要对策 |
|---|---|---|
| 恶意网页（用户浏览器中打开的第三方站点） | 伪造跨源请求调用本地 API（CSRF 式读取/取消/导出） | 严格 Origin 白名单 + Bearer 令牌 + 非简单请求强制校验 Origin |
| 局域网内其他设备（LAN 模式） | 未授权访问 API、探测任务与导出结果 | 非 loopback 监听强制 `ACCESS_TOKEN`（恒定时间比较） |
| 超大或恶意构造的请求体 | 资源耗尽、解析器攻击 | 1 MiB 请求体上限、JSON Schema 校验、拒绝非 identity 压缩 |
| 被劫持或变更的上游接口 | 恶意重定向、 SSRF、异常大响应 | 出站 HTTPS 域名白名单、禁重定向、单响应 8 MiB 上限 |
| 日志与错误信息泄露 | 令牌/Cookie/查询参数进入日志 | 日志只含 requestId + 状态码；错误细节递归脱敏 |
| 浏览器缓存/SW 持久化 | 敏感请求被缓存到磁盘 | Service Worker 只缓存同源静态资源，API 响应 `no-store` |
| 本机数据残留 | 任务/结果长期留在磁盘 | 任务与结果只保存在内存，带 TTL，重启即失 |

## 安全控制清单

以下每一项都对应服务端现有实现（`apps/server/src/`）：

1. **默认回环监听**：`HOST` 默认 `127.0.0.1`；只有显式配置才会暴露到网络。
2. **非 loopback 必须令牌**：`ACCESS_TOKEN` 未配置且监听地址非回环时，服务在启动阶段直接拒绝（不创建任何 socket）。
3. **令牌恒定时间比较**：Bearer 令牌先做 SHA-256 摘要再用 `timingSafeEqual` 比较，不泄漏时序信息；令牌拒绝控制字符、长度上限 4096 字节。
4. **Origin 严格校验**：白名单按完整 origin（协议+主机+端口）精确匹配；拒绝 `*`、`null` 与带路径/凭证的 origin；所有变更类请求（POST/PUT/PATCH/DELETE）必须携带被允许的 Origin；预检只放行白名单方法（GET/POST/DELETE）与白名单请求头（authorization/content-type）。
5. **1 MiB 请求体上限**：`MAX_BODY_BYTES` 默认且最大为 1 MiB（1048576 字节），超出返回 413；同时拒绝任何非 `identity` 的 `Content-Encoding`（返回 415）。
6. **最小化日志**：每条服务日志仅含 `requestId` 与 HTTP 状态码；错误响应的 `technicalDetails` 只含 `requestId`；错误对象中的技术细节在构造时递归脱敏（Authorization/Cookie/token/query secret 等键）。
7. **出站 HTTPS 白名单**：Provider 的所有上游请求经由受限 fetch——仅允许 `https`、无用户信息、无显式端口、主机名在白名单（当前为 `music.163.com`、`y.music.163.com`、`163cn.tv`）之内；**重定向被禁止**（`redirect: 'error'`）；另有 15 秒超时、最小 250ms 请求间隔、单响应 8 MiB 上限。
8. **内存任务 + TTL**：任务（含读取结果）只存在于内存，不落盘、不持久化凭证；已结束任务默认保留 15 分钟（`JOB_TTL_MS=900000`）后被清扫，任务 ID 随之失效；并发（默认 2）与队列（默认 100）有上限。
9. **Service Worker 缓存边界**：`apps/web/src/sw.js` 只缓存同源的静态外壳资源（`/`、`/index.html`、`/manifest.webmanifest`、`/sw.js`、`/assets/`、`/icons/`）；跳过 `/api/`、`/healthz`，且带 `Authorization` 或 `Cookie` 头的请求一律不缓存；API 响应统一 `Cache-Control: no-store`。
10. **Docker 交付基线**（随 NAS Docker 阶段落地并在验证记录中确认）：容器以非 root 用户运行、根文件系统只读、`cap_drop: ALL`、带 healthcheck、数据仅写入显式挂载卷；compose 默认仅映射 `127.0.0.1`。
11. **CI 密钥扫描与依赖审计**：`.github/workflows/ci.yml` 中的 security job 对全量历史运行 gitleaks，并对生产依赖执行 `pnpm audit --prod --audit-level=high`。

## 已明确不做的事

以下能力**不在产品范围内**，无论以何种方式请求都不会实现：

- 不下载、不缓存、不转发任何音频流。
- 不实现播放功能，不绕过任何平台的 DRM 或会员限制。
- 不修改任何平台上的歌单（无增删改操作）。
- 不要求、不存储、不中转任何平台账号、Cookie 或登录态。
- PWA 独立运行形态不持久化高价值凭证；需要凭证的能力（如未来 Apple BYO Token 预览）只能通过已鉴权的本地服务/Tauri 运行时提供，且凭证走系统 keychain/keystore（设计约束）。

## 漏洞反馈

请勿在公开 issue 中粘贴令牌、Cookie、歌单内容或完整日志；发现安全问题请优先私下联系维护者（发布阶段会在本节补充具体联系方式）。
