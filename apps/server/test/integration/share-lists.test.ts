import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/** Shared lists: the owner's recommendations, readable by link without signing in, change-logged and undoable. */

let h: Harness;
let cookie = '';
const KEYS = ['cr:GSHA', 'cr:GSHB', 'cr:GSHC'];

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'share@example.com', displayName: 'S' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'share owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'share@example.com', password: 'share owner password' })), 'kuro_session') ?? '';
  for (const k of KEYS) {
    await h.db.crSeries.create({ data: { id: k.slice(3), title: `Series ${k.slice(6)}`, slugTitle: `series-${k.slice(3).toLowerCase()}`, description: `About ${k.slice(6)}.`, raw: { series_launch_year: 2019, season_count: 2 } } });
    await h.db.showState.create({ data: { showKey: k, title: `Show ${k.slice(6)}`, status: 'watching', watchedEpisodes: 3, totalEpisodes: 24, remainingS: 9999, derivedAt: new Date() } });
  }
});
afterAll(async () => {
  await h.db.shareList.deleteMany();
  await h.db.showState.deleteMany({ where: { showKey: { in: KEYS } } });
  await h.db.crSeries.deleteMany({ where: { id: { in: KEYS.map((k) => k.slice(3)) } } });
  await h.close();
});

const call = (method: string, path: string, body?: unknown) => fetch(`${h.base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let id = '';
let token = '';

describe('shared lists', () => {
  it('are the owner’s alone to make and edit', async () => {
    expect((await fetch(`${h.base}/api/share-lists`, json({ title: 'For Sam' }))).status).toBe(401);
    const res = await call('POST', '/api/share-lists', { title: 'For Sam', intro: 'Start at the top.' });
    expect(res.status).toBe(201);
    id = ((await res.json()) as { id: string }).id;
    expect((await call('POST', `/api/share-lists/${id}/items`, { showKey: 'cr:GSHA', note: 'The best one' })).status).toBe(201);
    expect((await call('POST', `/api/share-lists/${id}/items`, { showKey: 'cr:GSHB' })).status).toBe(201);
    expect((await call('POST', `/api/share-lists/${id}/items`, { showKey: 'cr:GSHC' })).status).toBe(201);
    expect((await call('POST', `/api/share-lists/${id}/items`, { showKey: 'cr:NOPE' })).status).toBe(404);
    expect((await call('PUT', `/api/share-lists/${id}/order`, { showKeys: ['cr:GSHC', 'cr:GSHA'] })).status).toBe(204);
    expect((await call('DELETE', `/api/share-lists/${id}/items/${encodeURIComponent('cr:GSHB')}`)).status).toBe(204);
    const list = (await (await call('GET', `/api/share-lists/${id}`)).json()) as { token: string; items: { showKey: string; note: string | null }[] };
    expect(list.items.map((i) => [i.showKey, i.note])).toEqual([['cr:GSHC', null], ['cr:GSHA', 'The best one']]);
    expect(list.token.length).toBeGreaterThanOrEqual(43);
    token = list.token;
  });

  it('read without signing in, and show nothing of the owner’s history', async () => {
    const res = await fetch(`${h.base}/public/lists/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const body = (await res.json()) as { title: string; intro: string; items: Record<string, unknown>[] };
    expect(body.title).toBe('For Sam');
    expect(body.intro).toBe('Start at the top.');
    expect(body.items.map((i) => i['title'])).toEqual(['Show C', 'Show A']);
    expect(body.items[1]).toMatchObject({ note: 'The best one', description: 'About A.', year: 2019, seasons: 2, episodes: 24, crunchyrollUrl: 'https://www.crunchyroll.com/series/GSHA/series-gsha' });
    const text = JSON.stringify(body);
    for (const secret of ['watching', 'remaining', 'watched', 'showKey', 'cr:GSH']) expect(text).not.toContain(secret);
  });

  it('stop working when sharing is off or the link is renewed', async () => {
    expect((await fetch(`${h.base}/public/lists/not-a-real-token-at-all-0000`)).status).toBe(404);
    const renewed = (await (await call('PUT', `/api/share-lists/${id}/link`, { enabled: true, renew: true })).json()) as { token: string };
    expect(renewed.token).not.toBe(token);
    expect((await fetch(`${h.base}/public/lists/${token}`)).status).toBe(404);
    expect((await fetch(`${h.base}/public/lists/${renewed.token}`)).status).toBe(200);
    expect(((await (await call('PUT', `/api/share-lists/${id}/link`, { enabled: false })).json()) as { token: string | null }).token).toBeNull();
    expect((await fetch(`${h.base}/public/lists/${renewed.token}`)).status).toBe(404);
    token = renewed.token;
  });

  it('undo brings back a deleted list, link and all', async () => {
    expect((await call('PUT', `/api/share-lists/${id}/link`, { enabled: true })).status).toBe(200);
    const live = ((await (await call('GET', `/api/share-lists/${id}`)).json()) as { token: string }).token;
    expect((await call('DELETE', `/api/share-lists/${id}`)).status).toBe(204);
    expect((await fetch(`${h.base}/public/lists/${live}`)).status).toBe(404);
    const c = await h.db.changeLog.findFirstOrThrow({ where: { entity: 'share_list', action: 'deleted' }, orderBy: { at: 'desc' } });
    expect((await call('POST', `/api/changes/${c.id}/undo`)).status).toBe(204);
    // Undo re-derives the Library, which has no plays here, so titles come from Crunchyroll's series.
    const back = (await (await fetch(`${h.base}/public/lists/${live}`)).json()) as { items: { title: string; note: string | null }[] };
    expect(back.items.map((i) => [i.title, i.note])).toEqual([['Series C', null], ['Series A', 'The best one']]);
  });
});
