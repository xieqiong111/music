import { describe, expect, it } from 'vitest';
import type { HttpTransport } from '@playlist-exporter/contracts';
import {
  createHttpTransport,
  createPaginationGuard,
  createTaskController,
  fetchWithRetry,
  redactSensitive,
  systemClock,
} from '@playlist-exporter/core';

describe('core public API', () => {
  it('exports the supported package-level factories and utilities', () => {
    expect(createPaginationGuard).toBeTypeOf('function');
    expect(createTaskController).toBeTypeOf('function');
    expect(fetchWithRetry).toBeTypeOf('function');
    expect(redactSensitive).toBeTypeOf('function');
    expect(systemClock.now).toBeTypeOf('function');

    const transport: HttpTransport = createHttpTransport({
      maxResponseBytes: 1_024,
      fetchImpl: async () => new Response('ok'),
    });
    expect(transport.request).toBeTypeOf('function');
  });
});
