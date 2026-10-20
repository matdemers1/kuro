import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { heatmap, lifetime, localDay, yearInReview, years } from '../stats/stats.js';

/**
 * Insights (KURO-T-5.1, KURO-T-5.2): lifetime stats with the last year's watch heatmap, the years
 * with plays, and a year in review for each.
 */

/** The heatmap's span: 53 weeks back to the Sunday that starts the first column, through today. */
function span(now: Date, tz: string): { from: string; to: string } {
  const to = localDay(now, tz);
  const t = new Date(`${to}T00:00:00Z`);
  const from = new Date(t.getTime() - (52 * 7 + t.getUTCDay()) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to };
}

export function statsRoutes(db: Db, tz: string): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', (_req, res, next) => {
    void (async () => {
      const now = new Date();
      const { from, to } = span(now, tz);
      const [life, days, all] = await Promise.all([lifetime(db, tz, now), heatmap(db, tz, from, to), years(db, tz)]);
      res.json({ ...life, timezone: tz, heatmap: { from, to, days }, years: all });
    })().catch(next);
  });

  router.get('/years/:year', (req, res, next) => {
    const year = Number(req.params['year']);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'year must be a four-digit year' });
      return;
    }
    void (async () => {
      const review = await yearInReview(db, tz, year);
      if (review === null) {
        res.status(404).json({ error: 'no plays that year' });
        return;
      }
      res.json(review);
    })().catch(next);
  });

  return router;
}
