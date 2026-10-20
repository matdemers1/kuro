import { Router } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { exportJson, malXml, playsCsv, showsCsv } from '../export/export.js';

/** Downloads (KURO-T-6.1): the whole history as JSON, the Shows and plays as CSV, and a MAL XML list. */
export function exportRoutes(db: Db, tz: string): Router {
  const router = Router();
  router.use(requireUser);
  const stamp = () => new Date().toISOString().slice(0, 10);
  const send = (res: import('express').Response, type: string, name: string, body: string) => {
    res.setHeader('content-type', `${type}; charset=utf-8`);
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  };

  router.get('/kuro.json', (req, res, next) => {
    void exportJson(db, req.auth?.userId ?? '').then((x) => { send(res, 'application/json', `kuro-${stamp()}.json`, JSON.stringify(x)); }, next);
  });
  router.get('/shows.csv', (_req, res, next) => {
    void showsCsv(db).then((x) => { send(res, 'text/csv', `kuro-shows-${stamp()}.csv`, x); }, next);
  });
  router.get('/plays.csv', (req, res, next) => {
    void playsCsv(db, req.auth?.userId ?? '').then((x) => { send(res, 'text/csv', `kuro-plays-${stamp()}.csv`, x); }, next);
  });
  router.get('/mal.xml', (req, res, next) => {
    void malXml(db, req.auth?.userId ?? '', tz).then((x) => { send(res, 'application/xml', `kuro-mal-${stamp()}.xml`, x.xml); }, next);
  });
  return router;
}
