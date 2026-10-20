import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { latestRelease, readRelease, type CatalogSource, type Release } from './source.js';

/**
 * The weekly catalog import (KURO-REQ-025). Every entry in the newest release is upserted; an entry
 * that disappeared is retired, not deleted, so a mapping that points at it surfaces for a remap
 * instead of breaking (KURO-T-2.1). Ids are stable: an incoming entry takes the id of the existing
 * row it shares a source URL with, so a merge upstream that adds or drops a provider keeps the id.
 */

export interface ImportOutcome {
  readonly status: 'imported' | 'unchanged';
  readonly repo: string;
  readonly tag: string;
  readonly entries: number;
  readonly added: number;
  readonly retired: number;
}

const Raw = z.object({
  sources: z.array(z.string()).min(1),
  title: z.string().min(1),
  type: z.string().catch('UNKNOWN'),
  episodes: z.number().int().nonnegative().catch(0),
  status: z.string().catch('UNKNOWN'),
  animeSeason: z
    .object({ season: z.string().nullish().catch(null), year: z.number().int().nullish().catch(null) })
    .nullish()
    .catch(null),
  picture: z.string().nullish().catch(null),
  thumbnail: z.string().nullish().catch(null),
  duration: z.object({ value: z.number(), unit: z.string() }).nullish().catch(null),
  synonyms: z.array(z.string()).catch([]),
  relatedAnime: z.array(z.string()).catch([]),
  tags: z.array(z.string()).catch([]),
  studios: z.array(z.string()).catch([]),
});

export interface CatalogRow {
  id: string;
  title: string;
  type: string;
  episodes: number;
  status: string;
  season: string | null;
  season_year: number | null;
  duration_s: number | null;
  picture: string | null;
  thumbnail: string | null;
  synonyms: string[];
  sources: string[];
  related: string[];
  tags: string[];
  studios: string[];
  anilist_id: number | null;
  mal_id: number | null;
}

const idFrom = (sources: readonly string[], pattern: RegExp): number | null => {
  for (const s of sources) {
    const m = pattern.exec(s);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return null;
};
const ANILIST = /^https:\/\/anilist\.co\/anime\/(\d+)$/;
const MAL = /^https:\/\/myanimelist\.net\/anime\/(\d+)$/;
const SECONDS: Record<string, number> = { SECONDS: 1, MINUTES: 60, HOURS: 3600 };

/** A raw release record as a row, without its id; null for a record too broken to keep. */
export function normalise(raw: unknown): Omit<CatalogRow, 'id'> | null {
  const p = Raw.safeParse(raw);
  if (!p.success) return null;
  const r = p.data;
  const season = r.animeSeason?.season ?? null;
  const year = r.animeSeason?.year ?? null;
  return {
    title: r.title,
    type: r.type,
    episodes: r.episodes,
    status: r.status,
    season: season === null || season === 'UNDEFINED' ? null : season,
    season_year: year === null || year <= 0 ? null : year,
    duration_s: r.duration === null || r.duration === undefined ? null : Math.round(r.duration.value * (SECONDS[r.duration.unit] ?? 1)),
    picture: r.picture ?? null,
    thumbnail: r.thumbnail ?? null,
    synonyms: r.synonyms,
    sources: r.sources,
    related: r.relatedAnime,
    tags: r.tags,
    studios: r.studios,
    anilist_id: idFrom(r.sources, ANILIST),
    mal_id: idFrom(r.sources, MAL),
  };
}

/** The id a brand-new entry gets. */
export function freshId(row: Omit<CatalogRow, 'id'>): string {
  if (row.anilist_id !== null) return `anilist:${String(row.anilist_id)}`;
  if (row.mal_id !== null) return `mal:${String(row.mal_id)}`;
  return `src:${row.sources[0] ?? row.title}`;
}

const UPSERT = `
INSERT INTO catalog_entry (id, title, type, episodes, status, season, season_year, duration_s, picture, thumbnail,
                           synonyms, sources, related, tags, studios, anilist_id, mal_id, retired_at, release_id, updated_at)
SELECT x.id, x.title, x.type, x.episodes, x.status, x.season, x.season_year, x.duration_s, x.picture, x.thumbnail,
       x.synonyms, x.sources, x.related, x.tags, x.studios, x.anilist_id, x.mal_id, NULL, $2::uuid, now()
FROM jsonb_to_recordset($1::jsonb) AS x(id text, title text, type text, episodes int, status text, season text,
     season_year int, duration_s int, picture text, thumbnail text, synonyms text[], sources text[], related text[],
     tags text[], studios text[], anilist_id int, mal_id int)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, type = EXCLUDED.type, episodes = EXCLUDED.episodes, status = EXCLUDED.status,
  season = EXCLUDED.season, season_year = EXCLUDED.season_year, duration_s = EXCLUDED.duration_s,
  picture = EXCLUDED.picture, thumbnail = EXCLUDED.thumbnail, synonyms = EXCLUDED.synonyms, sources = EXCLUDED.sources,
  related = EXCLUDED.related, tags = EXCLUDED.tags, studios = EXCLUDED.studios, anilist_id = EXCLUDED.anilist_id,
  mal_id = EXCLUDED.mal_id, retired_at = NULL, release_id = EXCLUDED.release_id, updated_at = now()`;

const BATCH = 1000;

export async function importCatalog(db: Db, source: CatalogSource, log: Logger, opts: { force?: boolean } = {}): Promise<ImportOutcome> {
  const release = await latestRelease(source);
  const known = await db.catalogRelease.findUnique({ where: { repo_tag: { repo: release.repo, tag: release.tag } } });
  if (known !== null && opts.force !== true) {
    return { status: 'unchanged', repo: release.repo, tag: release.tag, entries: known.entries, added: 0, retired: 0 };
  }
  return importRelease(db, release, log);
}

export async function importRelease(db: Db, release: Release, log: Logger): Promise<ImportOutcome> {
  // Every source URL the catalog already knows, and the row it belongs to.
  const bySource = new Map<string, string>();
  const existing = new Set<string>();
  for (const e of await db.catalogEntry.findMany({ select: { id: true, sources: true } })) {
    existing.add(e.id);
    for (const s of e.sources) bySource.set(s, e.id);
  }

  const releaseId = randomUUID();
  const assigned = new Set<string>();
  let batch: CatalogRow[] = [];
  let entries = 0;
  let added = 0;
  let skipped = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await db.$executeRawUnsafe(UPSERT, JSON.stringify(batch), releaseId);
    batch = [];
  };

  for await (const raw of readRelease(release)) {
    const row = normalise(raw);
    if (row === null) {
      skipped++;
      continue;
    }
    // The existing row it shares a source with, unless another entry in this release took it.
    let id = row.sources.map((s) => bySource.get(s)).find((candidate) => candidate !== undefined && !assigned.has(candidate));
    if (id === undefined) {
      id = freshId(row);
      for (let n = 2; assigned.has(id); n++) id = `${freshId(row)}#${String(n)}`;
    }
    assigned.add(id);
    if (!existing.has(id)) added++;
    batch.push({ id, ...row });
    entries++;
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  if (entries === 0) throw new Error(`${release.repo} ${release.tag} held no catalog entries; nothing was retired`);

  const retired = await db.$executeRaw`UPDATE catalog_entry SET retired_at = now() WHERE retired_at IS NULL AND release_id <> ${releaseId}::uuid`;
  await db.catalogRelease.upsert({
    where: { repo_tag: { repo: release.repo, tag: release.tag } },
    create: { id: releaseId, repo: release.repo, tag: release.tag, publishedAt: release.publishedAt, entries, added, retired },
    update: { publishedAt: release.publishedAt, importedAt: new Date(), entries, added, retired },
  });
  log.info({ repo: release.repo, tag: release.tag, entries, added, retired, skipped }, 'catalog imported');
  return { status: 'imported', repo: release.repo, tag: release.tag, entries, added, retired };
}

/** The newest imported release, for the stale alert and the health panel. */
export function newestRelease(db: Db) {
  return db.catalogRelease.findFirst({ orderBy: { publishedAt: 'desc' } });
}
