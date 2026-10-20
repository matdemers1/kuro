import { normalise } from './titles.js';

/**
 * The matcher's core (KURO-ADR-003): a Crunchyroll season becomes one or more episode ranges, each
 * mapped to a catalog entry with an offset (catalog episode = Crunchyroll episode number + offset).
 * Pure: the runner gathers the pool of plausible entries, this decides.
 *
 * The shapes it has to survive, all in the owner's real history:
 *   - one season, one entry (Demon Slayer S1: 26 → Kimetsu no Yaiba, 26);
 *   - a split cour (SPY x FAMILY S1: 25 → Spy x Family 12 + Part 2 13);
 *   - absolute numbering (JUJUTSU KAISEN S2 runs E25–E47 → the 23-episode 2nd Season, offset −24);
 *   - a long-running entry across many seasons (One Piece's arcs, E1–E1180 → One Piece, offset 0);
 *   - a movie as a one-episode season (Mugen Train), and specials.
 *
 * A proposal is `strong` only when independent signals agree — an AniList Crunchyroll link to the
 * series, or an exact title, and the episode count and the year (ADR-003). Everything else is
 * `weak` and goes to the review queue with its candidates.
 */

export interface EpisodeIn {
  readonly number: number | null;
  readonly sequence: number;
  readonly durationS: number;
  readonly airDate: Date | null;
  /** The Canonical Episode it folds onto: a dub season shares these with the original. */
  readonly canonicalId?: string;
}

export interface SeasonIn {
  readonly id: string;
  readonly title: string;
  readonly episodes: readonly EpisodeIn[];
}

export type EntryType = 'TV' | 'ONA' | 'OVA' | 'MOVIE' | 'SPECIAL' | 'UNKNOWN';

export interface EntryIn {
  readonly id: string;
  readonly title: string;
  readonly synonyms: readonly string[];
  readonly type: string;
  readonly episodes: number;
  readonly status: string;
  readonly year: number | null;
  /** WINTER 0 … FALL 3, for ordering within a year. */
  readonly seasonIndex: number | null;
}

export interface Pool {
  /** Entries plausibly in this series, in watch order. */
  readonly entries: readonly EntryIn[];
  /** AniList links this Crunchyroll series to at least one of them. */
  readonly anchored: boolean;
  /** Entries on the anchored main line (AniList SEQUEL/PREQUEL from an anchor). */
  readonly mainLine: ReadonlySet<string>;
  /** Entries anywhere in the anchored franchise. */
  readonly franchise: ReadonlySet<string>;
  /** The Crunchyroll series title, for exact-title signals. */
  readonly seriesTitle: string;
}

export interface Proposal {
  readonly seasonId: string;
  readonly epFrom: number;
  readonly epTo: number;
  readonly entryId: string | null;
  readonly offset: number;
  readonly confidence: 'strong' | 'weak';
  readonly signals: readonly string[];
  /** For the review queue: the entries worth showing, best first. */
  readonly candidates: readonly string[];
}

const SEASON_INDEX: Record<string, number> = { WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3 };
export const seasonIndex = (s: string | null): number | null => (s === null ? null : (SEASON_INDEX[s] ?? null));

const TV_TYPES = new Set(['TV', 'ONA']);
const MOVIE_MIN_S = 45 * 60;

type Kind = 'tv' | 'movie' | 'special';

export function kindOf(season: SeasonIn, main: readonly EpisodeIn[]): Kind {
  if (/\b(movie|film|gekijou?ban)\b/i.test(season.title) && main.length <= 2) return 'movie';
  if (main.length === 1 && (main[0]?.durationS ?? 0) >= MOVIE_MIN_S) return 'movie';
  if (/\b(specials?|ova|oad|recap|picture drama|shorts?)\b/i.test(season.title)) return 'special';
  return 'tv';
}

/**
 * The season's main-line episodes: one per distinct episode number, the first in sequence order.
 * Crunchyroll repeats numbers for recaps and re-uploads (86 has 26 episodes numbered 1–23), so a
 * raw count never matches the catalog.
 */
export function mainEpisodes(episodes: readonly EpisodeIn[]): (EpisodeIn & { number: number })[] {
  const byNumber = new Map<number, EpisodeIn & { number: number }>();
  for (const e of [...episodes].sort((a, b) => a.sequence - b.sequence)) {
    if (e.number === null || byNumber.has(e.number)) continue;
    byNumber.set(e.number, { ...e, number: e.number });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** The median air year: one stray date (an episode listed as 2011 in a 2021 season) cannot move it. */
export function seasonYear(episodes: readonly EpisodeIn[]): number | null {
  const years = episodes.flatMap((e) => (e.airDate === null ? [] : [e.airDate.getUTCFullYear()])).sort((a, b) => a - b);
  return years.length === 0 ? null : (years[Math.floor(years.length / 2)] ?? null);
}

const yearsAgree = (entry: EntryIn, year: number | null) => year === null || entry.year === null || Math.abs(entry.year - year) <= 1;
/**
 * On the anchored main line, a Crunchyroll season may air years after its entry — an English dub of
 * a 2010 show released in 2022 — but never before it.
 */
const yearFits = (entry: EntryIn, year: number | null, pool: Pool) => (pool.anchored && pool.franchise.has(entry.id) ? year === null || entry.year === null || entry.year <= year + 1 : yearsAgree(entry, year));

function titleMatches(entry: EntryIn, titles: readonly string[]): boolean {
  const wanted = new Set(titles.map(normalise).filter((t) => t !== ''));
  return [entry.title, ...entry.synonyms].some((t) => wanted.has(normalise(t)));
}

/** Entries ordered for watching: by year, then season of the year, then title. */
export function watchOrder(a: EntryIn, b: EntryIn): number {
  return (a.year ?? 9999) - (b.year ?? 9999) || (a.seasonIndex ?? 4) - (b.seasonIndex ?? 4) || a.title.localeCompare(b.title);
}

/**
 * Every season of a series, in order — the matcher's entry point.
 *
 *   - A season sharing most of its canonical episodes with an earlier one, over the same numbers, is
 *     a dub or a remaster of it, and takes its answer.
 *   - An entry an earlier season used is not offered again (except a long-running entry, which
 *     spans seasons by design), and a later season is expected to start at the next unused entry on
 *     the main line: a run that starts anywhere else is weak unless the numbering puts it there.
 *   - A recap that repeats the previous season's last number, and a stray leading number (MHA's
 *     season 4 listing an "episode 1" before E64), are trimmed before counting.
 *   - If one range of a season is weak, the whole season is: its ranges stand or fall together.
 */
export function matchSeries(seasons: readonly SeasonIn[], pool: Pool, now = new Date()): Proposal[] {
  const used = new Set<string>();
  const line = mainLineOf(pool);
  const answered: { canon: Set<string>; range: string; title: string; proposals: Proposal[] }[] = [];
  const out: Proposal[] = [];
  let cursor: string | null = null;
  let prevMax: number | null = null;
  for (const season of seasons) {
    const canon = new Set(season.episodes.flatMap((e) => (e.canonicalId === undefined || e.canonicalId === '' ? [] : [e.canonicalId])));
    const main = trimmed(mainEpisodes(season.episodes), prevMax);
    if (main.length === 0) continue;
    const range = `${String(main[0]?.number)}-${String(main.at(-1)?.number)}-${String(main.length)}`;
    const twin = answered.find((a) => a.range === range && (overlap(canon, a.canon) >= 0.5 || (VERSION.test(season.title) && a.title === unversioned(season.title))));
    if (twin !== undefined) {
      out.push(...twin.proposals.map((p) => ({ ...p, seasonId: season.id, signals: [...p.signals, 'same episodes as an earlier season'] })));
      continue;
    }
    const keep = new Set(main.map((e) => e.sequence));
    // The first season starts at the earliest main-line entry of its own year — a 2019 remake is not
    // the 2001 original — or, failing that (a dub years later), at the top of the line.
    // A dub's dates are the dub's (Date A Live's 2013 season 1, dubbed onto Crunchyroll in 2022):
    // it starts at the top of the line.
    const year = seasonYear(main);
    const dub = DUB.test(season.title);
    const first = (dub ? undefined : line.find((e) => !used.has(e.id) && yearsAgree(e, year))) ?? line.find((e) => !used.has(e.id));
    let proposals = matchSeason({ ...season, episodes: season.episodes.filter((e) => keep.has(e.sequence)) }, pool, now, used, cursor ?? first?.id ?? null, answered.length === 0);
    // A recut with nothing to pair with is a different cut of the story: the owner places it.
    if (RECUT.test(season.title)) proposals = proposals.map((p) => ({ ...p, confidence: 'weak', signals: [...p.signals, 'a recut of episodes shown elsewhere'] }));
    if (proposals.some((p) => p.confidence === 'weak')) proposals = proposals.map((p) => (p.confidence === 'weak' ? p : { ...p, confidence: 'weak', signals: [...p.signals, 'another range of this season is weak'] }));
    for (const p of proposals) if (p.entryId !== null && !p.signals.includes('long-running entry')) used.add(p.entryId);
    // The next season is expected to start after the furthest main-line entry used so far.
    const furthest = Math.max(-1, ...proposals.map((p) => line.findIndex((e) => e.id === p.entryId)));
    if (furthest >= 0) cursor = line[furthest + 1]?.id ?? null;
    prevMax = Math.max(prevMax ?? 0, ...main.map((e) => e.number));
    answered.push({ canon, range, title: unversioned(season.title), proposals });
    out.push(...proposals);
  }
  return out;
}

/** Titles Crunchyroll gives another version of the same episodes. */
const VERSION_WORDS = String.raw`\b(uncensored|director'?s cut|special edition|remaster(ed)?|subtitled|dub(bed)?|english|edited|hd|version)\b`;
const VERSION = new RegExp(VERSION_WORDS, 'i');
const DUB = /\b(dub|dubbed)\b/i;
const RECUT = /\b(director'?s cut|episodic cut|remaster(ed)?|re-?edited|recap)\b/i;
/** The title without its version words: twins have the same one. */
const unversioned = (title: string) => normalise(title.replace(new RegExp(VERSION_WORDS, 'gi'), ' '));

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / a.size;
};

/** Drop a stray leading number, and a recap repeating the previous season's last number. */
function trimmed<T extends { number: number }>(main: readonly T[], prevMax: number | null): T[] {
  // Episode 0 is a prologue (Attack on Titan, SAO II): an extra, not part of the season's count.
  let out = main.length > 1 ? main.filter((e) => e.number !== 0) : [...main];
  while (out.length > 3 && (out[1]?.number ?? 0) - (out[0]?.number ?? 0) > 2) out = out.slice(1);
  const first = out[0]?.number ?? 0;
  if (prevMax !== null && first > 1 && first <= prevMax) {
    const rest = out.filter((e) => e.number > prevMax);
    if (rest.length > 0) out = rest;
  }
  return out;
}

/** The anchored main line's seasons in watch order — TV, and ONAs long enough to be seasons. */
export function mainLineOf(pool: Pool): EntryIn[] {
  // A short ONA on the sequel chain (Slime's three-episode Coleus no Yume) is a side story, not a
  // season: it would throw off every position after it.
  return pool.entries.filter((e) => (e.type === 'TV' || (e.type === 'ONA' && e.episodes >= 8)) && (!pool.anchored || pool.mainLine.has(e.id))).sort(watchOrder);
}

/**
 * One season. `expected` is the main-line entry the season should start at — the next one after
 * those earlier seasons used; a run starting anywhere else is weak unless the numbering places it.
 * `opening` says no earlier season of the series was matched.
 */
export function matchSeason(season: SeasonIn, pool: Pool, now = new Date(), used: ReadonlySet<string> = new Set(), expected: string | null = null, opening = true): Proposal[] {
  const main = mainEpisodes(season.episodes);
  if (main.length === 0) return [];
  const first = main[0];
  const last = main[main.length - 1];
  if (first === undefined || last === undefined) return [];
  const kind = kindOf(season, main);
  const year = seasonYear(main);
  const titles = [season.title, pool.seriesTitle];
  const ranked = rankCandidates(pool.entries, kind, main.length, year, titles);
  const weak = (signals: string[]): Proposal[] => [
    { seasonId: season.id, epFrom: first.number, epTo: last.number, entryId: ranked[0]?.id ?? null, offset: 1 - first.number, confidence: 'weak', signals, candidates: ranked.slice(0, 6).map((e) => e.id) },
  ];

  if (kind !== 'tv') {
    const types = kind === 'movie' ? new Set(['MOVIE']) : new Set(['SPECIAL', 'OVA', 'ONA', 'TV']);
    const fits = pool.entries.filter((e) => !used.has(e.id) && types.has(e.type) && yearFits(e, year, pool) && (kind === 'movie' || e.episodes === main.length));
    const exact = fits.filter((e) => titleMatches(e, [season.title]));
    const inFranchise = fits.filter((e) => pool.franchise.has(e.id));
    const pick = exact[0] ?? (inFranchise.length === 1 ? inFranchise[0] : undefined);
    if (pick === undefined) return weak([`${kind}: no single entry fits`]);
    const signals = [kind, exact[0] === pick ? 'exact title' : 'only fit in the anchored franchise', 'year agrees'];
    const strong = exact[0] === pick || (pool.anchored && inFranchise.length === 1);
    return [{ seasonId: season.id, epFrom: first.number, epTo: last.number, entryId: pick.id, offset: 1 - first.number, confidence: strong ? 'strong' : 'weak', signals, candidates: ranked.slice(0, 6).map((e) => e.id) }];
  }

  const line = mainLineOf(pool);

  // A long-running entry: absolute numbering that fits inside one entry (One Piece).
  // A long-running entry holds many Crunchyroll seasons (One Piece's arcs, Black Clover's parts):
  // absolute numbering inside it, or season 1 when it is the expected entry and far bigger.
  const long = line.find((e) => {
    const holds = e.episodes === 0 ? e.status === 'ONGOING' : e.episodes >= last.number;
    if (!holds || e.episodes === main.length) return false;
    return first.number > 1 || (opening && e.id === expected && (e.episodes === 0 || e.episodes >= main.length * 1.5));
  });
  if (long !== undefined && (pool.anchored || titleMatches(long, titles))) {
    return [{ seasonId: season.id, epFrom: first.number, epTo: last.number, entryId: long.id, offset: 0, confidence: 'strong', signals: ['long-running entry', 'absolute numbering', pool.anchored ? 'AniList links this series' : 'exact title'], candidates: [long.id] }];
  }

  // Where each main-line entry starts, counting episodes from the top: with continuous numbering
  // (season 2 starting at E26) the run has to start exactly there.
  const startsAt = new Map<string, number>();
  let position = 1;
  for (const e of line) {
    startsAt.set(e.id, position);
    position += e.episodes;
  }
  const continuous = first.number > 1;

  // A run of consecutive main-line entries whose episodes add up to the season (split cours too).
  const runs: { entries: EntryIn[]; tail: boolean; positioned: boolean; inOrder: boolean; extra?: boolean }[] = [];
  for (let i = 0; i < line.length; i++) {
    const start = line[i];
    if (start === undefined || used.has(start.id) || !yearFits(start, year, pool)) continue;
    const positioned = continuous && startsAt.get(start.id) === first.number;
    if (continuous && !positioned && [...startsAt.values()].includes(first.number)) continue;
    let sum = 0;
    const run: EntryIn[] = [];
    for (let j = i; j < line.length && sum < main.length; j++) {
      const e = line[j];
      if (e === undefined || used.has(e.id)) break;
      run.push(e);
      sum += e.episodes;
    }
    // The season is still airing: Crunchyroll has fewer episodes than the newest entry will.
    const airing = run.at(-1)?.status === 'ONGOING' || (run.at(-1)?.year ?? 0) >= now.getUTCFullYear() - 1;
    const inOrder = expected === null || start.id === expected;
    if (sum === main.length) runs.push({ entries: run, tail: false, positioned, inOrder });
    // Crunchyroll often appends an OVA or unaired episode: one more than the catalog, in order only.
    else if (sum === main.length - 1 && main.length >= 10 && inOrder && pool.anchored) runs.push({ entries: run, tail: false, positioned, inOrder, extra: true });
    else if (sum > main.length && airing && sum - (run.at(-1)?.episodes ?? 0) < main.length) runs.push({ entries: run, tail: true, positioned, inOrder });
  }
  const best = runs.sort((a, b) => Number(b.positioned) - Number(a.positioned) || Number(b.inOrder) - Number(a.inOrder) || Number(a.extra ?? false) - Number(b.extra ?? false) || Math.abs((a.entries[0]?.year ?? 0) - (year ?? 0)) - Math.abs((b.entries[0]?.year ?? 0) - (year ?? 0)) || a.entries.length - b.entries.length)[0];
  // No run fits. Matching on episode count alone would pick any same-sized entry — season 1's first
  // cour for season 2, say — so the owner decides.
  if (best === undefined) return weak(['no run of entries adds up to the season']);

  const proposals: Proposal[] = [];
  let k = 0;
  for (const [i, entry] of best.entries.entries()) {
    const isLast = i === best.entries.length - 1;
    const take = isLast ? main.length - k : entry.episodes;
    const from = main[k];
    const to = main[k + take - 1];
    if (from === undefined || to === undefined) break;
    const rangeYear = seasonYear(main.slice(k, k + take));
    const signals = [best.extra === true ? 'one more episode on Crunchyroll than in the catalog' : 'episode count agrees', best.entries.length > 1 ? `split across ${String(best.entries.length)} entries` : 'one entry', ...(best.positioned ? ['numbering agrees'] : []), ...(best.tail && isLast ? ['still airing'] : [])];
    const p = strongOrWeak(season.id, from.number, to.number, entry, 1 - from.number, signals, pool, titles, ranked);
    const placed = best.positioned || best.inOrder;
    proposals.push(
      !yearFits(entry, rangeYear, pool) ? { ...p, confidence: 'weak', signals: [...p.signals, 'range year disagrees'] }
      : !placed ? { ...p, confidence: 'weak', signals: [...p.signals, 'not the next season on the main line'] }
      : p,
    );
    k += take;
  }
  return proposals;
}

function strongOrWeak(seasonId: string, from: number, to: number, entry: EntryIn, offset: number, signals: string[], pool: Pool, titles: readonly string[], ranked: readonly EntryIn[]): Proposal {
  const anchored = pool.anchored && pool.mainLine.has(entry.id);
  const exact = titleMatches(entry, titles);
  const strong = anchored || exact;
  return {
    seasonId,
    epFrom: from,
    epTo: to,
    entryId: entry.id,
    offset,
    confidence: strong ? 'strong' : 'weak',
    signals: [...signals, ...(anchored ? ['AniList links this series'] : []), ...(exact ? ['exact title'] : []), ...(strong ? [] : ['no independent title or link'])],
    candidates: [entry.id, ...ranked.filter((e) => e.id !== entry.id).slice(0, 5).map((e) => e.id)],
  };
}

/** The pool ranked for a reviewer: right type, right size, right year, then title. */
function rankCandidates(entries: readonly EntryIn[], kind: Kind, count: number, year: number | null, titles: readonly string[]): EntryIn[] {
  const score = (e: EntryIn) =>
    (kind === 'movie' ? (e.type === 'MOVIE' ? 3 : 0) : TV_TYPES.has(e.type) ? 3 : 1) +
    (e.episodes === count ? 3 : 0) +
    (yearsAgree(e, year) ? 2 : 0) +
    (titleMatches(e, titles) ? 2 : 0);
  return [...entries].sort((a, b) => score(b) - score(a) || watchOrder(a, b));
}
