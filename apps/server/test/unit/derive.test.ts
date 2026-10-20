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

describe('dub first (KURO-T-3.3)', () => {
  /** One season of ten in Japanese; the English dub is out to episode `dubbed`. */
  function simulcast(dubbed: number): EpisodeIn[] {
    const out: EpisodeIn[] = [];
    for (let n = 1; n <= 10; n++) {
      const canonicalId = `SJ${String(n)}`;
      const base = { canonicalId, seasonNumber: 1, seasonSequence: 1, sequenceNumber: n, episodeNumber: n, durationS: 1440, creditsStartS: 1300, airDate: ago(30 - n) };
      // Crunchyroll lists the season once; each episode's versions say which dubs it is out in.
      out.push({ ...base, id: n <= dubbed ? `SE${String(n)}` : canonicalId, title: `Ep ${String(n)}`, audioLocale: n <= dubbed ? 'en-US' : 'ja-JP', locales: n <= dubbed ? ['ja-JP', 'en-US'] : ['ja-JP'] });
    }
    return out;
  }
  const dubPlays = (to: number) => Array.from({ length: to }, (_, i) => play(`SE${String(i + 1)}`, 10 - i * 0.5));

  it('watching the dub, caught up with it: Caught up, "dub 2 behind", not in Up Next', () => {
    const s = deriveShow(simulcast(8), dubPlays(8), NOW);
    expect(s).toMatchObject({ status: 'caught_up', dubLag: 2, nextCrEpisodeId: 'SJ9' });
    expect(upNext([{ showKey: 'cr:SIM', status: s.status, pinned: false, nextIsNew: s.nextIsNew, nextIsNewSeason: s.nextIsNewSeason, lastPlayedAt: s.lastPlayedAt, nextCrEpisodeId: s.nextCrEpisodeId }])).toEqual([]);
  });

  it('the next dub episode lands: Watching again, one behind', () => {
    expect(deriveShow(simulcast(9), dubPlays(8), NOW)).toMatchObject({ status: 'watching', dubLag: 1, nextCrEpisodeId: 'SE9' });
  });

  it('watching in Japanese: no dub lag, the next episode is simply next', () => {
    const subPlays = Array.from({ length: 8 }, (_, i) => play(`SJ${String(i + 1)}`, 10 - i * 0.5));
    const eps = simulcast(0);
    expect(deriveShow(eps, subPlays, NOW)).toMatchObject({ status: 'watching', dubLag: 0, nextCrEpisodeId: 'SJ9' });
  });

  it('a show with no dub at all is never "behind"', () => {
    expect(deriveShow(simulcast(0), [play('SJ1', 1)], NOW).dubLag).toBe(0);
  });
});

describe('a new season brings a finished Show back (KURO-T-3.3)', () => {
  it('Season 1 finished months ago, Season 2 now out: Watching, NEXT SEASON in Up Next', () => {
    const eps = show(2, 3).filter((e) => e.seasonNumber === 1 || e.audioLocale === 'en-US').map((e) => (e.seasonNumber === 2 ? { ...e, airDate: ago(2) } : e));
    const done = deriveShow(eps.filter((e) => e.seasonNumber === 1), [play('EN11', 100), play('EN12', 99), play('EN13', 98)], NOW);
    expect(done.status).toBe('completed');
    const back = deriveShow(eps, [play('EN11', 100), play('EN12', 99), play('EN13', 98)], NOW);
    expect(back).toMatchObject({ status: 'watching', nextIsNewSeason: true, nextIsNew: true, nextCrEpisodeId: 'EN21' });
    expect(upNext([{ showKey: 'cr:BACK', status: back.status, pinned: false, nextIsNew: back.nextIsNew, nextIsNewSeason: back.nextIsNewSeason, lastPlayedAt: back.lastPlayedAt, nextCrEpisodeId: back.nextCrEpisodeId }])).toEqual([{ showKey: 'cr:BACK', group: 'next_season' }]);
  });
});

describe('rewatches (KURO-T-4.2)', () => {
  const eps = () => show(1, 3).filter((e) => e.audioLocale === 'en-US');
  const first = [play('EN11', 100), play('EN12', 99), play('EN13', 98)];

  it('a replay of a fully watched episode after the end opens a rewatch; the last episode closes it', () => {
    const open = deriveShow(eps(), [...first, play('EN11', 10)], NOW);
    expect(open.rewatches).toEqual([{ startedAt: ago(10), endedAt: null }]);
    const closed = deriveShow(eps(), [...first, play('EN11', 10), play('EN12', 9), play('EN13', 8)], NOW);
    expect(closed.rewatches).toEqual([{ startedAt: ago(10), endedAt: ago(8) }]);
    expect(closed.status).toBe('completed');
  });

  it('replaying before ever finishing is not a rewatch, and a second pass is a second rewatch', () => {
    expect(deriveShow(eps(), [play('EN11', 100), play('EN11', 50)], NOW).rewatches).toEqual([]);
    const twice = deriveShow(eps(), [...first, play('EN11', 20), play('EN13', 19), play('EN12', 5)], NOW);
    expect(twice.rewatches.map((r) => r.endedAt === null)).toEqual([false, true]);
  });
});
