import { z } from 'zod';

/** A base64 secret that must decode to at least 32 bytes (AES-256 key, HMAC pepper). */
const Secret32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length >= 32, 'must be base64 decoding to at least 32 bytes');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_DIST: z.string().optional(),
  /** The public origin. Cookies are Secure, and named `__Host-`, only when this is https. */
  BASE_URL: z.url().default('http://localhost:3300'),
  DATABASE_URL: z.string().min(1).optional(),
  /** Encrypts the TOTP secret and the Crunchyroll refresh token at rest (KURO-ADR-008). */
  KURO_SECRET_KEY: Secret32.optional(),
  /** HMAC'd into every password before Argon2id, so a stolen database alone cannot be cracked. */
  AUTH_PEPPER: Secret32.optional(),
  /** First-run gate (KURO-REQ-055). Unused once the owner exists. */
  SETUP_TOKEN: z.string().min(16).optional(),
  /** Cached images (KURO-REQ-021): the `images` volume. */
  IMAGE_DIR: z.string().default('/data/images'),
  /** pg_dump output: pre-migration, manual and Shipyard's backup step. */
  BACKUP_DIR: z.string().default('/data/backups'),
  /** Take a dump before applying migrations to a database that already holds data. */
  BACKUP_BEFORE_MIGRATE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** The owner's time zone: nightly sync and day boundaries (KURO-REQ-005). */
  SYNC_TIMEZONE: z.string().default('America/New_York'),
  /** The sidecar, on the compose network only (KURO-REQ-056). */
  KURO_CR_URL: z.url().default('http://kuro-cr:8080'),
  /** Web Push (KURO-ADR-010). Without them, alerts are recorded but not delivered. */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().default('mailto:owner@kuro.invalid'),
  D3AUTH_ISSUER: z.url().optional(),
  D3AUTH_CLIENT_ID: z.string().min(1).optional(),
  D3AUTH_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Config = z.infer<typeof Env> & { readonly oidcConfigured: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  const oidcConfigured =
    parsed.D3AUTH_ISSUER !== undefined && parsed.D3AUTH_CLIENT_ID !== undefined && parsed.D3AUTH_CLIENT_SECRET !== undefined;
  return { ...parsed, oidcConfigured };
}

/** The secrets a running server cannot do without; checked at boot, not at first use. */
export function requireSecrets(config: Config): { secretKey: string; pepper: string; databaseUrl: string } {
  const missing = (['KURO_SECRET_KEY', 'AUTH_PEPPER', 'DATABASE_URL'] as const).filter((k) => config[k] === undefined);
  if (missing.length > 0) throw new Error(`missing required environment: ${missing.join(', ')}`);
  return { secretKey: config.KURO_SECRET_KEY ?? '', pepper: config.AUTH_PEPPER ?? '', databaseUrl: config.DATABASE_URL ?? '' };
}
