import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createDb } from './db.js';
import type { Logger } from './logger.js';

/**
 * Boot: pending migrations run **only after a dump has been written** when the database already
 * holds data — the moment before a migration is the moment a backup matters most. The dump path is
 * logged before the migration starts, and a dump that fails stops the boot. Ported from Overflow.
 */

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../prisma/migrations');

async function migrationDirs(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export async function pendingMigrations(databaseUrl: string): Promise<string[]> {
  const onDisk = await migrationDirs();
  const db = createDb(databaseUrl);
  try {
    const applied = await db.$queryRaw<{ migration_name: string }[]>`
      select migration_name from _prisma_migrations where finished_at is not null`;
    const done = new Set(applied.map((r) => r.migration_name));
    return onDisk.filter((name) => !done.has(name));
  } catch {
    return onDisk; // no _prisma_migrations table: an empty database
  } finally {
    await db.$disconnect();
  }
}

function prismaCli(): string {
  const require_ = createRequire(import.meta.url);
  const manifest = require_('prisma/package.json') as { bin: Record<string, string> | string };
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['prisma'];
  if (entry === undefined) throw new Error('the prisma package declares no CLI entry point');
  return join(dirname(require_.resolve('prisma/package.json')), entry);
}

export function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

export async function dumpDatabase(databaseUrl: string, backupDir: string, reason: string): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(backupDir, `${stamp}-${reason}.dump`);
  await run('pg_dump', ['--format=custom', '--file', path, databaseUrl], process.env);
  return path;
}

export async function migrate(opts: { databaseUrl: string; backupDir: string; backupFirst: boolean; log: Logger }): Promise<string[]> {
  const pending = await pendingMigrations(opts.databaseUrl);
  if (pending.length === 0) {
    opts.log.info('schema is current; no migration and no dump');
    return [];
  }
  opts.log.info({ pending }, 'migrations pending');
  const hasData = pending.length < (await migrationDirs()).length;
  if (opts.backupFirst && hasData) {
    const dumpPath = await dumpDatabase(opts.databaseUrl, opts.backupDir, 'pre-migration');
    opts.log.info({ dumpPath }, 'pre-migration dump written');
  }
  await run(process.execPath, [prismaCli(), 'migrate', 'deploy'], { ...process.env, DATABASE_URL: opts.databaseUrl });
  opts.log.info({ applied: pending }, 'migrations applied');
  return pending;
}

/** The newest applied migration — what /health reports and Shipyard compares. */
export async function schemaRevision(db: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1`;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}
