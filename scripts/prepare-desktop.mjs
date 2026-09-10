import { cp, mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This package builds Windows x64 and must use an x64 Node runtime');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const workspace of ['web', 'server']) {
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `pnpm --filter @playlist-exporter/${workspace} build`], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, VITE_API_BASE_URL: '' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const resources = join(root, 'apps/desktop/src-tauri/resources');
await mkdir(resources, { recursive: true });
await cp(process.execPath, join(resources, 'node.exe'));
await cp(join(root, 'apps/server/dist/index.js'), join(resources, 'server.mjs'));
await cp(join(root, 'apps/desktop/desktop-server.mjs'), join(resources, 'desktop-server.mjs'));
await cp(join(root, 'apps/web/dist'), join(resources, 'web'), { recursive: true });
await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(resources, 'THIRD_PARTY_NOTICES.md'));
const license = join(dirname(process.execPath), 'LICENSE');
try {
  await access(license);
  await cp(license, join(resources, 'NODE-LICENSE.txt'));
} catch {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!response.ok) throw new Error(`Node license download failed: ${response.status}`);
  await writeFile(join(resources, 'NODE-LICENSE.txt'), await response.text());
}
await writeFile(join(resources, 'runtime-version.txt'), `${process.version}\n`);
console.log(`Prepared self-contained Windows resources with Node ${process.version}`);
