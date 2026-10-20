import { z } from 'zod';
import { CrSidecarError, type CrSidecar } from '../adapters/crunchyroll.js';
import * as connection from '../cr/connection.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import type { MediaSource } from '../match/pool.js';

/**
 * One sync run against Crunchyroll's watch history, into the History Vault (KURO-REQ-003..006).
 *
 * The `sync_run` row is the checkpoint: after every page is stored, `last_page` moves. A backfill
 * that dies — a crash, a block, a deploy — resumes after the last page it stored, and storing a page
 * twice is harmless because a Play is unique on (episode, date played). A delta stops at the first
 * page that holds nothing newer than the high-water mark.
 *
 * Crunchyroll's `total` on a watch-history page counts that page's items, not the whole history, so
 * it never ends a run: a short or empty page does. A page identical to the one before it means the
 * page parameter was ignored, and stops the run rather than looping over it.
 *
 * Crunchyroll refuses page numbers past 10 with a 400, however small the pages, so a backfill asks
 * for 1000 at a time (about 10,000 plays reachable) and reads that 400 as the end of what it will
 * serve, not a failure. The checkpoint is an offset — `last_page × page_size` — so a run started at
 * one page size resumes correctly at another.
 */

/** Pages a backfill asks for: Crunchyroll caps the page number, not the page size. */
export const BACKFILL_PAGE_SIZE = 1000;
/** A nightly delta rarely needs more than one small page. */
export const DELTA_PAGE_SIZE = 100;

export type SyncKind = 'backfill' | 'delta';

export interface SyncDeps {
  readonly db: Db;
  readonly sidecar: CrSidecar;
  readonly secretKey: string;
  readonly log: Logger;
  /** Pause between pages, to stay gentle with Crunchyroll (default 1.5 s). */
  readonly pauseMs?: number;
  /** Overrides both page sizes (tests). */
  readonly pageSize?: number;
  /** AniList for the matcher; without it, matching is skipped (tests that only sync). */
  readonly anilist?: MediaSource;
}

export type SyncOutcome =
  | { readonly status: 'succeeded'; readonly runId: string; readonly pages: number; readonly playsNew: number }
  | { readonly status: 'failed'; readonly runId: string; readonly kind: string; readonly message: string }
  | { readonly status: 'not_linked' };

const Entry = z.object({
  id: z.string().min(1),
  parent_id: z.string().default(''),
  parent_type: z.enum(['series', 'movie_listing']).catch('series'),
  date_played: z.iso.datetime({ offset: true }),
  playhead: z.number().int().nonnegative().catch(0),
  fully_watched: z.boolean().catch(false),
});

export async function runSync(deps: SyncDeps, userId: string, kind: SyncKind): Promise<SyncOutcome> {
  const conn = await deps.db.crConnection.findUnique({ where: { userId } });
  if (conn === null) return { status: 'not_linked' };

  // Resume an unfinished backfill rather than starting over.
  const unfinished =
    kind === 'backfill'
      ? await deps.db.syncRun.findFirst({ where: { crConnectionId: conn.id, kind: 'backfill', status: { in: ['running', 'failed'] } }, orderBy: { startedAt: 'desc' } })
      : null;
  const wanted = deps.pageSize ?? (kind === 'backfill' ? BACKFILL_PAGE_SIZE : DELTA_PAGE_SIZE);
  let run;
  if (unfinished !== null) {
    // Re-express the checkpoint in the wanted page size when it lands on a page boundary.
    const offset = unfinished.lastPage * unfinished.pageSize;
    const resize = offset % wanted === 0 ? { pageSize: wanted, lastPage: offset / wanted } : {};
    run = await deps.db.syncRun.update({ where: { id: unfinished.id }, data: { status: 'running', error: null, finishedAt: null, ...resize } });
  } else {
    run = await deps.db.syncRun.create({ data: { crConnectionId: conn.id, kind, pageSize: wanted } });
  }

  const pageSize = run.pageSize;
  const pause = deps.pauseMs ?? 1500;
  const highWater = conn.highWaterMark;
  let newest: Date | null = highWater;
  let page = run.lastPage + 1;
  let observed = run.playsObserved;
  let added = run.playsNew;
  let previousFirst: string | null = null;
  let note: string | null = null;

  try {
    for (;;) {
      const s = await connection.session(deps.db, deps.secretKey, userId);
      let result;
      try {
        result = await deps.sidecar.historyPage({ refreshToken: s.refreshToken, deviceId: s.deviceId, accountId: s.accountId, page, pageSize });
      } catch (err) {
        // Past the page cap Crunchyroll answers 400: everything it will serve is already stored.
        if (page > 1 && err instanceof CrSidecarError && err.kind === 'upstream' && /\b400\b/.test(err.message)) {
          note = `Crunchyroll serves no history past page ${String(page - 1)} of ${String(pageSize)}; older plays are out of reach.`;
          deps.log.warn({ runId: run.id, page, pageSize }, 'history page refused past the cap; ending the run');
          break;
        }
        throw err;
      }
      // Persist the rotated token before anything else: losing it means re-linking.
      await connection.rotate(deps.db, deps.secretKey, s.id, result.refreshToken);
      if (result.items.length === 0) break;
      const first = pageKey(result.items[0]);
      if (first !== null && first === previousFirst) {
        deps.log.warn({ runId: run.id, page }, 'history page repeats the one before it; stopping');
        break;
      }
      previousFirst = first;

      const plays = [];
      let pageOldest: Date | null = null;
      for (const raw of result.items) {
        const parsed = Entry.safeParse(raw);
        if (!parsed.success) continue;
        const e = parsed.data;
        const datePlayed = new Date(e.date_played);
        if (newest === null || datePlayed > newest) newest = datePlayed;
        if (pageOldest === null || datePlayed < pageOldest) pageOldest = datePlayed;
        plays.push({
          crEpisodeId: e.id,
          crParentId: e.parent_id,
          crParentType: e.parent_type,
          datePlayed,
          playheadS: e.playhead,
          fullyWatched: e.fully_watched,
          raw: raw as object,
          syncRunId: run.id,
        });
      }
      const { count } = await deps.db.play.createMany({ data: plays, skipDuplicates: true });
      observed += result.items.length;
      added += count;
      await deps.db.syncRun.update({
        where: { id: run.id },
        data: {
          lastPage: page,
          playsObserved: observed,
          playsNew: added,
          // Only a total larger than one page says anything about how many pages are left.
          ...(result.total !== null && result.total > result.items.length ? { pagesTotal: Math.ceil(result.total / pageSize) } : {}),
        },
      });
      deps.log.debug({ runId: run.id, page, stored: count }, 'history page stored');

      // History comes newest first: once a page reaches back to the mark, a delta has caught up.
      if (kind === 'delta' && highWater !== null && pageOldest !== null && pageOldest <= highWater) break;
      if (result.items.length < pageSize) break;
      page++;
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
  } catch (err) {
    const failure = err instanceof CrSidecarError ? err.kind : 'internal';
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.syncRun.update({ where: { id: run.id }, data: { status: 'failed', error: `${failure}: ${message}`.slice(0, 1000), finishedAt: new Date() } });
    if (failure === 'expired' || failure === 'blocked') {
      await deps.db.crConnection.update({
        where: { id: conn.id },
        data: { state: failure === 'expired' ? 'paused' : 'blocked', stateReason: message.slice(0, 500) },
      });
    }
    deps.log.warn({ runId: run.id, kind, failure, page }, 'sync failed');
    return { status: 'failed', runId: run.id, kind: failure, message };
  }

  // The mark is the newest play in the vault, not just this run's: a resumed backfill never saw the
  // pages before its checkpoint.
  const { _max } = await deps.db.play.aggregate({ where: { syncRun: { crConnectionId: conn.id } }, _max: { datePlayed: true } });
  const mark = _max.datePlayed ?? newest;
  await deps.db.$transaction([
    deps.db.syncRun.update({ where: { id: run.id }, data: { status: 'succeeded', finishedAt: new Date(), error: note } }),
    deps.db.crConnection.update({ where: { id: conn.id }, data: { state: 'linked', stateReason: null, lastSuccessAt: new Date(), highWaterMark: mark } }),
  ]);
  deps.log.info({ runId: run.id, kind, pages: page, playsNew: added }, 'sync succeeded');
  return { status: 'succeeded', runId: run.id, pages: page, playsNew: added };
}

function pageKey(raw: unknown): string | null {
  const e = Entry.safeParse(raw);
  return e.success ? `${e.data.id}@${e.data.date_played}` : null;
}

/** What the import screen and the sync health panel show. */
export async function latestRun(db: Db, userId: string) {
  const conn = await db.crConnection.findUnique({ where: { userId } });
  if (conn === null) return null;
  const run = await db.syncRun.findFirst({ where: { crConnectionId: conn.id }, orderBy: { startedAt: 'desc' } });
  const plays = await db.play.count({ where: { syncRun: { crConnectionId: conn.id } } });
  return run === null
    ? { run: null, plays }
    : {
        plays,
        run: {
          id: run.id,
          kind: run.kind,
          status: run.status,
          lastPage: run.lastPage,
          pagesTotal: run.pagesTotal,
          playsObserved: run.playsObserved,
          playsNew: run.playsNew,
          error: run.error,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          // Set once the run's plays are matched and Up Next rebuilt — the import is done for the owner.
          derivedAt: run.derivedAt?.toISOString() ?? null,
        },
      };
}
