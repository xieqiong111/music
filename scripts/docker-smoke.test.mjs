// docker-smoke 回归测试（认证改版后的矩阵：登录会话 + Origin 白名单 + 校验层）。
// 全部场景使用内存 mock（docker CLI / fetch / 端口探测），绝不触碰真实 Docker。
// 覆盖：
//   1. docker run 失败（名称冲突）→ 清理登记为零，不删除任何既有容器；进程失败；
//      容器环境不再包含任何令牌（ACCESS_TOKEN 已废弃）。
//   2. 成功创建 → 仅清理本次 run 返回的自身容器 ID；两轮 run 容器名各自唯一；
//      检查矩阵走通"未登录 401 → 错误密码 401 → 登录拿 Cookie → 会话 + 校验层"全链路；
//      /data 以 tmpfs 挂载（只读根文件系统下认证存储可写）。
//   3. 创建成功但健康检查失败 → 仍清理自身 ID，退出码非零。
//   4. 清理失败 → 警告 + 手动清理提示（带 ID），不影响其余清理，主流程退出码不受影响。
//   5. redactDockerArgs：-e/--env 后的敏感 KEY=VALUE 值替换为 [REDACTED]（防御性保留），
//      会话 Cookie 值一律脱敏。
//   6. redactSessionCookie：任何日志文本中的 pe_session 值替换为 [REDACTED]。
//   7. 4319 被占用 → 跳过默认端口场景的行为保留。
//   8. parseArgs：--username/--password 覆盖默认 admin/admin；未知选项报错。
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as smokeModule from './docker-smoke.mjs';

const { runMain, SmokeError, parseArgs, buildCheckPlan } = smokeModule;
// 旧实现未导出 redactDockerArgs：恒等回退让旧实现上该测试以"未脱敏"失败（可变红）。
const redactDockerArgs = smokeModule.redactDockerArgs ?? ((args) => args);
const redactSessionCookie = smokeModule.redactSessionCookie ?? ((text) => text);

const ID_1 = '1'.repeat(64);
const ID_2 = '2'.repeat(64);
const NAME_PATTERN = /^playlist-exporter-smoke-[0-9a-f]{8}$/;

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => [] },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

// 按检查矩阵语义应答的 fetch mock（与服务端登录会话契约一致）：
//   /healthz → 200；未登录 inspect → 401；登录错误密码 → 401；登录成功 → 200 + Set-Cookie；
//   携带会话：非法 Origin → 403；未知 provider → 400 INVALID_REQUEST；
//   否则 → 400 INVALID_PLAYLIST_INPUT。
const createSuccessFetch = () => {
  const calls = [];
  const issuedTokens = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = new URL(url).pathname;
    if (path === '/healthz') return jsonResponse(200, { status: 'ok' });
    const headers = init.headers ?? {};
    const body = JSON.parse(init.body ?? '{}');
    if (path === '/api/auth/login') {
      if (body.password !== 'admin' || body.username !== 'admin') {
        return jsonResponse(401, { code: 'AUTH_REQUIRED' });
      }
      const token = randomBytes(32).toString('hex');
      issuedTokens.push(token);
      return {
        ...jsonResponse(200, { authenticated: true, username: 'admin' }),
        headers: {
          getSetCookie: () =>
            [`pe_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`],
        },
      };
    }
    if (headers.cookie === undefined) return jsonResponse(401, { code: 'AUTH_REQUIRED' });
    if (headers.origin === 'https://evil.example') return jsonResponse(403, { code: 'ORIGIN_NOT_ALLOWED' });
    if (body.provider !== 'netease') return jsonResponse(400, { code: 'INVALID_REQUEST' });
    return jsonResponse(400, { code: 'INVALID_PLAYLIST_INPUT' });
  };
  return { fetchImpl, calls, issuedTokens };
};

// 健康检查始终失败（HTTP status），且健康失败后不应发起检查矩阵请求。
const createFailingHealthFetch = (status) => async (url) => {
  if (new URL(url).pathname === '/healthz') return jsonResponse(status, { status: 'error' });
  throw new Error('健康检查未通过时不应发起其他请求');
};

const createNeverFetch = () => async () => {
  throw new Error('此场景不应发起任何 HTTP 请求');
};

// docker CLI mock：按首个子命令分发，记录全部调用与 rm 目标。
const createDockerMock = ({ runResults, rm } = {}) => {
  const runCalls = [];
  const rmCalls = [];
  const spawnSync = (_command, args) => {
    if (args[0] === 'version') return { status: 0, stdout: '27.0.0\n', stderr: '' };
    if (args[0] === 'run') {
      runCalls.push(args);
      const result = runResults[Math.min(runCalls.length - 1, runResults.length - 1)];
      return typeof result === 'function' ? result(args) : result;
    }
    if (args[0] === 'rm' && args[1] === '-f') {
      rmCalls.push(args[2]);
      return typeof rm === 'function' ? rm(args[2]) : { status: 0, stdout: `${args[2]}\n`, stderr: '' };
    }
    throw new Error(`mock 未预期的 docker 命令: docker ${args.join(' ')}`);
  };
  return { spawnSync, runCalls, rmCalls };
};

// 端口探测 mock：自定义端口场景返回随机空闲端口，默认端口场景视为可绑定。
const probePortBindable = async (port = 0) => (port === 0 ? 45673 : port);

const captureStream = (stream) => {
  const chunks = [];
  const original = stream.write;
  stream.write = function capturedWrite(chunk, ...rest) {
    chunks.push(String(chunk));
    return original.call(stream, chunk, ...rest);
  };
  return { chunks, restore: () => { stream.write = original; } };
};

const runSmoke = async ({ docker, fetchImpl, probePort = probePortBindable, healthTimeoutMs, healthIntervalMs, argv }) =>
  runMain({
    argv: argv ?? ['--skip-build'],
    spawnSync: docker.spawnSync,
    fetch: fetchImpl,
    probePort,
    ...(healthTimeoutMs !== undefined ? { healthTimeoutMs } : {}),
    ...(healthIntervalMs !== undefined ? { healthIntervalMs } : {}),
  });

describe('docker-smoke 回归（容器清理与登录会话矩阵）', () => {
  let originalExitCode;
  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('名称冲突：docker run 失败时清理调用为零、不触碰既有容器，进程失败且无敏感环境变量', async () => {
    const docker = createDockerMock({
      runResults: [{
        status: 125,
        stdout: '',
        stderr: 'docker: Error response from daemon: Conflict. The container name is already in use',
      }],
    });
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let thrown;
    try {
      await runSmoke({ docker, fetchImpl: createNeverFetch() });
    } catch (error) {
      thrown = error;
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(docker.runCalls).toHaveLength(1); // mock 确实执行到 docker run 这一步
    expect(thrown).toBeInstanceOf(SmokeError);
    expect(thrown.step).toBe('docker-run');
    expect(docker.rmCalls).toEqual([]); // 清理登记为零：不删除同名既有容器
    expect(process.exitCode).toBe(1); // 进程失败
    // 认证改版：容器环境不再注入任何令牌；-origin 白名单照旧。
    const runArgs = docker.runCalls[0];
    const envValues = runArgs.filter((arg, index) => runArgs[index - 1] === '-e');
    expect(envValues.some((value) => value.startsWith('ACCESS_TOKEN='))).toBe(false);
    expect(envValues).toContain('HOST=0.0.0.0');
    expect(envValues.some((value) => value.startsWith('ALLOWED_ORIGINS='))).toBe(true);
    const combinedOutput = [...stdout.chunks, ...stderr.chunks].join('');
    expect(combinedOutput).not.toContain('should-not-escape');
  });

  it('成功创建：两轮 run 容器名唯一、/data 以 tmpfs 挂载，登录会话检查矩阵全链路通过', async () => {
    const docker = createDockerMock({
      runResults: [
        { status: 0, stdout: `${ID_1}\n`, stderr: '' },
        { status: 0, stdout: `${ID_2}\n`, stderr: '' },
      ],
    });
    const { fetchImpl, calls, issuedTokens } = createSuccessFetch();
    const stdout = captureStream(process.stdout);
    try {
      await runSmoke({ docker, fetchImpl });
    } finally {
      stdout.restore();
    }
    expect(docker.runCalls).toHaveLength(2);
    const names = docker.runCalls.map((args) => args[args.indexOf('--name') + 1]);
    for (const name of names) expect(name).toMatch(NAME_PATTERN);
    expect(new Set(names).size).toBe(2); // 两次 run 各自唯一，不与既有容器争名
    // 默认/自定义双端口场景保留：随机空闲端口 + 4319。
    expect(docker.runCalls[0]).toContain('-p');
    expect(docker.runCalls[0]).toContain('127.0.0.1:45673:4319');
    expect(docker.runCalls[1]).toContain('127.0.0.1:4319:4319');
    // 只读根文件系统下 /data 认证存储以 tmpfs 挂载（对齐容器内 UID/GID 10001）。
    expect(docker.runCalls[0]).toContain('--tmpfs');
    expect(docker.runCalls[0]).toContain('/data:size=16m,uid=10001,gid=10001');
    // 清理按容器 ID 执行，且只有本次创建并记录 ID 的两个容器。
    expect(docker.rmCalls).toEqual([ID_1, ID_2]);
    expect(process.exitCode).toBe(0);
    // 清理日志同时输出场景标签与容器 ID。
    const output = stdout.chunks.join('');
    expect(output).toContain(`已清理容器 场景=custom-port id=${ID_1}`);
    expect(output).toContain(`已清理容器 场景=default-port id=${ID_2}`);

    // 每轮容器各执行一次完整矩阵：两轮 × 7 项（无 loopback 变体的 origin 场景）。
    const paths = calls.map((call) => new URL(call.url).pathname);
    expect(paths.filter((path) => path === '/api/auth/login')).toHaveLength(4); // 2 轮 × (错误密码 + 成功)
    expect(issuedTokens).toHaveLength(2);
    expect(output).toContain('✓ login-success: HTTP 200');
    expect(output).toContain('✓ auth-required: HTTP 401');
    expect(output).toContain('✓ login-wrong-password: HTTP 401');
    expect(output).toContain('✓ origin-not-allowed: HTTP 403');
    expect(output).toContain('✓ validation-input-reached: HTTP 400');
  });

  it('创建成功但健康检查失败：仍清理自身 ID 且退出码非零', async () => {
    const docker = createDockerMock({
      runResults: [{ status: 0, stdout: `${ID_1}\n`, stderr: '' }],
    });
    const stderr = captureStream(process.stderr);
    let thrown;
    try {
      await runSmoke({
        docker,
        fetchImpl: createFailingHealthFetch(500),
        healthTimeoutMs: 30,
        healthIntervalMs: 5,
      });
    } catch (error) {
      thrown = error;
    } finally {
      stderr.restore();
    }
    expect(docker.runCalls).toHaveLength(1);
    expect(thrown).toBeInstanceOf(SmokeError);
    expect(thrown.step).toBe('healthz');
    expect(docker.rmCalls).toEqual([ID_1]); // 已创建的容器仍被 finally 清理
    expect(process.exitCode).toBe(1);
  });

  it('清理失败：输出警告与带 ID 的手动清理提示，其余容器仍被清理，主流程不失败', async () => {
    const docker = createDockerMock({
      runResults: [
        { status: 0, stdout: `${ID_1}\n`, stderr: '' },
        { status: 0, stdout: `${ID_2}\n`, stderr: '' },
      ],
      rm: (id) => (id === ID_1
        ? { status: 1, stdout: '', stderr: 'Error response from daemon: cannot remove container' }
        : { status: 0, stdout: `${id}\n`, stderr: '' }),
    });
    const { fetchImpl } = createSuccessFetch();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    let thrown;
    try {
      await runSmoke({ docker, fetchImpl });
    } catch (error) {
      thrown = error;
    } finally {
      stdout.restore();
      stderr.restore();
    }
    expect(thrown).toBeUndefined(); // 主流程不受清理失败影响
    expect(process.exitCode).toBe(0);
    expect(docker.rmCalls).toEqual([ID_1, ID_2]); // 不影响其余清理
    const stderrText = stderr.chunks.join('');
    expect(stderrText).toContain(`警告：清理容器 场景=custom-port (id=${ID_1}) 失败`);
    expect(stderrText).toContain(`docker rm -f ${ID_1}`); // 手动清理提示带 ID
    expect(stdout.chunks.join('')).toContain(`已清理容器 场景=default-port id=${ID_2}`);
  });

  it('4319 被占用：跳过默认端口场景，仅清理自定义端口一轮的容器', async () => {
    const docker = createDockerMock({
      runResults: [{ status: 0, stdout: `${ID_1}\n`, stderr: '' }],
    });
    const { fetchImpl } = createSuccessFetch();
    const probePort = async (port = 0) => (port === 0 ? 45673 : 5000); // 4319 不可绑定
    const stdout = captureStream(process.stdout);
    try {
      await runSmoke({ docker, fetchImpl, probePort });
    } finally {
      stdout.restore();
    }
    expect(docker.runCalls).toHaveLength(1);
    expect(docker.rmCalls).toEqual([ID_1]);
    expect(stdout.chunks.join('')).toContain('跳过默认端口场景');
  });

  it('base-url 模式：用 --username/--password 覆盖默认 admin/admin', async () => {
    const seenBodies = [];
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/healthz') return jsonResponse(200, { status: 'ok' });
      const headers = init.headers ?? {};
      const body = JSON.parse(init.body ?? '{}');
      if (path === '/api/auth/login') {
        seenBodies.push(body);
        if (body.username !== 'ops' || body.password !== 's3cret-pass') {
          return jsonResponse(401, { code: 'AUTH_REQUIRED' });
        }
        const token = randomBytes(32).toString('hex');
        return {
          ...jsonResponse(200, { authenticated: true }),
          headers: {
            getSetCookie: () => [`pe_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`],
          },
        };
      }
      if (headers.cookie === undefined) return jsonResponse(401, { code: 'AUTH_REQUIRED' });
      if (headers.origin === 'https://evil.example') return jsonResponse(403, { code: 'ORIGIN_NOT_ALLOWED' });
      if (body.provider !== 'netease') return jsonResponse(400, { code: 'INVALID_REQUEST' });
      return jsonResponse(400, { code: 'INVALID_PLAYLIST_INPUT' });
    };
    const stdout = captureStream(process.stdout);
    try {
      await runMain({
        argv: ['--base-url', 'http://127.0.0.1:4319', '--username', 'ops', '--password', 's3cret-pass'],
        spawnSync: createDockerMock().spawnSync,
        fetch: fetchImpl,
      });
    } finally {
      stdout.restore();
    }
    expect(seenBodies.some((body) => body.username === 'ops' && body.password === 's3cret-pass')).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(stdout.chunks.join('')).toContain('全部检查通过');
  });
});

describe('check plan（登录前后两阶段）', () => {
  const legalOrigins = ['http://127.0.0.1:4319', 'http://localhost:4319'];

  it('pre 阶段无需会话：healthz、未登录 401、错误密码 401、登录拿 Cookie', () => {
    const plan = buildCheckPlan({ phase: 'pre', legalOrigins });
    expect(plan.map((check) => check.name)).toEqual([
      'healthz', 'auth-required', 'login-wrong-password', 'login-success',
    ]);
    expect(plan[3].captureCookie).toBe(true);
    const loginBody = JSON.parse(plan[3].request.init.body);
    expect(loginBody).toEqual({ username: 'admin', password: 'admin', duration: '7d' });
  });

  it('post 阶段必须携带登录 Cookie 并注入到每个请求', () => {
    expect(() => buildCheckPlan({ phase: 'post', legalOrigins })).toThrow(SmokeError);
    const plan = buildCheckPlan({ phase: 'post', cookie: 'a'.repeat(64), legalOrigins });
    expect(plan.map((check) => check.name)).toEqual([
      'origin-not-allowed', 'validation-schema-reached', 'validation-input-reached',
      'loopback-variant-accepted',
    ]);
    for (const check of plan) {
      expect(check.request.init.headers.cookie).toBe(`pe_session=${'a'.repeat(64)}`);
    }
    expect(plan[0].request.init.headers.origin).toBe('https://evil.example');
  });
});

describe('redactDockerArgs / redactSessionCookie（失败详情脱敏）', () => {
  it('对 -e/--env 后的敏感 KEY=VALUE 脱敏，其余参数原样（Cookie 值一律脱敏）', () => {
    expect(redactDockerArgs([
      'run', '-d', '-e', 'ACCESS_TOKEN=test-only-secret-value', '-e', 'PORT=4319',
      '--env', 'APPLE_DEVELOPER_TOKEN=test-only-dev-secret', '-e', 'HOST=0.0.0.0',
      '--env-file', '.env', '-e', 'ALLOWED_ORIGINS=http://127.0.0.1:4319',
      'playlist-exporter:smoke',
    ])).toEqual([
      'run', '-d', '-e', 'ACCESS_TOKEN=[REDACTED]', '-e', 'PORT=4319',
      '--env', 'APPLE_DEVELOPER_TOKEN=[REDACTED]', '-e', 'HOST=0.0.0.0',
      '--env-file', '.env', '-e', 'ALLOWED_ORIGINS=http://127.0.0.1:4319',
      'playlist-exporter:smoke',
    ]);
  });

  it('防御性脱敏混入参数的会话 Cookie 值', () => {
    expect(redactDockerArgs([
      'run', '-e', `PE_SESSION=pe_session=${'f'.repeat(64)}`,
    ])).toEqual(['run', '-e', `PE_SESSION=pe_session=[REDACTED]`]);
  });

  it('redactSessionCookie 替换任意文本中的 Cookie 值并保留属性', () => {
    const token = 'abc123ef'.repeat(8);
    expect(redactSessionCookie(`Set-Cookie: pe_session=${token}; Path=/; HttpOnly`))
      .toBe('Set-Cookie: pe_session=[REDACTED]; Path=/; HttpOnly');
    expect(redactSessionCookie('普通文本不受影响')).toBe('普通文本不受影响');
  });

  it('无敏感参数时原样返回', () => {
    const args = ['build', '-t', 'playlist-exporter:smoke', '.'];
    expect(redactDockerArgs(args)).toEqual(args);
  });
});

describe('parseArgs', () => {
  it('默认 admin/admin，可被 --username/--password 覆盖', () => {
    expect(parseArgs([])).toMatchObject({ username: 'admin', password: 'admin', skipBuild: false });
    expect(parseArgs(['--username', 'ops', '--password', 'pw']))
      .toMatchObject({ username: 'ops', password: 'pw' });
  });

  it('未知选项报错且 base-url 模式不再要求令牌', () => {
    expect(() => parseArgs(['--token', 'legacy'])).toThrow(SmokeError);
    expect(parseArgs(['--base-url', 'http://127.0.0.1:4319'])).toMatchObject({
      baseUrl: 'http://127.0.0.1:4319',
    });
  });
});
