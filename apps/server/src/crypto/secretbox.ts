import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM under KURO_SECRET_KEY (KURO-ADR-008), for anything that must be stored but never
 * readable from the database alone: the Crunchyroll refresh token and the TOTP secret.
 * Stored as `iv.ciphertext.tag`, each base64url — self-describing, nothing to keep in step.
 */

const ALGORITHM = 'aes-256-gcm';

function keyFrom(secretKey: string): Buffer {
  const key = Buffer.from(secretKey, 'base64');
  if (key.length < 32) throw new Error('KURO_SECRET_KEY must decode to at least 32 bytes');
  return key.subarray(0, 32);
}

export function seal(plaintext: string, secretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secretKey), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, enc, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed: string, secretKey: string): string {
  const [iv, data, tag] = sealed.split('.');
  if (iv === undefined || data === undefined || tag === undefined) throw new Error('sealed value is malformed');
  const decipher = createDecipheriv(ALGORITHM, keyFrom(secretKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
