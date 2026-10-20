import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A freshly migrated database nobody has written to — for first-run (setup) tests. */
    emptyDatabaseUrl: string;
  }
}

/**
 * Create the test database if absent, then migrate it, so a dropped volume costs nothing and CI's
 * Postgres service needs no bespoke provisioning. Refuses any database whose name does not end in
 * `_test`: these tests write rows, and the vault refuses to forget them.
 */
export default async function setup(project: TestProject): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('DATABASE_URL is required for integration tests');
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to run integration tests against "${name}": the name must end in _test`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    // Fresh every run: the vault cannot be truncated, so a clean slate means a new database.
    await client.query(`drop database if exists "${name}" with (force)`);
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }

  const cli = join(dirname(createRequire(import.meta.url).resolve('prisma/package.json')), 'build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: join(import.meta.dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`prisma migrate deploy failed:\n${result.stderr}${result.stdout}`);

  // A pristine copy, cloned while nothing is connected to the template.
  const emptyName = `${name.slice(0, -'_test'.length)}_empty_test`;
  const cloner = new Client({ connectionString: admin.toString() });
  await cloner.connect();
  try {
    await cloner.query(`drop database if exists "${emptyName}" with (force)`);
    await cloner.query(`create database "${emptyName}" template "${name}"`);
  } finally {
    await cloner.end();
  }
  const empty = new URL(url);
  empty.pathname = `/${emptyName}`;
  project.provide('emptyDatabaseUrl', empty.toString());
}
