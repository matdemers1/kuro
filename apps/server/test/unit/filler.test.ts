import { describe, expect, it } from 'vitest';
import { AnimeFillerList, parseEpisodes, parseIndex } from '../../src/adapters/fillerlist.js';
import { kindOf, linkSeasons, namesOf } from '../../src/filler/link.js';

/** KURO-T-5.3: reading the filler guide's pages, and linking a list's numbers to a Show's Seasons. */

const INDEX = `<div id="block-x"><a href="/shows/elsewhere">Not in the list</a></div>
<div id="ShowList"><div class="Group"><h2>S</h2><ul>
<li><a href="/shows/synthetic-saga">Synthetic Saga (Gousei Monogatari)</a></li>
<li><a href="/shows/synthetic-saga-movies">Synthetic Saga Films</a></li>
<li><a href="/shows/synthetic-saga-next">Synthetic Saga: Next &amp; Beyond</a></li>
</ul></div></div>`;

const EPISODES = `<table class="EpisodeList"><tbody>
<tr class="manga_canon odd" id="eps-1"><td class="Number">1</td><td class="Title">One</td></tr>
<tr class="filler even" id="eps-2"><td class="Number">2</td><td class="Title">Two</td></tr>
<tr class="mixed_canon/filler odd" id="eps-3"><td class="Number">3</td><td class="Title">Three</td></tr>
<tr class="anime_canon even" id="eps-4"><td class="Number">4</td><td class="Title">Four</td></tr>
</tbody></table>`;

describe('the filler guide’s pages', () => {
  it('reads the show index, leaving out film lists and anything outside the list', () => {
    expect(parseIndex(INDEX)).toEqual([
      { slug: 'synthetic-saga', title: 'Synthetic Saga (Gousei Monogatari)' },
      { slug: 'synthetic-saga-next', title: 'Synthetic Saga: Next & Beyond' },
    ]);
  });

  it('reads each episode’s kind', () => {
    expect(parseEpisodes(EPISODES)).toEqual([
      { number: 1, kind: 'canon' },
      { number: 2, kind: 'filler' },
      { number: 3, kind: 'mixed' },
      { number: 4, kind: 'anime_canon' },
    ]);
  });

  it('waits the crawl delay between requests', async () => {
    const at: number[] = [];
    const client = new AnimeFillerList((() => { at.push(Date.now()); return Promise.resolve(new Response(EPISODES)); }), 'https://example.test', 150);
    await client.episodes('a');
    await client.episodes('b');
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(140);
  });
});

describe('linking a list to Seasons', () => {
  const season = (entryId: string, title: string, episodes: number, synonyms: string[] = []) => ({ entryId, title, synonyms, episodes });

  it('takes the whole name and both halves of "English (Romaji)", but a year in brackets stays part of the name', () => {
    expect(namesOf('My Hero Academia (Boku no Hero Academia)')).toEqual(['my hero academia boku no hero academia', 'my hero academia', 'boku no hero academia']);
    expect(namesOf('Fruits Basket (2019)')).toEqual(['fruits basket 2019']);
  });

  it('numbers straight through the Seasons after the matched one, until the list runs out', () => {
    const links = linkSeasons([season('s1', 'Gousei Monogatari', 13), season('s2', 'Gousei Monogatari 2nd Season', 25), season('s3', 'Gousei Monogatari 3rd Season', 25)], [{ slug: 'synthetic-saga', title: 'Synthetic Saga (Gousei Monogatari)', count: 38 }]);
    expect([...links]).toEqual([['s1', { slug: 'synthetic-saga', offset: 0 }], ['s2', { slug: 'synthetic-saga', offset: 13 }]]);
    const kinds = new Map([['synthetic-saga', new Map([[14, 'filler' as const]])]]);
    expect(kindOf(links, kinds, 's2', 1)).toBe('filler');
    expect(kindOf(links, kinds, 's2', 2)).toBeUndefined();
    expect(kindOf(links, kinds, 's3', 1)).toBeUndefined();
  });

  it('a later Season with a list of its own starts that list', () => {
    const links = linkSeasons([season('a', 'Synthetic Saga', 220), season('b', 'Shippu', 500, ['Synthetic Saga: Next & Beyond'])], [
      { slug: 'synthetic-saga', title: 'Synthetic Saga (Gousei Monogatari)', count: 1000 },
      { slug: 'synthetic-saga-next', title: 'Synthetic Saga: Next & Beyond', count: 500 },
    ]);
    expect(links.get('b')).toEqual({ slug: 'synthetic-saga-next', offset: 0 });
  });

  it('a name two lists share links neither', () => {
    const lists = [{ slug: 'fb-2001', title: 'Fruits Basket (Furuba)', count: 26 }, { slug: 'fb-2019', title: 'Fruits Basket (2019)', count: 63 }, { slug: 'fb-other', title: 'Fruits Basket (Another)', count: 10 }];
    expect(linkSeasons([season('x', 'Fruits Basket (2019)', 25, ['Fruits Basket'])], lists).get('x')?.slug).toBe('fb-2019');
    expect(linkSeasons([season('y', 'Something', 25, ['Fruits Basket'])], lists).size).toBe(0);
  });

  it('an unknown episode count ends the run', () => {
    const links = linkSeasons([season('s1', 'Gousei Monogatari', 0), season('s2', 'Gousei Monogatari 2nd Season', 12)], [{ slug: 'synthetic-saga', title: 'Synthetic Saga (Gousei Monogatari)', count: 500 }]);
    expect([...links.keys()]).toEqual(['s1']);
  });
});
