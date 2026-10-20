import type { FillerKind } from '../adapters/fillerlist.js';
import { normalise } from '../match/titles.js';

/**
 * Where a filler list's numbers fall in a Show (KURO-T-5.3). The site numbers a run straight through
 * — My Hero Academia 1–170 across seven Seasons — so a list links to the Season its name matches and
 * carries on through the Seasons after it, each starting where the one before ended, until the list
 * runs out or the next Season has a list of its own (Naruto, then Naruto Shippuden). Pure.
 */

export interface SeasonIn {
  entryId: string;
  title: string;
  synonyms: readonly string[];
  /** The catalog's episode count; 0 while unknown, which ends a run. */
  episodes: number;
}

export interface ListIn {
  slug: string;
  /** "My Hero Academia (Boku no Hero Academia)": both names count. */
  title: string;
  count: number;
}

/**
 * "My Hero Academia (Boku no Hero Academia)" → its whole name, and its English and romaji names. A
 * year in brackets is part of the name, not a second one: "Fruits Basket (2019)" is not "Fruits Basket".
 */
export function namesOf(title: string): string[] {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title);
  const parts = m === null || /^\d{4}$/.test((m[2] ?? '').trim()) ? [title] : [title, m[1] ?? '', m[2] ?? ''];
  return [...new Set(parts.map(normalise).filter((n) => n.length > 0))];
}

/** The list a Season's own names match, if any. */
function listFor(season: SeasonIn, byName: ReadonlyMap<string, ListIn>): ListIn | undefined {
  for (const t of [season.title, ...season.synonyms]) {
    const hit = byName.get(normalise(t));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function linkSeasons(seasons: readonly SeasonIn[], lists: readonly ListIn[]): Map<string, { slug: string; offset: number }> {
  // A name two lists share (the 2001 and 2019 Fruits Basket) links neither.
  const named = lists.flatMap((l) => namesOf(l.title).map((n) => [n, l] as const));
  const shared = new Set(named.filter(([n], i) => named.findIndex(([m]) => m === n) !== i).map(([n]) => n));
  const byName = new Map(named.filter(([n]) => !shared.has(n)));
  const out = new Map<string, { slug: string; offset: number }>();
  let run: { list: ListIn; offset: number } | null = null;
  for (const s of seasons) {
    const own = listFor(s, byName);
    if (own !== undefined && own.slug !== run?.list.slug) run = { list: own, offset: 0 };
    if (run === null || run.offset >= run.list.count) {
      run = null;
      continue;
    }
    out.set(s.entryId, { slug: run.list.slug, offset: run.offset });
    if (s.episodes <= 0) run = null;
    else run.offset += s.episodes;
  }
  return out;
}

/** A Season's episode → its kind on the linked list, or undefined when nothing covers it. */
export function kindOf(
  links: ReadonlyMap<string, { slug: string; offset: number }>,
  kinds: ReadonlyMap<string, ReadonlyMap<number, FillerKind>>,
  entryId: string,
  episode: number,
): FillerKind | undefined {
  const link = links.get(entryId);
  return link === undefined ? undefined : kinds.get(link.slug)?.get(link.offset + episode);
}
