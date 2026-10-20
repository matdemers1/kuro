// Playwright's webServer: a fresh *_test database, migrated, then the mock issuer and the built
// Kurō server serving the built web app. Everything Kurō needs is set here; nothing is read from a
// developer's .env.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pg from 'pg';

const root = join(import.meta.dirname, '..');
const url = process.env.E2E_DATABASE_URL ?? 'postgresql://kuro:kuro@127.0.0.1:5432/kuro_e2e_test';
const name = new URL(url).pathname.slice(1);
if (!name.endsWith('_test')) throw new Error(`refusing to use ${name}: e2e databases end in _test`);

const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
await client.query(`drop database if exists "${name}" with (force)`);
await client.query(`create database "${name}"`);
await client.end();

const serverDir = join(root, 'apps/server');
const prisma = join(dirname(createRequire(join(serverDir, 'package.json')).resolve('prisma/package.json')), 'build/index.js');
const migrated = spawnSync(process.execPath, [prisma, 'migrate', 'deploy'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
if (migrated.status !== 0) throw new Error(`migrate failed:\n${migrated.stderr}${migrated.stdout}`);

const children = [
  spawn(process.execPath, [join(import.meta.dirname, 'issuer.mjs')], { stdio: 'inherit', env: { ...process.env, ISSUER_PORT: '4545', APP_BASE: 'http://localhost:3399' } }),
];
// Give the issuer a moment so discovery at boot succeeds.
await new Promise((r) => setTimeout(r, 800));
children.push(
  spawn(process.execPath, [join(serverDir, 'dist/index.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '3399',
      BASE_URL: 'http://localhost:3399',
      DATABASE_URL: url,
      WEB_DIST: join(root, 'apps/web/dist'),
      KURO_SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
      AUTH_PEPPER: Buffer.alloc(32, 5).toString('base64'),
      SETUP_TOKEN: 'e2e-setup-token-0123456789',
      D3AUTH_ISSUER: 'http://localhost:4545',
      D3AUTH_CLIENT_ID: 'kuro-e2e',
      D3AUTH_CLIENT_SECRET: 'kuro-e2e-secret',
      LOG_LEVEL: 'warn',
    },
  }),
);
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
