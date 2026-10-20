/**
 * animefillerlist.com (KURO-T-5.3, KURO-ADR-012): which episodes of a long series are filler. No API,
 * so two pages are read — the show index and one show's episode table — and its robots.txt asks for
 * ten seconds between requests, which this client keeps. Personal use, a handful of pages a week.
 */

export const FILLER_SITE = 'https://www.animefillerlist.com';
export const CRAWL_DELAY_MS = 10_000;

export type FillerKind = 'canon' | 'mixed' | 'filler' | 'anime_canon';

const KIND: Record<string, FillerKind> = { manga_canon: 'canon', 'mixed_canon/filler': 'mixed', filler: 'filler', anime_canon: 'anime_canon' };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#039': "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : m));

export interface FillerShow {
  slug: string;
  title: string;
}

/** Every show in the site's index, leaving out film, movie and special lists: only TV runs have episode numbers to mark. */
export function parseIndex(html: string): FillerShow[] {
  const list = html.slice(Math.max(0, html.indexOf('id="ShowList"')));
  const out: FillerShow[] = [];
  for (const m of list.matchAll(/<a href="\/shows\/([^"?#]+)">([^<]+)<\/a>/g)) {
    const slug = decodeURIComponent(m[1] ?? '');
    const title = decode(m[2] ?? '').trim();
    if (slug.length === 0 || /\b(films?|movies?|specials?|ova)\b/i.test(title)) continue;
    out.push({ slug, title });
  }
  return out;
}

/** The episode table: each numbered episode and what kind it is. */
export function parseEpisodes(html: string): { number: number; kind: FillerKind }[] {
  const out = new Map<number, FillerKind>();
  for (const m of html.matchAll(/<tr class="([a-z_/]+)\s+(?:odd|even)"[^>]*>\s*<td class="Number">(\d+)<\/td>/g)) {
    const kind = KIND[m[1] ?? ''];
    const number = Number(m[2]);
    if (kind !== undefined && Number.isInteger(number) && number > 0) out.set(number, kind);
  }
  return [...out].map(([number, kind]) => ({ number, kind })).sort((a, b) => a.number - b.number);
}

export interface FillerClient {
  index(): Promise<FillerShow[]>;
  episodes(slug: string): Promise<{ number: number; kind: FillerKind }[]>;
}

export class AnimeFillerList implements FillerClient {
  private last = 0;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly site = FILLER_SITE,
    private readonly delayMs = CRAWL_DELAY_MS,
  ) {}

  private async get(path: string): Promise<string> {
    const wait = this.last + this.delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const res = await this.fetchFn(`${this.site}${path}`, { headers: { 'user-agent': 'kuro (personal anime tracker)', accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`animefillerlist answered ${String(res.status)} for ${path}`);
    return res.text();
  }

  async index(): Promise<FillerShow[]> {
    return parseIndex(await this.get('/shows'));
  }

  async episodes(slug: string): Promise<{ number: number; kind: FillerKind }[]> {
    return parseEpisodes(await this.get(`/shows/${encodeURIComponent(slug)}`));
  }
}
