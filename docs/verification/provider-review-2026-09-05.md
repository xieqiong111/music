# Provider / importer 有限审验（2026-09-05）

## 审验范围与证据边界

- 目标工作树：`D:/gpt/2026-09-02/apple-music-qq-utf-8-txt/.worktrees/core-netease-mvp`
- 审验 HEAD：`1d23c53d98e6439823bcf40560f364d05a1302ba`
- 范围：`packages/provider-*` 与 `packages/importers`，本次仅核实已知问题，未扩展为完整项目审查。
- 工作树原有修改仅在 `apps/web` 与 `packages/exporters`，审验期间未触碰；本文件是唯一新增文件。
- GitNexus 工具在当前环境不可用，以下结论来自源码、测试和本地行为探针，不宣称 GitNexus 图审验覆盖。
- 未发起真实歌单请求、未上传、未提交。

## Findings

### P1：Apple 分页遇到官方相对 `next` 必然失败

- 位置：`packages/provider-apple/src/provider.ts:163-175`。
- 证据：`parseNextUrl()` 使用单参数 `new URL(next)`，只接受绝对 URL；`fetchAllPages()` 在 `:356` 对每个 continuation 调用它。Node 行为探针显示 `/v1/catalog/us/playlists/.../tracks?offset=100` 抛 `TypeError: Invalid URL`，而同一地址的绝对形式可解析。
- 影响：Apple 返回相对子路径 `next` 时，分页在发出第二个请求前转为 `PROVIDER_SCHEMA_DRIFT`，因此超过首个页面的歌单无法读取。
- 测试缺口：`packages/provider-apple/test/provider.test.ts:72-74` 的 `nextUrl()` 始终生成绝对 URL；分页用例使用它的 `:148,151`，没有相对 `next` 回归用例。
- 修复建议：用 `new URL(next, API_ORIGIN)` 解析相对路径，保留现有 HTTPS、host、`/v1/catalog/` 路径约束，并补充相对 continuation 测试。

### P2：缺失 `data` 被静默当成空数组，可制造“空且完整”结果

- 位置：`packages/provider-apple/src/schemas.ts:36-42`、`:75-80`；调用处 `packages/provider-apple/src/provider.ts:415-418`。
- 证据：两个 schema 都对缺失/null `data` 使用 `.nullish().transform((value) => value ?? [])`；首屏关系本身也可缺失（`schemas.ts:57-59`），调用处再用 `?? []`。若响应同时缺少 `trackCount` 与 `next`，`fetchAllPages()` 在 `provider.ts:356-375` 正常结束，并在 `:391-395` 返回 `total: 0, complete: true`。下游 `playlistSchema` 允许该形状（`packages/contracts/src/models.ts:45-57`）。
- 影响：格式损坏或字段缺失的响应可能被当作成功的空歌单，造成静默数据丢失，而不是报告 schema drift。
- 测试缺口：现有 provider 测试 63/63 通过，但 fixture 在 `packages/provider-apple/test/provider.test.ts:56-62` 始终提供 `tracks.data`；已有的 `missingData` 用例（`:523-531`）只测顶层 `data` 缺失，不能覆盖关系/续页 `data` 缺失。
- 修复建议：要求响应及 tracks relationship 的 `data` 为数组，移除默认 `[]` 与调用处 `?? []`；若 API 合同允许省略关系，应显式区分该情形，不能默认视为成功空歌单。

### P1：标准 Apple plist 的 DOCTYPE 被整体拒绝

- 位置：`packages/importers/src/apple-xml.ts:152-170`。
- 证据：`rejectBangNode()` 对 `<!DOCTYPE ...>` 直接抛 `IMPORT_XML_DOCTYPE_FORBIDDEN`。测试 fixture 在 `packages/importers/test/fixtures.ts:138-155` 生成标准 Apple plist 公共 DOCTYPE：`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`；测试 `packages/importers/test/apple-xml.test.ts:138-148` 确认带该声明的输入被拒绝。
- 影响：包含标准 DOCTYPE 的 Apple/iTunes plist 导出文件无法导入；XXE 防护直接变成格式兼容性阻断。
- 修复建议：安全接受已知 plist DOCTYPE（仅跳过声明，不解析或加载外部实体，并拒绝内部实体子集），或采用关闭外部实体解析的 XML 库；增加带标准 DOCTYPE 的成功导入回归测试。

## 验证结果

- `pnpm --filter @playlist-exporter/provider-apple test -- --reporter=dot`：3 个测试文件、63/63 通过。
- `pnpm --filter @playlist-exporter/importers test -- --reporter=dot`：4 个测试文件、58/58 通过。
- `pnpm --filter @playlist-exporter/provider-apple typecheck`：通过。
- `pnpm --filter @playlist-exporter/importers typecheck`：通过。

测试全绿不抵消上述问题：现有 fixture 分别使用绝对 `next`、始终提供 `data`，并把 DOCTYPE 拒绝行为固化为预期。
