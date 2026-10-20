import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(async () => {
  await h.close();
});

describe('GET /health (the Shipyard manifest check)', () => {
  it('reports the newest applied migration as the schema revision', async () => {
    const res = await fetch(`${h.base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; schemaRevision: string; database: string };
    expect(body.ok).toBe(true);
    expect(body.database).toBe('up');
    expect(body.schemaRevision).toMatch(/^\d{14}_/);
  });
});
