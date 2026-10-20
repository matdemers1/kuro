import { Media } from '../adapters/anilist.js';
import { loadOverrides } from '../overrides/overrides.js';
import type { Db } from '../db.js';
import { seasonIndex } from '../match/ranges.js';
import { groupShows, type EntryInfo, type GroupedShow, type Relation } from './grouping.js';
import { deriveShow, type EpisodeIn, type PlayIn } from './show.js';

/**
 * Rebuild every Show from scratch, in one transaction (KURO-ADR-004): the vault, the resolved
 * Crunchyroll catalog, the accepted mappings, the catalog entries they point at and AniList's
 * cached relations go in; `show`, `show_item` and `show_state` come out whole. Run after every sync,
 * resolve, match and owner change. Deterministic: same inputs, same rows.
 */

export interface ShowInputs {
  readonly show: GroupedShow;
  /** The main line, ranked by Season then catalog episode when matched. */
  readonly main: EpisodeIn[];
  /** Extras' episodes, and a matched season's episodes outside every range (recaps, an E0). */
  readonly extras: EpisodeIn[];
  readonly plays: PlayIn[];
  readonly description: string | null;
  /** The last Season is still airing, or a sequel is announced (KURO-T-2.7). */
  readonly moreComing: boolean;
  /** On the watchlist or a Crunchylist (KURO-T-3.5): with nothing watched, Plan to watch. */
  readonly plannedAt: Date | null;
}

/** Everything derivation needs, grouped into Shows. `only` narrows to one Show (the detail page). */
export async function loadShows(db: Db, userId: string, only?: string): Promise<ShowInputs[]> {
  const plays = await db.play.findMany({
    where: { syncRun: { crConnection: { userId } }, crParentType: 'series' },
    select: { crEpisodeId: true, crParentId: true, datePlayed: true, playheadS: true, fullyWatched: true },
  });
  const bySeries = new Map<string, PlayIn[]>();
  for (const p of plays) bySeries.set(p.crParentId, [...(bySeries.get(p.crParentId) ?? []), p]);
  const plannedAt = new Map<string, Date>();
  for (const p of await db.planEntry.findMany()) if (!plannedAt.has(p.crSeriesId) || (plannedAt.get(p.crSeriesId) ?? p.syncedAt) > p.syncedAt) plannedAt.set(p.crSeriesId, p.syncedAt);

  // Every resolved series, watched or not: one Crunchyroll split off a show (a Final Season) joins
  // its Show even before the owner starts it. Only Shows with something watched are kept.
  const series = await db.crSeries.findMany({ include: { seasons: { include: { episodes: true } } }, orderBy: { id: 'asc' } });
  const seasonSeries = new Map(series.flatMap((s) => s.seasons.map((x) => [x.id, s.id] as const)));

  // Accepted mappings only: a season still in review is shown on Crunchyroll's structure.
  const mappings = await db.mapping.findMany({ where: { crSeasonId: { in: [...seasonSeries.keys()] }, status: 'accepted' } });
  const entryRows = await db.catalogEntry.findMany({
    where: { id: { in: [...new Set(mappings.flatMap((m) => (m.catalogEntryId === null ? [] : [m.catalogEntryId])))] } },
    select: { id: true, title: true, synonyms: true, type: true, episodes: true, status: true, seasonYear: true, season: true, anilistId: true },
  });
  const entries = new Map<string, EntryInfo>(
    entryRows.map((e) => [e.id, { id: e.id, title: e.title, synonyms: e.synonyms, type: e.type, episodes: e.episodes, status: e.status, year: e.seasonYear, seasonIndex: seasonIndex(e.season), anilistId: e.anilistId }]),
  );
  const relations: Relation[] = [];
  const sequelsOf = new Map<number, number[]>();
  for (const row of await db.anilistMedia.findMany({ where: { anilistId: { in: entryRows.flatMap((e) => (e.anilistId === null ? [] : [e.anilistId])) } } })) {
    const m = Media.safeParse(row.payload);
    if (!m.success) continue;
    for (const edge of m.data.relations) {
      if (edge.node.type !== 'ANIME') continue;
      relations.push({ from: m.data.id, to: edge.node.id, type: edge.relationType });
      if (edge.relationType === 'SEQUEL') sequelsOf.set(m.data.id, [...(sequelsOf.get(m.data.id) ?? []), edge.node.id]);
    }
  }
  // Where the catalog says those sequels stand: an UPCOMING or ONGOING one means more is coming.
  const coming = new Set(
    (await db.catalogEntry.findMany({ where: { anilistId: { in: [...new Set([...sequelsOf.values()].flat())] }, status: { in: ['UPCOMING', 'ONGOING'] } }, select: { anilistId: true } })).flatMap((e) => (e.anilistId === null ? [] : [e.anilistId])),
  );

  const grouping = groupShows(
    series.map((s) => ({ id: s.id, title: s.title })),
    mappings.flatMap((m) => {
      const seriesId = seasonSeries.get(m.crSeasonId);
      return seriesId === undefined ? [] : [{ seriesId, seasonId: m.crSeasonId, entryId: m.catalogEntryId }];
    }),
    entries,
    relations,
    await loadOverrides(db),
  );

  const seriesById = new Map(series.map((s) => [s.id, s]));
  const mappingsBySeason = new Map<string, typeof mappings>();
  for (const m of mappings) mappingsBySeason.set(m.crSeasonId, [...(mappingsBySeason.get(m.crSeasonId) ?? []), m]);

  const out: ShowInputs[] = [];
  for (const show of grouping.shows) {
    if (only !== undefined && show.key !== only) continue;
    if (!show.seriesIds.some((id) => bySeries.has(id) || plannedAt.has(id))) continue;
    const position = new Map(show.items.map((i) => [i.entryId, i.position]));
    const matched = show.key.startsWith('show:');
    const main: EpisodeIn[] = [];
    const extras: EpisodeIn[] = [];
    const members = show.seriesIds.flatMap((id) => seriesById.get(id) ?? []);
    for (const s of members) {
      for (const season of s.seasons) {
        const ranges = mappingsBySeason.get(season.id) ?? [];
        const seq = season.seasonSequenceNumber ?? season.seasonNumber;
        for (const e of season.episodes) {
          const base: EpisodeIn = {
            id: e.id,
            canonicalId: e.canonicalId ?? e.id,
            seasonNumber: season.seasonNumber,
            seasonSequence: seq,
            sequenceNumber: e.sequenceNumber,
            episodeNumber: e.episodeNumber,
            title: e.title,
            durationS: e.durationS,
            audioLocale: e.audioLocale,
            airDate: e.airDate,
            creditsStartS: e.creditsStartS,
            seasonId: season.id,
            locales: e.audioLocales,
          };
          const n = e.episodeNumber;
          const range = n === null ? undefined : ranges.find((r) => n >= r.epFrom && n <= r.epTo);
          if (range !== undefined && range.catalogEntryId !== null && n !== null) {
            // An entry in another Show — split off, or attached elsewhere — is that Show's to count.
            const at = position.get(range.catalogEntryId);
            if (at === undefined) continue;
            const ranked = { ...base, rank: [at, n + range.offset] as const };
            if (grouping.kindOfEntry.get(range.catalogEntryId) === 'extra') extras.push(ranked);
            else main.push(ranked);
          } else if (grouping.showOfSeries.get(s.id) !== show.key) {
            // A series in two Shows after a split: its unplaced episodes stay with the one it came from.
            continue;
          } else if (ranges.some((r) => r.catalogEntryId !== null)) {
            // A matched season's episode outside every range — a recap, an episode 0: an extra.
            extras.push(base);
          } else if (matched) {
            // A season of a matched Show the catalog does not place: after everything that is placed.
            main.push({ ...base, rank: [10_000 + seq, e.sequenceNumber] });
          } else {
            main.push(base);
          }
        }
      }
    }
    const seasons = show.items.filter((i) => i.kind === 'season').flatMap((i) => entries.get(i.entryId) ?? []);
    const last = seasons.at(-1);
    const moreComing =
      (last !== undefined && (last.status === 'ONGOING' || last.status === 'UPCOMING')) ||
      seasons.some((e) => e.anilistId !== null && (sequelsOf.get(e.anilistId) ?? []).some((id) => coming.has(id) && !seasons.some((x) => x.anilistId === id)));
    out.push({
      show,
      main,
      extras,
      plays: show.seriesIds.flatMap((id) => bySeries.get(id) ?? []),
      description: members[0]?.description ?? null,
      moreComing,
      plannedAt: show.seriesIds.map((id) => plannedAt.get(id)).find((d) => d !== undefined) ?? null,
    });
  }
  return out;
}

export async function rebuildShows(db: Db, userId: string, now = new Date(), fallbackLocale = 'en-US'): Promise<number> {
  const inputs = await loadShows(db, userId);
  const prefs = await db.showPreference.findMany();
  const manualOf = new Map(prefs.flatMap((p) => (p.status === 'plan_to_watch' || p.status === 'dropped' ? [[p.showKey, { status: p.status, at: p.statusAt ?? p.updatedAt }] as const] : [])));
  const states = inputs.map(({ show, main, plays, moreComing, plannedAt }) => ({
    showKey: show.key,
    title: show.title,
    // The owner's own status first; a show on a Crunchyroll list is planned until watched.
    ...deriveShow(main, plays, now, fallbackLocale, { moreComing, manual: manualOf.get(show.key) ?? (plannedAt === null ? null : { status: 'plan_to_watch', at: plannedAt }) }),
    derivedAt: now,
  }));

  // A pin made while a Show was still its Crunchyroll series follows it into the matched Show.
  const pinned = new Set(prefs.filter((p) => p.pinned).map((p) => p.showKey));
  const carried = inputs.filter(({ show }) => !pinned.has(show.key) && show.seriesIds.some((id) => pinned.has(`cr:${id}`))).map(({ show }) => show.key);

  await db.$transaction([
    db.showItem.deleteMany({}),
    db.show.deleteMany({}),
    db.showState.deleteMany({}),
    db.show.createMany({ data: inputs.map(({ show }) => ({ showKey: show.key, title: show.title, franchiseKey: show.franchiseKey, seriesIds: [...show.seriesIds], derivedAt: now })) }),
    db.showItem.createMany({ data: inputs.flatMap(({ show }) => show.items.map((i) => ({ showKey: show.key, position: i.position, catalogEntryId: i.entryId, kind: i.kind, required: i.required }))) }),
    db.showState.createMany({ data: states }),
    ...carried.map((showKey) => db.showPreference.upsert({ where: { showKey }, create: { showKey, pinned: true }, update: { pinned: true } })),
  ]);
  return states.length;
}
