/**
 * The local, explainable recommender (KURO-REQ-045–048, KURO-T-4.4/4.5). Every Show and catalog
 * entry is a bag of terms — its tags and studios — weighted by how rare the term is across the
 * catalog (IDF). The owner's taste is the sum of their Shows' vectors, each weighted by a rating or,
 * failing one, by its status; Not interested adds the dismissed entry with a negative weight, and the
 * owner's own edits boost, lower or mute single terms. A candidate scores by cosine against that
 * profile plus a small nudge from the catalog's score, and the terms that contributed most are its
 * "because". Pure: nothing here reads the database.
 */

export type Term = string;

/** Tags that describe the release, not the show, or that would read badly as a reason. */
const META = new Set([
  'place', 'time', 'season', 'present', 'past', 'future', 'earth', 'japan', 'asia', 'tropes', 'new', 'manga', 'novel',
  'japanese production', 'chinese production', 'based on a manga', 'based on a light novel', 'based on a novel',
  'based on a visual novel', 'based on a video game', 'original work', 'cgi', 'award winning', 'sequel', 'remake',
  'ed variety', 'op variety', 'preaired episodes', 'censored uncensored version', 'recap in opening', 'stereoscopic',
  'unsorted', 'setting', 'elements', 'themes', 'target audience', 'technical aspects', 'cast', 'origin', 'maintenance tags',
  'episodic', 'running gag', 'funny expressions', 'calling your attacks', 'primarily adult cast', 'primarily teen cast',
  'primarily female cast', 'primarily male cast', 'heterosexual', 'anachronisms', 'fictional location', 'speculative fiction',
  'stereotypes', 'summer', 'winter', 'spring', 'autumn', 'present', 'noitamina', 'tv censoring', 'storytelling', 'ending',
]);
/** AniDB's technical-aspect tags: how it was made or aired, not what it is. */
const TECHNICAL = /co-production|censor|bounce|transition|recycled|variety|preair|filler|continuity|distortion|open-ended|multiple endings|widescreen|cliffhanger|shot|animation style|watercolour|rotoscop|stop motion|3d cg|motion comic|live-action|subtitle|dub|remaster/;
const UNSHOWABLE = /breast|nud(e|ity)|pant(y|ies|su)|sexual|jokes|skimpy|ecchi|fan ?service|bdsm|incest|hentai|erot|nipple|\bbath|chest|\bbust|\bbutt|crotch|grop|lingerie|swimsuit|underwear|pornograph|\brape|lolicon|shotacon|yaoi/;
/** Entries tagged so are never recommended. */
export const ADULT = ['hentai', 'erotic game', 'pornography', 'borderline porn'];

/** The terms a catalog entry stands for: its showable tags and its studios. */
export function termsOf(tags: readonly string[], studios: readonly string[]): Term[] {
  const out = new Set<Term>();
  for (const t of tags) {
    const tag = t.trim().toLowerCase();
    if (tag.length === 0 || META.has(tag) || TECHNICAL.test(tag) || UNSHOWABLE.test(tag)) continue;
    out.add(`tag:${tag}`);
  }
  for (const s of studios) if (s.trim().length > 0) out.add(`studio:${s.trim().toLowerCase()}`);
  return [...out];
}

/** How rare each term is across `docs`: ln(N / (1 + df)), floored at a sliver so common terms still count. */
export function idfOf(docs: Iterable<readonly Term[]>): { idf: (t: Term) => number; size: number } {
  const df = new Map<Term, number>();
  let n = 0;
  for (const terms of docs) {
    n += 1;
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const unseen = Math.log(Math.max(n, 2));
  return { idf: (t) => (df.has(t) ? Math.max(Math.log(n / (1 + (df.get(t) ?? 0))), 0.05) : unseen), size: n };
}

/** A unit-length IDF vector over the terms. */
export function vectorOf(terms: readonly Term[], idf: (t: Term) => number): Map<Term, number> {
  const v = new Map(terms.map((t) => [t, idf(t)] as const));
  const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  if (norm > 0) for (const [t, x] of v) v.set(t, x / norm);
  return v;
}

export type ManualAdjust = 'boost' | 'lower' | 'mute';

export interface Signal {
  /** What the owner said or did: a Show they rated or watched, or an entry they dismissed. */
  key: string;
  title: string;
  terms: readonly Term[];
  weight: number;
}

/** Status weights when a Show has no rating of its own. Plan to watch is mild interest; Dropped, mild dislike. */
const STATUS_WEIGHT: Record<string, number> = {
  rewatching: 0.8,
  completed: 0.6,
  caught_up: 0.5,
  watching: 0.4,
  paused: 0.15,
  plan_to_watch: 0.1,
  dropped: -0.5,
};
export const DISMISSED_WEIGHT = -0.6;

/** A rating maps 1→-1, 10→+1; without one, the status says how much the Show counts. */
export function weightOf(rating: number | null, status: string): number {
  if (rating !== null) return (rating - 5.5) / 4.5;
  return STATUS_WEIGHT[status] ?? 0;
}

/** At least this many confident signals — a rating, or a Show finished — before recommending. */
export const MIN_SIGNALS = 3;
export const isConfident = (s: { weight: number; rated: boolean; status: string }) =>
  s.rated || s.status === 'completed' || s.status === 'rewatching';

export interface Profile {
  weights: Map<Term, number>;
  /** Each term's weight before the owner's edits, for the taste screen. */
  learned: Map<Term, number>;
  muted: ReadonlySet<Term>;
}

/**
 * Sum the signals' vectors and scale to unit length, so a fit is a cosine; then apply the owner's
 * edits: a boost or a lowering moves a term by half the strongest weight.
 */
export function profileOf(signals: readonly Signal[], idf: (t: Term) => number, adjust: ReadonlyMap<Term, ManualAdjust> = new Map()): Profile {
  const learned = new Map<Term, number>();
  for (const s of signals) {
    if (s.weight === 0) continue;
    for (const [t, x] of vectorOf(s.terms, idf)) learned.set(t, (learned.get(t) ?? 0) + s.weight * x);
  }
  const norm = Math.sqrt([...learned.values()].reduce((sum, x) => sum + x * x, 0));
  if (norm > 0) for (const [t, x] of learned) learned.set(t, x / norm);
  const weights = new Map(learned);
  const strongest = Math.max(0.1, ...[...learned.values()].map(Math.abs));
  const muted = new Set<Term>();
  for (const [t, a] of adjust) {
    if (a === 'mute') {
      weights.delete(t);
      muted.add(t);
    } else weights.set(t, (weights.get(t) ?? 0) + (a === 'boost' ? 0.5 : -0.5) * strongest);
  }
  return { weights, learned, muted };
}

export interface Candidate {
  id: string;
  terms: readonly Term[];
  /** The catalog's 1–10 score, if it has one. */
  score: number | null;
}

export interface Scored {
  id: string;
  fit: number;
  /** The terms that pulled it up most, strongest first. */
  because: Term[];
}

/** How much the catalog's score can move a candidate: a 9 adds this much, a 5 takes it away. */
const QUALITY = 0.04;

export function score(c: Candidate, profile: Profile, idf: (t: Term) => number): Scored {
  const v = vectorOf(c.terms.filter((t) => !profile.muted.has(t)), idf);
  let dot = 0;
  const parts: [Term, number][] = [];
  for (const [t, x] of v) {
    const w = profile.weights.get(t);
    if (w === undefined) continue;
    dot += w * x;
    if (w > 0) parts.push([t, w * x]);
  }
  const quality = c.score === null ? 0 : Math.max(-1, Math.min(1, (c.score - 7) / 2));
  parts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { id: c.id, fit: dot + QUALITY * quality, because: parts.slice(0, 3).map(([t]) => t) };
}

export function rank(candidates: readonly Candidate[], profile: Profile, idf: (t: Term) => number): Scored[] {
  return candidates.map((c) => score(c, profile, idf)).sort((a, b) => b.fit - a.fit || a.id.localeCompare(b.id));
}

/** The owner's liked Show most like the candidate — "because you liked …" — if any shares its terms. */
export function closestLiked(c: Candidate, liked: readonly Signal[], idf: (t: Term) => number): Signal | null {
  const v = vectorOf(c.terms, idf);
  let best: Signal | null = null;
  let bestSim = 0.15;
  for (const s of liked) {
    if (s.weight <= 0) continue;
    let sim = 0;
    for (const [t, x] of vectorOf(s.terms, idf)) sim += x * (v.get(t) ?? 0);
    if (sim > bestSim) {
      best = s;
      bestSim = sim;
    }
  }
  return best;
}

/** "tag:slice of life" → "slice of life"; "studio:madhouse inc." → "Madhouse Inc." */
export function labelOf(term: Term): string {
  if (term.startsWith('studio:')) return term.slice('studio:'.length).replace(/\b\p{L}/gu, (m) => m.toUpperCase());
  return term.slice(term.indexOf(':') + 1);
}

/** The anime season a date falls in, as the catalog names them. */
export function seasonOf(d: Date): { season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'; year: number } {
  const m = d.getUTCMonth();
  return { season: m < 3 ? 'WINTER' : m < 6 ? 'SPRING' : m < 9 ? 'SUMMER' : 'FALL', year: d.getUTCFullYear() };
}
