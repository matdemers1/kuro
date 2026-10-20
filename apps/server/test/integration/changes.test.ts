import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

let h: Harness;
let cookie = '';
const KEY = 'cr:GCHANGES';

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'changes@example.com', displayName: 'C' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'changes owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'changes@example.com', password: 'changes owner password' })), 'kuro_session') ?? '';
});
afterAll(async () => {
  await h.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${h.base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const pinned = async () => (await h.db.showPreference.findUnique({ where: { showKey: KEY } }))?.pinned ?? false;
const latestPin = async () => {
  const { items } = (await (await call('GET', '/api/changes')).json()) as { items: { id: string; entityId: string; action: string; undoable: boolean }[] };
  return items.filter((i) => i.entityId === KEY);
};

describe('the change log and undo (KURO-REQ-022)', () => {
  it('records every pin change with before and after', async () => {
    expect((await call('PUT', `/api/shows/${KEY}/pin`, { pinned: true })).status).toBe(204);
    const [entry] = await latestPin();
    expect(entry).toMatchObject({ action: 'pinned', undoable: true });
    const row = await h.db.changeLog.findUniqueOrThrow({ where: { id: entry?.id ?? '' } });
    expect(row.before).toEqual({ pinned: false });
    expect(row.after).toEqual({ pinned: true });
  });

  it('undo restores the before state and records its own entry', async () => {
    const [entry] = await latestPin();
    expect((await call('POST', `/api/changes/${entry?.id ?? ''}/undo`)).status).toBe(204);
    expect(await pinned()).toBe(false);
    const rows = await latestPin();
    expect(rows[0]?.action).toBe('undo:pinned');
    expect(rows.find((r) => r.id === entry?.id)?.undoable).toBe(false);
  });

  it('refuses to undo the same change twice', async () => {
    const original = (await latestPin()).find((r) => r.action === 'pinned');
    expect((await call('POST', `/api/changes/${original?.id ?? ''}/undo`)).status).toBe(409);
  });

  it('refuses to undo a change that something newer has overtaken', async () => {
    await call('PUT', `/api/shows/${KEY}/pin`, { pinned: true });
    const [pin] = await latestPin();
    await call('PUT', `/api/shows/${KEY}/pin`, { pinned: false });
    expect((await call('POST', `/api/changes/${pin?.id ?? ''}/undo`)).status).toBe(409);
    expect(await pinned()).toBe(false);
  });
});
