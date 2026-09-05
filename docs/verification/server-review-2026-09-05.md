# Server 有限安全审查记录（2026-09-05）

本记录覆盖 `apps/server`、`packages/core`、`packages/contracts` 的有限只读审查，重点为 CORS/Origin、任务 TTL、出站边界和错误脱敏。

## 审查基线

- 目标分支：`codex/core-netease-mvp`
- 审查 HEAD：`1d23c53d98e6439823bcf40560f364d05a1302ba`
- 对比基线：本地 `main`，`d63dfe86df1a59ae739599ea4c9b68bc2bf66834`
- 当前 worktree 另有 `apps/web` 与 `packages/exporters` 未提交改动；本记录仅针对上述服务端/核心范围。
- `apps/server` 行号以下均按审查 HEAD 记录。`apps/web/src/api.ts` 在当前工作树有未提交改动，引用行号可能随修改偏移。

## Findings

### P2：跨源导出无法读取文件名和导出元数据

- 位置：`apps/server/src/app.ts:298-313`
- 触发场景：PWA 与 API 使用不同 origin（例如 Vite preview 的 `http://127.0.0.1:4321` 请求 `http://127.0.0.1:4319`），且该 origin 已在白名单中。
- 证据：导出响应返回 `Content-Disposition` 及 `X-Export-*` 响应头，但没有 `Access-Control-Expose-Headers`。浏览器跨源 fetch 不能读取这些非 safelist 响应头；客户端 `apps/web/src/api.ts:216` 的 `response.headers.get('content-disposition')` 因而得到 `null`，`safeFilename()` 会回退到 `playlist.txt`。导出字节本身仍可读取；同源部署不受影响。
- 覆盖缺口：`apps/server/test/api.test.ts:158-190` 直接检查 Hono Response，不模拟浏览器的 CORS 响应头可见性。
- 修复建议：在导出响应加入 `Access-Control-Expose-Headers: Content-Disposition`；若客户端需要导出诊断字段，再暴露实际使用的 `X-Export-*` 头，并增加跨源响应头契约测试。

### P2：TTL 过期后 `getCompletedResult()` 仍返回已删除结果

- 位置：`apps/server/src/jobs.ts:235-240`；过期删除逻辑位于 `apps/server/src/jobs.ts:125-129`。
- 触发场景：已完成任务达到 `terminalTtlMs` 后调用 `getCompletedResult(jobId)`。`deleteIfExpired(record)` 会从 `records` 删除条目，但函数随后仍读取本地 `record` 并返回 `record.result`。此外，`apps/server/src/app.ts:274` 的 `jobs.get()` 与 `:282` 的 `getCompletedResult()` 分两次调用，跨过 TTL 边界时存在窄窗口，可能仍生成导出文件。
- 影响：违反“任务结果随 TTL 失效”的内存保留契约，过期歌单元数据仍可被内部调用方取得；API 路径在两个同步调用之间跨过过期边界时也可能导出。
- 覆盖缺口：`apps/server/test/jobs.test.ts:119-137` 只验证过期后 `get()` 返回 `undefined`，没有验证过期后 `getCompletedResult()` 必须返回 `undefined`，也没有覆盖导出边界。
- 修复建议：让 `deleteIfExpired` 返回是否删除，删除后立即返回 `undefined`（或重新检查 `records.has(jobId)`）；增加过期后结果访问和 API TTL 边界测试。

## 验证结果

- `pnpm --filter @playlist-exporter/server exec vitest run`：7 个测试文件、66 个用例通过。
- `pnpm --filter @playlist-exporter/core exec vitest run`：6 个测试文件、58 个用例通过。
- `pnpm --filter @playlist-exporter/contracts exec vitest run`：4 个测试文件、17 个用例通过。
- 未发送真实歌单请求，未改动源码，未提交代码。
- GitNexus runner/CLI 在目标 worktree 不可用，未执行图谱/taint pass；本记录以 diff 与源码证据为准。

## 范围说明

本记录是有限审查，不替代完整 PR 审查。Origin 鉴权、egress 和错误脱敏已做源码级抽查，但未在本轮形成额外完整 verdict；应将其视为待后续专门审查的范围。
