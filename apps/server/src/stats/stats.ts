import type { Db } from '../db.js';

/**
 * Insights (KURO-T-5.1, KURO-T-5.2): lifetime totals, the watch heatmap and a year in review, all
 * straight from the plays in SQL, so a hand count over the same tables gives the same numbers.
 *
 * - plays: rows in `play` — one per episode per time Crunchyroll saw it played.
 * - episodes: distinct episodes with a fully watched play.
 * - watch time: each play's playhead, capped at the episode's length when that is known.
 * - days: the owner's calendar days (SYNC_TIMEZONE, America/New_York by default).
 */

const ORIGINAL = ['ja-JP', 'zh-CN', 'ko-KR'];

/** Each play with its seconds, local day, audio and Show — the one place the definitions live. */
const PLAYS = (tz: string) => {
  // An IANA zone name from config; checked rather than escaped, since it lands in SQL text.
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) throw new Error(`not a time zone: ${tz}`);
  return `
WITH owner AS (
  SELECT DISTINCT ON (series_id) series_id, show_key FROM (SELECT show_key, unnest(series_ids) AS series_id FROM show) s ORDER BY series_id, show_key
), plays AS (
  SELECT p.id, p.cr_episode_id, p.fully_watched, p.date_played,
         (p.date_played AT TIME ZONE '${tz}')::date AS day,
         CASE WHEN e.duration_s > 0 THEN LEAST(p.playhead_s, e.duration_s) ELSE p.playhead_s END AS seconds,
         e.audio_locale,
         o.show_key
  FROM play p
  LEFT JOIN cr_episode e ON e.id = p.cr_episode_id
  LEFT JOIN cr_season se ON se.id = e.season_id
  LEFT JOIN owner o ON o.series_id = COALESCE(se.series_id, p.cr_parent_id)
)`;
};

export interface Totals {
  plays: number;
  episodes: number;
  seconds: number;
  days: number;
  /** Share of plays with a known audio track that were a dub, 0–1. */
  dubShare: number | null;
  firstPlay: string | null;
  lastPlay: string | null;
}

interface TotalsRow {
  plays: bigint;
  episodes: bigint;
  seconds: bigint | null;
  days: bigint;
  dubbed: bigint;
  known: bigint;
  first: Date | null;
  last: Date | null;
}

const totalsOf = (r: TotalsRow | undefined): Totals => ({
  plays: Number(r?.plays ?? 0),
  episodes: Number(r?.episodes ?? 0),
  seconds: Number(r?.seconds ?? 0),
  days: Number(r?.days ?? 0),
  dubShare: r === undefined || r.known === 0n ? null : Number(r.dubbed) / Number(r.known),
  firstPlay: r?.first?.toISOString() ?? null,
  lastPlay: r?.last?.toISOString() ?? null,
});

const TOTALS = `
SELECT count(*) AS plays,
       count(DISTINCT cr_episode_id) FILTER (WHERE fully_watched) AS episodes,
       sum(seconds) AS seconds,
       count(DISTINCT day) AS days,
       count(*) FILTER (WHERE audio_locale IS NOT NULL AND audio_locale <> ALL ($1::text[])) AS dubbed,
       count(*) FILTER (WHERE audio_locale IS NOT NULL) AS known,
       min(date_played) AS first, max(date_played) AS last
FROM plays`;

export interface TopShow {
  showKey: string;
  title: string;
  seconds: number;
  plays: number;
}

async function topShows(db: Db, tz: string, where: string, args: unknown[], limit: number): Promise<TopShow[]> {
  const rows = await db.$queryRawUnsafe<{ show_key: string; title: string | null; seconds: bigint; plays: bigint }[]>(
    `${PLAYS(tz)}
SELECT p.show_key, st.title, sum(p.seconds) AS seconds, count(*) AS plays
FROM plays p LEFT JOIN show_state st ON st.show_key = p.show_key
WHERE p.show_key IS NOT NULL ${where}
GROUP BY p.show_key, st.title ORDER BY seconds DESC, p.show_key LIMIT ${String(limit)}`,
    ...args,
  );
  return rows.map((r) => ({ showKey: r.show_key, title: r.title ?? r.show_key, seconds: Number(r.seconds), plays: Number(r.plays) }));
}

/** The longest run of consecutive active days, and the run ending today or yesterday. */
export function streaks(days: readonly string[], today: string): { longest: number; current: number } {
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of [...days].sort()) {
    const t = ms(d);
    run = prev !== null && t - prev === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  const last = prev;
  const current = last !== null && ms(today) - last <= 86_400_000 ? run : 0;
  return { longest, current };
}

/** The owner's calendar day for an instant. */
export function localDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function lifetime(db: Db, tz: string, now = new Date()) {
  const [totals] = await db.$queryRawUnsafe<TotalsRow[]>(`${PLAYS(tz)}${TOTALS}`, ORIGINAL);
  const days = await db.$queryRawUnsafe<{ day: Date }[]>(`${PLAYS(tz)} SELECT DISTINCT day FROM plays ORDER BY day`);
  const statuses = await db.showState.groupBy({ by: ['status'], _count: { _all: true } });
  return {
    totals: totalsOf(totals),
    streaks: streaks(days.map((d) => d.day.toISOString().slice(0, 10)), localDay(now, tz)),
    shows: Object.fromEntries(statuses.map((s) => [s.status, s._count._all])),
    top: await topShows(db, tz, '', [], 10),
  };
}

/** Plays and seconds per local day, `from` to `to` inclusive (YYYY-MM-DD); days without plays are left out. */
export async function heatmap(db: Db, tz: string, from: string, to: string) {
  const rows = await db.$queryRawUnsafe<{ day: Date; plays: bigint; seconds: bigint }[]>(
    `${PLAYS(tz)} SELECT day, count(*) AS plays, sum(seconds) AS seconds FROM plays WHERE day BETWEEN $1::date AND $2::date GROUP BY day ORDER BY day`,
    from,
    to,
  );
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), plays: Number(r.plays), seconds: Number(r.seconds) }));
}

/** Every year with plays, newest first, with its hours. */
export async function years(db: Db, tz: string) {
  const rows = await db.$queryRawUnsafe<{ year: number; plays: bigint; seconds: bigint }[]>(
    `${PLAYS(tz)} SELECT extract(year FROM day)::int AS year, count(*) AS plays, sum(seconds) AS seconds FROM plays GROUP BY 1 ORDER BY 1 DESC`,
  );
  return rows.map((r) => ({ year: r.year, plays: Number(r.plays), seconds: Number(r.seconds) }));
}

/** A year in review: totals, top Shows, each month's hours and the busiest, the biggest day, and Shows first played that year. */
export async function yearInReview(db: Db, tz: string, year: number) {
  const inYear = `extract(year FROM day) = ${String(year)}`;
  const [totals] = await db.$queryRawUnsafe<TotalsRow[]>(`${PLAYS(tz)}${TOTALS} WHERE ${inYear}`, ORIGINAL);
  if (totals === undefined || totals.plays === 0n) return null;
  const months = await db.$queryRawUnsafe<{ month: number; plays: bigint; seconds: bigint }[]>(
    `${PLAYS(tz)} SELECT extract(month FROM day)::int AS month, count(*) AS plays, sum(seconds) AS seconds FROM plays WHERE ${inYear} GROUP BY 1 ORDER BY 1`,
  );
  const [biggest] = await db.$queryRawUnsafe<{ day: Date; plays: bigint; seconds: bigint }[]>(
    `${PLAYS(tz)} SELECT day, count(*) AS plays, sum(seconds) AS seconds FROM plays WHERE ${inYear} GROUP BY day ORDER BY seconds DESC, day LIMIT 1`,
  );
  const started = await db.$queryRawUnsafe<{ show_key: string; title: string | null; first: Date }[]>(
    `${PLAYS(tz)} SELECT p.show_key, st.title, min(p.date_played) AS first FROM plays p LEFT JOIN show_state st ON st.show_key = p.show_key
     WHERE p.show_key IS NOT NULL GROUP BY p.show_key, st.title HAVING extract(year FROM min(p.day)) = ${String(year)} ORDER BY first`,
  );
  const byMonth = Array.from({ length: 12 }, (_, i) => {
    const m = months.find((x) => x.month === i + 1);
    return { month: i + 1, plays: Number(m?.plays ?? 0), seconds: Number(m?.seconds ?? 0) };
  });
  const busiest = byMonth.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  return {
    year,
    totals: totalsOf(totals),
    top: await topShows(db, tz, `AND ${inYear}`, [], 5),
    months: byMonth,
    busiestMonth: busiest.month,
    biggestDay: biggest === undefined ? null : { day: biggest.day.toISOString().slice(0, 10), plays: Number(biggest.plays), seconds: Number(biggest.seconds) },
    started: started.map((s) => ({ showKey: s.show_key, title: s.title ?? s.show_key, first: s.first.toISOString() })),
  };
}
