import { z } from 'zod';
import type { CrSidecar } from '../adapters/crunchyroll.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import * as connection from './connection.js';

/**
 * Resolve what the vault's plays point at (KURO-T-1.4): each series, its seasons (Crunchyroll
 * makes one per audio language) and their episodes, mirrored into cr_series / cr_season /
 * cr_episode. Dub and sub variants of an episode fold onto one Canonical Episode — the `original`
 * version's ID (KURO-REQ-012) — and episodes with plays get their credits marker (KURO-REQ-011).
 */

const SERIES_TTL_MS = 20 * 60 * 60 * 1000;
const RECENT_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Every series is looked at again weekly, however long ago it was watched: that is how a new season
 * or dub of a Completed Show is found and brings it back to Up Next (KURO-T-3.3).
 */
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

const Version = z.object({ guid: z.string(), original: z.boolean().catch(false), audio_locale: z.string().nullish() });
const Episode = z.object({
  id: z.string(),
  title: z.string().catch(''),
  episode_number: z.number().int().nullish(),
  sequence_number: z.number().catch(0),
  duration_ms: z.number().catch(0),
  audio_locale: z.string().nullish(),
  episode_air_date: z.string().nullish(),
  versions: z.array(Version).nullish(),
});
const Season = z.object({
  id: z.string(),
  title: z.string().catch(''),
  season_number: z.number().int().catch(0),
  season_sequence_number: z.number().nullish(),
  audio_locale: z.string().nullish(),
});
const Series = z.object({ id: z.string(), title: z.string().catch(''), slug_title: z.string().nullish(), description: z.string().nullish() });
const Data = z.object({ data: z.array(z.unknown()) });
const Credits = z.object({ start: z.number() });

export interface ResolveDeps {
  readonly db: Db;
  readonly sidecar: CrSidecar;
  readonly secretKey: string;
  readonly log: Logger;
  readonly pauseMs?: number;
}

/** The ID every audio version of an episode shares: the original's, else the smallest. */
export function canonicalId(episode: { id: string; versions?: { guid: string; original: boolean }[] | null | undefined }): string {
  const versions = episode.versions ?? [];
  const original = versions.find((v) => v.original);
  if (original !== undefined) return original.guid;
  const guids = [episode.id, ...versions.map((v) => v.guid)].sort();
  return guids[0] ?? episode.id;
}

/**
 * Series, seasons and episodes for what the vault points at. Credits markers are a separate pass
 * (`resolveMarkers`): there are as many as there are watched episodes, and Up Next should not wait
 * on them.
 */
export async function resolveCatalog(deps: ResolveDeps, userId: string, now = new Date()): Promise<{ series: number; episodes: number }> {
  const pause = deps.pauseMs ?? 300;
  const wait = () => (pause > 0 ? new Promise((r) => setTimeout(r, pause)) : Promise.resolve());

  const mine = { syncRun: { crConnection: { userId } } };
  const played = await deps.db.play.groupBy({ by: ['crParentId'], where: { ...mine, crParentType: 'series', crParentId: { not: '' } }, _max: { datePlayed: true } });
  // Series on the watchlist or a Crunchylist are resolved too: they are Shows to watch (KURO-T-3.5).
  const planned = (await deps.db.planEntry.findMany({ select: { crSeriesId: true }, distinct: ['crSeriesId'] })).filter((p) => !played.some((x) => x.crParentId === p.crSeriesId));
  const parents = [...played, ...planned.map((p) => ({ crParentId: p.crSeriesId, _max: { datePlayed: null as Date | null } }))];
  const known = new Map((await deps.db.crSeries.findMany({ select: { id: true, fetchedAt: true } })).map((s) => [s.id, s.fetchedAt]));
  const due = parents.filter((p) => {
    const fetched = known.get(p.crParentId);
    if (fetched === undefined) return true;
    // Series watched lately are refreshed daily, so new episodes and seasons show up; the rest weekly.
    const recent = (p._max.datePlayed?.getTime() ?? 0) > now.getTime() - RECENT_MS;
    const age = now.getTime() - fetched.getTime();
    return age > (recent ? SERIES_TTL_MS : WEEKLY_MS);
  });

  let episodes = 0;
  const cms = async (path: string) => {
    const s = await connection.session(deps.db, deps.secretKey, userId);
    const result = await deps.sidecar.cms({ refreshToken: s.refreshToken, deviceId: s.deviceId, path });
    await connection.rotate(deps.db, deps.secretKey, s.id, result.refreshToken);
    await wait();
    return Data.parse(result.body).data;
  };

  for (const { crParentId: seriesId } of due) {
    const [rawSeries] = await cms(`series/${seriesId}`);
    const series = Series.safeParse(rawSeries);
    if (!series.success) continue;
    await deps.db.crSeries.upsert({
      where: { id: seriesId },
      create: { id: seriesId, title: series.data.title, slugTitle: series.data.slug_title ?? null, description: series.data.description ?? null, raw: rawSeries as object },
      update: { title: series.data.title, slugTitle: series.data.slug_title ?? null, description: series.data.description ?? null, raw: rawSeries as object, fetchedAt: now },
    });
    for (const rawSeason of await cms(`series/${seriesId}/seasons`)) {
      const season = Season.safeParse(rawSeason);
      if (!season.success) continue;
      const s = season.data;
      const seasonData = { seriesId, title: s.title, seasonNumber: s.season_number, seasonSequenceNumber: s.season_sequence_number ?? null, audioLocale: s.audio_locale ?? null, raw: rawSeason as object, fetchedAt: now };
      await deps.db.crSeason.upsert({ where: { id: s.id }, create: { id: s.id, ...seasonData }, update: seasonData });
      for (const rawEpisode of await cms(`seasons/${s.id}/episodes`)) {
        const episode = Episode.safeParse(rawEpisode);
        if (!episode.success) continue;
        const e = episode.data;
        const data = {
          seasonId: s.id,
          title: e.title,
          episodeNumber: e.episode_number ?? null,
          sequenceNumber: e.sequence_number,
          durationS: Math.round(e.duration_ms / 1000),
          audioLocale: e.audio_locale ?? s.audio_locale ?? null,
          audioLocales: [...new Set([...(e.versions ?? []).flatMap((v) => (v.audio_locale ? [v.audio_locale] : [])), ...(e.audio_locale ? [e.audio_locale] : [])])],
          airDate: e.episode_air_date ? new Date(e.episode_air_date) : null,
          canonicalId: canonicalId(e),
          raw: rawEpisode as object,
          fetchedAt: now,
        };
        await deps.db.crEpisode.upsert({ where: { id: e.id }, create: { id: e.id, ...data }, update: data });
        episodes++;
      }
    }
  }

  deps.log.info({ series: due.length, episodes }, 'catalog resolved');
  return { series: due.length, episodes };
}

/** Credits markers for episodes with plays, asked for once each (KURO-REQ-011). */
export async function resolveMarkers(deps: ResolveDeps, userId: string, now = new Date()): Promise<{ checked: number; markers: number }> {
  const pause = deps.pauseMs ?? 300;
  const wait = () => (pause > 0 ? new Promise((r) => setTimeout(r, pause)) : Promise.resolve());
  const mine = { syncRun: { crConnection: { userId } } };
  const played = await deps.db.play.findMany({ where: mine, distinct: ['crEpisodeId'], select: { crEpisodeId: true } });
  const needMarkers = await deps.db.crEpisode.findMany({ where: { id: { in: played.map((p) => p.crEpisodeId) }, skipCheckedAt: null }, select: { id: true } });
  let markers = 0;
  let checked = 0;
  for (const { id } of needMarkers) {
    const events = await deps.sidecar.skipEvents(id).catch(() => undefined);
    if (events === undefined) continue; // a transient failure: try again next run
    const credits = Credits.safeParse(events?.['credits']);
    const start = credits.success ? Math.floor(credits.data.start) : null;
    await deps.db.crEpisode.update({ where: { id }, data: { creditsStartS: start, skipCheckedAt: now } });
    checked++;
    if (start !== null) markers++;
    await wait();
  }

  deps.log.info({ checked, markers }, 'credits markers resolved');
  return { checked, markers };
}
