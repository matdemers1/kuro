import { describe, expect, it } from 'vitest';
import { kindOf, matchSeason, matchSeries, type EntryIn, type Pool, type SeasonIn } from '../../src/match/ranges.js';
import { core, normalise, TitleIndex } from '../../src/match/titles.js';

/**
 * KURO-T-2.3 golden cases: the season shapes the owner's real history holds, as synthetic stand-ins
 * (no real export is committed — KURO-REQ-057).
 */

const NOW = new Date('2026-10-20T00:00:00Z');
let n = 0;
const entry = (title: string, type: string, episodes: number, year: number, more: Partial<EntryIn> = {}): EntryIn => ({ id: `e${String(++n)}`, title, synonyms: [], type, episodes, status: 'FINISHED', year, seasonIndex: 1, ...more });
/** `canon` names the Canonical Episodes: a dub season shares its original's. */
const season = (id: string, title: string, from: number, to: number, year: number, durationS = 1420, canon = id): SeasonIn => ({
  id,
  title,
  episodes: Array.from({ length: to - from + 1 }, (_, i) => ({ number: from + i, sequence: from + i, durationS, airDate: new Date(Date.UTC(year, 3, 6 + i * 7)), canonicalId: `${canon}-${String(from + i)}` })),
});
const anchoredPool = (entries: EntryIn[], seriesTitle: string, mainLine = entries): Pool => ({ entries, anchored: true, mainLine: new Set(mainLine.map((e) => e.id)), franchise: new Set(entries.map((e) => e.id)), seriesTitle });

describe('titles', () => {
  it('normalises spelling, case, punctuation and diacritics away', () => {
    expect(normalise('SPY x FAMILY')).toBe(normalise('Spy x Family'));
    expect(normalise('Demon Slayer: Kimetsu no Yaiba')).toBe('demon slayer kimetsu no yaiba');
    expect(normalise('Pokémon')).toBe('pokemon');
  });

  it('strips Crunchyroll decorations for a second look-up', () => {
    expect(core('JUJUTSU KAISEN Season 2')).toBe('jujutsu kaisen');
    expect(core('Mushoku Tensei: Jobless Reincarnation (English Dub)')).toBe('mushoku tensei');
  });

  it('finds an entry through a synonym, and ranks an exact hit first', () => {
    const ds = entry('Kimetsu no Yaiba', 'TV', 26, 2019, { synonyms: ['Demon Slayer: Kimetsu no Yaiba'] });
    const other = entry('Demon Slayer Fan Recap', 'SPECIAL', 1, 2020);
    const index = new TitleIndex([ds, other]);
    expect(index.search(['Demon Slayer: Kimetsu no Yaiba'])[0]?.id).toBe(ds.id);
  });
});

describe('matchSeason (KURO-ADR-003)', () => {
  it('one season, one entry: Demon Slayer S1 → Kimetsu no Yaiba (26)', () => {
    const s1 = entry('Kimetsu no Yaiba', 'TV', 26, 2019);
    const [p, ...rest] = matchSeason(season('S1', 'Demon Slayer: Kimetsu no Yaiba Tanjiro Kamado, Unwavering Resolve Arc', 1, 26, 2019), anchoredPool([s1], 'Demon Slayer: Kimetsu no Yaiba'), NOW);
    expect(rest).toHaveLength(0);
    expect(p).toMatchObject({ entryId: s1.id, epFrom: 1, epTo: 26, offset: 0, confidence: 'strong' });
  });

  it('a split cour: SPY x FAMILY S1 (25) → Spy x Family (12) + Part 2 (13)', () => {
    const a = entry('Spy x Family', 'TV', 12, 2022, { seasonIndex: 1 });
    const b = entry('Spy x Family Part 2', 'TV', 13, 2022, { seasonIndex: 3 });
    const s2 = entry('Spy x Family Season 2', 'TV', 12, 2023);
    const out = matchSeason(season('S1', 'Season 1', 1, 25, 2022), anchoredPool([s2, b, a], 'SPY x FAMILY'), NOW);
    expect(out.map((p) => [p.entryId, p.epFrom, p.epTo, p.offset])).toEqual([
      [a.id, 1, 12, 0],
      [b.id, 13, 25, -12],
    ]);
    expect(out.every((p) => p.confidence === 'strong')).toBe(true);
  });

  it('absolute numbering: JJK S2 E25–E47 → the 23-episode 2nd Season, offset −24', () => {
    const s1 = entry('Jujutsu Kaisen', 'TV', 24, 2020);
    const s2 = entry('Jujutsu Kaisen 2nd Season', 'TV', 23, 2023);
    const [p] = matchSeason(season('S2', 'JUJUTSU KAISEN Season 2', 25, 47, 2023), anchoredPool([s1, s2], 'JUJUTSU KAISEN'), NOW);
    expect(p).toMatchObject({ entryId: s2.id, epFrom: 25, epTo: 47, offset: -24, confidence: 'strong' });
  });

  it('a long-running entry: One Piece arcs keep absolute numbers, offset 0', () => {
    const op = entry('One Piece', 'TV', 0, 1999, { status: 'ONGOING' });
    const [p] = matchSeason(season('WANO', 'Land of Wano (892-1088)', 892, 1088, 2019), anchoredPool([op], 'One Piece'), NOW);
    expect(p).toMatchObject({ entryId: op.id, epFrom: 892, epTo: 1088, offset: 0, confidence: 'strong' });
  });

  it('a movie as a one-episode season: Mugen Train → the movie, not a TV entry', () => {
    const tv = entry('Kimetsu no Yaiba', 'TV', 26, 2019);
    const movie = entry('Kimetsu no Yaiba Movie: Mugen Ressha-hen', 'MOVIE', 1, 2020);
    const s = season('MOV', 'Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train', 1, 1, 2020, 117 * 60);
    expect(kindOf(s, s.episodes)).toBe('movie');
    const [p] = matchSeason(s, anchoredPool([tv, movie], 'Demon Slayer: Kimetsu no Yaiba', [tv, movie]), NOW);
    expect(p).toMatchObject({ entryId: movie.id, confidence: 'strong' });
  });

  it('a season still airing: 8 of 12 episodes out → the ongoing entry, flagged', () => {
    const cur = entry('Spy x Family Season 3', 'TV', 12, 2025, { status: 'ONGOING' });
    const [p] = matchSeason(season('S3', 'Season 3', 38, 45, 2025), anchoredPool([cur], 'SPY x FAMILY'), NOW);
    expect(p).toMatchObject({ entryId: cur.id, confidence: 'strong', offset: -37 });
    expect(p?.signals).toContain('still airing');
  });

  it('without an AniList link, the count alone is not enough: weak, with candidates', () => {
    const lookalike = entry('Some Other Show', 'TV', 12, 2022);
    const pool: Pool = { entries: [lookalike], anchored: false, mainLine: new Set(), franchise: new Set(), seriesTitle: 'Mystery Series' };
    const [p] = matchSeason(season('S1', 'Mystery Series', 1, 12, 2022), pool, NOW);
    expect(p).toMatchObject({ entryId: lookalike.id, confidence: 'weak' });
    expect(p?.candidates).toContain(lookalike.id);
  });

  it('without an AniList link, exact title + count + year is strong (ADR-003)', () => {
    const e = entry('Mystery Series', 'TV', 12, 2022);
    const pool: Pool = { entries: [e], anchored: false, mainLine: new Set(), franchise: new Set(), seriesTitle: 'Mystery Series' };
    expect(matchSeason(season('S1', 'Mystery Series', 1, 12, 2022), pool, NOW)[0]).toMatchObject({ entryId: e.id, confidence: 'strong' });
  });

  it('without an AniList link, the wrong year makes even an exact title weak (a remake)', () => {
    const e = entry('Remake Show', 'TV', 12, 2008);
    const pool: Pool = { entries: [e], anchored: false, mainLine: new Set(), franchise: new Set(), seriesTitle: 'Remake Show' };
    expect(matchSeason(season('S1', 'Remake Show', 1, 12, 2022), pool, NOW)[0]?.confidence).toBe('weak');
  });

  it('on the anchored line, a dub released years later still matches — but never earlier than the entry', () => {
    const e = entry('Vampire Show', 'TV', 12, 2010);
    expect(matchSeason(season('EN', 'Vampire Show: Season 1 (English Dub)', 1, 12, 2022), anchoredPool([e], 'Vampire Show'), NOW)[0]?.confidence).toBe('strong');
    const later = entry('Later Show', 'TV', 12, 2024);
    expect(matchSeason(season('EARLY', 'Later Show', 1, 12, 2020), anchoredPool([later], 'Later Show'), NOW)[0]?.confidence).toBe('weak');
  });

  it('counts distinct episode numbers: recaps and re-uploads that repeat a number do not count twice', () => {
    const a = entry('Eighty', 'TV', 11, 2021);
    const b = entry('Eighty Part 2', 'TV', 12, 2021);
    const base = season('S', 'Eighty', 1, 23, 2021);
    const dupes = { ...base, episodes: [...base.episodes, { number: 12, sequence: 12.5, durationS: 1420, airDate: new Date(Date.UTC(2021, 9, 1)) }, { number: 18, sequence: 18.5, durationS: 1420, airDate: new Date(Date.UTC(2021, 10, 1)) }] };
    expect(matchSeason(dupes, anchoredPool([a, b], 'Eighty'), NOW).map((p) => [p.entryId, p.epFrom, p.epTo])).toEqual([
      [a.id, 1, 11],
      [b.id, 12, 23],
    ]);
  });

  it('season 2 never lands on season 1’s same-sized first cour (order and numbering)', () => {
    const a = entry('Fam', 'TV', 12, 2022, { seasonIndex: 1 });
    const b = entry('Fam Part 2', 'TV', 13, 2022, { seasonIndex: 3 });
    const pool = anchoredPool([a, b], 'Fam');
    // Season 2's own entry is missing from the catalog: the matcher must say so, not reuse cour 1.
    const out = matchSeries([season('S1', 'Season 1', 1, 25, 2022), season('S2', 'Season 2', 26, 37, 2023)], pool, NOW);
    expect(out.filter((p) => p.seasonId === 'S1').map((p) => p.entryId)).toEqual([a.id, b.id]);
    expect(out.find((p) => p.seasonId === 'S2')).toMatchObject({ confidence: 'weak' });
  });

  it('a dub of a season takes the same answer', () => {
    const e = entry('Show', 'TV', 12, 2022);
    const out = matchSeries([season('JA', 'Show', 1, 12, 2022), season('EN', 'Show (English Dub)', 1, 12, 2022, 1420, 'JA')], anchoredPool([e], 'Show'), NOW);
    expect(out.map((p) => [p.seasonId, p.entryId, p.confidence])).toEqual([['JA', e.id, 'strong'], ['EN', e.id, 'strong']]);
  });

  it('season 2 numbered E1–E12 again is the next entry, not season 1 a second time', () => {
    const s1 = entry('Doll', 'TV', 12, 2022);
    const s2 = entry('Doll Season 2', 'TV', 12, 2025);
    const out = matchSeries([season('S1', 'Season 1', 1, 12, 2022), season('S2', 'Season 2', 1, 12, 2025)], anchoredPool([s1, s2], 'Doll'), NOW);
    expect(out.map((p) => [p.seasonId, p.entryId, p.confidence])).toEqual([['S1', s1.id, 'strong'], ['S2', s2.id, 'strong']]);
  });

  it('a recap repeating the last number of the season before is trimmed (Slime S2 opens on E24)', () => {
    const s1 = entry('Slimy', 'TV', 24, 2018);
    const a = entry('Slimy 2nd Season', 'TV', 12, 2021, { seasonIndex: 0 });
    const b = entry('Slimy 2nd Season Part 2', 'TV', 12, 2021, { seasonIndex: 2 });
    const out = matchSeries([season('S1', 'Season 1', 1, 24, 2018), season('S2', 'Season 2', 24, 48, 2021)], anchoredPool([s1, a, b], 'Slimy'), NOW);
    expect(out.filter((p) => p.seasonId === 'S2').map((p) => [p.entryId, p.epFrom, p.epTo, p.confidence])).toEqual([
      [a.id, 25, 36, 'strong'],
      [b.id, 37, 48, 'strong'],
    ]);
  });
});
