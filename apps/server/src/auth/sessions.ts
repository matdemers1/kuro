import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { Db } from '../db.js';
import type { AuthMethod } from '../generated/prisma/enums.js';

/**
 * Session cookies, ported from Foreman (KURO-ADR-007). The cookie carries a random value; the
 * database stores only its SHA-256, so a leaked row is not a usable cookie. Sessions live in a
 * table rather than a sealed cookie because signing out has to end a session now.
 */

/** `__Host-` forbids a Domain attribute and requires Secure and Path=/: no sibling subdomain of
 * dormice.ai can set it. */
export const COOKIE_NAME = '__Host-kuro_session';
/** Plain-HTTP local development, where `__Host-` is not permitted. */
export const INSECURE_COOKIE_NAME = 'kuro_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh the expiry at most this often, so an active session does not write on every request. */
const SLIDING_REFRESH_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function cookieName(secure: boolean): string {
  return secure ? COOKIE_NAME : INSECURE_COOKIE_NAME;
}

export function cookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    // Lax, not Strict: the D3 Auth redirect arrives as a cross-site GET. Lax still blocks
    // cross-site POST.
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export interface IssuedSession {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issue(
  db: Db,
  userId: string,
  method: AuthMethod,
  meta: { ip?: string | undefined; userAgent?: string | undefined; idTokenSub?: string | undefined } = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      method,
      ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
      ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
      ...(meta.idTokenSub !== undefined ? { idTokenSub: meta.idTokenSub } : {}),
      expiresAt,
    },
  });
  return { id: session.id, token, expiresAt };
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly method: AuthMethod;
}

/** Resolve a token to a live session, or null. Expired and revoked both mean null. */
export async function resolve(db: Db, token: string): Promise<ResolvedSession | null> {
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) } });
  if (session === null) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  if (Date.now() - session.lastSeenAt.getTime() > SLIDING_REFRESH_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
  }
  return { sessionId: session.id, userId: session.userId, method: session.method };
}

export async function revoke(db: Db, sessionId: string): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Every session for a user — what a password change ends. */
export async function revokeAllForUser(db: Db, userId: string): Promise<number> {
  const { count } = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return count;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(cookieName(secure), token, cookieOptions(secure));
}

export function clearCookie(res: Response, secure: boolean): void {
  res.clearCookie(cookieName(secure), { ...cookieOptions(secure), maxAge: undefined });
}
