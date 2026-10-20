import { describe, expect, it } from 'vitest';
import { deriveShow, isWatched, PAUSED_AFTER_MS, upNext, type EpisodeIn, type PlayIn, type UpNextRow } from '../../src/derive/show.js';

/**
 * Golden fixtures for derivation v1 (KURO-T-1.5). A two-season synthetic show: each episode has a
 * Japanese original and an English dub version that fold onto one canonical episode.
 */
const NOW = new Date('2026-10-20T03:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function show(seasons: number, perSeason: number, opts: { dubAir?: (s: number, n: number) => Date } = {}): EpisodeIn[] {
  const out: EpisodeIn[] = [];
  for (let s = 1; s <= seasons; s++) {
    for (let n = 1; n <= perSeason; n++) {
      const canonicalId = `JA${String(s)}${String(n)}`;
      const base = { canonicalId, seasonNumber: s, seasonSequence: s, sequenceNumber: n, episodeNumber: n, durationS: 1440, creditsStartS: 1300, airDate: ago(400 - s * 30 - n) };
      out.push({ ...base, id: canonicalId, title: `Ep ${String(n)}`, audioLocale: 'ja-JP' });
      out.push({ ...base, id: `EN${String(s)}${String(n)}`, title: `Ep ${String(n)} (dub)`, audioLocale: 'en-US', airDate: opts.dubAir?.(s, n) ?? base.airDate });
    }
  }
  return out;
}
const play = (id: string, daysAgo: number, playheadS = 1440, fullyWatched = true): PlayIn => ({ crEpisodeId: id, datePlayed: ago(daysAgo), playheadS, fullyWatched });

describe('the watched rule (KURO-REQ-011)', () => {
  const ep = { durationS: 1440, creditsStartS: 1300 };
  it('trusts fully_watched', () => {
    expect(isWatched({ crEpisodeId: 'x', datePlayed: NOW, playheadS: 10, fullyWatched: true }, ep)).toBe(true);
  });
  it('counts past the credits marker, and not before it', () => {
    expect(isWatched({ crEpisodeId: 'x', datePlayed: NOW, playheadS: 1300, fullyWatched: false }, ep)).toBe(true);
    expect(isWatched({ crEpisodeId: 'x', datePlayed: NOW, playheadS: 1299, fullyWatched: false }, ep)).toBe(false);
  });
  it('falls back to 90% when no marker is published', () => {
    expect(isWatched({ crEpisodeId: 'x', datePlayed: NOW, playheadS: 1296, fullyWatched: false }, { durationS: 1440, creditsStartS: null })).toBe(true);
    expect(isWatched({ crEpisodeId: 'x', datePlayed: NOW, playheadS: 1295, fullyWatched: false }, { durationS: 1440, creditsStartS: null })).toBe(false);
  });
});

describe('progress and position', () => {
  it('folds sub and dub: watching E1 in Japanese and E2 in English is two episodes, next is E3 in English', () => {
    const out = deriveShow(show(2, 3), [play('JA11', 10), play('EN12', 5)], NOW);
    expect(out).toMatchObject({ watchedEpisodes: 2, totalEpisodes: 6, currentSeason: 1, currentEpisode: 2, nextSeason: 1, nextEpisode: 3, nextCrEpisodeId: 'EN13', nextAudioLocale: 'en-US', status: 'watching' });
    expect(out.remainingS).toBe(4 * 1440);
  });

  it('resumes after the last watched episode, not at a skipped one', () => {
    const out = deriveShow(show(1, 4), [play('EN11', 9), play('EN13', 8)], NOW);
    expect(out).toMatchObject({ currentEpisode: 3, nextEpisode: 4 });
  });

  it('marks a new season and points into it', () => {
    const out = deriveShow(show(2, 2), [play('EN11', 9), play('EN12', 8)], NOW);
    expect(out).toMatchObject({ nextSeason: 2, nextEpisode: 1, nextIsNewSeason: true });
  });

  it('is completed when every episode is watched, with no next', () => {
    const out = deriveShow(show(1, 2), [play('EN11', 9), play('EN12', 8)], NOW);
    expect(out).toMatchObject({ status: 'completed', nextCrEpisodeId: null, remainingS: 0 });
  });
});

describe('paused after 6 weeks (KURO-REQ-016)', () => {
  it('is Paused at 43 days idle and Watching at 41', () => {
    expect(deriveShow(show(1, 3), [play('EN11', 43)], NOW).status).toBe('paused');
    expect(deriveShow(show(1, 3), [play('EN11', 41)], NOW).status).toBe('watching');
    expect(PAUSED_AFTER_MS).toBe(42 * 86_400_000);
  });

  it('is not Paused when the next dub episode arrived after the last watch', () => {
    const out = deriveShow(show(1, 3, { dubAir: (_s, n) => (n === 2 ? ago(2) : ago(400)) }), [play('EN11', 60)], NOW);
    expect(out).toMatchObject({ status: 'watching', nextIsNew: true });
  });
});

describe('Up Next order (KURO-REQ-013): five kinds', () => {
  const row = (showKey: string, over: Partial<UpNextRow>): UpNextRow => ({ showKey, status: 'watching', pinned: false, nextIsNew: false, nextIsNewSeason: false, lastPlayedAt: ago(5), nextCrEpisodeId: 'x', ...over });
  it('pinned → new episode → recent → next season out → paused; completed shows are absent', () => {
    const order = upNext([
      row('paused', { status: 'paused', lastPlayedAt: ago(60) }),
      row('recent-older', { lastPlayedAt: ago(9) }),
      row('next-season', { nextIsNewSeason: true, lastPlayedAt: ago(1) }),
      row('pinned', { pinned: true, lastPlayedAt: ago(30) }),
      row('completed', { status: 'completed', nextCrEpisodeId: null }),
      row('new', { nextIsNew: true, lastPlayedAt: ago(20) }),
      row('recent-newer', { lastPlayedAt: ago(2) }),
    ]);
    expect(order).toEqual([
      { showKey: 'pinned', group: 'pinned' },
      { showKey: 'new', group: 'new' },
      { showKey: 'recent-newer', group: 'recent' },
      { showKey: 'recent-older', group: 'recent' },
      { showKey: 'next-season', group: 'next_season' },
      { showKey: 'paused', group: 'paused' },
    ]);
  });
});

describe('determinism (KURO-REQ-017)', () => {
  it('gives the same result for the same inputs in any order', () => {
    const eps = show(2, 3);
    const plays = [play('JA11', 10), play('EN12', 5), play('EN21', 2, 700, false)];
    expect(deriveShow([...eps].reverse(), [...plays].reverse(), NOW)).toEqual(deriveShow(eps, plays, NOW));
  });
});
