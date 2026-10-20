import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/** KURO-T-4.2: the rewatch queue — reorderable, with a reason and starting Season, change-logged and undoable. */

let h: Harness;
let cookie = '';
const KEYS = ['cr:GRWA', 'cr:GRWB', 'cr:GRWC'];

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'rewatch@example.com', displayName: 'R' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'rewatch owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'rewatch@example.com', password: 'rewatch owner password' })), 'kuro_session') ?? '';
  for (const k of KEYS) await h.db.showState.create({ data: { showKey: k, title: `Show ${k}`, status: 'completed', watchedEpisodes: 12, totalEpisodes: 12, remainingS: 0, derivedAt: new Date() } });
});
afterAll(async () => {
  await h.db.rewatchQueueItem.deleteMany();
  await h.db.showState.deleteMany({ where: { showKey: { in: KEYS } } });
  await h.close();
});

const call = (method: string, path: string, body?: unknown) => fetch(`${h.base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const queue = async () => ((await (await call('GET', '/api/rewatch-queue')).json()) as { items: { showKey: string; reason: string | null; startEntryId: string | null }[] }).items;

describe('the rewatch queue (KURO-REQ-042)', () => {
  it('queues Shows with a reason and a Season to start from, refusing unknown ones', async () => {
    expect((await call('POST', '/api/rewatch-queue', { showKey: 'cr:GRWA', reason: 'Before season 2' })).status).toBe(201);
    expect((await call('POST', '/api/rewatch-queue', { showKey: 'cr:GRWB', startEntryId: 'anilist:5' })).status).toBe(201);
    expect((await call('POST', '/api/rewatch-queue', { showKey: 'cr:GRWC' })).status).toBe(201);
    expect((await call('POST', '/api/rewatch-queue', { showKey: 'cr:NOPE' })).status).toBe(404);
    expect((await queue()).map((q) => [q.showKey, q.reason, q.startEntryId])).toEqual([['cr:GRWA', 'Before season 2', null], ['cr:GRWB', null, 'anilist:5'], ['cr:GRWC', null, null]]);
  });

  it('reorders, edits and removes', async () => {
    expect((await call('PUT', '/api/rewatch-queue/order', { showKeys: ['cr:GRWC', 'cr:GRWA'] })).status).toBe(204);
    expect((await queue()).map((q) => q.showKey)).toEqual(['cr:GRWC', 'cr:GRWA', 'cr:GRWB']);
    expect((await call('PUT', `/api/rewatch-queue/${encodeURIComponent('cr:GRWB')}`, { reason: 'Comfort show' })).status).toBe(204);
    expect((await call('DELETE', `/api/rewatch-queue/${encodeURIComponent('cr:GRWA')}`)).status).toBe(204);
    expect((await queue()).map((q) => [q.showKey, q.reason])).toEqual([['cr:GRWC', null], ['cr:GRWB', 'Comfort show']]);
  });

  it('undo puts the queue back exactly as it was', async () => {
    const c = await h.db.changeLog.findFirstOrThrow({ where: { entity: 'rewatch_queue', action: 'unqueued' }, orderBy: { at: 'desc' } });
    expect((await call('POST', `/api/changes/${c.id}/undo`)).status).toBe(204);
    expect((await queue()).map((q) => q.showKey)).toEqual(['cr:GRWC', 'cr:GRWA', 'cr:GRWB']);
  });
});
