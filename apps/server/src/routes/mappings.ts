import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { rebuildShows } from '../derive/rebuild.js';
import { record } from '../domain/changelog.js';
import type { CatalogEntryRow } from '../match/pool.js';
import { mainEpisodes } from '../match/ranges.js';
import { loadCatalog } from '../match/run.js';
import type { TitleIndex } from '../match/titles.js';

/**
 * The match review queue (KURO-T-2.4): every season the matcher was not sure of, with its guess and
 * candidates, settled in one tap. Confirming keeps the matcher's ranges; choosing an entry maps the
 * whole season to it; "not in the catalog" keeps the season on Crunchyroll's own structure. Each
 * answer is the owner's from then on — `confirmed` or `override`, never touched by automation —
 * writes the change log, and can be undone (KURO-REQ-022).
 */

export interface EntrySummary {
  id: string;
  title: string;
  type: string;
  episodes: number;
  year: number | null;
  season: string | null;
  picture: string | null;
}

const summary = (e: { id: string; title: string; type: string; episodes: number; seasonYear: number | null; season: string | null; picture: string | null }): EntrySummary => ({
  id: e.id,
  title: e.title,
  type: e.type,
  episodes: e.episodes,
  year: e.seasonYear,
  season: e.season,
  picture: e.picture,
});
const ENTRY_FIELDS = { id: true, title: true, type: true, episodes: true, seasonYear: true, season: true, picture: true } as const;

/** What a season's mappings were, for the change log and undo. */
export type Snapshot = { epFrom: number; epTo: number; catalogEntryId: string | null; offset: number; source: string; status: string; confidence: string; signals: string[]; candidates: string[]; autoEntryId: string | null }[];

export async function snapshot(db: Db, seasonId: string): Promise<Snapshot> {
  return (await db.mapping.findMany({ where: { crSeasonId: seasonId }, orderBy: { epFrom: 'asc' } })).map((m) => ({
    epFrom: m.epFrom,
    epTo: m.epTo,
    catalogEntryId: m.catalogEntryId,
    offset: m.offset,
    source: m.source,
    status: m.status,
    confidence: m.confidence,
    signals: m.signals,
    candidates: m.candidates,
    autoEntryId: m.autoEntryId,
  }));
}

export async function restoreSeason(db: Db, seasonId: string, rows: Snapshot): Promise<void> {
  await db.$transaction([db.mapping.deleteMany({ where: { crSeasonId: seasonId } }), db.mapping.createMany({ data: rows.map((r) => ({ ...r, crSeasonId: seasonId })) })]);
}

/** A title index over the catalog, rebuilt only when a newer release has been imported. */
let cached: { releaseId: string; index: TitleIndex<CatalogEntryRow> } | null = null;
async function catalogIndex(db: Db): Promise<TitleIndex<CatalogEntryRow>> {
  const newest = await db.catalogRelease.findFirst({ orderBy: { importedAt: 'desc' }, select: { id: true } });
  const releaseId = newest?.id ?? 'none';
  if (cached?.releaseId !== releaseId) cached = { releaseId, index: (await loadCatalog(db)).index };
  return cached.index;
}

/** One entry, or several in watch order when the season spans them (a split cour). */
const Choose = z.union([z.object({ entryId: z.string().min(1).max(300) }), z.object({ entryIds: z.array(z.string().min(1).max(300)).min(1).max(8) })]);

export function mappingRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/review', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    void (async () => {
      const rows = await db.mapping.findMany({ where: { status: 'review' }, orderBy: [{ crSeasonId: 'asc' }, { epFrom: 'asc' }] });
      const seasonIds = [...new Set(rows.map((r) => r.crSeasonId))];
      const seasons = await db.crSeason.findMany({
        where: { id: { in: seasonIds } },
        include: { series: { select: { id: true, title: true } }, episodes: { select: { id: true, episodeNumber: true, sequenceNumber: true, durationS: true, airDate: true } } },
      });
      const entryIds = [...new Set(rows.flatMap((r) => [...(r.catalogEntryId === null ? [] : [r.catalogEntryId]), ...r.candidates]))];
      const entries = new Map((await db.catalogEntry.findMany({ where: { id: { in: entryIds } }, select: ENTRY_FIELDS })).map((e) => [e.id, summary(e)]));
      const plays = await db.play.groupBy({
        by: ['crEpisodeId'],
        where: { crEpisodeId: { in: seasons.flatMap((s) => s.episodes.map((e) => e.id)) }, syncRun: { crConnection: { userId } } },
        _count: { _all: true },
      });
      const playsByEpisode = new Map(plays.map((p) => [p.crEpisodeId, p._count._all]));

      const items = seasons.map((s) => {
        const mine = rows.filter((r) => r.crSeasonId === s.id);
        const candidates = [...new Set(mine.flatMap((r) => r.candidates))].flatMap((id) => entries.get(id) ?? []);
        return {
          seasonId: s.id,
          seriesId: s.series.id,
          seriesTitle: s.series.title,
          seasonTitle: s.title,
          plays: s.episodes.reduce((n, e) => n + (playsByEpisode.get(e.id) ?? 0), 0),
          /** Main-line episodes, counted as the matcher counts them: one per distinct number. */
          episodes: mainEpisodes(s.episodes.map((e) => ({ number: e.episodeNumber, sequence: e.sequenceNumber, durationS: e.durationS, airDate: e.airDate }))).length,
          ranges: mine.map((r) => ({ id: r.id, epFrom: r.epFrom, epTo: r.epTo, entry: r.catalogEntryId === null ? null : (entries.get(r.catalogEntryId) ?? null), signals: r.signals })),
          candidates,
        };
      });
      // Only what the owner has watched, most-played first: an unsure match on a season nobody has
      // started changes nothing yet. `?all=1` lists every unsure season.
      const all = req.query['all'] === '1';
      const shown = items.filter((i) => all || i.plays > 0).sort((a, b) => b.plays - a.plays || a.seriesTitle.localeCompare(b.seriesTitle) || a.seasonTitle.localeCompare(b.seasonTitle));
      res.json({ items: shown, total: shown.length, unwatched: items.length - items.filter((i) => i.plays > 0).length });
    })().catch(next);
  });

  /** Yes, that is it: the matcher's ranges, made the owner's. */
  router.post('/season/:seasonId/confirm', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    const seasonId = req.params['seasonId'];
    void (async () => {
      const before = await snapshot(db, seasonId);
      if (before.length === 0) {
        res.status(404).json({ error: 'nothing to confirm for that season' });
        return;
      }
      await db.mapping.updateMany({ where: { crSeasonId: seasonId }, data: { source: 'confirmed', status: 'accepted' } });
      await record(db, { userId, entity: 'mapping_season', entityId: seasonId, action: 'confirm', before, after: await snapshot(db, seasonId) });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  /**
   * It is this one — or these, in order: the season's episodes are split across the chosen entries
   * by their episode counts, the last taking whatever remains.
   */
  router.post('/season/:seasonId/choose', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    const seasonId = req.params['seasonId'];
    const parsed = Choose.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'entryId or entryIds is required' });
      return;
    }
    const ids = 'entryIds' in parsed.data ? parsed.data.entryIds : [parsed.data.entryId];
    void (async () => {
      const found = new Map((await db.catalogEntry.findMany({ where: { id: { in: ids } }, select: { id: true, episodes: true } })).map((e) => [e.id, e]));
      const entries = ids.flatMap((id) => found.get(id) ?? []);
      const before = await snapshot(db, seasonId);
      if (entries.length !== ids.length || before.length === 0) {
        res.status(404).json({ error: entries.length !== ids.length ? 'no such catalog entry' : 'nothing to change for that season' });
        return;
      }
      const episodes = await db.crEpisode.findMany({ where: { seasonId }, select: { episodeNumber: true, sequenceNumber: true, durationS: true, airDate: true } });
      const numbers = mainEpisodes(episodes.map((e) => ({ number: e.episodeNumber, sequence: e.sequenceNumber, durationS: e.durationS, airDate: e.airDate }))).map((e) => e.number);
      // No episodes stored (not resolved yet): the range the mappings already cover.
      const lo = Math.min(...before.map((r) => r.epFrom));
      const hi = Math.max(...before.map((r) => r.epTo));
      const all = numbers.length > 0 ? numbers : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      const after: Snapshot = [];
      let k = 0;
      for (const [i, e] of entries.entries()) {
        const take = i === entries.length - 1 || e.episodes === 0 ? all.length - k : Math.min(e.episodes, all.length - k);
        if (take <= 0) break;
        const epFrom = all[k] ?? 0;
        const epTo = all[k + take - 1] ?? epFrom;
        after.push({ epFrom, epTo, catalogEntryId: e.id, offset: 1 - epFrom, source: 'override', status: 'accepted', confidence: 'strong', signals: ['chosen by the owner'], candidates: before[0]?.candidates ?? [], autoEntryId: before[0]?.autoEntryId ?? null });
        k += take;
      }
      await restoreSeason(db, seasonId, after);
      await record(db, { userId, entity: 'mapping_season', entityId: seasonId, action: 'choose', before, after });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  /** Not in the catalog: the season stays on Crunchyroll's own structure, and stops asking. */
  router.post('/season/:seasonId/skip', (req, res, next) => {
    const userId = req.auth?.userId ?? '';
    const seasonId = req.params['seasonId'];
    void (async () => {
      const before = await snapshot(db, seasonId);
      if (before.length === 0) {
        res.status(404).json({ error: 'nothing to change for that season' });
        return;
      }
      const epFrom = Math.min(...before.map((r) => r.epFrom));
      const epTo = Math.max(...before.map((r) => r.epTo));
      const after: Snapshot = [{ epFrom, epTo, catalogEntryId: null, offset: 0, source: 'override', status: 'accepted', confidence: 'strong', signals: ['not in the catalog, says the owner'], candidates: before[0]?.candidates ?? [], autoEntryId: before[0]?.autoEntryId ?? null }];
      await restoreSeason(db, seasonId, after);
      await record(db, { userId, entity: 'mapping_season', entityId: seasonId, action: 'skip', before, after });
      await rebuildShows(db, userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

/** Catalog search for the review queue's "search the catalog". */
export function catalogRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);
  router.get('/search', (req, res, next) => {
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 200) : '';
    if (q.length < 2) {
      res.json({ items: [] });
      return;
    }
    void (async () => {
      const ids = (await catalogIndex(db)).search([q], 10).map((e) => e.id);
      const rows = new Map((await db.catalogEntry.findMany({ where: { id: { in: ids }, retiredAt: null }, select: ENTRY_FIELDS })).map((e) => [e.id, summary(e)]));
      res.json({ items: ids.flatMap((id) => rows.get(id) ?? []) });
    })().catch(next);
  });
  return router;
}
