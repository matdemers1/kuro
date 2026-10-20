import type { Db } from '../db.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import * as sessions from './sessions.js';
import * as throttle from './throttle.js';
import { decryptSecret, encryptSecret, generateSecret, provisioningUri, verifyCode } from './totp.js';

/**
 * The app-native login path, ported from Foreman (KURO-ADR-007). It must keep working when
 * auth.d3cloud.io is unreachable, which is why nothing in this file imports anything OIDC.
 *
 * The order is deliberate: **throttle, then hash**. Deciding the delay after a failed comparison
 * would mean every rejected guess had already cost 64MB of Argon2id.
 */

export interface AuthDeps {
  readonly db: Db;
  readonly secretKey: string;
  readonly pepper: string;
}

export type LoginOutcome =
  | { readonly kind: 'session'; readonly token: string; readonly userId: string }
  | { readonly kind: 'totp_required'; readonly userId: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'throttled'; readonly retryAfterMs: number };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly totpCode?: string | undefined;
  readonly ip: string;
  readonly userAgent?: string | undefined;
}

/** Verified when no account matches, so a missing account and a wrong password take the same time. */
let decoyHash: Promise<string> | null = null;
function decoy(pepper: string): Promise<string> {
  decoyHash ??= hashPassword(`decoy:${String(Math.random())}`, pepper);
  return decoyHash;
}

export async function login({ db, secretKey, pepper }: AuthDeps, input: LoginInput): Promise<LoginOutcome> {
  const email = input.email.trim().toLowerCase();
  const keys = { account: email, ip: input.ip };

  const decision = await throttle.check(db, keys);
  if (!decision.allowed) return { kind: 'throttled', retryAfterMs: decision.retryAfterMs };

  const user = await db.user.findUnique({ where: { email }, include: { credential: true } });
  if (user === null || user.credential === null) {
    await verifyPassword(await decoy(pepper), input.password, pepper);
    await throttle.recordFailure(db, keys);
    return { kind: 'rejected' };
  }
  if (!(await verifyPassword(user.credential.passwordHash, input.password, pepper))) {
    await throttle.recordFailure(db, keys);
    return { kind: 'rejected' };
  }
  if (needsRehash(user.credential.passwordHash)) {
    await db.credential.update({ where: { userId: user.id }, data: { passwordHash: await hashPassword(input.password, pepper) } });
  }

  const { totpSecret, totpConfirmedAt, totpLastStep } = user.credential;
  if (totpSecret !== null && totpConfirmedAt !== null) {
    if (input.totpCode === undefined || input.totpCode.length === 0) return { kind: 'totp_required', userId: user.id };
    const result = verifyCode(
      decryptSecret(totpSecret, secretKey),
      input.totpCode,
      email,
      totpLastStep === null ? null : Number(totpLastStep),
    );
    if (!result.valid) {
      await throttle.recordFailure(db, keys);
      return { kind: 'rejected' };
    }
    // Burn the step so the same code cannot be replayed inside its window.
    await db.credential.update({ where: { userId: user.id }, data: { totpLastStep: BigInt(result.step ?? 0) } });
  }

  await throttle.clear(db, keys);
  const session = await sessions.issue(db, user.id, 'password', { ip: input.ip, userAgent: input.userAgent });
  return { kind: 'session', token: session.token, userId: user.id };
}

/** Begin TOTP enrolment: a secret, stored encrypted but not in force until a code proves it. */
export async function beginTotpEnrolment({ db, secretKey }: AuthDeps, userId: string): Promise<{ secret: string; uri: string }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const secret = generateSecret();
  await db.credential.update({ where: { userId }, data: { totpSecret: encryptSecret(secret, secretKey), totpConfirmedAt: null } });
  return { secret, uri: provisioningUri(secret, user.email) };
}

/** Confirm enrolment. Until this succeeds, TOTP is not in force and cannot lock the owner out. */
export async function confirmTotpEnrolment({ db, secretKey }: AuthDeps, userId: string, code: string): Promise<boolean> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { credential: true } });
  const stored = user.credential?.totpSecret;
  if (stored === undefined || stored === null) return false;
  const result = verifyCode(decryptSecret(stored, secretKey), code, user.email, null);
  if (!result.valid) return false;
  await db.credential.update({ where: { userId }, data: { totpConfirmedAt: new Date(), totpLastStep: BigInt(result.step ?? 0) } });
  return true;
}

/** Set or change a password. Every existing session ends: a change is also a revocation. */
export async function setPassword({ db, pepper }: AuthDeps, userId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password, pepper);
  await db.credential.upsert({
    where: { userId },
    create: { userId, passwordHash },
    update: { passwordHash, passwordUpdatedAt: new Date() },
  });
  await sessions.revokeAllForUser(db, userId);
}
