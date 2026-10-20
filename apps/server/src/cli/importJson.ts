import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { importJson as runImport } from '../export/export.js';

/** `kuro import-json <file>` — read a Kurō export back in: plays the vault lacks, and the owner's choices (KURO-T-6.1). */
export async function importJson(args: readonly string[]): Promise<number> {
  const config = loadConfig();
  const file = args[0];
  if (config.DATABASE_URL === undefined || file === undefined) {
    console.error('usage: DATABASE_URL=… kuro import-json <export.json>');
    return 2;
  }
  const db = createDb(config.DATABASE_URL);
  try {
    const owner = await db.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (owner === null) {
      console.error('finish setup first: there is no owner to import into');
      return 1;
    }
    const out = await runImport(db, owner.id, JSON.parse(await readFile(file, 'utf8')) as unknown);
    await rebuildShows(db, owner.id);
    console.log(`imported ${String(out.added)} new plays of ${String(out.plays)}; Shows rebuilt`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}
