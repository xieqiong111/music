#!/usr/bin/env node
// Docker 冒烟测试：构建镜像 → 以受限配置运行容器 → 验证健康检查与 API 安全边界。
// 网络访问仅限 127.0.0.1；任何一步失败都会输出明确 stderr 信息并以非零退出码结束。
//
// 用法：node scripts/docker-smoke.mjs

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'playlist-exporter:smoke';
const CONTAINER = 'playlist-exporter-smoke';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 1_000;

// 宿主机侧端口（脚本只会访问 127.0.0.1）。
let port = 0;

const fail = (step, message) => {
  process.stderr.write(`[docker-smoke] ✗ ${step} 失败: ${message}\n`);
  process.exitCode = 1;
  throw new Error(`step-failed: ${step}`);
};

const runDocker = (step, args, { capture = false } = {}) => {
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...(capture ? {} : { stdio: ['ignore', 'inherit', 'inherit'] }),
  });
  if (result.error !== undefined) {
    fail(step, `无法执行 docker 命令（${result.error.code ?? result.error.message}）。` +
      '请确认 Docker Desktop/Engine 已安装并正在运行。');
  }
  if (result.status !== 0) {
    const detail = capture ? `\nstdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}` :
      '（详见上方 docker 输出）';
    fail(step, `docker ${args.join(' ')} 退出码 ${result.status}。${detail}`);
  }
  return result;
};

const getFreeLoopbackPort = async () => {
  await new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      port = probe.address().port;
      probe.close(() => resolvePort());
    });
  });
  return port;
};

const fetchLocal = async (path, init) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  return response;
};

const waitForHealth = async () => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = '尚未尝试';
  while (Date.now() < deadline) {
    try {
      const response = await fetchLocal('/healthz');
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
    await new Promise(resolveWait => setTimeout(resolveWait, HEALTH_INTERVAL_MS));
  }
  fail('healthz', `等待 ${HEALTH_TIMEOUT_MS / 1000}s 后仍未通过健康检查。最后错误: ${lastError}`);
};

const expectStatus = async (step, path, init, expected) => {
  let response;
  try {
    response = await fetchLocal(path, init);
  } catch (error) {
    fail(step, `请求 ${path} 异常: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  if (response.status !== expected) {
    fail(step, `${path} 期望 HTTP ${expected}，实际 ${response.status}。响应: ${body.slice(0, 300)}`);
  }
  return { status: response.status, body };
};

const checks = [];

try {
  // 1. Docker 可用性。
  const version = runDocker('docker-version', ['version', '--format', '{{.Server.Version}}'], { capture: true });
  const dockerServerVersion = version.stdout.trim();
  checks.push({ step: 'docker-version', ok: true, detail: dockerServerVersion });
  process.stdout.write(`[docker-smoke] Docker Server 版本: ${dockerServerVersion}\n`);

  // 2. 构建镜像。
  runDocker('docker-build', ['build', '-t', IMAGE, '.']);
  checks.push({ step: 'docker-build', ok: true, detail: `镜像 ${IMAGE}` });
  process.stdout.write(`[docker-smoke] 镜像构建完成: ${IMAGE}\n`);

  // 3. 以受限配置运行容器（与 compose 一致：只读根文件系统、tmpfs、cap_drop、非 root 由镜像保证）。
  port = await getFreeLoopbackPort();
  const accessToken = randomBytes(32).toString('hex');
  runDocker('docker-run', [
    'run', '-d', '--rm',
    '--name', CONTAINER,
    '-p', `127.0.0.1:${port}:4319`,
    '-e', 'HOST=0.0.0.0',
    '-e', 'PORT=4319',
    '-e', 'WEB_DIST=/app/web/dist',
    '-e', `ACCESS_TOKEN=${accessToken}`,
    // 冒烟请求来自宿主机 127.0.0.1，需要把这个 origin 加入白名单才能越过 403 检查，
    // 从而验证 401（缺令牌）路径；错误 origin 的 403 单独用 evil.example 验证。
    '-e', `ALLOWED_ORIGINS=http://127.0.0.1:${port}`,
    '--read-only',
    '--tmpfs', '/tmp:size=16m,mode=1777',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    IMAGE,
  ], { capture: true });
  checks.push({ step: 'docker-run', ok: true, detail: `127.0.0.1:${port} → 容器 4319（read_only + tmpfs + cap_drop ALL）` });
  process.stdout.write(`[docker-smoke] 容器已启动: ${CONTAINER} @ http://127.0.0.1:${port}\n`);

  // 4. 轮询健康检查。
  const health = await waitForHealth();
  checks.push({ step: 'healthz', ok: true, detail: JSON.stringify(health) });
  process.stdout.write(`[docker-smoke] 健康检查通过: ${JSON.stringify(health)}\n`);

  // 5. 无 Authorization 的 inspect 必须得到 401（带本机 loopback origin 以越过 origin 检查）。
  const unauthenticated = await expectStatus(
    'auth-required',
    '/api/playlists/inspect',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ provider: 'netease', input: { value: '1' } }),
    },
    401,
  );
  checks.push({ step: 'auth-required', ok: true, detail: `HTTP ${unauthenticated.status} ${unauthenticated.body}` });

  // 6. 带错 Origin 的请求必须得到 403。
  const foreignOrigin = await expectStatus(
    'origin-not-allowed',
    '/api/playlists/inspect',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ provider: 'netease', input: { value: '1' } }),
    },
    403,
  );
  checks.push({ step: 'origin-not-allowed', ok: true, detail: `HTTP ${foreignOrigin.status} ${foreignOrigin.body}` });

  process.stdout.write(`\n${JSON.stringify({
    ok: true,
    image: IMAGE,
    container: CONTAINER,
    endpoint: `http://127.0.0.1:${port}`,
    dockerServerVersion,
    checks,
  }, null, 2)}\n`);
  process.stdout.write('[docker-smoke] 全部检查通过。\n');
} catch {
  // fail() 已写入 stderr 并设置退出码；这里仅兜底保证 finally 清理。
} finally {
  if (port !== 0) {
    const cleanup = spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' });
    if (cleanup.status === 0) {
      process.stdout.write(`[docker-smoke] 已清理容器 ${CONTAINER}。\n`);
    } else {
      process.stderr.write(`[docker-smoke] 警告：清理容器 ${CONTAINER} 失败` +
        `（退出码 ${cleanup.status}），请手动执行: docker rm -f ${CONTAINER}\n`);
    }
  }
}
