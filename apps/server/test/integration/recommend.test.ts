import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { forgetPool } from '../../src/recommend/load.js';
import { seasonOf } from '../../src/recommend/model.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-4.4 and 4.5: Discover over a synthetic catalog — each rec with its because, sequels and
 * relatives of the owner's Shows left out, Not interested hiding one and lowering its likes — and
 * This Season's picks reordering when the owner edits the taste profile. The terms are unique to
 * this file, so what other files left in the shared database cannot move them.
 */

let h: Harness;
let cookie = '';
const RELEASE = randomUUID();
const NOW = new Date();
const { season, year } = seasonOf(NOW);

interface Rec { entryId: string; fit: number; because: { term: string; label: string }[]; like: { title: string } | null }
const entry = (id: string, tags: string[], over: Record<string, unknown> = {}) => ({
  id, title: id, type: 'TV', episodes: 12, status: 'FINISHED', season: 'SPRING', seasonYear: 2015, synonyms: [], sources: [`https://zz.example/${id}`], related: [], tags, studios: [], releaseId: RELEASE, updatedAt: NOW, ...over,
});
const OWNED = [
  { key: 'show:zz:mecha', title: 'ZZ Mecha Show', entry: entry('zz:owned-mecha', ['zz-mecha', 'zz-space', 'zz-war']), score: 9 },
  { key: 'show:zz:cook', title: 'ZZ Cooking Show', entry: entry('zz:owned-cook', ['zz-cooking', 'zz-slice']), score: 8 },
  { key: 'show:zz:horror', title: 'ZZ Horror Show', entry: entry('zz:owned-horror', ['zz-horror']), score: 7 },
];
const CANDIDATES = [
  entry('zz:space-opera', ['zz-mecha', 'zz-space']),
  entry('zz:war-story', ['zz-mecha', 'zz-war', 'zz-politics'], { season, seasonYear: year, status: 'ONGOING' }),
  entry('zz:kitchen', ['zz-cooking'], { season, seasonYear: year, status: 'ONGOING' }),
  entry('zz:sequel', ['zz-mecha', 'zz-space', 'sequel']),
  entry('zz:relative', ['zz-mecha', 'zz-space'], { related: ['https://zz.example/zz:owned-mecha'] }),
  entry('zz:part-two', ['zz-cooking', 'zz-slice'], { seasonYear: year + 1, related: ['https://zz.example/zz:kitchen'] }),
];

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'recs@example.com', displayName: 'R' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'recs owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'recs@example.com', password: 'recs owner password' })), 'kuro_session') ?? '';
  await h.db.catalogEntry.createMany({ data: [...OWNED.map((o) => o.entry), ...CANDIDATES] });
  for (const o of OWNED) await h.db.rating.create({ data: { target: `show:${o.key}`, score: o.score } });
  forgetPool();
});

// Shows are derived: an undo rebuilds them from plays, which these synthetic ones have none of.
beforeEach(() => seedShows());

afterAll(async () => {
  const keys = OWNED.map((o) => o.key);
  await h.db.showItem.deleteMany({ where: { showKey: { in: keys } } });
  await h.db.show.deleteMany({ where: { showKey: { in: keys } } });
  await h.db.showState.deleteMany({ where: { showKey: { in: keys } } });
  await h.db.rating.deleteMany({ where: { target: { in: keys.map((k) => `show:${k}`) } } });
  await h.db.recDismissal.deleteMany({ where: { catalogEntryId: { startsWith: 'zz:' } } });
  await h.db.tasteTerm.deleteMany({ where: { term: { startsWith: 'tag:zz-' } } });
  await h.db.catalogEntry.deleteMany({ where: { releaseId: RELEASE } });
  await h.close();
});

const get = async <T,>(path: string) => (await (await fetch(`${h.base}${path}`, { headers: { cookie } })).json()) as T;
const put = (path: string, body: unknown) => fetch(`${h.base}${path}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const recs = async () => (await get<{ state: string; items: Rec[] }>('/api/discover')).items.filter((r) => r.entryId.startsWith('zz:'));
const picks = async () => (await get<{ picks: { items: Rec[] } }>('/api/this-season')).picks.items.filter((r) => r.entryId.startsWith('zz:')).map((r) => r.entryId);
const seedShows = async () => {
  for (const o of OWNED) {
    if ((await h.db.show.findUnique({ where: { showKey: o.key } })) !== null) continue;
    await h.db.show.create({ data: { showKey: o.key, title: o.title, franchiseKey: `fr:${o.key}`, seriesIds: [], derivedAt: NOW, items: { create: [{ position: 0, catalogEntryId: o.entry.id, kind: 'season', required: true }] } } });
    await h.db.showState.upsert({ where: { showKey: o.key }, create: { showKey: o.key, title: o.title, status: 'completed', watchedEpisodes: 12, totalEpisodes: 12, remainingS: 0, derivedAt: NOW }, update: {} });
  }
};
const undoLast = async (entity: string) => {
  const c = await h.db.changeLog.findFirstOrThrow({ where: { entity, undoesId: null }, orderBy: { at: 'desc' } });
  const res = await fetch(`${h.base}/api/changes/${c.id}/undo`, { method: 'POST', headers: { cookie } });
  await seedShows();
  return res;
};

describe('Discover (KURO-T-4.4)', () => {
  it('each rec says why — the shared terms and the liked Show it is most like', async () => {
    const items = await recs();
    const opera = items.find((r) => r.entryId === 'zz:space-opera');
    expect(opera?.because.map((b) => b.label)).toEqual(expect.arrayContaining(['zz-mecha', 'zz-space']));
    expect(opera?.like?.title).toBe('ZZ Mecha Show');
    expect(items.every((r) => r.because.length > 0)).toBe(true);
  });

  it('leaves out the owner’s own Shows, sequels, relatives of what they watched, and later parts of a candidate', async () => {
    const ids = (await recs()).map((r) => r.entryId);
    expect(ids).toEqual(expect.arrayContaining(['zz:space-opera', 'zz:war-story', 'zz:kitchen']));
    for (const gone of ['zz:owned-mecha', 'zz:sequel', 'zz:relative', 'zz:part-two']) expect(ids).not.toContain(gone);
  });

  it('Not interested hides it and lowers the Shows like it; undo brings it back', async () => {
    const fitOf = (items: Rec[], id: string) => items.find((r) => r.entryId === id)?.fit ?? Number.NaN;
    const before = await recs();
    expect((await put('/api/discover/zz:space-opera/interest', { interested: false })).status).toBe(204);
    const after = await recs();
    expect(after.map((r) => r.entryId)).not.toContain('zz:space-opera');
    expect(fitOf(after, 'zz:war-story')).toBeLessThan(fitOf(before, 'zz:war-story'));
    expect(fitOf(after, 'zz:kitchen')).toBeGreaterThanOrEqual(fitOf(before, 'zz:kitchen') - 0.05);
    expect((await undoLast('rec_dismissal')).status).toBe(204);
    expect((await recs()).map((r) => r.entryId)).toContain('zz:space-opera');
  });

  it('refuses an unknown entry', async () => {
    expect((await put('/api/discover/zz:nope/interest', { interested: false })).status).toBe(404);
    expect((await put('/api/discover/zz:kitchen/interest', { interested: 'no' })).status).toBe(400);
  });
});

describe('season picks and the taste profile (KURO-T-4.5)', () => {
  it('This Season orders new Shows by fit; editing the taste profile changes the order; undo restores it', async () => {
    expect(await picks()).toEqual(['zz:war-story', 'zz:kitchen']);
    expect((await put(`/api/taste/terms/${encodeURIComponent('tag:zz-cooking')}`, { adjust: 'boost' })).status).toBe(204);
    expect(await picks()).toEqual(['zz:kitchen', 'zz:war-story']);
    expect((await undoLast('taste_term')).status).toBe(204);
    expect(await picks()).toEqual(['zz:war-story', 'zz:kitchen']);
    expect((await put(`/api/taste/terms/${encodeURIComponent('tag:zz-mecha')}`, { adjust: 'mute' })).status).toBe(204);
    expect((await put(`/api/taste/terms/${encodeURIComponent('tag:zz-war')}`, { adjust: 'lower' })).status).toBe(204);
    expect(await picks()).toEqual(['zz:kitchen', 'zz:war-story']);
  });

  it('the profile lists learned tags with their weights, and every edited term', async () => {
    const t = await get<{ tags: { term: string; learned: number }[]; edited: { term: string; adjust: string }[] }>('/api/taste');
    expect(t.tags.map((x) => x.term)).toContain('tag:zz-space');
    expect(t.edited).toEqual(expect.arrayContaining([expect.objectContaining({ term: 'tag:zz-mecha', adjust: 'mute' }), expect.objectContaining({ term: 'tag:zz-war', adjust: 'lower' })]));
    expect((await put('/api/taste/terms/genre:zz', { adjust: 'boost' })).status).toBe(400);
    expect((await put(`/api/taste/terms/${encodeURIComponent('tag:zz-war')}`, { adjust: null })).status).toBe(204);
    expect(await h.db.tasteTerm.findUnique({ where: { term: 'tag:zz-war' } })).toBeNull();
  });
});
