import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import type { Server } from 'node:http';
import { pino } from 'pino';
import { createApp } from '../../src/app.js';
import type { OidcClient } from '../../src/auth/oidc.js';
import { createDb, type Db } from '../../src/db.js';
import type { Logger } from '../../src/logger.js';

export const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
export const PEPPER = Buffer.alloc(32, 9).toString('base64');

export interface Harness {
  readonly db: Db;
  readonly base: string;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly setupToken?: string;
  readonly databaseUrl?: string;
  readonly sidecarUrl?: string;
  readonly log?: Logger;
}

export async function startApp(oidc: OidcClient | null = null, setupToken?: string, databaseUrl?: string, more: StartOptions = {}): Promise<Harness> {
  const db = createDb(databaseUrl ?? process.env['DATABASE_URL'] ?? '');
  const app = createApp({
    version: 'test',
    core: { db, baseUrl: 'http://localhost', secretKey: SECRET_KEY, pepper: PEPPER, oidc, log: more.log ?? pino({ level: 'silent' }), setupToken, sidecarUrl: more.sidecarUrl },
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

/**
 * A database of its own, freshly migrated, for a test that needs one owner and nothing else in it —
 * an import, a restore. Named `<name>` beside the shared test database; dropped by `drop()`.
 */
export async function freshDatabase(name: string): Promise<{ url: string; db: Db; drop(): Promise<void> }> {
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`fresh database names end in _test: ${name}`);
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${name}`;
  const admin = async (sql: string) => {
    const u = new URL(url);
    u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  await admin(`drop database if exists "${name}" with (force)`);
  await admin(`create database "${name}"`);
  const cli = join(dirname(createRequire(import.meta.url).resolve('prisma/package.json')), 'build/index.js');
  const out = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: join(import.meta.dirname, '../..'), env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr + out.stdout);
  const db = createDb(url.toString());
  return {
    url: url.toString(),
    db,
    async drop() {
      await db.$disconnect();
      await admin(`drop database if exists "${name}" with (force)`);
    },
  };
}
