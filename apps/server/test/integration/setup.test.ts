import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { cookieFrom, json, startApp, type Harness } from './helpers.js';

const TOKEN = 'setup-token-for-tests-only-0123456789';
const OWNER = { email: 'Owner@Example.com', displayName: 'Owner', password: 'a long enough password' };
let h: Harness;

beforeAll(async () => {
  h = await startApp(null, TOKEN, inject('emptyDatabaseUrl'));
});
afterAll(async () => {
  await h.close();
});

describe('first-run setup (KURO-REQ-055, KURO-REQ-062)', () => {
  it('says setup is required while no owner exists', async () => {
    const res = await fetch(`${h.base}/api/setup`);
    expect(res.status).toBe(200);
    expect(((await (await fetch(`${h.base}/auth/session`)).json()) as { setupRequired: boolean }).setupRequired).toBe(true);
  });

  it('refuses the wrong setup token', async () => {
    const res = await fetch(`${h.base}/api/setup`, json({ ...OWNER, setupToken: 'wrong' }));
    expect(res.status).toBe(403);
    expect(await h.db.user.count()).toBe(0);
  });

  it('refuses a short password', async () => {
    const res = await fetch(`${h.base}/api/setup`, json({ ...OWNER, password: 'short', setupToken: TOKEN }));
    expect(res.status).toBe(400);
  });

  it('creates the owner with the right token and signs them in', async () => {
    const res = await fetch(`${h.base}/api/setup`, json({ ...OWNER, setupToken: TOKEN }));
    expect(res.status).toBe(201);
    const cookie = cookieFrom(res, 'kuro_session');
    const session = (await (await fetch(`${h.base}/auth/session`, { headers: { cookie: cookie ?? '' } })).json()) as {
      authenticated: boolean;
      user: { email: string };
      totpEnrolled: boolean;
    };
    expect(session.authenticated).toBe(true);
    expect(session.user.email).toBe('owner@example.com');
    expect(session.totpEnrolled).toBe(false);
    expect(await h.db.changeLog.count({ where: { action: 'owner_created' } })).toBe(1);
  });

  it('then closes setup for good: 404 for every request, even with the token', async () => {
    expect((await fetch(`${h.base}/api/setup`)).status).toBe(404);
    const again = await fetch(`${h.base}/api/setup`, json({ ...OWNER, email: 'second@example.com', setupToken: TOKEN }));
    expect(again.status).toBe(404);
    expect(await h.db.user.count()).toBe(1);
  });

  it('lets the new owner sign in with the password they chose', async () => {
    const res = await fetch(`${h.base}/auth/login`, json({ email: OWNER.email, password: OWNER.password }));
    expect(res.status).toBe(200);
  });

  it('has no signup route anywhere', async () => {
    for (const path of ['/auth/signup', '/auth/register', '/api/users']) {
      const res = await fetch(`${h.base}${path}`, json({ email: 'x@example.com', password: 'whatever whatever' }));
      expect([403, 404]).toContain(res.status);
    }
  });
});
