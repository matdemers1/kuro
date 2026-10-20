/**
 * Title matching for the matcher (KURO-T-2.3): one normal form for every title and synonym in the
 * catalog, an exact index over it, and a token index for near misses. Crunchyroll and the catalog
 * spell the same show differently — "SPY x FAMILY" and "Spy x Family", "Demon Slayer: Kimetsu no
 * Yaiba" as a synonym of "Kimetsu no Yaiba" — so nothing compares raw strings.
 */

const STOP = new Set(['the', 'a', 'an', 'no', 'of', 'to', 'wa', 'ga', 'and', 'x', 'season', 'part', 'cour', 'tv', 'arc', 'hen']);

export function normalise(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The title with Crunchyroll's season and dub decorations taken off, for a second look-up. */
export function core(title: string): string {
  return normalise(
    title
      .replace(/\((?:[^)]*dub|[^)]*sub(?:bed|titled)?)\)/gi, ' ')
      .replace(/\b(?:season|part|cour)\s*\d+\b/gi, ' ')
      .replace(/\b\d+(?:st|nd|rd|th)\s+(?:season|cour|part)\b/gi, ' ')
      // A subtitle after ': ' or ' - ' (not 'Re:ZERO', whose colon has no space after it).
      .replace(/\s*(?::|\s[-–])\s.*$/, ' '),
  );
}

export function tokens(normalised: string): string[] {
  // A bare number says nothing on its own: "Season 2" must not find every "Part 2" in the catalog.
  return normalised.split(' ').filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

export interface Titled {
  readonly id: string;
  readonly title: string;
  readonly synonyms: readonly string[];
}

export class TitleIndex<T extends Titled> {
  private readonly exact = new Map<string, Set<string>>();
  private readonly byToken = new Map<string, Set<string>>();
  private readonly entries = new Map<string, T>();

  constructor(entries: Iterable<T>) {
    for (const e of entries) {
      this.entries.set(e.id, e);
      const all = new Set<string>();
      for (const t of [e.title, ...e.synonyms]) {
        const n = normalise(t);
        if (n === '') continue;
        add(this.exact, n, e.id);
        for (const tok of tokens(n)) all.add(tok);
      }
      for (const tok of all) add(this.byToken, tok, e.id);
    }
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  /** Entries one of whose titles is exactly this one, after normalising. */
  exactly(title: string): T[] {
    return [...(this.exact.get(normalise(title)) ?? [])].flatMap((id) => this.entries.get(id) ?? []);
  }

  /**
   * The best `limit` entries for a set of titles: exact hits first, then by token overlap. Tokens
   * shared by thousands of entries say nothing and are skipped.
   */
  search(titles: readonly string[], limit = 25): T[] {
    const score = new Map<string, number>();
    const queryTokens = new Set<string>();
    for (const t of titles) {
      // An exact hit on the whole title outranks one on its stripped core ("Show" for "Show Season 2").
      const whole = normalise(t);
      const stripped = core(t);
      for (const [n, weight] of [[whole, 12], [stripped, 8]] as const) {
        // A title with nothing but stop words and numbers ("Season 2") names nothing: some catalog
        // entry lists it as a synonym, and it would match that.
        if (n === '' || tokens(n).length === 0 || (n === stripped && stripped === whole && weight === 8)) continue;
        for (const id of this.exact.get(n) ?? []) score.set(id, (score.get(id) ?? 0) + weight);
        for (const tok of tokens(n)) queryTokens.add(tok);
      }
    }
    if (queryTokens.size > 0) {
      const seen = new Map<string, number>();
      for (const tok of queryTokens) {
        const holders = this.byToken.get(tok);
        if (holders === undefined || holders.size > 2000) continue;
        for (const id of holders) seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      // Coverage, not Jaccard: an entry with fifty synonyms in ten languages holds many tokens, and
      // what matters is how much of the Crunchyroll title it accounts for.
      for (const [id, shared] of seen) {
        const coverage = shared / queryTokens.size;
        if (coverage >= 0.6) score.set(id, (score.get(id) ?? 0) + coverage * 5);
      }
    }
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .flatMap(([id]) => this.entries.get(id) ?? []);
  }
}

function add(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (set === undefined) map.set(key, (set = new Set()));
  set.add(id);
}
