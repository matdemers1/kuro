import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { pickImage, type ImageCache } from '../images/cache.js';

/** /img/series/:id/poster and /img/episode/:id/thumb — the only images the app shows. */
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

  router.get('/series/:id/poster', serve(async (id) => {
    const s = await db.crSeries.findUnique({ where: { id }, select: { raw: true } });
    return pickImage((s?.raw as { images?: unknown } | undefined)?.images, 'poster_tall', 240);
  }));

  router.get('/episode/:id/thumb', serve(async (id) => {
    const e = await db.crEpisode.findUnique({ where: { id }, select: { raw: true } });
    return pickImage((e?.raw as { images?: unknown } | undefined)?.images, 'thumbnail', 320);
  }));

  return router;
}
