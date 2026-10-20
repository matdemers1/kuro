import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedImageUrl, ImageCache, pickImage } from '../../src/images/cache.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kuro-img-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
let calls = 0;
const fakeFetch = ((url: URL) => {
  calls++;
  const isImage = !url.pathname.endsWith('.html');
  return Promise.resolve(new Response(isImage ? PNG : '<html>', { status: 200, headers: { 'content-type': isImage ? 'image/png' : 'text/html' } }));
}) as unknown as typeof fetch;

describe('the image cache (KURO-REQ-021)', () => {
  it('only ever fetches from Crunchyroll image hosts, over https', () => {
    expect(allowedImageUrl('https://imgsrv.crunchyroll.com/cdn-cgi/image/w=240/poster.jpg')).not.toBeNull();
    for (const bad of ['http://imgsrv.crunchyroll.com/x.jpg', 'https://evil.example/x.jpg', 'https://169.254.169.254/latest', 'not a url']) expect(allowedImageUrl(bad)).toBeNull();
  });

  it('fetches once and serves the second view from disk', async () => {
    const cache = new ImageCache(dir, fakeFetch);
    const url = 'https://imgsrv.crunchyroll.com/a/poster.jpg';
    const first = await cache.get(url);
    const second = await cache.get(url);
    expect(first?.contentType).toBe('image/png');
    expect(second?.body.equals(PNG)).toBe(true);
    expect(cache.upstreamFetches).toBe(1);
    expect(calls).toBe(1);
  });

  it('survives a restart: a new cache over the same volume makes no request', async () => {
    const again = new ImageCache(dir, fakeFetch);
    await again.get('https://imgsrv.crunchyroll.com/a/poster.jpg');
    expect(again.upstreamFetches).toBe(0);
  });

  it('refuses something that is not an image', async () => {
    expect(await new ImageCache(dir, fakeFetch).get('https://imgsrv.crunchyroll.com/page.html')).toBeNull();
  });

  it('picks the smallest image at least as wide as asked, from nested lists', () => {
    const images = { poster_tall: [[{ source: 'a', width: 60 }, { source: 'b', width: 240 }, { source: 'c', width: 480 }]] };
    expect(pickImage(images, 'poster_tall', 200)).toBe('b');
    expect(pickImage(images, 'poster_tall', 9999)).toBe('c');
    expect(pickImage({}, 'thumbnail', 100)).toBeNull();
  });
});
