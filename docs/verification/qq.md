# QQ 音乐公开歌单阶段验证记录（2026-09-05）

执行人：GLM-5.3-Flash 代理（ZCode 会话，Windows 本机）。本记录只含实际执行的命令与真实结果；未执行的项目如实标注。

## 门禁验证（实现前置条件）

- 依据：`outputs/research/2026-09-05-qq-public-api-probe.md`（40 次只读请求、间隔 ≥1.65s、无凭证、无 429）。
- **GATE: PASS**：公开歌单 `disstid=7729596131` 共 1240 首（`cdlist[0].songnum=total_song_num=1240`）；song_num=1000 分页：1000 + 240 = **1240 == 1240，无截断**；song_begin 越过 1000 正常返回；响应内全量有序 `songids` 与分页累计序列逐位一致。
- 可用端点：`GET https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&format=json&utf8=1&disstid=<ID>&song_begin=<B>&song_num=<N>`，最小必要请求头仅 `Referer: https://y.qq.com/`。候选 A（musicu.fcg GetPlaylistDetail）匿名一律 500003 需登录，判定不可用；候选 B（c.y.qq.com 旧端点）已 404。
- 无效 disstid：HTTP 200 + 业务码（探测观测 `code:-1`；本阶段复测观测 `code:10`），两者均映射为"未找到该 QQ 音乐歌单"。

## 自动化验证（本机实际执行）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm --filter @playlist-exporter/provider-qq test` | 3 文件 / **45 用例全过**（1001 首三页、哨兵一致/长度不符/顺序不符、code -1 与 10、invalid referer、GBK 解码、PII 与截断 dissid 不透出、abort/429/401/403/404/断网/schema 漂移） | 0 |
| `pnpm test`（全仓） | **30 文件 / 236 用例全过** | 0 |
| `pnpm typecheck` | 7 个工作区全部通过 | 0 |
| `pnpm --filter @playlist-exporter/server build` | 成功 | 0 |
| `pnpm --filter @playlist-exporter/web build` | 成功 | 0 |
| `pnpm --filter @playlist-exporter/web e2e` | **4 passed (7.2s)**：原 3 个 netease 用例 + 新增 QQ 12 首全流程用例（链接识别 → 提交 → 进度 → 预览 → 真实下载字节校验、文件名 `qq-music_..._日期.txt`） | 0 |
| `git diff --check` | 通过 | 0 |

## 真实端到端冒烟（经本地服务，非 mock）

命令：`PORT=4392 HOST=127.0.0.1 ACCESS_TOKEN=*** node apps/server/dist/index.js` + curl（带 Bearer 与同源 Origin）。

| 步骤 | 结果 |
|---|---|
| `POST /api/playlists/inspect`（provider=qq-music，disstid=7729596131） | 202 + jobId |
| 轮询任务 | `completed`，progress `{completed:1240, total:1240}` |
| 结果结构 | `complete=true`、1240 首、`position` 连续单调、warnings=0 |
| PII 检查 | 输出 JSON 不含 nick/uin/encrypt_uin/headurl；无 `creator` 字段 |
| `POST /api/exports`（TXT/LF） | 200；36654 字节；无 BOM；严格 UTF-8 解码成功；无 CR、以 LF 结尾；**1240 行**；重复歌名按原顺序保留（19 组）；文件名形如 `qq-music_<歌单名>_2026-09-05.txt`（歌单名为真实用户创建的公开歌单名，本记录中不复述） |
| 无效 ID（99999999999） | 任务 failed，`PROVIDER_HTTP_ERROR`，中文文案"未找到该 QQ 音乐歌单，请确认链接或歌单 ID"，technicalDetails `{code:10}`，不重试 |

## 未验证项

1. **Docker 容器内的 QQ 读取**（Docker 本机不可用，同 `docs/verification/docker.md`）。
2. 真实"已下架/地区不可用"曲目样本未获得——可用性判别保持"条目存在即 available"，`pay`/`switch` 字段语义未实证、不用于下架判定（见 capabilities 边界说明）。
3. 页大小 >1000 未实测（实现上限取 1000）；QEMU/arm64 与 LAN 模式未测。
4. 响应 `songids` 哨兵缺失时的降级路径（生产端点总是携带）仅由单元测试覆盖。
5. 上游老端点（qzone 系）的长期存续风险无法在本机验证，已通过 egress 白名单与结构化错误保证失效时可观测。

## 已知限制与风险

- i.y.qq.com 老端点可能变化：端点常量集中在 `provider.ts` 顶部；失败会以结构化中文错误呈现，不会静默截断。
- 上游偶发限流未实测（探测 40 次零 429）；provider 对 429 走 core 重试（尊重 Retry-After、可取消）。
- 请求节流依赖 server transport 的 `minIntervalMs`（250ms），低于探测建议的 1.5s 人工间隔；如遇风控可调大。
