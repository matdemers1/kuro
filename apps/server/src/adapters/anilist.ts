import { z } from 'zod';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

/**
 * AniList, used only for catalog entries the owner has and kept forever (KURO-ADR-002, KURO-T-2.2).
 * AniList's terms rule out building a tracker on its catalog, and its API is degraded to 30 requests
 * a minute, so Kurō asks for at most 20 a minute, 50 entries a request, one request at a time, and
 * never asks twice for the same entry. A 429 waits out Retry-After and tries again.
 */

export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
export const PER_MINUTE = 20;
const PER_REQUEST = 50;
const MAX_429 = 3;

const QUERY = `query ($ids: [Int]) {
  Page(perPage: ${String(PER_REQUEST)}) {
    media(id_in: $ids, type: ANIME) {
      id idMal format episodes season seasonYear
      title { romaji english native }
      synonyms
      externalLinks { site url }
      relations { edges { relationType node { id type format } } }
    }
  }
}`;

export const Media = z.object({
  id: z.number().int(),
  idMal: z.number().int().nullable().catch(null),
  format: z.string().nullable().catch(null),
  episodes: z.number().int().nullable().catch(null),
  season: z.string().nullable().catch(null),
  seasonYear: z.number().int().nullable().catch(null),
  title: z.object({ romaji: z.string().nullable().catch(null), english: z.string().nullable().catch(null), native: z.string().nullable().catch(null) }).catch({ romaji: null, english: null, native: null }),
  synonyms: z.array(z.string()).catch([]),
  externalLinks: z.array(z.object({ site: z.string(), url: z.string() })).nullable().catch([]).transform((v) => v ?? []),
  relations: z
    .object({ edges: z.array(z.object({ relationType: z.string(), node: z.object({ id: z.number().int(), type: z.string().nullable().catch(null), format: z.string().nullable().catch(null) }) })) })
    .nullable()
    .catch(null)
    .transform((r) => r?.edges ?? []),
});
export type AniListMedia = z.infer<typeof Media>;
const Response = z.object({ data: z.object({ Page: z.object({ media: z.array(z.unknown()) }) }) });

export interface AniListOptions {
  readonly endpoint?: string;
  /** Requests a minute; tests raise it. */
  readonly perMinute?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class AniList {
  private readonly endpoint: string;
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    opts: AniListOptions = {},
  ) {
    this.endpoint = opts.endpoint ?? ANILIST_ENDPOINT;
    this.intervalMs = Math.ceil(60_000 / (opts.perMinute ?? PER_MINUTE));
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /**
   * The AniList record for each id, from the cache where it is already held. Ids AniList does not
   * return (deleted, or not anime) are simply absent.
   */
  async media(ids: readonly number[]): Promise<Map<number, AniListMedia>> {
    const wanted = [...new Set(ids)];
    const out = new Map<number, AniListMedia>();
    for (const row of await this.db.anilistMedia.findMany({ where: { anilistId: { in: wanted } } })) {
      const m = Media.safeParse(row.payload);
      if (m.success) out.set(row.anilistId, m.data);
    }
    const missing = wanted.filter((id) => !out.has(id));
    for (let i = 0; i < missing.length; i += PER_REQUEST) {
      const chunk = missing.slice(i, i + PER_REQUEST);
      for (const raw of await this.request(chunk)) {
        const m = Media.safeParse(raw);
        if (!m.success) continue;
        await this.db.anilistMedia.upsert({ where: { anilistId: m.data.id }, create: { anilistId: m.data.id, payload: raw as object }, update: {} });
        out.set(m.data.id, m.data);
      }
    }
    return out;
  }

  /** One paced request; serialised, so concurrent callers share the budget. */
  private request(ids: readonly number[]): Promise<unknown[]> {
    const run = this.queue.then(() => this.send(ids));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(ids: readonly number[]): Promise<unknown[]> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + this.intervalMs;
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'kuro (personal anime tracker)' },
        body: JSON.stringify({ query: QUERY, variables: { ids } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < MAX_429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '60');
        const backoff = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60) * 1000;
        this.log.warn({ backoffMs: backoff, attempt }, 'AniList rate limit; backing off');
        this.nextAt = this.now() + backoff;
        continue;
      }
      if (!res.ok) throw new Error(`AniList answered ${String(res.status)}`);
      return Response.parse(await res.json()).data.Page.media;
    }
  }
}

/** The Crunchyroll series an AniList record links to: slugs and G-ids, lower-cased. */
export function crunchyrollKeys(media: Pick<AniListMedia, 'externalLinks'>): Set<string> {
  const keys = new Set<string>();
  for (const link of media.externalLinks) {
    if (link.site.toLowerCase() !== 'crunchyroll') continue;
    let path: string;
    try {
      path = new URL(link.url).pathname;
    } catch {
      continue;
    }
    // /series/GY5P48XEY/demon-slayer…, /demon-slayer-kimetsu-no-yaiba, /en-gb/series/G4PH0WXVJ
    const parts = path.split('/').filter((p) => p !== '' && !/^[a-z]{2}(-[a-z]{2})?$/i.test(p));
    const series = parts.indexOf('series');
    if (series >= 0) {
      const id = parts[series + 1];
      if (id !== undefined) keys.add(id.toLowerCase());
      const slug = parts[series + 2];
      if (slug !== undefined) keys.add(slug.toLowerCase());
    } else if (parts[0] !== undefined) {
      keys.add(parts[0].toLowerCase());
    }
  }
  return keys;
}
