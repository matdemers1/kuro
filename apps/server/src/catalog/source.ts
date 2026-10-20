import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { z } from 'zod';

/**
 * Where the catalog comes from (KURO-REQ-025): GitHub releases of an anime-offline-database
 * continuation. cedya77 is the default; athanasso is the fallback, swapped by `KURO_CATALOG_REPO`.
 * The two publish different files — cedya77 a streamable JSONL, athanasso only minified JSON — so a
 * release is read from whichever it has.
 */

export interface CatalogSource {
  /** owner/name on GitHub. */
  readonly repo: string;
  /** The GitHub API origin; a test points it at a local server. */
  readonly apiBase?: string;
}

export interface Release {
  readonly repo: string;
  readonly tag: string;
  readonly publishedAt: Date;
  readonly url: string;
  readonly format: 'jsonl' | 'json';
}

const JSONL = 'anime-offline-database.jsonl';
const JSON_MIN = 'anime-offline-database-minified.json';
/** Weekly releases are tagged YYYY-WW; other tags (cedya77's `fillers`) are not catalog dumps. */
const WEEKLY = /^\d{4}-\d{2}$/;

const ReleaseList = z.array(
  z.object({
    tag_name: z.string(),
    published_at: z.string(),
    draft: z.boolean().default(false),
    assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() })),
  }),
);

const headers = { accept: 'application/vnd.github+json', 'user-agent': 'kuro-catalog-import' };

/** The newest weekly release that carries a catalog file. */
export async function latestRelease(source: CatalogSource): Promise<Release> {
  const api = source.apiBase ?? 'https://api.github.com';
  const res = await fetch(`${api}/repos/${source.repo}/releases?per_page=20`, { headers });
  if (!res.ok) throw new Error(`release list for ${source.repo}: HTTP ${String(res.status)}`);
  const releases = ReleaseList.parse(await res.json())
    .filter((r) => !r.draft && WEEKLY.test(r.tag_name))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  for (const r of releases) {
    const jsonl = r.assets.find((a) => a.name === JSONL);
    const json = r.assets.find((a) => a.name === JSON_MIN);
    const asset = jsonl ?? json;
    if (asset === undefined) continue;
    return { repo: source.repo, tag: r.tag_name, publishedAt: new Date(r.published_at), url: asset.browser_download_url, format: jsonl !== undefined ? 'jsonl' : 'json' };
  }
  throw new Error(`no weekly release of ${source.repo} carries ${JSONL} or ${JSON_MIN}`);
}

/** Every raw record in a release, in file order. */
export async function* readRelease(release: Release): AsyncGenerator {
  const res = await fetch(release.url, { headers: { 'user-agent': headers['user-agent'] }, redirect: 'follow' });
  if (!res.ok || res.body === null) throw new Error(`download ${release.tag}: HTTP ${String(res.status)}`);
  if (release.format === 'json') {
    const doc = (await res.json()) as { data?: unknown };
    if (!Array.isArray(doc.data)) throw new Error(`${release.tag}: no data array`);
    yield* doc.data as unknown[];
    return;
  }
  const lines = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    // The first line is the file's own metadata ($schema, license, lastUpdate).
    if (!('sources' in record)) continue;
    yield record;
  }
}
