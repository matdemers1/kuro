import { describe, expect, it } from 'vitest';
import { closestLiked, DISMISSED_WEIGHT, idfOf, labelOf, profileOf, rank, seasonOf, termsOf, weightOf, type Candidate, type Signal } from '../../src/recommend/model.js';

/** KURO-T-4.4/4.5: the recommender's model — terms, weights, the profile and its edits, and the because. */

const docs = [['tag:mecha', 'tag:space'], ['tag:mecha'], ['tag:cooking'], ['tag:horror'], ['tag:space', 'tag:war'], ['tag:comedy'], ['tag:comedy'], ['tag:comedy']];
const { idf } = idfOf(docs);
const liked = (key: string, terms: string[], weight = 1): Signal => ({ key, title: key, terms, weight });
const c = (id: string, terms: string[], score: number | null = null): Candidate => ({ id, terms, score });

describe('terms (KURO-REQ-045)', () => {
  it('keeps what a show is — tags and studios — and drops release metadata, technical tags and anything unshowable', () => {
    expect(termsOf(['Mecha', 'sequel', 'japanese production', 'crunchyroll co-production', 'tv censoring', 'large breasts', 'Space'], ['Sunrise'])).toEqual(['tag:mecha', 'tag:space', 'studio:sunrise']);
  });

  it('labels a term for people', () => {
    expect(labelOf('tag:slice of life')).toBe('slice of life');
    expect(labelOf('studio:madhouse inc.')).toBe('Madhouse Inc.');
  });

  it('rarer terms weigh more', () => {
    expect(idf('tag:horror')).toBeGreaterThan(idf('tag:comedy'));
  });
});

describe('weights', () => {
  it('a rating maps 1 → −1 and 10 → +1; without one the status decides, Dropped counting against', () => {
    expect(weightOf(10, 'completed')).toBe(1);
    expect(weightOf(1, 'completed')).toBe(-1);
    expect(weightOf(null, 'completed')).toBeGreaterThan(weightOf(null, 'watching'));
    expect(weightOf(null, 'dropped')).toBeLessThan(0);
  });
});

describe('ranking and its because', () => {
  const profile = profileOf([liked('Space Show', ['tag:mecha', 'tag:space']), liked('Kitchen Show', ['tag:cooking'], 0.3)], idf);

  it('ranks by overlap with what the owner liked, and says which terms did it', () => {
    const ranked = rank([c('cook', ['tag:cooking']), c('mech', ['tag:mecha', 'tag:space']), c('scare', ['tag:horror'])], profile, idf);
    expect(ranked.map((r) => r.id)).toEqual(['mech', 'cook', 'scare']);
    expect(ranked[0]?.because).toEqual(expect.arrayContaining(['tag:mecha', 'tag:space']));
    expect(ranked[2]?.because).toEqual([]);
  });

  it('names the liked Show it is most like', () => {
    expect(closestLiked(c('mech', ['tag:mecha', 'tag:war']), [liked('Space Show', ['tag:mecha', 'tag:space']), liked('Kitchen Show', ['tag:cooking'])], idf)?.title).toBe('Space Show');
    expect(closestLiked(c('scare', ['tag:horror']), [liked('Space Show', ['tag:mecha'])], idf)).toBeNull();
  });

  it('the catalog score breaks a tie, never more', () => {
    const [a, b] = rank([c('low', ['tag:mecha'], 5), c('high', ['tag:mecha'], 9)], profile, idf);
    expect([a?.id, b?.id]).toEqual(['high', 'low']);
  });
});

describe('Not interested and the owner’s edits (KURO-REQ-046, KURO-REQ-048)', () => {
  const signals = [liked('Space Show', ['tag:mecha', 'tag:space']), liked('Kitchen Show', ['tag:cooking'], 0.4)];
  const fit = (p: ReturnType<typeof profileOf>, terms: string[]) => rank([c('x', terms)], p, idf)[0]?.fit ?? 0;

  it('a dismissal weighs similar Shows down', () => {
    const before = profileOf(signals, idf);
    const after = profileOf([...signals, liked('dismissed', ['tag:mecha', 'tag:war'], DISMISSED_WEIGHT)], idf);
    expect(fit(after, ['tag:mecha', 'tag:war'])).toBeLessThan(fit(before, ['tag:mecha', 'tag:war']));
  });

  it('boosting a term moves its Shows up; lowering moves them down; muting removes it from the score', () => {
    const plain = profileOf(signals, idf);
    const boosted = profileOf(signals, idf, new Map([['tag:cooking', 'boost' as const]]));
    const lowered = profileOf(signals, idf, new Map([['tag:mecha', 'lower' as const]]));
    const muted = profileOf(signals, idf, new Map([['tag:mecha', 'mute' as const]]));
    const order = (p: ReturnType<typeof profileOf>) => rank([c('mech', ['tag:mecha']), c('cook', ['tag:cooking'])], p, idf).map((r) => r.id);
    expect(order(plain)).toEqual(['mech', 'cook']);
    expect(order(boosted)).toEqual(['cook', 'mech']);
    expect(order(lowered)).toEqual(['cook', 'mech']);
    expect(fit(muted, ['tag:mecha'])).toBe(0);
    expect(muted.learned.get('tag:mecha')).toBeGreaterThan(0);
  });
});

describe('the anime season', () => {
  it('names the season a date falls in', () => {
    expect(seasonOf(new Date('2026-10-20T00:00:00Z'))).toEqual({ season: 'FALL', year: 2026 });
    expect(seasonOf(new Date('2027-01-05T00:00:00Z'))).toEqual({ season: 'WINTER', year: 2027 });
    expect(seasonOf(new Date('2026-04-01T00:00:00Z'))).toEqual({ season: 'SPRING', year: 2026 });
  });
});
