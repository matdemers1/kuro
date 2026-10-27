import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { pickImage, type ImageCache } from '../images/cache.js';

/** /img/series/:id/poster, /img/show/:key/{poster,banner}, /img/episode/:id/thumb and /img/catalog/:id — the only images the app shows. */
export function imageRoutes(db: Db, cache: ImageCache): Router {
  const router = Router();
  router.use(requireUser);

  const serve = (find: (id: string) => Promise<string | null>) => (req: { params: Record<string, string | undefined> }, res: import('express').Response, next: import('express').NextFunction) => {
    void (async () => {
      const source = await find(req.params['id'] ?? '');
      const image = source === null ? null : await cache.get(source);
      if (image === null) {
        res.status(404).end();
        return;
      }
      res.setHeader('content-type', image.contentType);
      res.setHeader('cache-control', 'private, max-age=604800, immutable');
      res.end(image.body);
    })().catch(next);
  };

  const seriesArt = async (id: string, kind: 'poster_tall' | 'poster_wide', width: number) => {
    const s = await db.crSeries.findUnique({ where: { id }, select: { raw: true } });
    return pickImage((s?.raw as { images?: unknown } | undefined)?.images, kind, width);
  };
  // A Show's art is its first Crunchyroll series' (what the owner recognises from Crunchyroll).
  const showSeries = async (key: string) => (key.startsWith('cr:') ? key.slice(3) : (await db.show.findUnique({ where: { showKey: key }, select: { seriesIds: true } }))?.seriesIds[0]);

  // 480 wide: sharp at the Library grid's largest tile on a 2x screen.
  router.get('/series/:id/poster', serve((id) => seriesArt(id, 'poster_tall', 480)));

  router.get('/episode/:id/thumb', serve(async (id) => {
    const e = await db.crEpisode.findUnique({ where: { id }, select: { raw: true } });
    return pickImage((e?.raw as { images?: unknown } | undefined)?.images, 'thumbnail', 320);
  }));

  router.get('/show/:id/poster', serve(async (key) => {
    const seriesId = await showSeries(key);
    return seriesId === undefined ? null : seriesArt(seriesId, 'poster_tall', 480);
  }));

  /** The wide key art, for a Show page's banner and Up Next's spotlight. */
  router.get('/show/:id/banner', serve(async (key) => {
    const seriesId = await showSeries(key);
    return seriesId === undefined ? null : seriesArt(seriesId, 'poster_wide', 1200);
  }));

  router.get('/catalog/:id', serve(async (id) => (await db.catalogEntry.findUnique({ where: { id }, select: { picture: true } }))?.picture ?? null));

  return router;
}
