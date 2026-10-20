import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Images, fetched once and kept (KURO-REQ-021). Content-addressed by a hash of the source URL on
 * the `images` volume, served by Kurō with a long cache. Only Crunchyroll's image hosts and the
 * catalog's (MyAnimeList's CDN, which anime-offline-database links) are ever fetched, so the cache
 * cannot be turned into a way to make the server request anything else.
 */

const ALLOWED_HOSTS = new Set(['imgsrv.crunchyroll.com', 'static.crunchyroll.com', 'img1.ak.crunchyroll.com', 'cdn.myanimelist.net']);
const MAX_BYTES = 5 * 1024 * 1024;

export function allowedImageUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** The best image at least `width` wide from Crunchyroll's nested image lists. */
export function pickImage(images: unknown, kind: 'poster_tall' | 'thumbnail', width: number): string | null {
  const list = (images as Record<string, unknown> | null | undefined)?.[kind];
  if (!Array.isArray(list)) return null;
  const flat = (list as unknown[]).flat().filter((i): i is { source: string; width: number } => typeof (i as { source?: unknown }).source === 'string' && typeof (i as { width?: unknown }).width === 'number');
  const sorted = flat.sort((a, b) => a.width - b.width);
  return (sorted.find((i) => i.width >= width) ?? sorted.at(-1))?.source ?? null;
}

export interface CachedImage {
  readonly body: Buffer;
  readonly contentType: string;
}

export class ImageCache {
  upstreamFetches = 0;

  constructor(
    private readonly dir: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private paths(url: URL) {
    const key = createHash('sha256').update(url.toString()).digest('hex');
    const base = join(this.dir, key.slice(0, 2), key);
    return { dir: join(this.dir, key.slice(0, 2)), body: base, type: `${base}.type` };
  }

  async get(source: string): Promise<CachedImage | null> {
    const url = allowedImageUrl(source);
    if (url === null) return null;
    const p = this.paths(url);
    try {
      const [body, contentType] = await Promise.all([readFile(p.body), readFile(p.type, 'utf8')]);
      return { body, contentType };
    } catch {
      // Not cached yet.
    }
    this.upstreamFetches++;
    const res = await this.fetcher(url, { signal: AbortSignal.timeout(15_000) });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.startsWith('image/')) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BYTES) return null;
    await mkdir(p.dir, { recursive: true });
    // Write then rename, so a half-written file is never served.
    await writeFile(`${p.body}.tmp`, body);
    await writeFile(p.type, contentType);
    await rename(`${p.body}.tmp`, p.body);
    return { body, contentType };
  }
}
