import { Media } from '../adapters/anilist.js';
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
}

/** Everything derivation needs, grouped into Shows. `only` narrows to one Show (the detail page). */
export async function loadShows(db: Db, userId: string, only?: string): Promise<ShowInputs[]> {
  const plays = await db.play.findMany({
    where: { syncRun: { crConnection: { userId } }, crParentType: 'series' },
    select: { crEpisodeId: true, crParentId: true, datePlayed: true, playheadS: true, fullyWatched: true },
  });
  const bySeries = new Map<string, PlayIn[]>();
  for (const p of plays) bySeries.set(p.crParentId, [...(bySeries.get(p.crParentId) ?? []), p]);

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
  for (const row of await db.anilistMedia.findMany({ where: { anilistId: { in: entryRows.flatMap((e) => (e.anilistId === null ? [] : [e.anilistId])) } } })) {
    const m = Media.safeParse(row.payload);
    if (!m.success) continue;
    for (const edge of m.data.relations) if (edge.node.type === 'ANIME') relations.push({ from: m.data.id, to: edge.node.id, type: edge.relationType });
  }

  const grouping = groupShows(
    series.map((s) => ({ id: s.id, title: s.title })),
    mappings.flatMap((m) => {
      const seriesId = seasonSeries.get(m.crSeasonId);
      return seriesId === undefined ? [] : [{ seriesId, seasonId: m.crSeasonId, entryId: m.catalogEntryId }];
    }),
    entries,
    relations,
  );

  const seriesById = new Map(series.map((s) => [s.id, s]));
  const mappingsBySeason = new Map<string, typeof mappings>();
  for (const m of mappings) mappingsBySeason.set(m.crSeasonId, [...(mappingsBySeason.get(m.crSeasonId) ?? []), m]);

  const out: ShowInputs[] = [];
  for (const show of grouping.shows) {
    if (only !== undefined && show.key !== only) continue;
    if (!show.seriesIds.some((id) => bySeries.has(id))) continue;
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
          };
          const n = e.episodeNumber;
          const range = n === null ? undefined : ranges.find((r) => n >= r.epFrom && n <= r.epTo);
          if (range !== undefined && range.catalogEntryId !== null && n !== null) {
            const ranked = { ...base, rank: [position.get(range.catalogEntryId) ?? 999, n + range.offset] as const };
            if (grouping.kindOfEntry.get(range.catalogEntryId) === 'extra') extras.push(ranked);
            else main.push(ranked);
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
    out.push({
      show,
      main,
      extras,
      plays: show.seriesIds.flatMap((id) => bySeries.get(id) ?? []),
      description: members[0]?.description ?? null,
    });
  }
  return out;
}

export async function rebuildShows(db: Db, userId: string, now = new Date(), fallbackLocale = 'en-US'): Promise<number> {
  const inputs = await loadShows(db, userId);
  const states = inputs.map(({ show, main, plays }) => ({ showKey: show.key, title: show.title, ...deriveShow(main, plays, now, fallbackLocale), derivedAt: now }));

  // A pin made while a Show was still its Crunchyroll series follows it into the matched Show.
  const prefs = await db.showPreference.findMany({ where: { pinned: true } });
  const pinned = new Set(prefs.map((p) => p.showKey));
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
