import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { seal } from '../../src/crypto/secretbox.js';
import { rebuildShows } from '../../src/derive/rebuild.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/** KURO-T-4.1 and 4.3: ratings on a Show and a Season, notes, drop reasons — each change-logged and undoable. */

let h: Harness;
let cookie = '';
const KEY = 'cr:GTASTE';

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'taste@example.com', displayName: 'T' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'taste owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'taste@example.com', password: 'taste owner password' })), 'kuro_session') ?? '';
  const sealed = seal('rt', SECRET_KEY);
  const conn = await h.db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000f2', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
  const run = await h.db.syncRun.create({ data: { crConnectionId: conn.id, kind: 'backfill', status: 'succeeded' } });
  await h.db.crSeries.create({ data: { id: 'GTASTE', title: 'Tasteful Show', raw: {} } });
  await h.db.crSeason.create({ data: { id: 'GTASTES1', seriesId: 'GTASTE', title: 'Season 1', seasonNumber: 1, raw: {} } });
  await h.db.crEpisode.create({ data: { id: 'GTASTEE1', seasonId: 'GTASTES1', title: 'E1', episodeNumber: 1, sequenceNumber: 1, durationS: 1420, canonicalId: 'GTASTEE1', raw: {} } });
  await h.db.play.create({ data: { crEpisodeId: 'GTASTEE1', crParentId: 'GTASTE', crParentType: 'series', datePlayed: new Date(), playheadS: 1420, fullyWatched: true, raw: {}, syncRunId: run.id } });
  await rebuildShows(h.db, user.id);
});
afterAll(async () => {
  await h.close();
});

const put = (path: string, body: unknown) => fetch(`${h.base}${path}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const detail = async () => (await (await fetch(`${h.base}/api/shows/${encodeURIComponent(KEY)}`, { headers: { cookie } })).json()) as { rating: number | null; note: string | null; dropReason: string | null; status: string };
const undoLast = async (entity: string) => {
  const c = await h.db.changeLog.findFirstOrThrow({ where: { entity, undoesId: null }, orderBy: { at: 'desc' } });
  return fetch(`${h.base}/api/changes/${c.id}/undo`, { method: 'POST', headers: { cookie } });
};

describe('the owner’s say on a Show (KURO-T-4.1, KURO-T-4.3)', () => {
  it('rates the Show 1–10, refuses anything else, and undo restores the earlier score', async () => {
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/rating`, { score: 8 })).status).toBe(204);
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/rating`, { score: 9 })).status).toBe(204);
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/rating`, { score: 11 })).status).toBe(400);
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/rating`, { score: 7.5 })).status).toBe(400);
    expect((await detail()).rating).toBe(9);
    expect((await undoLast('rating')).status).toBe(204);
    expect((await detail()).rating).toBe(8);
  });

  it('rates a Season on its own', async () => {
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/seasons/${encodeURIComponent('anilist:1')}/rating`, { score: 6 })).status).toBe(204);
    expect((await h.db.rating.findUniqueOrThrow({ where: { target: 'season:anilist:1' } })).score).toBe(6);
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/seasons/${encodeURIComponent('anilist:1')}/rating`, { score: null })).status).toBe(204);
    expect(await h.db.rating.findUnique({ where: { target: 'season:anilist:1' } })).toBeNull();
  });

  it('keeps a note, change-logged; an empty note removes it; undo brings it back', async () => {
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/note`, { text: '  Stopped at the tournament arc.  ' })).status).toBe(204);
    expect((await detail()).note).toBe('Stopped at the tournament arc.');
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/note`, { text: '' })).status).toBe(204);
    expect((await detail()).note).toBeNull();
    expect((await undoLast('show_note')).status).toBe(204);
    expect((await detail()).note).toBe('Stopped at the tournament arc.');
  });

  it('dropping records why; clearing the status clears the reason; undo restores both', async () => {
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/status`, { status: 'dropped', reason: 'pacing' })).status).toBe(204);
    expect(await detail()).toMatchObject({ status: 'dropped', dropReason: 'pacing' });
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/status`, { status: 'dropped', reason: 'boring' })).status).toBe(400);
    expect((await put(`/api/shows/${encodeURIComponent(KEY)}/status`, { status: null })).status).toBe(204);
    expect((await detail()).dropReason).toBeNull();
    expect((await undoLast('show_status')).status).toBe(204);
    expect(await detail()).toMatchObject({ status: 'dropped', dropReason: 'pacing' });
  });
});
