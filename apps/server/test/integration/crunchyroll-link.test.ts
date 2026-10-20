import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPassword } from '../../src/auth/login.js';
import * as connection from '../../src/cr/connection.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/** Recognisable values, so a leak anywhere is a plain substring match. */
const CR_PASSWORD = 'cr-password-MUST-NEVER-BE-STORED-7f3a';
const CR_TOKEN = 'cr-refresh-token-MUST-BE-SEALED-91c2';
const ROTATED = 'cr-refresh-token-ROTATED-55aa';

let sidecar: Server;
let sidecarUrl = '';
const devicesSeen: string[] = [];
let logged = '';
let h: Harness;
let cookie = '';
let userId = '';

beforeAll(async () => {
  sidecar = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const b = JSON.parse(body) as { password?: string; deviceId?: string };
      res.setHeader('content-type', 'application/json');
      devicesSeen.push(b.deviceId ?? '');
      if (b.password !== CR_PASSWORD) {
        res.writeHead(401).end(JSON.stringify({ error: 'expired', message: 'invalid_credentials' }));
        return;
      }
      res.end(JSON.stringify({ refreshToken: CR_TOKEN, accountId: '00000000-0000-4000-8000-0000000000aa', profileId: null }));
    });
  });
  await new Promise<void>((r) => sidecar.listen(0, r));
  sidecarUrl = `http://127.0.0.1:${String((sidecar.address() as AddressInfo).port)}`;

  const sink = new Writable({ write(chunk: Buffer, _e, done) { logged += chunk.toString(); done(); } });
  h = await startApp(null, undefined, undefined, { sidecarUrl, log: pino({ level: 'trace' }, sink) });
  const user = await h.db.user.create({ data: { email: 'cr-owner@example.com', displayName: 'CR owner' } });
  userId = user.id;
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'owner password for tests');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'cr-owner@example.com', password: 'owner password for tests' })), 'kuro_session') ?? '';
});

afterAll(async () => {
  await h.close();
  sidecar.close();
});

const post = (path: string, body: unknown) => fetch(`${h.base}${path}`, { ...json(body), headers: { 'content-type': 'application/json', cookie } });

describe('linking Crunchyroll (KURO-REQ-001, KURO-REQ-002)', () => {
  it('needs a signed-in owner', async () => {
    expect((await fetch(`${h.base}/api/crunchyroll`)).status).toBe(401);
  });

  it('refuses wrong Crunchyroll credentials with a plain message', async () => {
    const res = await post('/api/crunchyroll/link', { email: 'me@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { kind: string }).kind).toBe('expired');
  });

  let responseText = '';
  it('links, and the response carries neither the password nor the token', async () => {
    const res = await post('/api/crunchyroll/link', { email: 'me@example.com', password: CR_PASSWORD });
    responseText = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({ linked: true, state: 'linked' });
    expect(responseText).not.toContain(CR_PASSWORD);
    expect(responseText).not.toContain(CR_TOKEN);
  });

  it('stores only AES-256-GCM ciphertext — no table row holds the password or the token', async () => {
    const rows = await h.db.$queryRawUnsafe<{ dump: string }[]>(
      `select coalesce(string_agg(t::text, E'\\n'), '') as dump from (
         select row_to_json(c)::text as t from cr_connection c
         union all select row_to_json(l)::text from change_log l
         union all select row_to_json(s)::text from session s
       ) x`,
    );
    const dump = rows[0]?.dump ?? '';
    expect(dump).toContain('refresh_token_ciphertext');
    expect(dump).not.toContain(CR_PASSWORD);
    expect(dump).not.toContain(CR_TOKEN);
    const row = await h.db.crConnection.findUniqueOrThrow({ where: { userId } });
    expect(row.refreshTokenCiphertext.split('.')).toHaveLength(3);
  });

  it('never writes either to the log, even at trace level', () => {
    expect(logged).toContain('crunchyroll linked');
    expect(logged).not.toContain(CR_PASSWORD);
    expect(logged).not.toContain(CR_TOKEN);
  });

  it('opens the sealed token only for a sidecar call, and seals the rotated one', async () => {
    const s = await connection.session(h.db, SECRET_KEY, userId);
    expect(s.refreshToken).toBe(CR_TOKEN);
    await connection.rotate(h.db, SECRET_KEY, s.id, ROTATED);
    expect((await connection.session(h.db, SECRET_KEY, userId)).refreshToken).toBe(ROTATED);
  });

  it('keeps the same device on re-link, and logs the change', async () => {
    await post('/api/crunchyroll/link', { email: 'me@example.com', password: CR_PASSWORD });
    const ok = devicesSeen.slice(-2);
    expect(ok[0]).toBe(ok[1]);
    expect(await h.db.changeLog.count({ where: { entity: 'cr_connection', action: 'relinked' } })).toBe(1);
  });
});
