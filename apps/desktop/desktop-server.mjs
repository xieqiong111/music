import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error('A writable desktop data directory is required');
// The application config intentionally rejects PORT=0. Ask the OS for a free
// loopback port first; bind failure is fatal, never attach to an existing server.
const probe = createServer();
await new Promise((resolveListen, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolveListen);
});
const port = probe.address().port;
await new Promise((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()));
const origin = `http://127.0.0.1:${port}`;
const runtime = startServer({
  env: {
    HOST: '127.0.0.1', PORT: String(port),
    DATA_DIR: resolve(process.argv[2]), WEB_DIST: resolve(root, 'web'),
    ALLOWED_ORIGINS: origin,
    APPLE_DEVELOPER_TOKEN: process.env.APPLE_DEVELOPER_TOKEN,
  },
});
runtime.server.once('listening', () => {
  process.stdout.write(`PLAYLIST_EXPORTER_READY=${origin}\n`);
});
runtime.server.once('error', error => {
  process.stderr.write(`Desktop backend failed: ${error.message}\n`);
  process.exit(1);
});
const shutdown = () => {
  runtime.server.close(() => { runtime.jobs.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
// Rust closes stdin when the desktop exits, including ordinary parent teardown.
process.stdin.resume();
process.stdin.once('end', shutdown);
