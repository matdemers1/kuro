import { randomUUID } from 'node:crypto';
import type { CrSidecar } from '../adapters/crunchyroll.js';
import { open, seal } from '../crypto/secretbox.js';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';

/**
 * The owner's Crunchyroll link (KURO-ADR-001). The password goes to the sidecar for one exchange
 * and is dropped; only the refresh token is kept, sealed under KURO_SECRET_KEY. Kurō's device ID is
 * minted once per connection and reused for every refresh — Crunchyroll binds the token to it.
 */

export interface CrStatus {
  readonly linked: boolean;
  readonly state?: 'linked' | 'paused' | 'blocked';
  readonly stateReason?: string | null;
  readonly lastSuccessAt?: string | null;
  readonly highWaterMark?: string | null;
}

export async function link(
  deps: { db: Db; sidecar: CrSidecar; secretKey: string },
  userId: string,
  credentials: { email: string; password: string },
): Promise<CrStatus> {
  const existing = await deps.db.crConnection.findUnique({ where: { userId } });
  // A re-link keeps the device: Crunchyroll then sees one device signing in again, not a new one.
  const deviceId = existing?.deviceId ?? randomUUID();
  const linked = await deps.sidecar.linkWithPassword(credentials.email, credentials.password, deviceId);
  const sealed = seal(linked.refreshToken, deps.secretKey);
  const [nonce = ''] = sealed.split('.');
  const data = {
    accountId: linked.accountId,
    profileId: linked.profileId,
    deviceId,
    refreshTokenCiphertext: sealed,
    refreshTokenNonce: nonce,
    state: 'linked' as const,
    stateReason: null,
  };
  const row = await deps.db.crConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  await record(deps.db, {
    userId,
    entity: 'cr_connection',
    entityId: row.id,
    action: existing === null ? 'linked' : 'relinked',
    ...(existing !== null ? { before: { state: existing.state } } : {}),
    after: { state: 'linked' },
  });
  return status(row);
}

export async function getStatus(db: Db, userId: string): Promise<CrStatus> {
  const row = await db.crConnection.findUnique({ where: { userId } });
  return row === null ? { linked: false } : status(row);
}

function status(row: { state: 'linked' | 'paused' | 'blocked'; stateReason: string | null; lastSuccessAt: Date | null; highWaterMark: Date | null }): CrStatus {
  return {
    linked: true,
    state: row.state,
    stateReason: row.stateReason,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    highWaterMark: row.highWaterMark?.toISOString() ?? null,
  };
}

/** The decrypted session, for one sidecar call. Callers persist the rotated token via `rotate`. */
export async function session(db: Db, secretKey: string, userId: string) {
  const row = await db.crConnection.findUniqueOrThrow({ where: { userId } });
  return { id: row.id, accountId: row.accountId, deviceId: row.deviceId, refreshToken: open(row.refreshTokenCiphertext, secretKey) };
}

export async function rotate(db: Db, secretKey: string, connectionId: string, refreshToken: string): Promise<void> {
  const sealed = seal(refreshToken, secretKey);
  await db.crConnection.update({ where: { id: connectionId }, data: { refreshTokenCiphertext: sealed, refreshTokenNonce: sealed.split('.')[0] ?? '' } });
}
