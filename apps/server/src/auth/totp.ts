import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

/**
 * TOTP, with the shared secret encrypted at rest under the KEK.
 *
 * Two properties matter beyond "the code is right": a used step is never accepted twice — a code
 * read over someone's shoulder is good for at most one login — and the secret is useless to anyone
 * reading the database without the key from the environment.
 */

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** One step either side, for clock skew. Wider than this is a meaningfully larger window. */
export const TOTP_WINDOW = 1;

const ALGORITHM = 'aes-256-gcm';

function keyFrom(kek: string): Buffer {
  const key = Buffer.from(kek, 'base64');
  if (key.length < 32) throw new Error('KEK must decode to at least 32 bytes');
  return key.subarray(0, 32);
}

export function encryptSecret(plaintext: string, kek: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFrom(kek), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // iv.ciphertext.tag, each base64url — self-describing, with no second column to keep in step.
  return [iv, enc, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(stored: string, kek: string): string {
  const [ivPart, dataPart, tagPart] = stored.split('.');
  if (ivPart === undefined || dataPart === undefined || tagPart === undefined) {
    throw new Error('stored TOTP secret is malformed');
  }
  const decipher = createDecipheriv(ALGORITHM, keyFrom(kek), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secret: string, label: string): TOTP {
  return new TOTP({
    issuer: 'Kurō',
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secret),
  });
}

export function provisioningUri(secret: string, label: string): string {
  return totpFor(secret, label).toString();
}

export interface TotpResult {
  readonly valid: boolean;
  /** The step the code matched, stored so the same code cannot be replayed. */
  readonly step?: number;
}

/**
 * Validate a code. `lastStep` is the most recent step already accepted for this account; a code at
 * or before it is refused even when it is otherwise still inside the window.
 */
export function verifyCode(
  secret: string,
  code: string,
  label: string,
  lastStep: number | null,
  now: Date = new Date(),
): TotpResult {
  const delta = totpFor(secret, label).validate({
    token: code.replace(/\s+/g, ''),
    window: TOTP_WINDOW,
    timestamp: now.getTime(),
  });
  if (delta === null) return { valid: false };

  const step = Math.floor(now.getTime() / 1000 / TOTP_PERIOD) + delta;
  if (lastStep !== null && step <= lastStep) return { valid: false };
  return { valid: true, step };
}
