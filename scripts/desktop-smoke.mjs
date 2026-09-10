import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';

const resources = resolve(process.argv[2] ?? 'apps/desktop/src-tauri/resources');
const node = join(resources, 'node.exe');
await access(node);
await access(join(resources, 'server.mjs'));
await access(join(resources, 'web/index.html'));
const data = await mkdtemp(join(tmpdir(), 'playlist desktop smoke '));
const child = spawn(node, [join(resources, 'desktop-server.mjs'), data], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  // Deliberately hostile inherited configuration must not affect the desktop bundle.
  env: { ...process.env, HOST: '0.0.0.0', PORT: '1', WEB_DIST: 'missing', DATA_DIR: 'missing', ALLOWED_ORIGINS: 'https://example.invalid' },
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
try {
  const base = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Backend readiness timed out: ${stderr}`)), 30000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.startsWith('PLAYLIST_EXPORTER_READY=')) {
        clearTimeout(timer);
        resolveReady(line.slice('PLAYLIST_EXPORTER_READY='.length));
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}: ${stderr}`)); });
  });
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const html = await (await fetch(base)).text();
  assert.match(html, /<div id="root">/u);
  const asset = html.match(/src="([^"]+\.js)"/u)?.[1];
  assert.ok(asset, 'built JavaScript asset is present');
  assert.equal((await fetch(new URL(asset, base))).status, 200);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: 'admin', duration: '7d' }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const session = await fetch(`${base}/api/auth/status`, { headers: { cookie } });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.username, 'admin');
  const library = await fetch(`${base}/api/local-library`, { headers: { cookie } });
  assert.equal(library.status, 200, 'packaged local library initializes before requests');
  const denied = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
    body: JSON.stringify({ username: 'admin', password: 'admin', duration: '7d' }),
  });
  assert.equal(denied.status, 403);
  assert.ok(JSON.parse(await readFile(join(data, 'auth.json'), 'utf8')).users.length);
  console.log('PASS: packaged runtime, static assets, login/session, origin rejection, and writable data directory');
} finally {
  if (child.exitCode === null) {
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    child.stdin.end();
    const force = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(force);
  }
  await rm(data, { recursive: true, force: true });
}
