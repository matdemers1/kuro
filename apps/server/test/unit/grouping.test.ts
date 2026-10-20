import { describe, expect, it } from 'vitest';
import { groupShows, type EntryInfo, type RangeIn, type Relation } from '../../src/derive/grouping.js';

/**
 * KURO-T-2.5 golden fixtures, the ones the Phase 2 plan names: a split cour, a One Piece-style long
 * series across many Crunchyroll seasons, dub-only seasons, Mugen Train as an optional Extra after
 * Season 1, and a spin-off as its own Show in the Franchise. Synthetic stand-ins (KURO-REQ-057).
 */

let al = 1000;
const e = (id: string, type: string, episodes: number, year: number, seasonIndex = 1): EntryInfo => ({ id, title: id, synonyms: [], type, episodes, status: 'FINISHED', year, seasonIndex, anilistId: ++al });
const entries = (...list: EntryInfo[]) => new Map(list.map((x) => [x.id, x]));
const seq = (a: EntryInfo, b: EntryInfo): Relation[] => [{ from: a.anilistId ?? 0, to: b.anilistId ?? 0, type: 'SEQUEL' }, { from: b.anilistId ?? 0, to: a.anilistId ?? 0, type: 'PREQUEL' }];
const range = (seriesId: string, seasonId: string, entryId: string | null): RangeIn => ({ seriesId, seasonId, entryId });

describe('groupShows (KURO-T-2.5)', () => {
  it('a split cour is one Show with both cours as Seasons', () => {
    const a = e('cour1', 'TV', 12, 2022, 1);
    const b = e('cour2', 'TV', 13, 2022, 3);
    const g = groupShows([{ id: 'SPY', title: 'SPY x FAMILY' }], [range('SPY', 'S1', 'cour1'), range('SPY', 'S1', 'cour2')], entries(a, b), seq(a, b));
    expect(g.shows).toHaveLength(1);
    expect(g.shows[0]).toMatchObject({ key: 'show:cour1', title: 'SPY x FAMILY' });
    expect(g.shows[0]?.items.map((i) => [i.entryId, i.kind])).toEqual([['cour1', 'season'], ['cour2', 'season']]);
  });

  it('One Piece: many Crunchyroll seasons on one long entry are one Show, one Season', () => {
    const op = e('onepiece', 'TV', 1180, 1999);
    const ranges = ['EAST', 'ALABASTA', 'SKYPIEA', 'WANO'].map((s) => range('OP', s, 'onepiece'));
    const g = groupShows([{ id: 'OP', title: 'One Piece' }], ranges, entries(op), []);
    expect(g.shows.map((s) => [s.key, s.items.length])).toEqual([['show:onepiece', 1]]);
  });

  it('dub-only seasons of the same episodes are the same Season', () => {
    const s1 = e('show1', 'TV', 12, 2015);
    const g = groupShows([{ id: 'DUB', title: 'Dubbed Show' }], [range('DUB', 'JA', 'show1'), range('DUB', 'EN', 'show1')], entries(s1), []);
    expect(g.shows[0]?.items.map((i) => i.entryId)).toEqual(['show1']);
  });

  it('Mugen Train is an optional Extra after Season 1, before the Mugen Train arc', () => {
    const s1 = e('ds1', 'TV', 26, 2019, 1);
    const movie = e('mugen-movie', 'MOVIE', 1, 2020, 3);
    const arc = e('mugen-arc', 'TV', 7, 2021, 3);
    const g = groupShows([{ id: 'DS', title: 'Demon Slayer' }], [range('DS', 'S1', 'ds1'), range('DS', 'MOV', 'mugen-movie'), range('DS', 'S4', 'mugen-arc')], entries(s1, movie, arc), [...seq(s1, movie), ...seq(movie, arc)]);
    expect(g.shows).toHaveLength(1);
    expect(g.shows[0]?.items.map((i) => [i.entryId, i.kind, i.required])).toEqual([
      ['ds1', 'season', true],
      ['mugen-movie', 'extra', false],
      ['mugen-arc', 'season', true],
    ]);
    expect(g.kindOfEntry.get('mugen-movie')).toBe('extra');
  });

  it('a spin-off is its own Show in the same Franchise', () => {
    const main = e('slime', 'TV', 24, 2018);
    const spin = e('slime-diary', 'TV', 12, 2021);
    const g = groupShows(
      [{ id: 'SLIME', title: 'Slime' }, { id: 'DIARY', title: 'The Slime Diaries' }],
      [range('SLIME', 'S1', 'slime'), range('DIARY', 'S1', 'slime-diary')],
      entries(main, spin),
      [{ from: main.anilistId ?? 0, to: spin.anilistId ?? 0, type: 'SPIN_OFF' }],
    );
    expect(g.shows.map((s) => s.key)).toEqual(['show:slime', 'show:slime-diary']);
    expect(new Set(g.shows.map((s) => s.franchiseKey))).toEqual(new Set(['fr:show:slime']));
  });

  it('one show Crunchyroll split into two series is one Show', () => {
    const s1 = e('aot1', 'TV', 25, 2013);
    const fin = e('aot-final', 'TV', 16, 2020);
    const g = groupShows([{ id: 'AOT', title: 'Attack on Titan' }, { id: 'AOTF', title: 'Attack on Titan Final Season' }], [range('AOT', 'S1', 'aot1'), range('AOTF', 'F', 'aot-final')], entries(s1, fin), seq(s1, fin));
    expect(g.shows.map((s) => [s.key, s.title, s.seriesIds])).toEqual([['show:aot1', 'Attack on Titan', ['AOT', 'AOTF']]]);
    expect(g.showOfSeries.get('AOTF')).toBe('show:aot1');
  });

  it('a series of nothing but a movie on another show’s line joins that show as an Extra', () => {
    const tv = e('tv', 'TV', 12, 2018);
    const movie = e('movie', 'MOVIE', 1, 2019);
    const g = groupShows([{ id: 'TV', title: 'Show' }, { id: 'MOV', title: 'Show: The Movie' }], [range('TV', 'S1', 'tv'), range('MOV', 'M', 'movie')], entries(tv, movie), seq(tv, movie));
    expect(g.shows.map((s) => [s.key, s.items.map((i) => i.kind)])).toEqual([['show:tv', ['season', 'extra']]]);
  });

  it('a standalone movie is its own Show in the Franchise, and counts as its main line', () => {
    const tv = e('tv2', 'TV', 12, 2018);
    const movie = e('gaiden', 'MOVIE', 1, 2021);
    const g = groupShows([{ id: 'TV2', title: 'Show' }, { id: 'GAI', title: 'Show Gaiden' }], [range('TV2', 'S1', 'tv2'), range('GAI', 'M', 'gaiden')], entries(tv, movie), [{ from: tv.anilistId ?? 0, to: movie.anilistId ?? 0, type: 'SIDE_STORY' }]);
    expect(g.shows.map((s) => s.key)).toEqual(['show:gaiden', 'show:tv2']);
    expect(g.shows.find((s) => s.key === 'show:gaiden')?.items[0]).toMatchObject({ kind: 'extra', required: true });
    expect(g.kindOfEntry.get('gaiden')).toBe('season');
    expect(new Set(g.shows.map((s) => s.franchiseKey)).size).toBe(1);
  });

  it('a series with nothing mapped stays a Show on Crunchyroll’s structure', () => {
    const g = groupShows([{ id: 'LOST', title: 'Unmatched' }], [range('LOST', 'S1', null)], new Map(), []);
    expect(g.shows.map((s) => [s.key, s.items.length])).toEqual([['cr:LOST', 0]]);
  });
});

describe('the owner’s overrides (KURO-T-2.6)', () => {
  const s1 = e('ov-s1', 'TV', 12, 2018, 1);
  const s2 = e('ov-s2', 'TV', 12, 2020, 1);
  const movie = e('ov-movie', 'MOVIE', 1, 2019, 1);
  const other = e('ov-other', 'TV', 12, 2021, 1);
  const base = () => ({
    series: [{ id: 'A', title: 'Show A' }, { id: 'M', title: 'Show A: The Movie' }, { id: 'O', title: 'Other Show' }],
    ranges: [range('A', 'A1', 'ov-s1'), range('A', 'A2', 'ov-s2'), range('M', 'M1', 'ov-movie'), range('O', 'O1', 'ov-other')],
    entries: entries(s1, s2, movie, other),
    relations: [...seq(s1, s2), { from: s1.anilistId ?? 0, to: movie.anilistId ?? 0, type: 'SIDE_STORY' }],
  });
  const run = (...overrides: Parameters<typeof groupShows>[4] & object) => {
    const b = base();
    return groupShows(b.series, b.ranges, b.entries, b.relations, overrides);
  };

  it('without overrides: Show A with two seasons, the movie on its own, Other on its own', () => {
    expect(run().shows.map((s) => [s.key, s.items.map((i) => i.entryId)])).toEqual([
      ['show:ov-movie', ['ov-movie']],
      ['show:ov-other', ['ov-other']],
      ['show:ov-s1', ['ov-s1', 'ov-s2']],
    ]);
  });

  it('merge: two series the owner says are one Show', () => {
    const g = run({ kind: 'merge', seriesIds: ['A', 'O'] });
    expect(g.shows.find((s) => s.key === 'show:ov-s1')?.items.map((i) => i.entryId)).toEqual(['ov-s1', 'ov-s2', 'ov-other']);
    expect(g.shows.some((s) => s.key === 'show:ov-other')).toBe(false);
  });

  it('split: season 2 becomes a Show of its own', () => {
    const g = run({ kind: 'split', entryIds: ['ov-s2'] });
    expect(g.shows.find((s) => s.key === 'show:ov-s1')?.items.map((i) => i.entryId)).toEqual(['ov-s1']);
    expect(g.shows.find((s) => s.key === 'show:ov-s2')).toMatchObject({ title: 'Show A', seriesIds: ['A'] });
  });

  it('attach: the standalone movie becomes an optional Extra after season 1', () => {
    const g = run({ kind: 'attach', entryId: 'ov-movie', afterEntryId: 'ov-s1' });
    expect(g.shows.find((s) => s.key === 'show:ov-s1')?.items.map((i) => [i.entryId, i.kind, i.required])).toEqual([
      ['ov-s1', 'season', true],
      ['ov-movie', 'extra', false],
      ['ov-s2', 'season', true],
    ]);
    expect(g.shows.some((s) => s.key === 'show:ov-movie')).toBe(false);
    expect(g.kindOfEntry.get('ov-movie')).toBe('extra');
  });

  it('reorder: the owner’s order, and the key stays the earliest season so pins survive', () => {
    const g = run({ kind: 'attach', entryId: 'ov-movie', afterEntryId: 'ov-s1' }, { kind: 'reorder', entryIds: ['ov-s1', 'ov-s2', 'ov-movie'] });
    const a = g.shows.find((s) => s.key === 'show:ov-s1');
    expect(a?.items.map((i) => [i.entryId, i.position])).toEqual([['ov-s1', 0], ['ov-s2', 1], ['ov-movie', 2]]);
    const flipped = run({ kind: 'reorder', entryIds: ['ov-s2', 'ov-s1'] });
    expect(flipped.shows.find((s) => s.items[0]?.entryId === 'ov-s2')?.key).toBe('show:ov-s1');
  });

  it('an override naming something that no longer exists is ignored, not an error', () => {
    expect(run({ kind: 'split', entryIds: ['gone'] }, { kind: 'attach', entryId: 'gone', afterEntryId: 'ov-s1' }, { kind: 'merge', seriesIds: ['A', 'GONE'] }).shows).toHaveLength(3);
  });
});
