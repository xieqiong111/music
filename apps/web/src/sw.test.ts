// @vitest-environment node
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type FetchEvent = {
  readonly request: Request;
  readonly respondWith: (response: Promise<Response>) => void;
};
type Listener = (event: FetchEvent) => void;

const loadFetchListener = async (): Promise<Listener> => {
  const listeners = new Map<string, Listener>();
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self,
    URL,
    fetch: vi.fn(async () => new Response('static', { status: 200 })),
    caches: {
      keys: vi.fn(async () => []),
      match: vi.fn(async () => undefined),
      open: vi.fn(async () => ({ put: vi.fn(async () => undefined) })),
      delete: vi.fn(),
    },
  });
  const listener = listeners.get('fetch');
  if (listener === undefined) throw new Error('fetch listener missing');
  return listener;
};

describe('service worker cache boundary', () => {
  it('never intercepts API, health, mutation, cross-origin, or credentialed requests', async () => {
    const listener = await loadFetchListener();
    for (const request of [
      new Request('https://app.example/api/jobs/job-1'),
      new Request('https://app.example/healthz'),
      new Request('https://app.example/assets/app.js', { method: 'POST' }),
      new Request('https://cdn.example/assets/app.js'),
      new Request('https://app.example/assets/app.js', {
        headers: { authorization: 'Bearer synthetic-test-value' },
      }),
    ]) {
      const respondWith = vi.fn();
      listener({ request, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it('intercepts only an allowlisted same-origin static asset', async () => {
    const listener = await loadFetchListener();
    const respondWith = vi.fn();
    listener({ request: new Request('https://app.example/assets/app.js'), respondWith });
    expect(respondWith).toHaveBeenCalledOnce();
  });
});
