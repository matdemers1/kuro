/**
 * The derivation engine, v1 (KURO-T-1.5, KURO-ADR-004): a pure function from what Crunchyroll
 * knows and what the owner watched to a Show's state. No I/O here — rebuild.ts gathers inputs and
 * writes outputs — so every rule is golden-testable and two rebuilds are identical by construction.
 */

import { deriveStatus, type ManualStatus, type ShowStatus } from './status.js';

export { PAUSED_AFTER_MS } from './status.js';
export const WATCHED_FRACTION = 0.9; // when Crunchyroll publishes no credits marker

export interface EpisodeIn {
  readonly id: string;
  readonly canonicalId: string;
  readonly seasonNumber: number;
  readonly seasonSequence: number;
  readonly sequenceNumber: number;
  readonly episodeNumber: number | null;
  readonly title: string;
  readonly durationS: number;
  readonly audioLocale: string | null;
  readonly airDate: Date | null;
  readonly creditsStartS: number | null;
  /**
   * Where a matched episode falls in its Show (KURO-T-2.5): its Season's position, then its catalog
   * episode number. When set it orders the Show instead of Crunchyroll's season numbers, so a show
   * Crunchyroll split across series, or numbered oddly, still runs in watch order.
   */
  readonly rank?: readonly [number, number];
  /** The Crunchyroll season it is in; with rank, what "a new season" means. */
  readonly seasonId?: string;
}

export interface PlayIn {
  readonly crEpisodeId: string;
  readonly datePlayed: Date;
  readonly playheadS: number;
  readonly fullyWatched: boolean;
}

export type Status = ShowStatus;

/** What derivation needs beyond episodes and plays (KURO-T-2.7). */
export interface DeriveOptions {
  /** The current Season is still airing, or a sequel is announced: "Caught up", not "Completed". */
  readonly moreComing?: boolean;
  /** The owner's own status: Plan to watch or Dropped. */
  readonly manual?: { readonly status: ManualStatus; readonly at: Date } | null;
}

export interface ShowOut {
  readonly status: Status;
  readonly watchedEpisodes: number;
  readonly totalEpisodes: number;
  readonly remainingS: number;
  readonly currentSeason: number | null;
  readonly currentEpisode: number | null;
  readonly nextSeason: number | null;
  readonly nextEpisode: number | null;
  readonly nextCrEpisodeId: string | null;
  readonly nextAudioLocale: string | null;
  readonly nextTitle: string | null;
  readonly nextIsNew: boolean;
  readonly nextIsNewSeason: boolean;
  readonly lastPlayedAt: Date | null;
}

/** Watched: Crunchyroll says so, or the playhead passed the credits, or 90% with no marker (KURO-REQ-011). */
export function isWatched(play: PlayIn, episode: Pick<EpisodeIn, 'durationS' | 'creditsStartS'>): boolean {
  if (play.fullyWatched) return true;
  if (episode.creditsStartS !== null) return play.playheadS >= episode.creditsStartS;
  return episode.durationS > 0 && play.playheadS >= episode.durationS * WATCHED_FRACTION;
}

interface Canonical {
  readonly id: string;
  /** The version whose ID is the canonical one — its season and number order the Show. */
  readonly primary: EpisodeIn;
  readonly versions: readonly EpisodeIn[];
}

function canonicalEpisodes(episodes: readonly EpisodeIn[]): Canonical[] {
  const groups = new Map<string, EpisodeIn[]>();
  for (const e of episodes) {
    const list = groups.get(e.canonicalId) ?? [];
    list.push(e);
    groups.set(e.canonicalId, list);
  }
  const out: Canonical[] = [];
  for (const [id, versions] of groups) {
    const sorted = [...versions].sort((a, b) => a.id.localeCompare(b.id));
    const primary = sorted.find((v) => v.id === id) ?? sorted[0];
    if (primary !== undefined) out.push({ id, primary, versions: sorted });
  }
  return out.sort(
    (a, b) =>
      compareRank(a.primary.rank, b.primary.rank) ||
      a.primary.seasonSequence - b.primary.seasonSequence ||
      a.primary.seasonNumber - b.primary.seasonNumber ||
      a.primary.sequenceNumber - b.primary.sequenceNumber ||
      a.id.localeCompare(b.id),
  );
}

/** Matched episodes in rank order, ahead of any the catalog does not place. */
function compareRank(a: readonly [number, number] | undefined, b: readonly [number, number] | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a[0] - b[0] || a[1] - b[1];
}

// Labels stay Crunchyroll's — "S1 · E13" is how the owner finds an episode there — while matching
// decides the order.
const seasonOf = (e: EpisodeIn | undefined) => e?.seasonNumber ?? null;
const episodeOf = (e: EpisodeIn | undefined) => e?.episodeNumber ?? null;

/** The owner's audio language for a Show: whatever they watched it in most recently. */
export function preferredLocale(plays: readonly PlayIn[], byId: ReadonlyMap<string, EpisodeIn>, fallback: string | null): string | null {
  const latest = [...plays].sort((a, b) => b.datePlayed.getTime() - a.datePlayed.getTime())[0];
  return (latest !== undefined ? byId.get(latest.crEpisodeId)?.audioLocale : undefined) ?? fallback;
}

export function deriveShow(episodes: readonly EpisodeIn[], plays: readonly PlayIn[], now: Date, fallbackLocale: string | null = 'en-US', options: DeriveOptions = {}): ShowOut {
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const ordered = canonicalEpisodes(episodes);
  const indexOf = new Map(ordered.map((c, i) => [c.id, i]));
  const watched = new Set<string>();
  let lastPlayedAt: Date | null = null;
  // Plays in time order: when the whole main line was first watched, and whether the latest play
  // went back over an episode already watched after that — a rewatch.
  let completedAt: Date | null = null;
  let rewatchAt: number | null = null;
  for (const p of [...plays].sort((a, b) => a.datePlayed.getTime() - b.datePlayed.getTime())) {
    const e = byId.get(p.crEpisodeId);
    if (lastPlayedAt === null || p.datePlayed > lastPlayedAt) lastPlayedAt = p.datePlayed;
    const replay = e !== undefined && completedAt !== null && watched.has(e.canonicalId);
    rewatchAt = replay ? (indexOf.get(e.canonicalId) ?? null) : null;
    if (e !== undefined && isWatched(p, e)) watched.add(e.canonicalId);
    if (completedAt === null && ordered.length > 0 && ordered.every((c) => watched.has(c.id))) completedAt = p.datePlayed;
  }
  // A rewatch that reached the last episode is over: the Show is Completed again.
  const rewatching = rewatchAt !== null && rewatchAt < ordered.length - 1;

  // Position: after the last watched episode, so one skipped episode never holds the Show back —
  // or, during a rewatch, after the episode replayed most recently.
  let lastIndex = -1;
  ordered.forEach((c, i) => {
    if (watched.has(c.id)) lastIndex = i;
  });
  if (rewatching && rewatchAt !== null) lastIndex = rewatchAt;
  const current = lastIndex >= 0 ? ordered[lastIndex] : undefined;
  const next = ordered[lastIndex + 1];
  const locale = preferredLocale(plays, byId, fallbackLocale);
  const nextVersion = next === undefined ? undefined : (next.versions.find((v) => v.audioLocale === locale) ?? next.primary);
  const remaining = ordered.slice(lastIndex + 1);
  const remainingS = remaining.reduce((s, c) => s + (c.versions.find((v) => v.audioLocale === locale) ?? c.primary).durationS, 0);

  const available = nextVersion?.airDate ?? null;
  const nextIsNew = nextVersion !== undefined && lastPlayedAt !== null && available !== null && available > lastPlayedAt;
  // A new season: the next episode is in a later Crunchyroll season — not the second cour of the
  // same one (SPY x FAMILY's Part 2 is still Crunchyroll's Season 1).
  const matched = next?.primary.rank !== undefined && current?.primary.rank !== undefined && next.primary.seasonId !== undefined;
  const nextIsNewSeason =
    next !== undefined && current !== undefined && (matched ? next.primary.seasonId !== current.primary.seasonId && compareRank(next.primary.rank, current.primary.rank) > 0 : next.primary.seasonNumber > current.primary.seasonNumber);

  const watchedCount = ordered.filter((c) => watched.has(c.id)).length;
  const status = deriveStatus(
    { total: ordered.length, watched: watchedCount, nextAvailable: next !== undefined, nextIsNew, lastPlayedAt, moreComing: options.moreComing ?? false, rewatching, manual: options.manual ?? null },
    now,
  );

  return {
    status,
    watchedEpisodes: watchedCount,
    totalEpisodes: ordered.length,
    remainingS,
    currentSeason: seasonOf(current?.primary),
    currentEpisode: episodeOf(current?.primary),
    nextSeason: seasonOf(next?.primary),
    nextEpisode: episodeOf(next?.primary),
    nextCrEpisodeId: nextVersion?.id ?? null,
    nextAudioLocale: nextVersion?.audioLocale ?? null,
    nextTitle: nextVersion?.title ?? null,
    nextIsNew,
    nextIsNewSeason,
    lastPlayedAt,
  };
}

export interface UpNextRow {
  readonly showKey: string;
  readonly status: string;
  readonly pinned: boolean;
  readonly nextIsNew: boolean;
  readonly nextIsNewSeason: boolean;
  readonly lastPlayedAt: Date | null;
  readonly nextCrEpisodeId: string | null;
}

export type UpNextGroup = 'pinned' | 'new' | 'recent' | 'next_season' | 'paused';

/**
 * Up Next order (KURO-REQ-013): pinned, then a new episode since you last watched, then most
 * recently watched, then a next season that is out; Paused shows last. Completed shows with nothing
 * new are not in Up Next at all.
 */
export function upNext(rows: readonly UpNextRow[]): { showKey: string; group: UpNextGroup }[] {
  const groupOf = (r: UpNextRow): UpNextGroup | null => {
    // Nothing to watch next, or the owner set it aside: not in Up Next.
    if (r.nextCrEpisodeId === null || r.status === 'dropped' || r.status === 'plan_to_watch') return null;
    if (r.pinned) return 'pinned';
    if (r.status === 'paused') return 'paused';
    if (r.nextIsNewSeason) return 'next_season';
    if (r.nextIsNew) return 'new';
    return 'recent';
  };
  const rank: Record<UpNextGroup, number> = { pinned: 0, new: 1, recent: 2, next_season: 3, paused: 4 };
  return rows
    .flatMap((r) => {
      const group = groupOf(r);
      return group === null ? [] : [{ r, group }];
    })
    .sort((a, b) => rank[a.group] - rank[b.group] || (b.r.lastPlayedAt?.getTime() ?? 0) - (a.r.lastPlayedAt?.getTime() ?? 0) || a.r.showKey.localeCompare(b.r.showKey))
    .map(({ r, group }) => ({ showKey: r.showKey, group }));
}

export interface EpisodeRow {
  readonly crEpisodeId: string;
  readonly seasonId: string | null;
  readonly seasonNumber: number;
  readonly episodeNumber: number | null;
  readonly title: string;
  readonly durationS: number;
  readonly audioLocale: string | null;
  readonly watched: boolean;
  readonly lastWatchedAt: Date | null;
  /** Past the owner's position: the title must stay hidden until tapped (KURO-REQ-018). */
  readonly spoiler: boolean;
  readonly isNext: boolean;
}

/** The Show's episode list in watch order, one row per canonical episode, in the owner's language. */
export function episodeList(episodes: readonly EpisodeIn[], plays: readonly PlayIn[], fallbackLocale: string | null = 'en-US'): EpisodeRow[] {
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const ordered = canonicalEpisodes(episodes);
  const watchedAt = new Map<string, Date>();
  for (const p of plays) {
    const e = byId.get(p.crEpisodeId);
    if (e === undefined || !isWatched(p, e)) continue;
    const prev = watchedAt.get(e.canonicalId);
    if (prev === undefined || p.datePlayed > prev) watchedAt.set(e.canonicalId, p.datePlayed);
  }
  let lastIndex = -1;
  ordered.forEach((c, i) => {
    if (watchedAt.has(c.id)) lastIndex = i;
  });
  const locale = preferredLocale(plays, byId, fallbackLocale);
  return ordered.map((c, i) => {
    const v = c.versions.find((x) => x.audioLocale === locale) ?? c.primary;
    return {
      crEpisodeId: v.id,
      seasonId: c.primary.seasonId ?? null,
      seasonNumber: seasonOf(c.primary) ?? c.primary.seasonNumber,
      episodeNumber: episodeOf(c.primary),
      title: v.title,
      durationS: v.durationS,
      audioLocale: v.audioLocale,
      watched: watchedAt.has(c.id),
      lastWatchedAt: watchedAt.get(c.id) ?? null,
      spoiler: i > lastIndex + 1,
      isNext: i === lastIndex + 1,
    };
  });
}
