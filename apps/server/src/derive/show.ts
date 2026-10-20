/**
 * The derivation engine, v1 (KURO-T-1.5, KURO-ADR-004): a pure function from what Crunchyroll
 * knows and what the owner watched to a Show's state. No I/O here — rebuild.ts gathers inputs and
 * writes outputs — so every rule is golden-testable and two rebuilds are identical by construction.
 */

export const PAUSED_AFTER_MS = 42 * 24 * 60 * 60 * 1000; // 6 weeks (KURO-REQ-016)
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
}

export interface PlayIn {
  readonly crEpisodeId: string;
  readonly datePlayed: Date;
  readonly playheadS: number;
  readonly fullyWatched: boolean;
}

export type Status = 'watching' | 'caught_up' | 'paused' | 'completed';

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
      a.primary.seasonSequence - b.primary.seasonSequence ||
      a.primary.seasonNumber - b.primary.seasonNumber ||
      a.primary.sequenceNumber - b.primary.sequenceNumber ||
      a.id.localeCompare(b.id),
  );
}

/** The owner's audio language for a Show: whatever they watched it in most recently. */
export function preferredLocale(plays: readonly PlayIn[], byId: ReadonlyMap<string, EpisodeIn>, fallback: string | null): string | null {
  const latest = [...plays].sort((a, b) => b.datePlayed.getTime() - a.datePlayed.getTime())[0];
  return (latest !== undefined ? byId.get(latest.crEpisodeId)?.audioLocale : undefined) ?? fallback;
}

export function deriveShow(episodes: readonly EpisodeIn[], plays: readonly PlayIn[], now: Date, fallbackLocale: string | null = 'en-US'): ShowOut {
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const ordered = canonicalEpisodes(episodes);
  const watched = new Set<string>();
  let lastPlayedAt: Date | null = null;
  for (const p of plays) {
    const e = byId.get(p.crEpisodeId);
    if (lastPlayedAt === null || p.datePlayed > lastPlayedAt) lastPlayedAt = p.datePlayed;
    if (e !== undefined && isWatched(p, e)) watched.add(e.canonicalId);
  }

  // Position: after the last watched episode, so one skipped episode never holds the Show back.
  let lastIndex = -1;
  ordered.forEach((c, i) => {
    if (watched.has(c.id)) lastIndex = i;
  });
  const current = lastIndex >= 0 ? ordered[lastIndex] : undefined;
  const next = ordered[lastIndex + 1];
  const locale = preferredLocale(plays, byId, fallbackLocale);
  const nextVersion = next === undefined ? undefined : (next.versions.find((v) => v.audioLocale === locale) ?? next.primary);
  const remaining = ordered.slice(lastIndex + 1);
  const remainingS = remaining.reduce((s, c) => s + (c.versions.find((v) => v.audioLocale === locale) ?? c.primary).durationS, 0);

  const available = nextVersion?.airDate ?? null;
  const nextIsNew = nextVersion !== undefined && lastPlayedAt !== null && available !== null && available > lastPlayedAt;
  const nextIsNewSeason = next !== undefined && current !== undefined && next.primary.seasonNumber > current.primary.seasonNumber;

  let status: Status;
  if (next === undefined) status = ordered.length > 0 && watched.size > 0 ? 'completed' : 'watching';
  else if (lastPlayedAt !== null && now.getTime() - lastPlayedAt.getTime() > PAUSED_AFTER_MS && !nextIsNew) status = 'paused';
  else status = 'watching';

  return {
    status,
    watchedEpisodes: ordered.filter((c) => watched.has(c.id)).length,
    totalEpisodes: ordered.length,
    remainingS,
    currentSeason: current?.primary.seasonNumber ?? null,
    currentEpisode: current?.primary.episodeNumber ?? null,
    nextSeason: next?.primary.seasonNumber ?? null,
    nextEpisode: next?.primary.episodeNumber ?? null,
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
    if (r.nextCrEpisodeId === null) return null;
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
      seasonNumber: c.primary.seasonNumber,
      episodeNumber: c.primary.episodeNumber,
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
