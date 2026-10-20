import { useEffect, useState } from 'react';
import { Screen } from '../components/ui.js';
import { api } from '../lib/api.js';
import { statusLabel } from '../lib/format.js';
import { navigate } from '../lib/router.js';

interface Totals {
  plays: number;
  episodes: number;
  seconds: number;
  days: number;
  dubShare: number | null;
  firstPlay: string | null;
  lastPlay: string | null;
}
interface TopShow { showKey: string; title: string; seconds: number; plays: number }
interface StatsData {
  totals: Totals;
  streaks: { longest: number; current: number };
  shows: Record<string, number>;
  top: TopShow[];
  timezone: string;
  heatmap: { from: string; to: string; days: { day: string; plays: number; seconds: number }[] };
  years: { year: number; plays: number; seconds: number }[];
}
interface YearData {
  year: number;
  totals: Totals;
  top: TopShow[];
  months: { month: number; plays: number; seconds: number }[];
  busiestMonth: number;
  biggestDay: { day: string; plays: number; seconds: number } | null;
  started: { showKey: string; title: string; first: string }[];
}

const NUM = new Intl.NumberFormat();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hours = (s: number) => (s >= 36_000 ? NUM.format(Math.round(s / 3600)) : (s / 3600).toFixed(1));
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[16px] border border-line bg-surface p-3">
      <span className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">{label}</span>
      <span className="font-display text-[28px] leading-8">{value}</span>
      {sub !== undefined && <span className="text-[12px] text-muted">{sub}</span>}
    </div>
  );
}

function Totals({ t }: { t: Totals }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Tile label="Hours" value={hours(t.seconds)} sub={`${NUM.format(t.plays)} plays`} />
      <Tile label="Episodes" value={NUM.format(t.episodes)} sub="watched to the end" />
      <Tile label="Days" value={NUM.format(t.days)} sub="with something watched" />
      <Tile label="Dubbed" value={t.dubShare === null ? '—' : `${String(Math.round(t.dubShare * 100))}%`} sub="of plays" />
    </div>
  );
}

function TopShows({ shows }: { shows: readonly TopShow[] }) {
  const most = Math.max(1, ...shows.map((s) => s.seconds));
  return (
    <ol className="flex flex-col gap-1">
      {shows.map((s, i) => (
        <li key={s.showKey}>
          <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(s.showKey)}`); }} className="flex w-full items-center gap-3 rounded-[10px] px-2 py-1.5 text-left hover:bg-raised">
            <span className="w-5 font-mono text-[12px] text-faint">{i + 1}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[15px]">{s.title}</span>
              <span aria-hidden="true" className="h-1 rounded-full bg-raised"><span className="block h-1 rounded-full bg-kin" style={{ width: `${String(Math.round((s.seconds / most) * 100))}%` }} /></span>
            </span>
            <span className="font-mono text-[12px] text-muted">{hours(s.seconds)} h</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Minutes watched → a step on one hue, kin over the raised surface (0 is the surface itself). */
const STEPS = [0, 30 * 60, 60 * 60, 2 * 60 * 60];
const SHADE = ['var(--color-bg-raised)', 'color-mix(in oklab, var(--color-accent-kin) 35%, var(--color-bg-raised))', 'color-mix(in oklab, var(--color-accent-kin) 60%, var(--color-bg-raised))', 'color-mix(in oklab, var(--color-accent-kin) 80%, var(--color-bg-raised))', 'var(--color-accent-kin)'];
const shadeOf = (seconds: number) => SHADE[seconds <= 0 ? 0 : STEPS.filter((s) => seconds > s).length] ?? SHADE[4];
const LEGEND = ['None', 'Up to 30 min', '30 min – 1 h', '1 – 2 h', 'Over 2 h'];

/** The last year, a column per week from Sunday, in the owner's own days (KURO-T-5.1). */
function Heatmap({ from, to, days }: StatsData['heatmap']) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const weeks: { day: string; future: boolean }[][] = [];
  for (let t = start; t <= end + 6 * 86_400_000; t += 86_400_000) {
    const i = Math.floor((t - start) / (7 * 86_400_000));
    (weeks[i] ??= []).push({ day: new Date(t).toISOString().slice(0, 10), future: t > end });
  }
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      {/* Focusable, so the heatmap scrolls from the keyboard on a narrow screen. */}
      <div tabIndex={0} role="region" aria-label="Watch heatmap, scrollable" className="min-w-0 overflow-x-auto pb-1 focus-visible:outline-2 focus-visible:outline-kin">
        <div role="img" aria-label={`Watch heatmap, ${dayLabel(from)} to ${dayLabel(to)}: ${String(days.length)} days with plays`} className="grid w-max grid-flow-col grid-rows-7 gap-[2px]">
          {weeks.flat().map(({ day, future }) => {
            const d = byDay.get(day);
            const label = d === undefined ? `${dayLabel(day)}: nothing` : `${dayLabel(day)}: ${String(Math.round(d.seconds / 60))} min, ${String(d.plays)} ${d.plays === 1 ? 'play' : 'plays'}`;
            return future ? <span key={day} className="h-3 w-3" /> : <span key={day} title={label} className="h-3 w-3 rounded-[3px]" style={{ background: shadeOf(d?.seconds ?? 0) }} />;
          })}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        {LEGEND.map((l, i) => (
          <span key={l} className="flex items-center gap-1"><span aria-hidden="true" className="h-3 w-3 rounded-[3px]" style={{ background: SHADE[i] }} />{l}</span>
        ))}
      </figcaption>
    </figure>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h2 id={id} className="text-[11px] font-medium tracking-[0.6px] text-faint uppercase">{title}</h2>
      {children}
    </section>
  );
}

function NeedsHistory() {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <p className="font-display text-[40px] text-faint">録</p>
      <p className="text-[18px] font-bold">Needs history</p>
      <p className="text-[15px] text-muted">Stats fill in after your first sync from Crunchyroll.</p>
    </div>
  );
}

/** Lifetime stats and the watch heatmap (KURO-T-5.1), with a way into each year's review. */
export function Stats() {
  const [data, setData] = useState<StatsData | null>();
  useEffect(() => {
    void api<StatsData>('/api/stats').then(setData, () => { setData(null); });
  }, []);
  return (
    <Screen kicker="You" title="Stats" wide>
      {data === undefined && <div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" />}
      {data === null && <p className="text-[15px] text-muted">Stats could not load. Try again in a moment.</p>}
      {data !== undefined && data !== null && data.totals.plays === 0 && <NeedsHistory />}
      {data !== undefined && data !== null && data.totals.plays > 0 && (
        <>
          <Totals t={data.totals} />
          <p className="text-[13px] text-muted">
            Longest streak {data.streaks.longest} {data.streaks.longest === 1 ? 'day' : 'days'}
            {data.streaks.current > 0 ? `, current ${String(data.streaks.current)}` : ''}
            {data.totals.firstPlay !== null ? ` · watching since ${dayLabel(data.totals.firstPlay.slice(0, 10))}` : ''}.{' '}
            {Object.entries(data.shows).map(([s, n]) => `${String(n)} ${statusLabel(s).toLowerCase()}`).join(', ')}.
          </p>
          <Section id="heatmap" title="The last year">
            <Heatmap {...data.heatmap} />
          </Section>
          <Section id="years" title="Year in review">
            <ul className="flex flex-wrap gap-2">
              {data.years.map((y) => (
                <li key={y.year}>
                  <button type="button" onClick={() => { navigate(`/you/year/${String(y.year)}`); }} className="flex flex-col rounded-[10px] border border-line-strong px-3 py-2 text-left hover:bg-raised">
                    <span className="font-display text-[20px]">{y.year}</span>
                    <span className="font-mono text-[12px] text-faint">{hours(y.seconds)} h</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
          <Section id="top" title="Most watched">
            <TopShows shows={data.top} />
          </Section>
          <p className="text-[12px] text-faint">Days are {data.timezone.replace('_', ' ')} days. Watch time is each play’s playhead, capped at the episode’s length.</p>
        </>
      )}
    </Screen>
  );
}

/** Hours per month as bars on one baseline; the busiest month labelled (KURO-T-5.2). */
function MonthBars({ months, busiest }: { months: YearData['months']; busiest: number }) {
  const most = Math.max(1, ...months.map((m) => m.seconds));
  return (
    <figure className="flex flex-col gap-2">
      <div role="img" aria-label={`Hours by month; busiest ${MONTH_LONG[busiest - 1] ?? ''}`} className="flex h-32 items-end gap-[2px]">
        {months.map((m) => (
          <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${MONTH_LONG[m.month - 1] ?? ''}: ${hours(m.seconds)} h, ${String(m.plays)} plays`}>
            {m.month === busiest && <span className="font-mono text-[11px] text-muted">{hours(m.seconds)} h</span>}
            <span className="w-full max-w-6 rounded-t-[4px] bg-kin" style={{ height: `${String(Math.max(m.seconds > 0 ? 2 : 0, Math.round((m.seconds / most) * 100)))}%`, opacity: m.month === busiest ? 1 : 0.7 }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-[2px] border-t border-line pt-1">
        {months.map((m) => <span key={m.month} className="flex-1 text-center font-mono text-[10px] text-faint">{MONTHS[m.month - 1]?.[0]}</span>)}
      </div>
      <table className="sr-only">
        <caption>Hours by month</caption>
        <tbody>{months.map((m) => <tr key={m.month}><th scope="row">{MONTH_LONG[m.month - 1]}</th><td>{hours(m.seconds)} hours</td><td>{m.plays} plays</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/** A year in review (KURO-T-5.2): hours, top shows, the busiest month, the biggest day, and what you started. */
export function YearInReview({ year }: { year: number }) {
  const [data, setData] = useState<YearData | null>();
  useEffect(() => {
    void api<YearData>(`/api/stats/years/${String(year)}`).then(setData, () => { setData(null); });
  }, [year]);
  return (
    <Screen kicker="Year in review" title={String(year)} wide>
      {data === undefined && <div aria-busy="true" className="h-40 animate-pulse rounded-[16px] bg-raised" />}
      {data === null && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[15px] text-muted">Nothing watched in {year}.</p>
          <button type="button" className="text-[13px] underline" onClick={() => { navigate('/you/stats'); }}>Back to stats</button>
        </div>
      )}
      {data !== undefined && data !== null && (
        <>
          <Totals t={data.totals} />
          <p className="text-[15px]">
            Your busiest month was <strong>{MONTH_LONG[data.busiestMonth - 1]}</strong>
            {data.biggestDay !== null && (
              <>
                {' '}and your biggest day <strong>{dayLabel(data.biggestDay.day)}</strong>: {data.biggestDay.plays} episodes, {hours(data.biggestDay.seconds)} hours
              </>
            )}
            .
          </p>
          <Section id="months" title="Month by month">
            <MonthBars months={data.months} busiest={data.busiestMonth} />
          </Section>
          <Section id="year-top" title="Top shows">
            <TopShows shows={data.top} />
          </Section>
          {data.started.length > 0 && (
            <Section id="started" title={`Started in ${String(year)} · ${String(data.started.length)}`}>
              <ul className="flex flex-wrap gap-1.5">
                {data.started.map((s) => (
                  <li key={s.showKey}>
                    <button type="button" onClick={() => { navigate(`/show/${encodeURIComponent(s.showKey)}`); }} className="rounded-full border border-line-strong px-3 py-1 text-[13px] text-muted hover:bg-raised">{s.title}</button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <button type="button" className="self-start text-[13px] text-muted underline" onClick={() => { navigate('/you/stats'); }}>All stats</button>
        </>
      )}
    </Screen>
  );
}
