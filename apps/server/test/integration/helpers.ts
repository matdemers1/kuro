import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { pino } from 'pino';
import { createApp } from '../../src/app.js';
import type { OidcClient } from '../../src/auth/oidc.js';
import { createDb, type Db } from '../../src/db.js';

export const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
export const PEPPER = Buffer.alloc(32, 9).toString('base64');

export interface Harness {
  readonly db: Db;
  readonly base: string;
  close(): Promise<void>;
}

export async function startApp(oidc: OidcClient | null = null, setupToken?: string, databaseUrl?: string): Promise<Harness> {
  const db = createDb(databaseUrl ?? process.env['DATABASE_URL'] ?? '');
  const app = createApp({
    version: 'test',
    core: { db, baseUrl: 'http://localhost', secretKey: SECRET_KEY, pepper: PEPPER, oidc, log: pino({ level: 'silent' }), setupToken },
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  return {
    db,
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await db.$disconnect();
    },
  };
}

/** The `name=value` part of a Set-Cookie header, for the next request. */
export function cookieFrom(res: Response, name: string): string | null {
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(';');
    if (pair?.startsWith(`${name}=`) === true && pair.length > name.length + 1) return pair;
  }
  return null;
}

export function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
