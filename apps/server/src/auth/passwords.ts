import { createHmac, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Argon2id with a server-side pepper.
 *
 * The pepper is HMAC'd into the password before hashing, so it is never stored beside the hash. A
 * stolen database is therefore not enough to mount an offline attack: the attacker also needs a
 * value that only ever lives in the process environment.
 */

/** OWASP's second recommended Argon2id profile: 64 MiB, three passes, one lane. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

function pepper(password: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(password, 'utf8').digest();
}

export async function hashPassword(password: string, secret: string): Promise<string> {
  return argon2.hash(pepper(password, secret), ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored hash: a corrupt row
 * is a failed login, not a 500 that tells an attacker something.
 */
export async function verifyPassword(
  hash: string,
  password: string,
  secret: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, pepper(password, secret));
  } catch {
    return false;
  }
}

/** True when the stored hash was made with weaker parameters than the ones in force now. */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/** Constant-time comparison for opaque tokens, where an early return leaks a prefix. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
