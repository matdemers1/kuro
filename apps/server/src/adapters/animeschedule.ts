import { z } from 'zod';

/**
 * AnimeSchedule.net, API v3 (KURO-T-3.1): the week's dub and sub timetables, for This Season and
 * dub alerts. A bearer token per application, created by the owner in their AnimeSchedule account;
 * without one, Kurō falls back to what Crunchyroll itself has released. The terms ask for a visible
 * credit link, respected limits, and no AI training on the data.
 */

export const ANIMESCHEDULE_API = 'https://animeschedule.net/api/v3';
export type AirType = 'dub' | 'sub' | 'raw';

/** The API's "no datetime": treated as absent. */
const NULL_DATE = '0001-01-01T00:00:00Z';
const when = z
  .string()
  .nullish()
  .transform((v) => (v === null || v === undefined || v.startsWith('0001-01-01') || v === NULL_DATE ? null : new Date(v)));

export const TimetableEntry = z.object({
  title: z.string(),
  route: z.string().min(1),
  english: z.string().nullish().transform((v) => v ?? null),
  episodeDate: when,
  episodeNumber: z.number().int().nullish().transform((v) => v ?? null),
  episodes: z.number().int().nullish().transform((v) => v ?? null),
  airType: z.string(),
  status: z.string().nullish().transform((v) => v ?? null),
  delayedUntil: when,
  imageVersionRoute: z.string().nullish().transform((v) => v ?? null),
  donghua: z.boolean().catch(false),
});
export type TimetableEntry = z.infer<typeof TimetableEntry>;

const AnimeLinks = z.object({
  route: z.string(),
  websites: z
    .object({ aniList: z.string().nullish(), mal: z.string().nullish() })
    .partial()
    .nullish()
    .transform((w) => w ?? {}),
});

/** An id from either a bare number or a provider URL ("https://anilist.co/anime/101922"). */
export function idFrom(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const m = /(\d+)\/?$/.exec(value.trim());
  return m?.[1] === undefined ? null : Number(m[1]);
}

export interface ScheduleClient {
  timetable(airType: AirType, week: { year: number; week: number }, tz: string): Promise<TimetableEntry[]>;
  links(route: string): Promise<{ anilistId: number | null; malId: number | null }>;
}

export class AnimeSchedule implements ScheduleClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly api = ANIMESCHEDULE_API,
  ) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.api}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', 'user-agent': 'kuro (personal anime tracker)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`AnimeSchedule answered ${String(res.status)} for ${path.split('?')[0] ?? path}`);
    return res.json();
  }

  async timetable(airType: AirType, week: { year: number; week: number }, tz: string): Promise<TimetableEntry[]> {
    const raw = await this.get(`/timetables/${airType}?year=${String(week.year)}&week=${String(week.week)}&tz=${encodeURIComponent(tz)}`);
    return (Array.isArray(raw) ? raw : []).flatMap((r) => {
      const e = TimetableEntry.safeParse(r);
      return e.success ? [e.data] : [];
    });
  }

  async links(route: string): Promise<{ anilistId: number | null; malId: number | null }> {
    const a = AnimeLinks.parse(await this.get(`/anime/${encodeURIComponent(route)}`));
    return { anilistId: idFrom(a.websites.aniList), malId: idFrom(a.websites.mal) };
  }
}

/** The ISO week a date falls in, as AnimeSchedule numbers its timetables. */
export function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7) };
}
