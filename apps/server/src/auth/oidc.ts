import { randomBytes } from 'node:crypto';
import { createAuthClient, type AuthClient } from '@d3cloudio/auth-client';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

/**
 * Sign in with D3 Auth — the second of the two login paths (GL-001, KURO-ADR-006), ported from
 * Foreman on `@d3cloudio/auth-client`.
 *
 * Two departures from Foreman, both because Kurō has exactly one owner:
 *  - **No just-in-time provisioning.** An identity nobody has linked is refused. Signup closes
 *    after setup (KURO-REQ-062), and D3 Auth must not be a back door around that.
 *  - Linking happens only from a signed-in session (setup, or Settings), never by email.
 *
 * Nothing here may be load-bearing for the password path: discovery failing at boot leaves the
 * client null and every other route untouched.
 */

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const TX_COOKIE = 'kuro_oidc_tx';

interface PendingSignIn {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly linkToUserId?: string;
}

export interface CompletedSignIn {
  readonly iss: string;
  readonly sub: string;
  readonly email?: string;
  readonly idToken: string;
  readonly linkToUserId?: string;
}

export interface OidcClient {
  readonly issuer: string;
  beginSignIn(linkToUserId?: string): Promise<{ url: string; tx: string }>;
  completeSignIn(callbackUrl: URL, tx: string, state: string): Promise<CompletedSignIn>;
  endSessionUrl(idToken: string, returnTo: string): Promise<string | null>;
}

export class OidcError extends Error {}

/** Discover the provider, or return null when unconfigured or unreachable. Never throws. */
export async function createOidcClient(config: Config, log: Logger): Promise<OidcClient | null> {
  if (!config.oidcConfigured) return null;
  const issuer = config.D3AUTH_ISSUER ?? '';
  let client: AuthClient;
  try {
    client = await createAuthClient({
      issuer,
      clientId: config.D3AUTH_CLIENT_ID ?? '',
      clientSecret: config.D3AUTH_CLIENT_SECRET ?? '',
      redirectUri: new URL('/auth/oidc/callback', config.BASE_URL).toString(),
      scope: 'openid profile email',
      ssoMode: 'optional',
      ...(issuer.startsWith('http://') ? { allowInsecureHttp: true } : {}),
    });
  } catch (error) {
    log.warn({ issuer, err: error instanceof Error ? error.message : String(error) }, 'D3 Auth discovery failed; the password path is unaffected');
    return null;
  }

  const pending = new Map<string, PendingSignIn>();
  const sweep = (): void => {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  };

  return {
    issuer,
    async beginSignIn(linkToUserId) {
      sweep();
      const start = await client.beginSignIn();
      const tx = randomBytes(32).toString('base64url');
      pending.set(tx, {
        verifier: start.verifier,
        state: start.state,
        nonce: start.nonce,
        expiresAt: Date.now() + TRANSACTION_TTL_MS,
        ...(linkToUserId !== undefined ? { linkToUserId } : {}),
      });
      return { url: start.url, tx };
    },
    async completeSignIn(callbackUrl, tx, state) {
      const started = pending.get(tx);
      pending.delete(tx);
      // This browser started it, and it is the sign-in it started — a pasted callback URL is useless.
      if (started === undefined) throw new OidcError('no sign-in is in progress for this browser');
      if (started.expiresAt <= Date.now()) throw new OidcError('the sign-in took too long');
      if (started.state !== state) throw new OidcError('state did not match');
      let session;
      try {
        session = await client.completeSignIn(callbackUrl, { verifier: started.verifier, state: started.state, nonce: started.nonce });
      } catch (error) {
        throw new OidcError(error instanceof Error ? error.message : String(error));
      }
      const email = session.identity.claims['email'];
      return {
        iss: session.identity.iss,
        sub: session.identity.sub,
        ...(typeof email === 'string' ? { email } : {}),
        idToken: session.idToken,
        ...(started.linkToUserId !== undefined ? { linkToUserId: started.linkToUserId } : {}),
      };
    },
    async endSessionUrl(idToken, returnTo) {
      try {
        return await client.endSessionUrl({ idToken, returnTo });
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve a completed sign-in to the owner. **By (iss, sub), never by email** (GL-001): an email
 * is a display attribute a provider may change or reuse.
 */
export async function resolveIdentity(db: Db, completed: CompletedSignIn): Promise<string> {
  const existing = await db.identity.findUnique({ where: { iss_sub: { iss: completed.iss, sub: completed.sub } } });
  if (existing !== null) {
    await db.identity.update({ where: { id: existing.id }, data: { lastLoginAt: new Date(), claims: { email: completed.email ?? null } } });
    return existing.userId;
  }
  if (completed.linkToUserId !== undefined) {
    await db.identity.create({
      data: { userId: completed.linkToUserId, iss: completed.iss, sub: completed.sub, lastLoginAt: new Date(), claims: { email: completed.email ?? null } },
    });
    return completed.linkToUserId;
  }
  throw new OidcError('This D3 Auth account is not linked to Kurō. Sign in with your password, then link it from Settings.');
}
