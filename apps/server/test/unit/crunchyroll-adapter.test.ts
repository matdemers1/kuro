import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrSidecar, CrSidecarError } from '../../src/adapters/crunchyroll.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const json = JSON.parse(body) as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/session/password') {
        if (json['password'] === 'right') res.end(JSON.stringify({ refreshToken: 'rt', accountId: 'acct', profileId: null }));
        else res.writeHead(401).end(JSON.stringify({ error: 'expired', message: 'bad credentials' }));
        return;
      }
      if (json['refreshToken'] === 'blocked') {
        res.writeHead(503).end(JSON.stringify({ error: 'blocked', message: 'cloudflare' }));
        return;
      }
      res.end(JSON.stringify({ refreshToken: 'rt2', total: 1, items: [{ id: 'EP1' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

describe('CrSidecar', () => {
  it('returns the link on success', async () => {
    expect(await new CrSidecar(base).linkWithPassword('e', 'right', 'd')).toEqual({ refreshToken: 'rt', accountId: 'acct', profileId: null });
  });
  it('carries the sidecar error kind through', async () => {
    await expect(new CrSidecar(base).linkWithPassword('e', 'wrong', 'd')).rejects.toMatchObject({ kind: 'expired' });
    await expect(new CrSidecar(base).historyPage({ refreshToken: 'blocked', deviceId: 'd', accountId: 'a', page: 1 })).rejects.toMatchObject({ kind: 'blocked' });
  });
  it('returns the rotated token with each page', async () => {
    const page = await new CrSidecar(base).historyPage({ refreshToken: 'rt', deviceId: 'd', accountId: 'a', page: 1 });
    expect(page.refreshToken).toBe('rt2');
  });
  it('calls an unreachable sidecar upstream, not a crash', async () => {
    const err = await new CrSidecar('http://127.0.0.1:1').linkWithPassword('e', 'p', 'd').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrSidecarError);
    expect((err as CrSidecarError).kind).toBe('upstream');
  });
});
