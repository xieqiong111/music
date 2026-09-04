# QQ 音乐公开歌单匿名读取探测报告

- 日期：2026-09-05（探测执行于 2026-09-04 晚，国内网络环境，Windows 11 + Git Bash + Node v24.20.0 原生 fetch）
- 目的：为"跨平台流媒体歌单导出工具"的 QQ 音乐 Provider 实现**门禁**验证——证明"公开歌单可完整分页读取（含超过 1000 首不截断）"
- 性质：全部为**只读公开数据 GET 请求**；未携带任何 Cookie/登录凭证/会员凭证；未请求任何私人歌单；未下载音频、未获取播放地址/试听地址、未触碰 DRM
- 限速与预算：串行执行，每次请求间隔 ≥1.65s；预算 80 次，实际使用 **40 次**；全程未收到 429/限流，无异常失败
- 隐私声明：本报告不含任何真实用户昵称、头像、歌单简介等个人信息；歌单以匿名代称+数字 ID 表示；歌曲示例全部为合成数据

---

## 一、结论摘要

> **GATE: PASS**
>
> 对 1240 首的公开歌单（代称"大歌单 A"，`disstid=7729596131`）按页大小 1000 全量分页：
> 第 1 页（song_begin=0）返回 1000 条 + 第 2 页（song_begin=1000）返回 240 条 = **累计 1240 条**，
> 与上游 total（`cdlist[0].songnum` = `total_song_num` = **1240**）**完全一致，无截断**。
> `song_begin` 越过 1000 后接口继续正常返回后续歌曲；第 3 页（song_begin=1240）返回空 songlist（code=0）干净终止。
> 此外：API 在每个分页响应中回传全量有序 `songids`（1240 个），与分页累计的 songid 序列**逐位一致**，独立佐证无重叠、无缺失、顺序稳定。

匿名可用的接口是候选 B 的同族老端点（`i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`），最小必要请求头仅 `Referer: https://y.qq.com/` 一个。候选 A（musicu.fcg `GetPlaylistDetail`）匿名一律返回业务错误码 500003（需登录），判定不可用于本项目的匿名导出场景。

---

## 二、候选接口逐一验证结果

### A. `POST https://u.y.qq.com/cgi-bin/musicu.fcg`（GetPlaylistDetail）——不可用（需登录）

实测的请求形态（均带 `Content-Type: application/json`、`Referer: https://y.qq.com/` 或歌单页、`Origin: https://y.qq.com`、常规 Chrome UA，无 Cookie）：

```json
{"comm":{"ct":24,"cv":0},
 "req_1":{"method":"GetPlaylistDetail","module":"music.srfDissInfo.UiDissInfo",
          "param":{"disstid":9587287911,"onlysonglist":1,"song_begin":0,"song_num":10}}}
```

尝试矩阵与结果（共 6 次请求，HTTP 均为 200）：

| 变体 | 结果 |
|---|---|
| comm `{ct:24,cv:0}`，onlysonglist=1 / =0 | `req_1.code=500003, subcode=860100001` |
| comm `{ct:19,cv:1873}` + Referer 改为歌单页 | 同上 500003 |
| `disstid` 改为字符串 `"9587287911"` | 同上 500003 |
| GET 形式 `musicu.fcg?format=json&data=<urlencode>` | 同上 500003 |
| comm 追加 `uin:"", wid:""` | 同上 500003 |

- 响应顶层结构：`{"code":0,"ts":...,"start_ts":...,"traceid":"...","req_1":{"code":500003,"subcode":860100001}}`（body 仅 127 字节）
- 结论：匿名访问一律 `500003`，该模块需要登录态，**判定不可用**。不排除携带 `qimei36` 等设备指纹的 comm 能解锁，但本项目禁止凭证、不追查登录路径，就此封存。

### B. `GET https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_iids_df.fcg`——不可用（已下线）

- 带 `Referer: https://y.qq.com/` + UA 请求 → **HTTP 404**，body 空。判定端点已废弃。

### B2（同族替代端点，本次实测可用）：`GET https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`

- 实测可用（社区开源项目中的老 qzone 端点，本机验证通过，非照抄）：
  `GET https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&format=json&utf8=1&disstid=<ID>&song_begin=<B>&song_num=<N>`
- 匿名、无 Cookie 即可读取**公开歌单**；HTTP 200；响应为单个 JSON 对象（非 JSONP）
- 关键行为细节见第四、五节

### 其他顺带验证的接口（用于发现大歌单，供后续参考）

| 接口 | 结果 |
|---|---|
| `POST musicu.fcg` module `playlist.PlayListPlazaServer` method `get_playlist_by_category` | code=0 可用；但 `id=10000000`（全部）返回 `total:0`，`id=3316` 仅返回 9 条编辑精选小歌单（条目含 `tid`、`song_ids` 数组、封面等）。不适合找大歌单 |
| `GET https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?...&categoryId=10000000&sortId=5&begin=0&size=30` | 匿名可用，返回 30 条热门歌单卡片（`dissid` 字符串、`listennum`、标题、封面；无歌曲数字段）。本次用它+逐个探测找到 1240 首大歌单 |
| `POST musicu.fcg` module `music.search.SearchCgiService` method `DoSearchForQQMusicDesktop` | code=0 可达，但匿名搜索结果为空（`meta.sum=0`，仅 singer tab 偶有结果）；search_type=1 实测是"歌手"tab。不适合匿名找歌单 |
| `GET https://y.qq.com/n/ryqq_v2/category`（分类页 HTML） | 200，SSR 中含约 20 个真实歌单链接（`/playlist/<disstid>`），无歌曲数信息 |
| `GET https://y.qq.com/n/ryqq/playlist/<disstid>`（歌单详情页 HTML） | 200，纯 JS 壳（10.5KB），无 SSR 歌曲数据，不能用作顺序交叉核对 |

---

## 三、门禁验证（核心）：大歌单 A（1240 首）全量分页

对象：公开歌单 A，`disstid=7729596131`（经大歌单搜索流程发现，见附录日志；另有 980/535/512/511 首等多个大歌单可复测）。

分页参数与结果（页大小先实测上限，见下节；最终用最大档 1000 验证）：

| 页 | song_begin | song_num | 实际返回条数（cur_song_num） | 累计 | 终止原因 |
|---|---|---|---|---|---|
| 1 | 0 | 1000 | 1000 | 1000 | — |
| 2 | 1000 | 1000 | 240 | **1240** | 短页（240 < 1000） |
| 3 | 1240 | 1000 | 0 | 1240 | 空页（code=0，songlist=[]），确认终止 |

- **上游 total 字段路径与值**：`cdlist[0].songnum = 1240`，`cdlist[0].total_song_num = 1240`（两处一致；顶层 `cdnum=1`、`realcdnum=1` 为碟/CD 结构字段）
- **累计条数是否等于 total**：1000 + 240 = **1240 == 1240，无截断** ✅
- **song_begin 越过 1000 后是否正常**：正常。begin=1000 返回 240 条完整曲目记录（字段齐全），HTTP 200、code=0，单次请求约 594ms/187KB ✅
- **无重叠/无缺失/顺序稳定**：页 1 末条与页 2 首条 songmid 不同；两页 1240 个 `songmid|songid` 全局唯一；且响应内回传的全量有序 `songids`（逗号分隔 1240 个 songid）与分页累计 songid 序列**逐位完全一致**（第 1 页首条 = songids[0]，末页末条 = songids[1239]）✅
- 结论性表述（按规范不粘贴真实曲目）：分页首条、第 1000 条、末条均为结构完整的真实曲目记录，其 songid 与上游全序表对应位置一致。

**页大小上限实测**（对大歌单 A，song_begin=0，各 1 次）：

| song_num 请求值 | 实际返回 | 响应大小 | 耗时 |
|---|---|---|---|
| 100 | 100 | 88KB | ~0.3s |
| 300 | 300 | 230KB | ~0.5s |
| 500 | 500 | 372KB | ~0.6s |
| 1000 | 1000（不再截断） | 728KB | ~0.7s |

即 `song_num` 至少到 1000 都被完全尊重（未测 >1000）。**小歌单对照**：`disstid=9587287911`（102 首）以 song_num=10/2 读取，`cur_song_num` 与请求一致，行为同上。

---

## 四、推荐 Provider 请求方案

**请求**：

```
GET https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg
    ?type=1&format=json&utf8=1&disstid=<ID>&song_begin=<B>&song_num=<N>
```

**必要请求头（最小集合）**：

| 头 | 必要性 | 依据 |
|---|---|---|
| `Referer: https://y.qq.com/` | **必需** | 缺失时 HTTP 仍 200，但 body 为 `{"code":0,"subcode":1,"msg":"invalid referer"}` |
| `User-Agent` | 可选 | 实测去掉 UA 仅带 Referer 仍正常返回；建议仍带常规浏览器 UA 降低风控风险 |

**参数要点**：

- `type=1` 必带：省略后 code=0 但 `cdlist[0]` 缺少 `songlist`/`cur_song_num`（响应明显变小）
- `utf8=1` 必带：不带时响应为 `charset=gb2312` 的 GBK 编码（songname 变乱码）；带上后 `content-type: application/json;charset=utf-8`。建议同时校验响应 charset，异常时回退 `new TextDecoder('gbk')` 解码
- `disstid` 直接放 URL（实测 >2^31 的 10 位 ID 无碍）；响应中 `cdlist[0].disstid` 为完整字符串，而 `cdlist[0].dissid` 数字字段存在 **int32 截断**（9587287911 → 9587287），**绝不能用 `dissid` 回写 ID**
- `song_begin` 越界时的回显会被**钳制到 songnum**（如 102 首歌单请求 begin=200，回显 `song_begin:102`、songlist 空）→ 翻页偏移量必须由客户端自己维护，不要依赖回显
- 推荐页大小 **500**（372KB/0.6s，性能与稳定性平衡；1000 亦可用但单包 728KB）。终止条件：`cur_song_num===0` 或返回条数 < song_num；以 `songnum`/`total_song_num` 为期望总数，最终校验累计条数

**完整性自校验（强烈建议内置）**：每个分页响应的 `cdlist[0].songids` 是全量有序 songid 逗号串，其长度应恒等于 `songnum`；分页累计的 songid 序列应与之一一对应。任何不一致立即报"上游分页异常"。

**错误码映射建议**：

| 观测到的响应 | 含义 | Provider 处理 |
|---|---|---|
| HTTP 200，顶层 `code:0`，`cdlist` 非空 | 成功 | 解析 `cdlist[0]` |
| HTTP 200，顶层 `code:-1, subcode:0, cdlist:[]` | **无效/不存在的 disstid**（注意 HTTP 仍是 200） | 映射"歌单不存在/链接无效" |
| HTTP 200，`code:0, subcode:1, msg:"invalid referer"` | 缺/错 Referer | 修复请求头后重试 |
| HTTP 200，code=0 但 `cdlist[0].songlist` 缺失 | 缺 `type=1` | 修复参数 |
| 响应 charset=gb2312 | 缺 `utf8=1` | 修复参数或 GBK 解码 |
| HTTP 404（空 body） | 端点不存在（如候选 B） | 换端点，不重试 |
| `musicu.fcg` `req_1.code=500003, subcode=860100001` | 该模块需登录 | 匿名场景下不使用该模块 |
| HTTP 429 / 明显限流文案 | 限流 | 立即停止并退避（本次探测未遇到） |

**重试建议**：仅对网络错误/5xx/超时重试，指数退避（1s→2s→4s，≤3 次）；请求间隔保持 ≥1.5s（实测 1.65s 间隔 × 40 次零限流）。业务码 -1（无效 ID）不重试。

**延迟参考**：小页 0.25-0.4s；500 首/页 0.6s；1000 首/页 0.7s。1240 首按 500/页共 3 页，总耗时约 2-3s（含限速间隔）。

---

## 五、响应字段结构记录（路径清单）

顶层 envelope：

```
{code, subcode, accessed_plaza_cache, accessed_favbase, login, cdnum, cdlist[], realcdnum}
```

`cdlist[0]`（歌单目录，共 44 个字段，PII 相关字段仅列出路径不引用值）：

| 字段路径 | 说明 |
|---|---|
| `disstid` | 歌单 ID（**字符串**，完整；`dissid` 数字字段有 int32 截断，勿用） |
| `dissname`, `desc` | 歌单标题与简介（文本） |
| `songnum`, `total_song_num` | 歌曲总数（两处同值，本次为 1240/102） |
| `songids` | **全量有序 songid 逗号分隔串**（长度==songnum，分页完整性校验基准） |
| `song_begin`, `cur_song_num` | 本页起始（越界时被钳制到 songnum）与本页条数 |
| `songlist[]` | 本页曲目数组 |
| `tags[]`, `ctime`, `mtime`, `song_update_time`, `song_update_num` | 标签、创建/修改时间、最近更新 |
| `logo`, `pic_mid`, `coveradurl`, `dir_pic_url2`, `pic_dpi`, `ifpicurl`, `headurl` | 封面/头像资源字段（不引用值） |
| `nick`, `nickname`, `uin`, `encrypt_uin`, `creator` 类 | 创建者信息（**PII，工具不应输出**） |
| `visitnum`, `cmtnum`, `buynum`, `scoreavage`, `scoreusercount`, `isvip`, `isdj`, `disstype`, `type`, `dir_show`, `owndir`, `dirid`, `singerid/singermid` 等 | 统计与分类元数据 |

`songlist[i]`（曲目，字段齐全，本次实测路径）：

| 字段路径 | 说明（可用性判断相关） |
|---|---|
| `songname` | 歌名 |
| `singer[]: {id, mid, name}` | 歌手数组（可多个） |
| `albumname`, `albumid`, `albummid`, `albumdesc` | 专辑 |
| `songid`（数字）, `songmid`（字符串）, `strMediaMid`, `type`, `songtype`, `alertid`, `msgid`, `label`, `songorig`, `isonly`, `belongCD`, `cdIdx`, `stream`, `rate`, `preview`, `vid` | 标识与杂项 |
| `interval` | 时长（秒） |
| `pay: {payalbum, payalbumprice, paydownload, payinfo, payplay, paytrackmouth, paytrackprice, timefree}` | **付费/可用性判断核心**：`payplay` 0=可免费播 / 1=需付费或会员 |
| `switch`（位掩码数字） | 权限位（实测在 1240 首中呈两种模式：低位 "1000"×561 与 "1100"×679；与 payplay 分布相关但不完全等同，语义未逐一确证） |
| `size128, size320, sizeflac, sizeape, sizeogg, size5_1` | 各音质资产字节数（可作资源存在性信号） |

**可用性字段分布实测**（大歌单 A 全部 1240 首）：`pay.payplay`：0→692 首、1→548 首；`size320==0` 12 首（无损/320 资产缺失但 128 存在）；`songid==0`、`songmid` 空、`interval==0`、`size128==0` 均 0 首。即本次样本中没有"已下架/完全不可用"的曲目，下架判别阈值**未获得实证**（见风险节）。

**缺失字段时的表现**：省略 `type=1` → `cdlist[0]` 出现但 `songlist`/`cur_song_num` 缺失；`song_num` 超过剩余数量 → 正常短页；未观察到字段级 null 的新形状（无效 ID 直接进入错误 envelope）。

---

## 六、合成 fixture 骨架（字段路径真实，值全部合成）

### fixture 1：成功页（song_begin=0，短页示范）

```json
{
  "code": 0,
  "subcode": 0,
  "accessed_plaza_cache": 0,
  "accessed_favbase": 0,
  "login": "off**",
  "cdnum": 1,
  "realcdnum": 1,
  "cdlist": [
    {
      "disstid": "10000000001",
      "dissid": 0,
      "dissname": "合成测试歌单甲",
      "nick": "（PII-略）",
      "songnum": 3,
      "total_song_num": 3,
      "song_begin": 0,
      "cur_song_num": 2,
      "songids": "9000001,9000002,9000003",
      "song_update_time": 1700000000,
      "song_update_num": 0,
      "tags": ["合成标签A", "合成标签B"],
      "songlist": [
        {
          "songid": 9000001,
          "songmid": "00SYNTHETIC00AAAA",
          "strMediaMid": "00SYNMEDIA00AAAA",
          "songname": "测试曲目一",
          "singer": [ { "id": 100, "mid": "00SINGER00AAAA", "name": "歌手甲" } ],
          "albumname": "合成专辑一",
          "albumid": 5001,
          "albummid": "00ALBUM00AAAAA",
          "interval": 240,
          "pay": { "payalbum": 0, "payalbumprice": 0, "paydownload": 1, "payinfo": 1,
                   "payplay": 0, "paytrackmouth": 1, "paytrackprice": 0, "timefree": 0 },
          "switch": 16824361,
          "size128": 3800000, "size320": 9500000, "sizeflac": 31000000,
          "sizeape": 0, "sizeogg": 0, "size5_1": 0,
          "vid": "", "isonly": 0, "songtype": 0, "type": 0,
          "belongCD": 0, "cdIdx": 0, "msgid": 16, "alertid": 2, "label": 0,
          "songorig": "合成来源一", "stream": 1, "rate": 0, "preview": { "trybegin": 0, "tryend": 0, "trysize": 0 },
          "albumdesc": "", "filename": "00SYNTHETIC00AAAA"
        },
        {
          "songid": 9000002,
          "songmid": "00SYNTHETIC00BBBB",
          "strMediaMid": "00SYNMEDIA00BBBB",
          "songname": "测试曲目二",
          "singer": [ { "id": 101, "mid": "00SINGER00BBBB", "name": "歌手乙" },
                       { "id": 102, "mid": "00SINGER00CCCC", "name": "歌手丙" } ],
          "albumname": "合成专辑二",
          "albumid": 5002,
          "albummid": "00ALBUM00BBBBB",
          "interval": 198,
          "pay": { "payalbum": 1, "payalbumprice": 1000, "paydownload": 1, "payinfo": 1,
                   "payplay": 1, "paytrackmouth": 1, "paytrackprice": 200, "timefree": 0 },
          "switch": 16904297,
          "size128": 3200000, "size320": 8000000, "sizeflac": 0,
          "sizeape": 0, "sizeogg": 0, "size5_1": 0,
          "vid": "", "isonly": 1, "songtype": 0, "type": 0,
          "belongCD": 0, "cdIdx": 1, "msgid": 16, "alertid": 2, "label": 0,
          "songorig": "合成来源二", "stream": 1, "rate": 0, "preview": { "trybegin": 0, "tryend": 0, "trysize": 0 },
          "albumdesc": "", "filename": "00SYNTHETIC00BBBB"
        }
      ]
    }
  ]
}
```

### fixture 2：终止页（song_begin == songnum，空 songlist）

```json
{
  "code": 0,
  "subcode": 0,
  "accessed_plaza_cache": 0,
  "accessed_favbase": 0,
  "login": "off**",
  "cdnum": 1,
  "realcdnum": 1,
  "cdlist": [
    {
      "disstid": "10000000001",
      "dissid": 0,
      "songnum": 3,
      "total_song_num": 3,
      "song_begin": 3,
      "cur_song_num": 0,
      "songids": "9000001,9000002,9000003",
      "songlist": []
    }
  ]
}
```

（真实行为：请求 begin 超过 songnum 时，回显的 `song_begin` 会被钳制到 songnum。）

### fixture 3：错误 envelope（无效 disstid / 缺 Referer）

```json
// 无效 disstid（HTTP 仍为 200！）
{
  "code": -1,
  "subcode": 0,
  "accessed_plaza_cache": 0,
  "accessed_favbase": 0,
  "login": "off**",
  "cdnum": 0,
  "cdlist": [],
  "realcdnum": 0
}

// 缺失/非法 Referer（HTTP 200，body 仅这一层）
{
  "code": 0,
  "subcode": 1,
  "msg": "invalid referer"
}
```

---

## 七、未验证项与风险

1. **"已下架/完全不可用"曲目的字段特征未实证**：样本歌单中不存在 `songid==0`、`interval==0`、`size128==0` 的曲目。`pay.payplay=1`（付费）与"不可用（灰色）"是两回事，导出工具对"不可用"的判定需在遇到真实下架曲目后再校准（候选信号：`songid==0`、`size128==0` 且 `interval==0`、`switch` 特定位），当前只能给出**启发式**。
2. **页大小 >1000 未测**：实测 1000 完全被尊重；1000 以上未测，也不建议使用（单包过大）。
3. **song_num 极大值/异常值**（0、负数、超大）的服务器行为未系统测试；Provider 应固定使用 300-1000 档。
4. **限流阈值未知**：1.65s 间隔 × 40 次无任何限流，但突发高频（<500ms 间隔）行为未测。导出时应保持 ≥1.5s 间隔并保留 429 退避逻辑。
5. **候选 A（musicu.fcg GetPlaylistDetail）的 500003**：未穷尽所有 comm 组合（如带 qimei36 的设备指纹）；若未来需要"只取元数据/目录"等能力可重开验证，但匿名分页场景已有 B2 完全满足。
6. **稳定性风险**：B2 属于老 qzone 系端点（候选 B 同族端点已 404），存在未来下线风险；建议 Provider 对端点做可配置化，并把 `songids` 全序校验作为防截断的持续哨兵。
7. **创建者 PII**（nick/nickname/uin/headurl 等）会随响应返回：工具实现时必须显式丢弃，不得写入导出文件。
8. **`dissid` int32 截断**：任何把 `dissid`（数字）当作歌单 ID 回用的实现都会得到错误 ID；只能用 `disstid`（字符串）。

---

## 附录：探测请求日志（40 条，脱敏：无任何 Cookie/凭证头；仅列关键头）

| # | 方法 | 端点/URL 摘要 | 关键请求头 | 状态 | 结果摘要 |
|---|---|---|---|---|---|
| 1 | GET | `y.qq.com/n/ryqq_v2/category` | UA, Accept | 200 | HTML 48.9KB，提取 20 个真实 disstid |
| 2 | POST | `u.y.qq.com/cgi-bin/musicu.fcg` plaza `get_playlist_by_category` id=10000000 | CT, Referer, Origin, UA | 200 | code 0，`total:0` 空列表 |
| 3 | POST | musicu.fcg `GetPlaylistDetail` ct24 onlysonglist=1 n=10 | CT, Referer, Origin, UA | 200 | `req_1.code=500003, subcode=860100001` |
| 4 | POST | 同上 onlysonglist=0 | 同上 | 200 | 500003 |
| 5 | GET | `c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_iids_df.fcg`（候选 B） | Referer, UA | **404** | 端点废弃 |
| 6 | POST | A + comm ct19/cv1873 + 歌单页 Referer | 同上 | 200 | 500003 |
| 7 | POST | A + disstid 字符串 | 同上 | 200 | 500003 |
| 8 | GET | A 的 `?format=json&data=` GET 形式 | Referer, UA | 200 | 500003 |
| 9 | GET | **B2** `i.y.qq.com/qzone-music/fcg_ucc_getcdinfo_byids_cp.fcg` type=1 n=10（歌单 9587287911，102 首） | Referer, UA | 200 | code 0，cdlist[0] songnum=102 cur=10（GBK 编码） |
| 10 | GET | B2 + `utf8=1&outCharset=utf-8` n=2 | Referer, UA | 200 | charset=utf-8，中文正常 |
| 11 | POST | 搜索 type=1 "1000首" | CT, Referer, Origin, UA | 200 | `meta.sum=0`，无结果 |
| 12 | POST | 搜索 type=3 "经典老歌" | 同上 | 200 | sum=0，无结果 |
| 13 | POST | A + comm uin/wid | 同上 | 200 | 500003（A 最终判死） |
| 14 | POST | plaza id=3316 size=30 | CT, Referer, Origin, UA | 200 | 9 条编辑精选（tid+song_ids），均 <100 首 |
| 15-17 | GET | B2 numprobe ×3（song_num=1） | Referer, UA | 200 | songnum=535/263/304 |
| 18 | POST | plaza id=10000000（无 titletype） | 同上 | 200 | total:0 |
| 19 | GET | `c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg` categoryId=10000000 sortId=5 | Referer, UA | 200 | 30 条热门歌单（dissid+listennum） |
| 20 | POST | 搜索 type1 + ct19 "粤语老歌" | 同上 | 200 | sum=192，仅 singer tab |
| 21-28 | GET | B2 numprobe ×8（listennum Top8） | Referer, UA | 200 | 512/90/125/980/**1240**/49/154/511 → 锁定大歌单 A |
| 29-32 | GET | B2 大歌单 A 页大小探测 n=100/300/500/1000 | Referer, UA | 200 | 全额返回；1000→1000 条不截断 |
| 33 | GET | B2 大歌单 A begin=1000 n=1000 | Referer, UA | 200 | 240 条；累计 1240==songnum ✅ |
| 34 | GET | B2 大歌单 A begin=1240 n=1000 | Referer, UA | 200 | 0 条，code 0，干净终止 |
| 35 | GET | B2 disstid=1（无效 ID） | Referer, UA | 200 | 顶层 code=-1，cdlist=[] |
| 36 | GET | B2 小歌单 begin=200（越界） | Referer, UA | 200 | 回显 song_begin=102（钳制），0 条 |
| 37 | GET | B2 **无 Referer** | 仅 UA | 200 | `{"code":0,"subcode":1,"msg":"invalid referer"}` |
| 38 | GET | B2 **仅 Referer 无 UA** | Referer | 200 | 正常返回 → 最小头集合成立 |
| 39 | GET | 歌单详情页 HTML（SSR 交叉核对尝试） | UA, Accept | 200 | JS 壳，无歌曲数据 |
| 40 | GET | B2 省略 `type=1` | Referer, UA | 200 | code 0 但 songlist/cur_song_num 缺失 → type=1 必需 |

临时探测脚本与原始响应存放于系统临时目录（`$TEMP/qq-probe/`，仓库内零改动），报告完成后已全部删除；原始响应中的真实曲目信息未进入本报告。
