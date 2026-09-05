#!/usr/bin/env node
// Docker 冒烟测试：构建镜像 → 以受限配置运行容器 → 验证健康检查、令牌、Origin 白名单
// 与 API 校验层可达性。网络访问仅限被测 base URL；全部使用合成令牌与合成 origin，
// 不携带任何真实凭证，也不发起对真实平台的请求（非法输入在校验层即被拒绝）。
//
// 用法：
//   node scripts/docker-smoke.mjs [选项]
// 选项：
//   --image <name>    镜像名（默认 playlist-exporter:smoke）
//   --skip-build      跳过 docker build，直接使用 --image 指定的已有镜像
//   --base-url <url>  跳过构建与容器管理，只对已运行的服务执行检查矩阵
//                     （例如对远程宿主上按 compose 启动的服务复用同一套检查）
//   --token <token>   与 --base-url 配套的 Bearer 令牌（base-url 模式必填）
//   --help            显示本说明
//
// 检查矩阵（覆盖 04 号问题的端口/origin/令牌组合）：
//   1. /healthz 返回 200 且 status=ok
//   2. 合法 Origin + 无令牌        → 401 AUTH_REQUIRED
//   3. 合法 Origin + 错误令牌      → 401 AUTH_REQUIRED
//   4. 非法 Origin + 正确令牌      → 403 ORIGIN_NOT_ALLOWED
//   5. 合法 Origin + 正确令牌 + 未知 provider（schema 校验层）→ 400 INVALID_REQUEST
//   6. 合法 Origin + 正确令牌 + 非法歌单输入（provider 校验层）→ 400 INVALID_PLAYLIST_INPUT
//   7. localhost origin 变体同样被白名单接受 → 400 INVALID_REQUEST
//   （默认运行会先以随机空闲宿主端口验证"自定义宿主端口"，再尝试以 4319 复现
//    compose 默认映射；4319 被占用时跳过并明确记录，不算失败。）
//
// 脚本结构：容器/镜像管理（build/run/清理）与"对 base URL 的检查项"完全分离，
// 检查矩阵由纯函数 buildCheckPlan 生成，便于在无 Docker 的宿主上单独复用。
// 容器生命周期（F1 修复）：每次运行使用唯一容器名（playlist-exporter-smoke-<8位随机hex>，
// 两轮 run 各自唯一），docker run -d 成功后从 stdout 取容器 ID 并立即登记清理；
// run 失败（如名称冲突）不登记任何清理目标，finally 只按容器 ID 清理本次创建的容器，
// 绝不按名称猜测所有权。runDocker 失败详情中的敏感环境变量值经 redactDockerArgs 脱敏。
// runMain 的依赖（spawnSync/fetch/端口探测/健康检查节奏）均为可注入参数，
// 默认值即真实实现，便于在无 Docker 的宿主上做内存级回归测试。

import { spawnSync as spawnSyncNode } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_IMAGE = 'playlist-exporter:smoke';
const CONTAINER_NAME_PREFIX = 'playlist-exporter-smoke-';
const DEFAULT_HOST_PORT = 4319;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
// 合成非法输入：既不匹配网易云歌单 ID（^[1-9]\d{0,19}$）也不是合法 URL，
// 一定在 provider 本地校验层被拒绝，绝不触发对真实平台的网络请求。
export const SYNTHETIC_INVALID_PLAYLIST_INPUT = '合成冒烟测试-无效输入-非 URL-非数字 ID';
// 合成未知 provider：contracts 的 providerIdSchema 是固定枚举，schema 层即拒绝。
export const SYNTHETIC_UNKNOWN_PROVIDER = 'example-invalid-provider';
const FOREIGN_ORIGIN = 'https://evil.example';

export class SmokeError extends Error {
  constructor(step, message) {
    super(`[${step}] ${message}`);
    this.name = 'SmokeError';
    this.step = step;
  }
}

const fail = (step, message) => {
  process.stderr.write(`[docker-smoke] ✗ ${step} 失败: ${message}\n`);
  process.exitCode = 1;
  throw new SmokeError(step, message);
};

// ---------- 纯逻辑：参数解析与检查矩阵构造（可被单独单测） ----------

export const parseArgs = (argv) => {
  const args = {
    image: DEFAULT_IMAGE,
    skipBuild: false,
    baseUrl: undefined,
    token: undefined,
    help: false,
  };
  const readValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value === '') {
      throw new SmokeError('arguments', `选项 ${flag} 需要一个参数值`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--image':
        args.image = readValue(flag, index);
        index += 1;
        break;
      case '--skip-build':
        args.skipBuild = true;
        break;
      case '--base-url':
        args.baseUrl = readValue(flag, index);
        index += 1;
        break;
      case '--token':
        args.token = readValue(flag, index);
        index += 1;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new SmokeError('arguments', `未知选项 ${flag}（使用 --help 查看用法）`);
    }
  }
  if (args.baseUrl !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new URL(args.baseUrl);
    } catch {
      throw new SmokeError('arguments', `--base-url 不是合法 URL: ${args.baseUrl}`);
    }
    if (args.token === undefined || args.token === '') {
      throw new SmokeError('arguments', 'base-url 模式必须同时提供 --token（被测服务的 Bearer 令牌）');
    }
  }
  return args;
};

// 由一个合法 origin 推导 loopback 变体（127.0.0.1 ⇄ localhost）；
// 非 loopback 主机无法推断变体，只返回自身。
export const withLoopbackVariants = (origin) => {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new SmokeError('arguments', `origin 不是合法 URL: ${origin}`);
  }
  const variants = [url.origin];
  const port = url.port === '' ? '' : `:${url.port}`;
  if (url.hostname === '127.0.0.1') variants.push(`http://localhost${port}`);
  if (url.hostname === 'localhost') variants.push(`http://127.0.0.1${port}`);
  return [...new Set(variants)];
};

const INSPECT_PATH = '/api/playlists/inspect';

// 生成对单个服务的检查计划。所有请求体都是"到达校验层即被拒绝"的合成输入，
// 即使服务端配置失误也不会触发对真实平台的访问。
export const buildCheckPlan = ({ token, legalOrigins, foreignOrigin = FOREIGN_ORIGIN }) => {
  if (legalOrigins === undefined || legalOrigins.length === 0) {
    throw new SmokeError('check-plan', 'legalOrigins 不能为空');
  }
  if (token === undefined || token === '') {
    throw new SmokeError('check-plan', 'token 不能为空');
  }
  const origin = legalOrigins[0];
  const post = (headers, body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const neteaseBody = { provider: 'netease', input: { value: SYNTHETIC_INVALID_PLAYLIST_INPUT } };
  const unknownProviderBody = { provider: SYNTHETIC_UNKNOWN_PROVIDER, input: { value: SYNTHETIC_INVALID_PLAYLIST_INPUT } };
  const plan = [
    {
      name: 'healthz',
      detail: 'GET /healthz 返回 200 且 status=ok',
      request: { path: '/healthz', init: { method: 'GET' } },
      expect: { status: 200, code: undefined },
    },
    {
      name: 'auth-required',
      detail: '合法 Origin + 无令牌 → 401 AUTH_REQUIRED',
      request: { path: INSPECT_PATH, init: post({ origin }, neteaseBody) },
      expect: { status: 401, code: 'AUTH_REQUIRED' },
    },
    {
      name: 'wrong-token',
      detail: '合法 Origin + 错误令牌 → 401 AUTH_REQUIRED',
      request: {
        path: INSPECT_PATH,
        init: post({ origin, authorization: `Bearer wrong-${randomBytes(8).toString('hex')}` }, neteaseBody),
      },
      expect: { status: 401, code: 'AUTH_REQUIRED' },
    },
    {
      name: 'origin-not-allowed',
      detail: '非法 Origin + 正确令牌 → 403 ORIGIN_NOT_ALLOWED',
      request: {
        path: INSPECT_PATH,
        init: post({ origin: foreignOrigin, authorization: `Bearer ${token}` }, neteaseBody),
      },
      expect: { status: 403, code: 'ORIGIN_NOT_ALLOWED' },
    },
    {
      name: 'validation-schema-reached',
      detail: '合法 Origin + 正确令牌 + 未知 provider → 400 INVALID_REQUEST（schema 校验层，零出站）',
      request: {
        path: INSPECT_PATH,
        init: post({ origin, authorization: `Bearer ${token}` }, unknownProviderBody),
      },
      expect: { status: 400, code: 'INVALID_REQUEST' },
    },
    {
      name: 'validation-input-reached',
      detail: '合法 Origin + 正确令牌 + 非法歌单输入 → 400 INVALID_PLAYLIST_INPUT（provider 校验层，零出站）',
      request: { path: INSPECT_PATH, init: post({ origin, authorization: `Bearer ${token}` }, neteaseBody) },
      expect: { status: 400, code: 'INVALID_PLAYLIST_INPUT' },
    },
  ];
  if (legalOrigins.length > 1) {
    plan.push({
      name: 'loopback-variant-accepted',
      detail: `loopback origin 变体 ${legalOrigins[1]} 同样在白名单内 → 400 INVALID_REQUEST`,
      request: {
        path: INSPECT_PATH,
        init: post({ origin: legalOrigins[1], authorization: `Bearer ${token}` }, unknownProviderBody),
      },
      expect: { status: 400, code: 'INVALID_REQUEST' },
    });
  }
  return plan;
};

// ---------- 检查执行：只依赖 base URL，不依赖 Docker ----------

export const runChecks = async ({ baseUrl, token, legalOrigins, fetch: fetchImpl = globalThis.fetch }) => {
  const results = [];
  const plan = buildCheckPlan({ token, legalOrigins });
  for (const check of plan) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${check.request.path}`, {
        ...check.request.init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      fail(check.name, `请求 ${check.request.path} 异常: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rawBody = await response.text();
    let bodyJson;
    try {
      bodyJson = JSON.parse(rawBody);
    } catch {
      bodyJson = undefined;
    }
    if (response.status !== check.expect.status) {
      fail(check.name, `${check.request.path} 期望 HTTP ${check.expect.status}，实际 ${response.status}。响应: ${rawBody.slice(0, 300)}`);
    }
    if (check.expect.code !== undefined && bodyJson?.code !== check.expect.code) {
      fail(check.name, `${check.request.path} 期望错误码 ${check.expect.code}，实际 ${bodyJson?.code ?? '（无 code 字段）'}。响应: ${rawBody.slice(0, 300)}`);
    }
    results.push({
      step: check.name,
      ok: true,
      detail: `${check.detail}；实际 HTTP ${response.status}${check.expect.code === undefined ? '' : ` code=${bodyJson?.code}`}`,
    });
    process.stdout.write(`[docker-smoke] ✓ ${check.name}: HTTP ${response.status}${check.expect.code === undefined ? '' : ` (${bodyJson?.code})`}\n`);
  }
  return results;
};

const waitForHealth = async ({
  baseUrl,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_INTERVAL_MS,
}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = '尚未尝试';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.status === 'ok') return body;
        lastError = `/healthz 返回非 ok 状态: ${JSON.stringify(body)}`;
      } else {
        lastError = `/healthz 返回 HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = `/healthz 请求异常: ${error instanceof Error ? error.message : String(error)}`;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs));
  }
  fail('healthz', `等待 ${timeoutMs / 1000}s 后仍未通过健康检查。最后错误: ${lastError}`);
};

// ---------- Docker 编排：构建 / 运行 / 清理 ----------

// docker 命令失败时会把参数拼进错误信息；-e/--env 之后的敏感 KEY=VALUE
// 必须把值替换为 [REDACTED] 后才允许进入日志（纯函数，便于单测）。
const REDACTED = '[REDACTED]';
const SENSITIVE_ENV_KEYS = new Set(['ACCESS_TOKEN', 'APPLE_DEVELOPER_TOKEN']);

export const redactDockerArgs = (args) => args.map((arg, index) => {
  const previous = index > 0 ? args[index - 1] : undefined;
  if (previous !== '-e' && previous !== '--env') return arg;
  const separator = arg.indexOf('=');
  if (separator <= 0) return arg;
  const key = arg.slice(0, separator);
  if (!SENSITIVE_ENV_KEYS.has(key)) return arg;
  return `${key}=${REDACTED}`;
});

const runDocker = (step, args, { capture = false, spawnSync = spawnSyncNode } = {}) => {
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...(capture ? {} : { stdio: ['ignore', 'inherit', 'inherit'] }),
  });
  if (result.error !== undefined) {
    fail(step, `无法执行 docker 命令（${result.error.code ?? result.error.message}）。` +
      '请确认 Docker Desktop/Engine 已安装并正在运行；若只需对已运行的服务执行检查，' +
      '可使用: node scripts/docker-smoke.mjs --base-url <url> --token <token>');
  }
  if (result.status !== 0) {
    const detail = capture ? `\nstdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}` :
      '（详见上方 docker 输出）';
    fail(step, `docker ${redactDockerArgs(args).join(' ')} 退出码 ${result.status}。${detail}`);
  }
  return result;
};

// 探测 host:port 是否可绑定；port 省略时由系统分配空闲端口。不可绑定返回 null。
const probeBindablePort = (port = 0) => new Promise((resolveProbe) => {
  const probe = createServer();
  probe.once('error', () => resolveProbe(null));
  probe.listen(port, '127.0.0.1', () => {
    const boundPort = probe.address().port;
    probe.close(() => resolveProbe(boundPort));
  });
});

// 每次运行生成唯一容器名（8 位随机 hex 后缀），两轮 run 各自唯一，
// 不与既有容器或并行烟测争名；所有权以"本次 run 返回的容器 ID"为准，而非名称。
const generateContainerName = () => `${CONTAINER_NAME_PREFIX}${randomBytes(4).toString('hex')}`;

const runSmokeContainer = async ({
  label,
  containerName,
  hostPort,
  image,
  spawnSync,
  fetch: fetchImpl,
  onContainerCreated,
  healthTimeoutMs,
  healthIntervalMs,
}) => {
  const token = randomBytes(32).toString('hex');
  // 与 docker-compose.yml 的派生规则一致：宿主映射端口对应的 127.0.0.1/localhost origin。
  const legalOrigins = withLoopbackVariants(`http://127.0.0.1:${hostPort}`);
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  const runResult = runDocker('docker-run', [
    'run', '-d', '--rm',
    '--name', containerName,
    '-p', `127.0.0.1:${hostPort}:4319`,
    '-e', 'HOST=0.0.0.0',
    '-e', 'PORT=4319',
    '-e', 'WEB_DIST=/app/web/dist',
    '-e', `ACCESS_TOKEN=${token}`,
    '-e', `ALLOWED_ORIGINS=${legalOrigins.join(',')}`,
    '--read-only',
    '--tmpfs', '/tmp:size=16m,mode=1777',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    image,
  ], { capture: true, spawnSync });
  // 只登记"本次调用成功创建"的容器：以 docker run -d 输出的容器 ID 为准，
  // 登记之后才继续健康检查。run 失败（含名称冲突）不会走到这里，
  // 清理队列保持为零，不会触碰任何既有容器。
  const runStdout = typeof runResult.stdout === 'string' ? runResult.stdout.trim() : '';
  const containerId = runStdout.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{8,64}$/i.test(containerId)) {
    fail('docker-run', `docker run -d 成功但未返回合法容器 ID（stdout: ${runStdout.slice(0, 64) || '（空）'}），` +
      '本次不登记任何清理目标');
  }
  onContainerCreated({ label, containerId });
  process.stdout.write(`[docker-smoke] 容器已启动: 场景=${label} name=${containerName} id=${containerId} @ ${baseUrl}\n`);
  const health = await waitForHealth({
    baseUrl,
    fetch: fetchImpl,
    timeoutMs: healthTimeoutMs,
    intervalMs: healthIntervalMs,
  });
  process.stdout.write(`[docker-smoke] 健康检查通过: ${JSON.stringify(health)}\n`);
  const checks = await runChecks({ baseUrl, token, legalOrigins, fetch: fetchImpl });
  return { label, containerName, containerId, baseUrl, hostPort, checks };
};

const printUsage = () => {
  process.stdout.write(`用法: node scripts/docker-smoke.mjs [选项]

选项:
  --image <name>    镜像名（默认 ${DEFAULT_IMAGE}）
  --skip-build      跳过 docker build，直接使用 --image 指定的已有镜像
  --base-url <url>  跳过构建与容器管理，只对已运行的服务执行检查矩阵
  --token <token>   与 --base-url 配套的 Bearer 令牌（base-url 模式必填）
  --help            显示本说明
`);
};

// ---------- 入口 ----------

// 依赖均可注入（默认值即真实实现）：spawnSync/fetch/端口探测与健康检查节奏，
// 便于在无 Docker 的宿主上以内存 mock 复现缺陷并做回归测试。
export const runMain = async ({
  argv = process.argv.slice(2),
  spawnSync = spawnSyncNode,
  fetch: fetchImpl = globalThis.fetch,
  probePort = probeBindablePort,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
  healthIntervalMs = HEALTH_INTERVAL_MS,
} = {}) => {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[docker-smoke] ✗ 参数错误: ${error instanceof Error ? error.message : String(error)}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printUsage();
    return;
  }

  // base-url 模式：不触碰 Docker，直接对已运行的服务执行检查矩阵（可复用于远程宿主）。
  if (args.baseUrl !== undefined) {
    const url = new URL(args.baseUrl);
    const legalOrigins = withLoopbackVariants(url.origin);
    const checks = await runChecks({ baseUrl: url.origin, token: args.token, legalOrigins, fetch: fetchImpl });
    process.stdout.write(`\n${JSON.stringify({ ok: true, mode: 'base-url', baseUrl: url.origin, checks }, null, 2)}\n`);
    process.stdout.write('[docker-smoke] 全部检查通过。\n');
    return;
  }

  const startedAt = new Date().toISOString();
  const runs = [];
  const skipped = [];
  // 清理登记：只包含"本次调用成功创建且已记录容器 ID"的容器；
  // docker run 失败（如名称冲突）时保持为零，绝不按名称清理既有容器。
  const cleanupRegistry = [];
  const onContainerCreated = ({ label, containerId }) => {
    cleanupRegistry.push({ label, containerId });
  };

  try {
    // 1. Docker 可用性（缺失时给出明确报错并以非零码退出）。
    const version = runDocker('docker-version', ['version', '--format', '{{.Server.Version}}'], { capture: true, spawnSync });
    const dockerServerVersion = version.stdout.trim();
    process.stdout.write(`[docker-smoke] Docker Server 版本: ${dockerServerVersion}\n`);

    // 2. 构建镜像（--skip-build 时跳过，使用已有镜像）。
    if (!args.skipBuild) {
      runDocker('docker-build', ['build', '-t', args.image, '.'], { spawnSync });
      process.stdout.write(`[docker-smoke] 镜像构建完成: ${args.image}\n`);
    } else {
      process.stdout.write(`[docker-smoke] 跳过构建，使用已有镜像: ${args.image}\n`);
    }

    // 3. 运行一：自定义宿主端口（随机空闲端口），覆盖"自定义宿主端口 + origin 派生"矩阵。
    const customPort = await probePort();
    if (customPort === null) throw new SmokeError('port-probe', '无法分配空闲的回环端口');
    runs.push(await runSmokeContainer({
      label: 'custom-port',
      containerName: generateContainerName(),
      hostPort: customPort,
      image: args.image,
      spawnSync,
      fetch: fetchImpl,
      onContainerCreated,
      healthTimeoutMs,
      healthIntervalMs,
    }));

    // 4. 运行二：复现 compose 默认映射（宿主端口 4319）。端口被占用时跳过并记录，不算失败。
    const defaultPort = await probePort(DEFAULT_HOST_PORT);
    if (defaultPort === DEFAULT_HOST_PORT) {
      runs.push(await runSmokeContainer({
        label: 'default-port',
        containerName: generateContainerName(),
        hostPort: DEFAULT_HOST_PORT,
        image: args.image,
        spawnSync,
        fetch: fetchImpl,
        onContainerCreated,
        healthTimeoutMs,
        healthIntervalMs,
      }));
    } else {
      skipped.push({
        step: 'default-port-run',
        reason: `宿主端口 ${DEFAULT_HOST_PORT} 已被占用，跳过默认端口场景（不算失败；` +
          '如需覆盖请释放端口后重跑，或用 --base-url 对现有服务执行检查）',
      });
      process.stdout.write(`[docker-smoke] ⚠ 跳过默认端口场景: ${skipped[0]?.reason ?? ''}\n`);
    }

    process.stdout.write(`\n${JSON.stringify({
      ok: true,
      mode: args.skipBuild ? 'existing-image' : 'build-and-run',
      image: args.image,
      startedAt,
      dockerServerVersion,
      runs,
      skipped,
    }, null, 2)}\n`);
    process.stdout.write('[docker-smoke] 全部检查通过。\n');
  } finally {
    // 只按容器 ID 清理本次创建并登记的容器；清理失败仅告警并给出手动提示，
    // 不影响其余容器的清理，也不改变主流程的退出码语义。
    for (const { label, containerId } of cleanupRegistry) {
      let cleanup;
      try {
        cleanup = spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf8' });
      } catch (error) {
        cleanup = { status: null, error: error instanceof Error ? error : new Error(String(error)) };
      }
      if (cleanup.status === 0) {
        process.stdout.write(`[docker-smoke] 已清理容器 场景=${label} id=${containerId}。\n`);
      } else {
        const reason = cleanup.error !== undefined
          ? `（${cleanup.error.code ?? cleanup.error.message}）`
          : `（退出码 ${cleanup.status}）`;
        process.stderr.write(`[docker-smoke] 警告：清理容器 场景=${label} (id=${containerId}) 失败${reason}，` +
          `请手动执行: docker rm -f ${containerId}\n`);
      }
    }
  }
};

// 作为 CLI 运行时执行主流程；被 import 时仅导出纯逻辑，便于单测。
const isMainProcess = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainProcess) {
  await runMain().catch(error => {
    if (!(error instanceof SmokeError)) {
      process.stderr.write(`[docker-smoke] ✗ 未预期错误: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  });
}
