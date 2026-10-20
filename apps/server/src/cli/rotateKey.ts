import { decryptSecret, encryptSecret } from '../auth/totp.js';
import { loadConfig } from '../config.js';
import { open, seal } from '../crypto/secretbox.js';
import { createDb } from '../db.js';

/**
 * `kuro rotate-key` — re-encrypt everything sealed under KURO_SECRET_KEY with KURO_SECRET_KEY_NEW
 * (KURO-ADR-008): the Crunchyroll refresh token and the TOTP secret. All or nothing, in one
 * transaction, and each value is opened again under the new key before it commits. Afterwards put
 * the new key in server.env as KURO_SECRET_KEY and redeploy (docs/runbooks/key-rotation.md).
 */
export async function rotateKey(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const next = env['KURO_SECRET_KEY_NEW'];
  if (config.DATABASE_URL === undefined || config.KURO_SECRET_KEY === undefined || next === undefined) {
    console.error('usage: KURO_SECRET_KEY=<current> KURO_SECRET_KEY_NEW=<new> kuro rotate-key');
    return 2;
  }
  if (Buffer.from(next, 'base64').length < 32) {
    console.error('KURO_SECRET_KEY_NEW must be 32 random bytes, base64 (openssl rand -base64 32)');
    return 2;
  }
  const old = config.KURO_SECRET_KEY;
  if (old === next) {
    console.error('the new key is the current key');
    return 2;
  }
  const db = createDb(config.DATABASE_URL);
  try {
    const counts = await db.$transaction(async (tx) => {
      let connections = 0;
      let totp = 0;
      for (const c of await tx.crConnection.findMany()) {
        const plain = open(c.refreshTokenCiphertext, old);
        const sealed = seal(plain, next);
        if (open(sealed, next) !== plain) throw new Error('re-sealed refresh token did not open under the new key');
        await tx.crConnection.update({ where: { id: c.id }, data: { refreshTokenCiphertext: sealed, refreshTokenNonce: sealed.split('.')[0] ?? '' } });
        connections += 1;
      }
      for (const c of await tx.credential.findMany({ where: { totpSecret: { not: null } } })) {
        const plain = decryptSecret(c.totpSecret ?? '', old);
        const sealed = encryptSecret(plain, next);
        if (decryptSecret(sealed, next) !== plain) throw new Error('re-encrypted TOTP secret did not open under the new key');
        await tx.credential.update({ where: { userId: c.userId }, data: { totpSecret: sealed } });
        totp += 1;
      }
      return { connections, totp };
    });
    console.log(`re-encrypted ${String(counts.connections)} Crunchyroll link(s) and ${String(counts.totp)} TOTP secret(s). Now set KURO_SECRET_KEY to the new key and redeploy.`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}
