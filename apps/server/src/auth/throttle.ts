import type { Db } from '../db.js';

/**
 * Throttle **before** the hash, per account and per IP (ported from Foreman, KURO-ADR-007).
 *
 * Argon2id is deliberately expensive, which makes an unthrottled login endpoint a CPU amplifier:
 * one cheap request costs the server 64MB and tens of milliseconds. The delay therefore has to be
 * decided before any hashing happens, not after a failed comparison.
 *
 * It delays with doubling and **never locks out**. Kurō has one operator; a
 * lockout is a self-inflicted outage, and an attacker who can trigger one has a denial of service
 * for free.
 */

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 30_000;
/** Failures before any delay applies at all — a typo should not be punished. */
export const FREE_ATTEMPTS = 3;
/** A quiet period long enough that yesterday's fumbles do not slow today's login. */
export const DECAY_MS = 15 * 60 * 1000;

export type Scope = 'account' | 'ip';

export interface ThrottleDecision {
  readonly allowed: boolean;
  /** Milliseconds until the next attempt is permitted. Zero when allowed. */
  readonly retryAfterMs: number;
  readonly scope?: Scope;
}

export function delayFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
}

/** Check both scopes. The stricter one wins, and nothing is hashed until this says yes. */
export async function check(
  db: Db,
  keys: { account: string; ip: string },
  now: Date = new Date(),
): Promise<ThrottleDecision> {
  const rows = await db.authThrottle.findMany({
    where: {
      OR: [
        { scope: 'account', key: keys.account },
        { scope: 'ip', key: keys.ip },
      ],
    },
  });

  let worst: ThrottleDecision = { allowed: true, retryAfterMs: 0 };
  for (const row of rows) {
    const retryAfterMs = row.nextAllowedAt.getTime() - now.getTime();
    if (retryAfterMs > 0 && retryAfterMs > worst.retryAfterMs) {
      worst = { allowed: false, retryAfterMs, scope: row.scope };
    }
  }
  return worst;
}

/** Record a failure in both scopes and lengthen the next delay. */
export async function recordFailure(
  db: Db,
  keys: { account: string; ip: string },
  now: Date = new Date(),
): Promise<void> {
  for (const [scope, key] of [
    ['account', keys.account],
    ['ip', keys.ip],
  ] as const) {
    const existing = await db.authThrottle.findUnique({ where: { scope_key: { scope, key } } });
    // Failures decay: a long quiet gap starts the count again rather than compounding forever.
    const stale = existing !== null && now.getTime() - existing.lastFailureAt.getTime() > DECAY_MS;
    const failures = existing === null || stale ? 1 : existing.failures + 1;
    const nextAllowedAt = new Date(now.getTime() + delayFor(failures));

    await db.authThrottle.upsert({
      where: { scope_key: { scope, key } },
      create: { scope, key, failures, nextAllowedAt, lastFailureAt: now },
      update: { failures, nextAllowedAt, lastFailureAt: now },
    });
  }
}

/** Clear both scopes after a success. */
export async function clear(db: Db, keys: { account: string; ip: string }): Promise<void> {
  await db.authThrottle.deleteMany({
    where: {
      OR: [
        { scope: 'account', key: keys.account },
        { scope: 'ip', key: keys.ip },
      ],
    },
  });
}
