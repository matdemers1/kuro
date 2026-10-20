import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AniList } from '../../src/adapters/anilist.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * KURO-T-2.2: AniList is paced (20 a minute), batched (50 a request), cached forever, and backs off
 * on a 429. A fake fetch and a fake clock stand in for the network and for time.
 */

let db: Db;
let clock = 0;
const sleeps: number[] = [];
const calls: { at: number; ids: number[] }[] = [];
let tooMany = 0;

const fakeFetch: typeof fetch = (_url, init) => {
  const ids = (JSON.parse(init?.body as string) as { variables: { ids: number[] } }).variables.ids;
  calls.push({ at: clock, ids });
  if (tooMany > 0) {
    tooMany--;
    return Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '7' } }));
  }
  // id 999 is not anime: AniList leaves it out.
  const media = ids.filter((id) => id !== 999).map((id) => ({ id, idMal: null, format: 'TV', episodes: 12, title: { romaji: `Show ${String(id)}`, english: null, native: null }, synonyms: [], externalLinks: [{ site: 'Crunchyroll', url: `https://www.crunchyroll.com/show-${String(id)}` }], relations: { edges: [{ relationType: 'SEQUEL', node: { id: id + 1, type: 'ANIME', format: 'TV' } }] } }));
  return Promise.resolve(new Response(JSON.stringify({ data: { Page: { media } } }), { status: 200, headers: { 'content-type': 'application/json' } }));
};

const client = () =>
  new AniList(db, pino({ level: 'silent' }), {
    fetch: fakeFetch,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });

beforeAll(() => {
  db = createDb(process.env['DATABASE_URL'] ?? '');
});
afterAll(async () => {
  await db.anilistMedia.deleteMany();
  await db.$disconnect();
});

describe('AniList relations for owned entries (KURO-T-2.2)', () => {
  it('asks 50 at a time, at most 20 requests a minute', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => 1000 + i);
    const out = await client().media(ids);
    expect(out.size).toBe(120);
    expect(calls.map((c) => c.ids.length)).toEqual([50, 50, 20]);
    const gaps = calls.slice(1).map((c, i) => c.at - (calls[i]?.at ?? 0));
    expect(gaps.every((g) => g >= 3000)).toBe(true);
    expect(out.get(1000)?.relations[0]).toMatchObject({ relationType: 'SEQUEL', node: { id: 1001 } });
  });

  it('never asks twice for an entry it holds — the cache is forever', async () => {
    calls.length = 0;
    const out = await client().media([1000, 1050, 1119]);
    expect(out.size).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it('waits out Retry-After on a 429, then succeeds', async () => {
    calls.length = 0;
    sleeps.length = 0;
    tooMany = 1;
    const out = await client().media([2000, 999]);
    expect(out.has(2000)).toBe(true);
    expect(out.has(999)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(7000);
  });
});
