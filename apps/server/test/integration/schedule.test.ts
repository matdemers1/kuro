import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScheduleClient, TimetableEntry } from '../../src/adapters/animeschedule.js';
import { setPassword } from '../../src/auth/login.js';
import { checkShowAlerts } from '../../src/jobs/alertsCheck.js';
import { Alerts } from '../../src/push/sender.js';
import { refreshSchedule, weekKey } from '../../src/schedule/refresh.js';
import { cookieFrom, json, PEPPER, SECRET_KEY, startApp, type Harness } from './helpers.js';

/**
 * KURO-T-3.1, 3.2 and 3.4: the schedule refresh against a fake AnimeSchedule, This Season from it
 * (dubs first, the owner's watching shows on top, the coverage report), the Crunchyroll fallback
 * when there is no timetable, and the dub and sequel alerts sent once each.
 */

let h: Harness;
let cookie = '';
const RELEASE = randomUUID();
const log = pino({ level: 'silent' });
const NOW = new Date();
const entry = (route: string, airType: string, episodeNumber: number, title: string): TimetableEntry => ({ title, route, english: null, episodeDate: new Date(NOW.getTime() + 3_600_000), episodeNumber, episodes: 12, airType, status: 'Ongoing', delayedUntil: null, imageVersionRoute: null, donghua: false });
const TIMETABLE: Record<string, TimetableEntry[]> = {
  dub: [entry('other-show', 'dub', 4, 'Somebody Else’s Show'), entry('my-show', 'dub', 7, 'My Show')],
  sub: [entry('my-show', 'sub', 9, 'My Show'), entry('sub-only', 'sub', 2, 'Sub Only Show')],
};
const LINKS: Record<string, number | null> = { 'my-show': 9301, 'other-show': 9399, 'sub-only': null };
const lookups: string[] = [];
const ENDPOINT = `https://push.example/schedule-${randomUUID()}`;
const client: ScheduleClient = {
  timetable: (airType) => Promise.resolve(TIMETABLE[airType] ?? []),
  links: (route) => {
    lookups.push(route);
    return Promise.resolve({ anilistId: LINKS[route] ?? null, malId: null });
  },
};

beforeAll(async () => {
  h = await startApp();
  const user = await h.db.user.create({ data: { email: 'season@example.com', displayName: 'S' } });
  await setPassword({ db: h.db, secretKey: SECRET_KEY, pepper: PEPPER }, user.id, 'season owner password');
  cookie = cookieFrom(await fetch(`${h.base}/auth/login`, json({ email: 'season@example.com', password: 'season owner password' })), 'kuro_session') ?? '';
  const ce = (id: number, title: string, status: string) => ({ id: `anilist:${String(id)}`, title, type: 'TV', episodes: 12, status, season: 'FALL', seasonYear: 2026, synonyms: [], sources: [], related: [], tags: [], studios: [], anilistId: id, releaseId: RELEASE, updatedAt: NOW });
  await h.db.catalogEntry.createMany({ data: [ce(9301, 'My Show', 'ONGOING'), ce(9302, 'Unlisted Airing Show', 'ONGOING')] });
  for (const [key, entryId, title, status] of [['show:anilist:9301', 'anilist:9301', 'My Show', 'watching'], ['show:anilist:9302', 'anilist:9302', 'Unlisted Airing Show', 'watching']] as const) {
    await h.db.show.create({ data: { showKey: key, title, franchiseKey: `fr:${key}`, seriesIds: [], derivedAt: NOW, items: { create: [{ position: 0, catalogEntryId: entryId, kind: 'season', required: true }] } } });
    await h.db.showState.create({ data: { showKey: key, title, status, watchedEpisodes: 6, totalEpisodes: 7, remainingS: 1420, derivedAt: NOW } });
  }
});

afterAll(async () => {
  await h.db.scheduleEntry.deleteMany();
  await h.db.scheduleAnime.deleteMany();
  await h.db.showItem.deleteMany({ where: { showKey: { in: ['show:anilist:9301', 'show:anilist:9302'] } } });
  await h.db.show.deleteMany({ where: { showKey: { in: ['show:anilist:9301', 'show:anilist:9302'] } } });
  await h.db.showState.deleteMany({ where: { showKey: { in: ['show:anilist:9301', 'show:anilist:9302', 'show:alert'] } } });
  await h.db.catalogEntry.deleteMany({ where: { releaseId: RELEASE } });
  await h.db.alert.deleteMany({ where: { OR: [{ key: { startsWith: 'dub:' } }, { key: { startsWith: 'sequel:' } }] } });
  await h.db.pushSubscription.deleteMany({ where: { endpoint: ENDPOINT } });
  await h.close();
});

type Season = { source: string; dubs: { title: string; showKey: string | null }[]; subs: { title: string }[]; missing: { title: string }[]; credit: unknown };
const season = async () => (await (await fetch(`${h.base}/api/this-season`, { headers: { cookie } })).json()) as Season;

describe('This Season (KURO-T-3.1, KURO-T-3.2)', () => {
  it('without a timetable, it is the owner’s own Crunchyroll releases, and says so', async () => {
    const s = await season();
    expect(s).toMatchObject({ source: 'crunchyroll', credit: null });
  });

  it('refreshes the week and asks each route once what it is', async () => {
    expect(await refreshSchedule(h.db, client, 'America/New_York', log, NOW, 0)).toEqual({ dub: 2, sub: 2, linked: 3 });
    expect(await h.db.scheduleEntry.count({ where: { week: weekKey(NOW) } })).toBe(4);
    await refreshSchedule(h.db, client, 'America/New_York', log, NOW, 0);
    expect(lookups.sort()).toEqual(['my-show', 'other-show', 'sub-only']);
  });

  it('lists dubs first with the owner’s watching show on top, sub-only second, credited', async () => {
    const s = await season();
    expect(s.source).toBe('animeschedule');
    expect(s.dubs.map((d) => [d.title, d.showKey])).toEqual([['My Show', 'show:anilist:9301'], ['Somebody Else’s Show', null]]);
    expect(s.subs.map((x) => x.title)).toEqual(['Sub Only Show']);
    expect(s.credit).toEqual({ name: 'AnimeSchedule.net', url: 'https://animeschedule.net' });
  });

  it('reports the owner’s airing Watching shows the timetable does not list (KURO-R-012)', async () => {
    expect((await season()).missing.map((m) => m.title)).toEqual(['Unlisted Airing Show']);
  });
});

describe('show alerts (KURO-T-3.4)', () => {
  it('remembers what is already true the first time, then sends each new dub episode and sequel once', async () => {
    const pushed: string[] = [];
    const alerts = new Alerts(h.db, { send: (t, payload) => { if (t.endpoint === ENDPOINT && payload.includes('Alerting Show')) pushed.push(payload); return Promise.resolve('ok'); } }, log);
    // A clean slate: other files' checks may already have run the first-time seeding.
    await h.db.alert.deleteMany({ where: { OR: [{ key: { startsWith: 'dub:' } }, { key: { startsWith: 'sequel:' } }] } });
    await h.db.pushSubscription.create({ data: { endpoint: ENDPOINT, p256dh: 'p', auth: 'a' } });
    const base = { title: 'Alerting Show', watchedEpisodes: 7, totalEpisodes: 7, remainingS: 0, derivedAt: NOW };
    await h.db.showState.create({ data: { showKey: 'show:alert', ...base, status: 'watching', nextIsNew: true, nextCrEpisodeId: 'GEPOLD', nextAudioLocale: 'en-US', nextEpisode: 7 } });
    expect((await checkShowAlerts(h.db, alerts)).filter((k) => k.includes('show:alert'))).toEqual([]);
    expect(pushed).toHaveLength(0);

    await h.db.showState.update({ where: { showKey: 'show:alert' }, data: { nextCrEpisodeId: 'GEPNEW', nextEpisode: 8 } });
    const mine = async () => (await checkShowAlerts(h.db, alerts)).filter((k) => k.includes('show:alert'));
    expect(await mine()).toEqual(['dub:show:alert:GEPNEW']);
    expect(await mine()).toEqual([]);

    // A Japanese-only next episode is not a dub alert.
    await h.db.showState.update({ where: { showKey: 'show:alert' }, data: { nextCrEpisodeId: 'GEPJA', nextAudioLocale: 'ja-JP' } });
    expect(await mine()).toEqual([]);

    await h.db.showState.update({ where: { showKey: 'show:alert' }, data: { status: 'caught_up', nextIsNew: false, comingEntryId: 'anilist:9301' } });
    expect(await mine()).toEqual(['sequel:show:alert:anilist:9301']);
    expect(pushed).toHaveLength(2);
  });
});
