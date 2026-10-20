import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { dumpDatabase, run } from '../boot.js';
import { createDb, type Db } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { upNext } from '../derive/show.js';
import type { Logger } from '../logger.js';

/**
 * The nightly backup (KURO-REQ-060, KURO-T-6.2): a custom-format dump into BACKUP_DIR, the newest 14
 * nightly dumps kept (and the newest 10 pre-migration ones), then a restore check — the dump restored
 * into a scratch database, Shows rebuilt there from the restored vault at the live derivation's
 * moment, and its Up Next compared with the live one. Derivation is deterministic (KURO-ADR-004), so
 * any difference means the dump is missing something.
 */

export const BACKUP_CRON = '30 4 * * *';
export const KEEP_NIGHTLY = 14;
export const KEEP_PRE_MIGRATION = 10;

/** Delete all but the newest `keep` dumps whose names end in `-<reason>.dump`. The names sort by time. */
export async function rotate(dir: string, reason: string, keep: number): Promise<string[]> {
  const mine = (await readdir(dir)).filter((f) => f.endsWith(`-${reason}.dump`)).sort();
  const gone = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of gone) await unlink(join(dir, f));
  return gone;
}

/** Up Next as the app shows it: the order, each Show's group and its next episode. */
export async function upNextOf(db: Db): Promise<{ showKey: string; group: string; next: string | null }[]> {
  const [states, pins] = await Promise.all([db.showState.findMany(), db.showPreference.findMany({ where: { pinned: true }, select: { showKey: true } })]);
  const pinned = new Set(pins.map((p) => p.showKey));
  const next = new Map(states.map((s) => [s.showKey, s.nextCrEpisodeId]));
  return upNext(states.map((s) => ({ ...s, pinned: pinned.has(s.showKey) }))).map((u) => ({ ...u, next: next.get(u.showKey) ?? null }));
}

const scratchUrl = (databaseUrl: string) => {
  const u = new URL(databaseUrl);
  u.pathname = `/${u.pathname.slice(1)}_restore_check`;
  return u;
};

async function admin(databaseUrl: string, sql: string): Promise<void> {
  const u = new URL(databaseUrl);
  u.pathname = '/postgres';
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/** Restore `file` into a scratch database and compare its Up Next with the live one. */
export async function restoreCheck(live: Db, databaseUrl: string, file: string): Promise<{ ok: boolean; detail: string }> {
  const scratch = scratchUrl(databaseUrl);
  const name = scratch.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
  await admin(databaseUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin(databaseUrl, `CREATE DATABASE "${name}"`);
  const db = createDb(scratch.toString());
  try {
    await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', scratch.toString(), file], process.env);
    const owner = await db.user.findFirst({ orderBy: { createdAt: 'asc' } });
    const derivedAt = (await live.showState.aggregate({ _max: { derivedAt: true } }))._max.derivedAt;
    if (owner !== null && derivedAt !== null) await rebuildShows(db, owner.id, derivedAt);
    const [a, b] = await Promise.all([upNextOf(live), upNextOf(db)]);
    const [livePlays, restoredPlays] = await Promise.all([live.play.count(), db.play.count()]);
    if (livePlays !== restoredPlays) return { ok: false, detail: `the restore has ${String(restoredPlays)} plays; live has ${String(livePlays)}` };
    const same = JSON.stringify(a) === JSON.stringify(b);
    const at = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
    return same ? { ok: true, detail: `${String(restoredPlays)} plays; Up Next identical (${String(a.length)} shows)` } : { ok: false, detail: `Up Next differs from position ${String(at + 1)}: live ${a[at]?.showKey ?? '—'}, restored ${b[at]?.showKey ?? '—'}` };
  } finally {
    await db.$disconnect();
    await admin(databaseUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}

export async function nightlyBackup(db: Db, opts: { databaseUrl: string; backupDir: string; log: Logger }): Promise<{ check: 'ok' | 'failed' | 'error'; detail: string; file: string | null }> {
  const row = await db.backupRun.create({ data: { check: 'error' } });
  let file: string | null = null;
  try {
    const path = await dumpDatabase(opts.databaseUrl, opts.backupDir, 'nightly');
    file = path.split('/').pop() ?? path;
    const size = (await stat(path)).size;
    await db.backupRun.update({ where: { id: row.id }, data: { file, sizeBytes: size } });
    const gone = [...(await rotate(opts.backupDir, 'nightly', KEEP_NIGHTLY)), ...(await rotate(opts.backupDir, 'pre-migration', KEEP_PRE_MIGRATION))];
    // One retry: a sync finishing between the dump and the comparison is not a broken backup.
    let result = await restoreCheck(db, opts.databaseUrl, path);
    if (!result.ok) result = await restoreCheck(db, opts.databaseUrl, path);
    const check = result.ok ? 'ok' : 'failed';
    await db.backupRun.update({ where: { id: row.id }, data: { check, detail: result.detail, finishedAt: new Date() } });
    opts.log.info({ file, size, rotated: gone.length, check, detail: result.detail }, 'nightly backup');
    return { check, detail: result.detail, file };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.backupRun.update({ where: { id: row.id }, data: { check: 'error', detail, finishedAt: new Date() } });
    opts.log.error({ file, err: detail }, 'nightly backup failed');
    return { check: 'error', detail, file };
  }
}
