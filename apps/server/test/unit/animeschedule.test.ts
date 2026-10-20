import { describe, expect, it } from 'vitest';
import { AnimeSchedule, idFrom, isoWeek, TimetableEntry } from '../../src/adapters/animeschedule.js';

describe('AnimeSchedule adapter (KURO-T-3.1)', () => {
  it('numbers weeks the ISO way, as the timetables do', () => {
    expect(isoWeek(new Date('2026-10-20T12:00:00Z'))).toEqual({ year: 2026, week: 43 });
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toEqual({ year: 2026, week: 53 });
  });

  it('reads ids from bare numbers and provider URLs alike', () => {
    expect(idFrom('https://anilist.co/anime/101922')).toBe(101922);
    expect(idFrom('38000')).toBe(38000);
    expect(idFrom('')).toBeNull();
    expect(idFrom(null)).toBeNull();
  });

  it('treats the API’s 0001-01-01 as no date', () => {
    const e = TimetableEntry.parse({ title: 'T', route: 'r', airType: 'dub', episodeDate: '2026-10-21T15:00:00Z', delayedUntil: '0001-01-01T00:00:00Z' });
    expect(e.episodeDate?.toISOString()).toBe('2026-10-21T15:00:00.000Z');
    expect(e.delayedUntil).toBeNull();
  });

  it('sends the bearer token and asks for the week in the owner’s zone', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fake: typeof fetch = (url, init) => {
      seen.push({ url: url as string, auth: new Headers(init?.headers).get('authorization') });
      return Promise.resolve(new Response(JSON.stringify([{ title: 'Show', route: 'show', airType: 'dub', episodeNumber: 3 }, { broken: true }]), { status: 200 }));
    };
    const out = await new AnimeSchedule('tok', fake).timetable('dub', { year: 2026, week: 43 }, 'America/New_York');
    expect(out.map((e) => [e.route, e.episodeNumber])).toEqual([['show', 3]]);
    expect(seen[0]).toEqual({ url: 'https://animeschedule.net/api/v3/timetables/dub?year=2026&week=43&tz=America%2FNew_York', auth: 'Bearer tok' });
  });
});
