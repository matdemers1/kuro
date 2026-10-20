import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/auth/totp.js';
import { rotateKey } from '../../src/cli/rotateKey.js';
import { open, seal } from '../../src/crypto/secretbox.js';
import { freshDatabase, SECRET_KEY } from './helpers.js';

/** KURO-T-6.4: `kuro rotate-key` re-encrypts the refresh token and the TOTP secret under the new key. */

let fresh: Awaited<ReturnType<typeof freshDatabase>>;
const NEXT = Buffer.alloc(32, 11).toString('base64');

beforeAll(async () => {
  fresh = await freshDatabase('kuro_rotate_test');
  const user = await fresh.db.user.create({ data: { email: 'rotate@example.com', displayName: 'R' } });
  await fresh.db.credential.create({ data: { userId: user.id, passwordHash: 'x', totpSecret: encryptSecret('JBSWY3DPEHPK3PXP', SECRET_KEY), totpConfirmedAt: new Date() } });
  const sealed = seal('the-refresh-token', SECRET_KEY);
  await fresh.db.crConnection.create({ data: { userId: user.id, accountId: '00000000-0000-4000-8000-0000000000f8', deviceId: 'd', refreshTokenCiphertext: sealed, refreshTokenNonce: 'n' } });
}, 60_000);

afterAll(async () => {
  await fresh.drop();
});

const env = (next: string | undefined) => ({ ...process.env, BASE_URL: 'http://localhost:3300', DATABASE_URL: fresh.url, KURO_SECRET_KEY: SECRET_KEY, ...(next === undefined ? {} : { KURO_SECRET_KEY_NEW: next }) });

describe('key rotation (KURO-T-6.4)', () => {
  it('refuses without a new key, or with the same key', async () => {
    expect(await rotateKey(env(undefined))).toBe(2);
    expect(await rotateKey(env(SECRET_KEY))).toBe(2);
    expect(await rotateKey(env('c2hvcnQ='))).toBe(2);
  });

  it('afterwards both secrets open under the new key and not the old one', async () => {
    expect(await rotateKey(env(NEXT))).toBe(0);
    const conn = await fresh.db.crConnection.findFirstOrThrow();
    const cred = await fresh.db.credential.findFirstOrThrow();
    expect(open(conn.refreshTokenCiphertext, NEXT)).toBe('the-refresh-token');
    expect(decryptSecret(cred.totpSecret ?? '', NEXT)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => open(conn.refreshTokenCiphertext, SECRET_KEY)).toThrow();
    // Run again with the old key as current: it cannot open them, and changes nothing.
    await expect(rotateKey(env(Buffer.alloc(32, 12).toString('base64')))).rejects.toThrow();
    expect(open((await fresh.db.crConnection.findFirstOrThrow()).refreshTokenCiphertext, NEXT)).toBe('the-refresh-token');
  });
});
