import { z } from 'zod';

/**
 * The server's side of the sidecar contract (KURO-ADR-009). Every call carries the session and
 * every success returns the rotated refresh token, which the caller must persist before anything
 * else — losing it means re-linking.
 */

export type CrFailure = 'expired' | 'blocked' | 'upstream' | 'bad_input';

export class CrSidecarError extends Error {
  constructor(
    readonly kind: CrFailure,
    message: string,
  ) {
    super(message);
  }
}

const Linked = z.object({ refreshToken: z.string().min(1), accountId: z.string().min(1), profileId: z.string().nullable() });
const Page = z.object({ refreshToken: z.string().min(1), total: z.number().nullable(), items: z.array(z.record(z.string(), z.unknown())) });
const Failure = z.object({ error: z.enum(['expired', 'blocked', 'upstream', 'bad_input']), message: z.string() });

const Cms = z.object({ refreshToken: z.string().min(1), body: z.record(z.string(), z.unknown()) });
const Skip = z.object({ events: z.record(z.string(), z.unknown()).nullable() });

export type LinkResult = z.infer<typeof Linked>;
export type HistoryPage = z.infer<typeof Page>;

export class CrSidecar {
  constructor(private readonly baseUrl: string) {}

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new CrSidecarError('upstream', `sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failure = Failure.safeParse(json);
      throw failure.success
        ? new CrSidecarError(failure.data.error, failure.data.message)
        : new CrSidecarError('upstream', `sidecar answered ${String(res.status)}`);
    }
    return schema.parse(json);
  }

  /** The password is passed straight through and never kept (KURO-ADR-001). */
  linkWithPassword(email: string, password: string, deviceId: string): Promise<LinkResult> {
    return this.post('/session/password', { email, password, deviceId }, Linked);
  }

  /** A read-only catalog path under /content/v2/cms (the sidecar enforces an allowlist). */
  cms(input: { refreshToken: string; deviceId: string; path: string }): Promise<z.infer<typeof Cms>> {
    return this.post('/cms', input, Cms);
  }

  /** Crunchyroll's public intro/credits markers, or null when none are published. */
  async skipEvents(episodeId: string): Promise<Record<string, unknown> | null> {
    return (await this.post('/skip-events', { episodeId }, Skip)).events;
  }

  historyPage(input: { refreshToken: string; deviceId: string; accountId: string; page: number; pageSize?: number }): Promise<HistoryPage> {
    return this.post('/history', { ...input, pageSize: input.pageSize ?? 100 }, Page);
  }
}
