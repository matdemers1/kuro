import { z } from 'zod';
import type { Db } from '../db.js';
import { entryProgress } from '../derive/progress.js';
import { loadShows } from '../derive/rebuild.js';
import { localDay } from '../stats/stats.js';

/**
 * Export (KURO-T-6.1): the owner's whole history as JSON — every play and every choice they made —
 * which `kuro import-json` reads back; the Shows and the plays as CSV for a spreadsheet; and a
 * MyAnimeList XML list, which AniList and MAL both import. Nothing derived is needed to restore:
 * Shows rebuild from what the JSON holds.
 */

export const EXPORT_FORMAT = 'kuro-export';
export const EXPORT_VERSION = 1;

const PlayRow = z.object({
  crEpisodeId: z.string().min(1),
  crParentId: z.string().min(1),
  crParentType: z.enum(['series', 'movie_listing']),
  datePlayed: z.iso.datetime({ offset: true }),
  playheadS: z.number().int().min(0),
  fullyWatched: z.boolean(),
  raw: z.unknown(),
});

export const KuroExport = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string(),
  plays: z.array(PlayRow),
  ratings: z.array(z.object({ target: z.string(), score: z.number().int().min(1).max(10) })).default([]),
  notes: z.array(z.object({ showKey: z.string(), text: z.string() })).default([]),
  preferences: z
    .array(z.object({ showKey: z.string(), pinned: z.boolean(), status: z.string().nullable(), statusAt: z.string().nullable(), dropReason: z.string().nullable(), skipFiller: z.boolean() }))
    .default([]),
  overrides: z.array(z.object({ id: z.string(), kind: z.string(), payload: z.unknown(), createdAt: z.string() })).default([]),
  mappings: z
    .array(z.object({ crSeasonId: z.string(), epFrom: z.number().int(), epTo: z.number().int(), catalogEntryId: z.string().nullable(), offset: z.number().int(), source: z.string(), autoEntryId: z.string().nullable() }))
    .default([]),
  rewatchQueue: z.array(z.object({ showKey: z.string(), position: z.number().int(), reason: z.string().nullable(), startEntryId: z.string().nullable() })).default([]),
  tasteTerms: z.array(z.object({ term: z.string(), adjust: z.enum(['boost', 'lower', 'mute']) })).default([]),
  dismissals: z.array(z.object({ catalogEntryId: z.string() })).default([]),
});
export type KuroExport = z.infer<typeof KuroExport>;

export async function exportJson(db: Db, userId: string, now = new Date()): Promise<KuroExport> {
  const [plays, ratings, notes, preferences, overrides, mappings, rewatchQueue, tasteTerms, dismissals] = await Promise.all([
    db.play.findMany({ where: { syncRun: { crConnection: { userId } } }, orderBy: [{ datePlayed: 'asc' }, { crEpisodeId: 'asc' }] }),
    db.rating.findMany({ orderBy: { target: 'asc' } }),
    db.showNote.findMany({ orderBy: { showKey: 'asc' } }),
    db.showPreference.findMany({ orderBy: { showKey: 'asc' } }),
    db.override.findMany({ orderBy: { createdAt: 'asc' } }),
    // Only the owner's answers: the matcher's own guesses are re-made on import.
    db.mapping.findMany({ where: { source: { in: ['confirmed', 'override'] } }, orderBy: [{ crSeasonId: 'asc' }, { epFrom: 'asc' }] }),
    db.rewatchQueueItem.findMany({ orderBy: { position: 'asc' } }),
    db.tasteTerm.findMany({ orderBy: { term: 'asc' } }),
    db.recDismissal.findMany({ orderBy: { catalogEntryId: 'asc' } }),
  ]);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    plays: plays.map((p) => ({ crEpisodeId: p.crEpisodeId, crParentId: p.crParentId, crParentType: p.crParentType, datePlayed: p.datePlayed.toISOString(), playheadS: p.playheadS, fullyWatched: p.fullyWatched, raw: p.raw })),
    ratings: ratings.map((r) => ({ target: r.target, score: r.score })),
    notes: notes.map((n) => ({ showKey: n.showKey, text: n.text })),
    preferences: preferences.map((p) => ({ showKey: p.showKey, pinned: p.pinned, status: p.status, statusAt: p.statusAt?.toISOString() ?? null, dropReason: p.dropReason, skipFiller: p.skipFiller })),
    overrides: overrides.map((o) => ({ id: o.id, kind: o.kind, payload: o.payload, createdAt: o.createdAt.toISOString() })),
    mappings: mappings.map((m) => ({ crSeasonId: m.crSeasonId, epFrom: m.epFrom, epTo: m.epTo, catalogEntryId: m.catalogEntryId, offset: m.offset, source: m.source, autoEntryId: m.autoEntryId })),
    rewatchQueue: rewatchQueue.map((q) => ({ showKey: q.showKey, position: q.position, reason: q.reason, startEntryId: q.startEntryId })),
    tasteTerms: tasteTerms.map((t) => ({ term: t.term, adjust: t.adjust as 'boost' | 'lower' | 'mute' })),
    dismissals: dismissals.map((d) => ({ catalogEntryId: d.catalogEntryId })),
  };
}

/**
 * Read an export back: plays the vault does not have are added under a new sync run of the owner's
 * Crunchyroll link (so the vault's append-only rule holds), and the owner's choices are restored.
 */
export async function importJson(db: Db, userId: string, data: unknown): Promise<{ plays: number; added: number }> {
  const x = KuroExport.parse(data);
  const conn = await db.crConnection.findUnique({ where: { userId } });
  if (conn === null) throw new Error('link Crunchyroll first: imported plays belong to a Crunchyroll link');
  const run = await db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'running', error: 'import from a Kurō export' } });
  let added = 0;
  for (let i = 0; i < x.plays.length; i += 1000) {
    const batch = x.plays.slice(i, i + 1000);
    added += (
      await db.play.createMany({
        data: batch.map((p) => ({ crEpisodeId: p.crEpisodeId, crParentId: p.crParentId, crParentType: p.crParentType, datePlayed: new Date(p.datePlayed), playheadS: p.playheadS, fullyWatched: p.fullyWatched, raw: (p.raw ?? {}), syncRunId: run.id })),
        skipDuplicates: true,
      })
    ).count;
  }
  await db.syncRun.update({ where: { id: run.id }, data: { status: 'succeeded', playsObserved: x.plays.length, playsNew: added, finishedAt: new Date(), error: null } });
  await db.$transaction([
    ...x.ratings.map((r) => db.rating.upsert({ where: { target: r.target }, create: r, update: { score: r.score } })),
    ...x.notes.map((n) => db.showNote.upsert({ where: { showKey: n.showKey }, create: n, update: { text: n.text } })),
    ...x.preferences.map((p) => {
      const row = { pinned: p.pinned, status: p.status, statusAt: p.statusAt === null ? null : new Date(p.statusAt), dropReason: p.dropReason, skipFiller: p.skipFiller };
      return db.showPreference.upsert({ where: { showKey: p.showKey }, create: { showKey: p.showKey, ...row }, update: row });
    }),
    ...x.overrides.map((o) => db.override.upsert({ where: { id: o.id }, create: { id: o.id, kind: o.kind, payload: (o.payload ?? {}), createdAt: new Date(o.createdAt) }, update: {} })),
    ...x.mappings.map((m) =>
      db.mapping.upsert({
        where: { crSeasonId_epFrom: { crSeasonId: m.crSeasonId, epFrom: m.epFrom } },
        create: { ...m, status: 'accepted', confidence: 'strong', signals: ['imported'], candidates: [] },
        update: { epTo: m.epTo, catalogEntryId: m.catalogEntryId, offset: m.offset, source: m.source, status: 'accepted', autoEntryId: m.autoEntryId },
      }),
    ),
    ...(x.rewatchQueue.length > 0 ? [db.rewatchQueueItem.deleteMany({}), db.rewatchQueueItem.createMany({ data: x.rewatchQueue })] : []),
    ...x.tasteTerms.map((t) => db.tasteTerm.upsert({ where: { term: t.term }, create: t, update: { adjust: t.adjust } })),
    db.recDismissal.createMany({ data: x.dismissals, skipDuplicates: true }),
  ]);
  return { plays: x.plays.length, added };
}

/** RFC 4180: quote a field when it holds a comma, quote or line break. */
const cell = (v: string | number | boolean | Date | null | undefined): string => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: readonly string[], rows: readonly (readonly (string | number | boolean | Date | null | undefined)[])[]) => [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export async function showsCsv(db: Db): Promise<string> {
  const [states, ratings, items] = await Promise.all([
    db.showState.findMany({ orderBy: { title: 'asc' } }),
    db.rating.findMany({ where: { target: { startsWith: 'show:' } } }),
    db.showItem.findMany({ where: { position: 0 }, select: { showKey: true, catalogEntryId: true } }),
  ]);
  const rating = new Map(ratings.map((r) => [r.target.slice('show:'.length), r.score]));
  const first = new Map(items.map((i) => [i.showKey, i.catalogEntryId]));
  const entries = new Map((await db.catalogEntry.findMany({ where: { id: { in: [...first.values()] } }, select: { id: true, anilistId: true, malId: true } })).map((e) => [e.id, e]));
  return csv(
    ['title', 'status', 'watched_episodes', 'total_episodes', 'rating', 'last_played', 'anilist_id', 'mal_id', 'show_key'],
    states.map((s) => {
      const e = entries.get(first.get(s.showKey) ?? '');
      return [s.title, s.status, s.watchedEpisodes, s.totalEpisodes, rating.get(s.showKey) ?? null, s.lastPlayedAt, e?.anilistId ?? null, e?.malId ?? null, s.showKey];
    }),
  );
}

export async function playsCsv(db: Db, userId: string): Promise<string> {
  const plays = await db.play.findMany({ where: { syncRun: { crConnection: { userId } } }, orderBy: [{ datePlayed: 'asc' }, { crEpisodeId: 'asc' }] });
  const episodes = new Map((await db.crEpisode.findMany({ where: { id: { in: [...new Set(plays.map((p) => p.crEpisodeId))] } }, include: { season: { include: { series: { select: { title: true } } } } } })).map((e) => [e.id, e]));
  return csv(
    ['date_played', 'series', 'season', 'episode', 'episode_title', 'audio', 'playhead_s', 'duration_s', 'fully_watched', 'cr_episode_id'],
    plays.map((p) => {
      const e = episodes.get(p.crEpisodeId);
      return [p.datePlayed, e?.season.series.title ?? null, e?.season.seasonNumber ?? null, e?.episodeNumber ?? null, e?.title ?? null, e?.audioLocale ?? null, p.playheadS, e?.durationS ?? null, p.fullyWatched, p.crEpisodeId];
    }),
  );
}

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const MAL_TYPE: Record<string, string> = { TV: 'TV', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special' };

export type MalStatus = 'Watching' | 'Completed' | 'On-Hold' | 'Dropped' | 'Plan to Watch';

/** One catalog entry's MAL status from its own progress and its Show's status; null leaves it off the list. */
export function malStatus(p: { watched: number; total: number }, entry: { episodes: number; status: string }, kind: string, showStatus: string): MalStatus | null {
  if (p.watched === 0) return kind === 'season' && showStatus !== 'dropped' ? 'Plan to Watch' : null;
  const all = Math.max(p.total, entry.episodes);
  if (p.watched >= all && entry.status === 'FINISHED') return 'Completed';
  if (showStatus === 'dropped') return 'Dropped';
  if (showStatus === 'paused') return 'On-Hold';
  return 'Watching';
}

/** MyAnimeList's export format, one <anime> per catalog entry with a MAL id. */
export async function malXml(db: Db, userId: string, tz: string): Promise<{ xml: string; entries: number; skipped: number }> {
  const inputs = await loadShows(db, userId);
  const states = new Map((await db.showState.findMany()).map((s) => [s.showKey, s]));
  const ratings = new Map((await db.rating.findMany()).map((r) => [r.target, r.score]));
  const rewatches = new Map<string, number>();
  for (const r of await db.rewatch.findMany({ where: { endedAt: { not: null } } })) rewatches.set(r.showKey, (rewatches.get(r.showKey) ?? 0) + 1);
  const ids = inputs.flatMap((i) => i.show.items.map((x) => x.entryId));
  const entries = new Map((await db.catalogEntry.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, type: true, episodes: true, status: true, malId: true } })).map((e) => [e.id, e]));
  const day = (d: Date | null) => (d === null ? '0000-00-00' : localDay(d, tz));
  const out: string[] = [];
  let skipped = 0;
  for (const show of inputs) {
    const state = states.get(show.show.key);
    if (state === undefined) continue;
    const progress = entryProgress(show);
    for (const item of show.show.items) {
      const e = entries.get(item.entryId);
      const p = progress.get(item.entryId) ?? { watched: 0, total: 0, firstWatchedAt: null, lastWatchedAt: null };
      const status = e === undefined ? null : malStatus(p, e, item.kind, state.status);
      if (e === undefined || status === null) continue;
      if (e.malId === null) {
        skipped += 1;
        continue;
      }
      const watched = e.episodes > 0 ? Math.min(p.watched, e.episodes) : p.watched;
      const score = ratings.get(`season:${e.id}`) ?? ratings.get(`show:${show.show.key}`) ?? 0;
      out.push(`  <anime>
    <series_animedb_id>${String(e.malId)}</series_animedb_id>
    <series_title>${cdata(e.title)}</series_title>
    <series_type>${MAL_TYPE[e.type] ?? 'Unknown'}</series_type>
    <series_episodes>${String(e.episodes)}</series_episodes>
    <my_id>0</my_id>
    <my_watched_episodes>${String(watched)}</my_watched_episodes>
    <my_start_date>${day(p.firstWatchedAt)}</my_start_date>
    <my_finish_date>${status === 'Completed' ? day(p.lastWatchedAt) : '0000-00-00'}</my_finish_date>
    <my_rated></my_rated>
    <my_score>${String(score)}</my_score>
    <my_storage></my_storage>
    <my_storage_value>0.00</my_storage_value>
    <my_status>${status}</my_status>
    <my_comments>${cdata('')}</my_comments>
    <my_times_watched>${String(status === 'Completed' ? (rewatches.get(show.show.key) ?? 0) : 0)}</my_times_watched>
    <my_rewatch_value></my_rewatch_value>
    <my_priority>LOW</my_priority>
    <my_tags>${cdata('')}</my_tags>
    <my_rewatching>0</my_rewatching>
    <my_rewatching_ep>0</my_rewatching_ep>
    <my_discuss>1</my_discuss>
    <my_sns>default</my_sns>
    <update_on_import>1</update_on_import>
  </anime>`);
    }
  }
  const counts = (s: MalStatus) => out.filter((a) => a.includes(`<my_status>${s}</my_status>`)).length;
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<!-- Exported by Kurō. ${String(skipped)} entries without a MyAnimeList id were left out. -->
<myanimelist>
  <myinfo>
    <user_id>0</user_id>
    <user_name>${cdata('kuro')}</user_name>
    <user_export_type>1</user_export_type>
    <user_total_anime>${String(out.length)}</user_total_anime>
    <user_total_watching>${String(counts('Watching'))}</user_total_watching>
    <user_total_completed>${String(counts('Completed'))}</user_total_completed>
    <user_total_onhold>${String(counts('On-Hold'))}</user_total_onhold>
    <user_total_dropped>${String(counts('Dropped'))}</user_total_dropped>
    <user_total_plantowatch>${String(counts('Plan to Watch'))}</user_total_plantowatch>
  </myinfo>
${out.join('\n')}
</myanimelist>
`;
  return { xml, entries: out.length, skipped };
}
