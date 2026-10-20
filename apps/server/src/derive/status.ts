/**
 * The seven statuses (KURO-REQ-033, KURO-T-2.7): every Show has exactly one of Plan to watch,
 * Watching, Caught up, Paused, Completed, Dropped or Rewatching. Pure, and decided in this order:
 *
 *   1. Dropped — only ever the owner's choice, and it holds until the owner watches the Show again.
 *   2. Plan to watch — the owner's choice for a Show with nothing watched; the first watched episode
 *      ends it.
 *   3. Rewatching — after everything was watched, an episode was played again; it lasts while the
 *      rewatch is under way (a play in the last six weeks) and has not reached the end.
 *   4. Completed — every main-line episode watched and nothing more coming.
 *   5. Caught up — every episode that is out is watched, and more is coming: the current Season is
 *      still airing, or a sequel is announced.
 *   6. Paused — no play in six weeks, and the next episode is not new since the last play.
 *   7. Watching — everything else.
 */

export const PAUSED_AFTER_MS = 42 * 24 * 60 * 60 * 1000; // 6 weeks (KURO-REQ-016)

export type ShowStatus = 'plan_to_watch' | 'watching' | 'caught_up' | 'paused' | 'completed' | 'dropped' | 'rewatching';
export const STATUSES: readonly ShowStatus[] = ['plan_to_watch', 'watching', 'caught_up', 'paused', 'completed', 'dropped', 'rewatching'];

/** The owner's own status, set from the Show page. Only these two are ever chosen by hand. */
export type ManualStatus = 'plan_to_watch' | 'dropped';

export interface StatusIn {
  /** Main-line episodes, and how many of them are watched. */
  readonly total: number;
  readonly watched: number;
  /** An unwatched main-line episode is available on Crunchyroll now. */
  readonly nextAvailable: boolean;
  /** That next episode came out after the owner's last play (a new dub episode, say). */
  readonly nextIsNew: boolean;
  readonly lastPlayedAt: Date | null;
  /** The current Season is still airing, or a sequel is announced. */
  readonly moreComing: boolean;
  /** A rewatch is under way: the latest play replayed an episode watched before. */
  readonly rewatching: boolean;
  readonly manual: { readonly status: ManualStatus; readonly at: Date } | null;
}

export function deriveStatus(s: StatusIn, now: Date): ShowStatus {
  const playedSince = (at: Date) => s.lastPlayedAt !== null && s.lastPlayedAt > at;
  if (s.manual?.status === 'dropped' && !playedSince(s.manual.at)) return 'dropped';
  if (s.manual?.status === 'plan_to_watch' && s.watched === 0) return 'plan_to_watch';
  const recent = s.lastPlayedAt !== null && now.getTime() - s.lastPlayedAt.getTime() <= PAUSED_AFTER_MS;
  const allWatched = s.total > 0 && s.watched >= s.total;
  if (s.rewatching && recent) return 'rewatching';
  if (allWatched || (!s.nextAvailable && s.watched > 0)) return s.moreComing ? 'caught_up' : 'completed';
  if (!recent && s.lastPlayedAt !== null && !s.nextIsNew) return 'paused';
  return 'watching';
}
