import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import type { CompletedSignIn, OidcClient } from '../../src/auth/oidc.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';
const COOKIE = 'kuro_session';
const ISS = 'https://auth.example';

/** A stand-in for D3 Auth: the next completed sign-in is whatever the test says it is. */
function fakeIssuer() {
  let next: Omit<CompletedSignIn, 'linkToUserId'> = { iss: ISS, sub: 'sub-1', idToken: 'id' };
  const pending = new Map<string, string | undefined>();
  const client: OidcClient = {
    issuer: ISS,
    beginSignIn(linkToUserId) {
      const tx = `tx-${String(pending.size + 1)}`;
      pending.set(tx, linkToUserId);
      return Promise.resolve({ url: `${ISS}/authorize?state=s`, tx });
    },
    completeSignIn(_url, tx) {
      if (!pending.has(tx)) return Promise.reject(new Error('unknown tx'));
      const linkToUserId = pending.get(tx);
      pending.delete(tx);
      return Promise.resolve({ ...next, ...(linkToUserId !== undefined ? { linkToUserId } : {}) });
    },
    endSessionUrl: () => Promise.resolve(null),
  };
  return { client, willReturn: (c: Omit<CompletedSignIn, 'linkToUserId'>) => { next = c; } };
}

const issuer = fakeIssuer();
let h: Harness;
let ownerId = '';

beforeAll(async () => {
  h = await startApp(issuer.client);
  const owner = await h.db.user.create({ data: { email: EMAIL, displayName: 'Owner' } });
  ownerId = owner.id;
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, owner.id, PASSWORD);
});

afterAll(async () => {
  await h.close();
});

async function signInWithPassword(totpCode?: string): Promise<Response> {
  return fetch(`${h.base}/auth/login`, json({ email: EMAIL, password: PASSWORD, ...(totpCode !== undefined ? { totpCode } : {}) }));
}

async function sessionFor(cookie: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.base}/auth/session`, cookie === null ? {} : { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('password + TOTP (GL-001, KURO-REQ-054)', () => {
  let cookie: string | null = null;
  let totp: TOTP;

  it('refuses a wrong password with the one generic message', async () => {
    const res = await fetch(`${h.base}/auth/login`, json({ email: EMAIL, password: 'nope' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid credentials' });
  });

  it('signs in with the password and sets an HttpOnly session cookie', async () => {
    const res = await signInWithPassword();
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(';')).toMatch(/HttpOnly/i);
    cookie = cookieFrom(res, COOKIE);
    const session = await sessionFor(cookie);
    expect(session.status).toBe(200);
    expect(session.body['authenticated']).toBe(true);
  });

  it('enrols TOTP, then requires a code to sign in', async () => {
    const enrol = await fetch(`${h.base}/auth/totp/enrol`, { method: 'POST', headers: { cookie: cookie ?? '' } });
    const { secret, uri } = (await enrol.json()) as { secret: string; uri: string };
    expect(uri).toContain('issuer=Kur');
    totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' });
    const confirm = await fetch(`${h.base}/auth/totp/confirm`, { ...json({ code: totp.generate() }), headers: { 'content-type': 'application/json', cookie: cookie ?? '' } });
    expect(confirm.status).toBe(204);

    const first = await signInWithPassword();
    expect(await first.json()).toEqual({ status: 'totp_required' });
  });

  it('accepts a fresh code once and refuses its replay', async () => {
    // The step confirmation burned is refused, so use the next step's code.
    const code = totp.generate({ timestamp: Date.now() + 30_000 });
    const ok = await signInWithPassword(code);
    expect(ok.status).toBe(200);
    expect(cookieFrom(ok, COOKIE)).not.toBeNull();
    const replay = await signInWithPassword(code);
    expect(replay.status).toBe(401);
  });

  it('ends the session on sign-out', async () => {
    await fetch(`${h.base}/auth/logout`, { method: 'POST', headers: { cookie: cookie ?? '' } });
    expect((await sessionFor(cookie)).status).toBe(401);
  });
});

describe('Sign in with D3 Auth (GL-001, KURO-REQ-054)', () => {
  async function callbackAfterStart(startCookie?: string): Promise<Response> {
    const start = await fetch(`${h.base}/auth/oidc/start${startCookie !== undefined ? '?link=1' : ''}`, {
      redirect: 'manual',
      ...(startCookie !== undefined ? { headers: { cookie: startCookie } } : {}),
    });
    expect(start.status).toBe(302);
    const tx = cookieFrom(start, 'kuro_oidc_tx');
    expect(tx).not.toBeNull();
    return fetch(`${h.base}/auth/oidc/callback?state=s&code=c`, { redirect: 'manual', headers: { cookie: tx ?? '' } });
  }

  it('refuses an identity nobody has linked — no just-in-time accounts', async () => {
    issuer.willReturn({ iss: ISS, sub: 'stranger', email: EMAIL, idToken: 'id' });
    const usersBefore = await h.db.user.count();
    const res = await callbackAfterStart();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('signin_error');
    expect(cookieFrom(res, COOKIE)).toBeNull();
    expect(await h.db.user.count()).toBe(usersBefore);
  });

  it('links an identity from a signed-in session, by (iss, sub)', async () => {
    const totpFree = await h.db.credential.update({ where: { userId: ownerId }, data: { totpConfirmedAt: null } });
    expect(totpFree.totpConfirmedAt).toBeNull();
    const signedIn = cookieFrom(await signInWithPassword(), COOKIE) ?? '';
    issuer.willReturn({ iss: ISS, sub: 'owner-sub', email: 'someone-else@example.com', idToken: 'id' });
    const res = await callbackAfterStart(signedIn);
    expect(res.headers.get('location')).toBe('/');
    const identity = await h.db.identity.findUnique({ where: { iss_sub: { iss: ISS, sub: 'owner-sub' } } });
    expect(identity?.userId).toBe(ownerId);
  });

  it('then signs the owner in through D3 Auth, whatever email the issuer now claims', async () => {
    issuer.willReturn({ iss: ISS, sub: 'owner-sub', email: 'changed@example.com', idToken: 'id' });
    const res = await callbackAfterStart();
    const cookie = cookieFrom(res, COOKIE);
    expect(cookie).not.toBeNull();
    const session = await sessionFor(cookie);
    expect((session.body['user'] as { id: string }).id).toBe(ownerId);
    expect(session.body['d3AuthLinked']).toBe(true);
  });

  it('refuses a callback this browser did not start', async () => {
    const res = await fetch(`${h.base}/auth/oidc/callback?state=s`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });
});
