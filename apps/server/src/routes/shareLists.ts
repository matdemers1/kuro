import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record } from '../domain/changelog.js';
import { pickImage, type ImageCache } from '../images/cache.js';

/**
 * Shared lists: Shows the owner recommends, in the owner's order with a note each, readable by
 * anyone holding the list's link without signing in. The public view shows what is on the list and
 * nothing of the owner's history — no status, progress, ratings or dates. Every owner change records
 * the whole list before and after, so undo puts it back exactly, link included.
 */

export interface ListSnapshot {
  list: { id: string; title: string; intro: string | null; token: string | null } | null;
  items: { showKey: string; position: number; note: string | null }[];
}

export async function listSnapshot(db: Db, id: string): Promise<ListSnapshot> {
  const list = await db.shareList.findUnique({ where: { id }, include: { items: { orderBy: { position: 'asc' } } } });
  if (list === null) return { list: null, items: [] };
  return { list: { id: list.id, title: list.title, intro: list.intro, token: list.token }, items: list.items.map((i) => ({ showKey: i.showKey, position: i.position, note: i.note })) };
}

export async function restoreList(db: Db, id: string, snap: ListSnapshot): Promise<void> {
  await db.$transaction(async (tx) => {
    if (snap.list === null) {
      await tx.shareList.deleteMany({ where: { id } });
      return;
    }
    const { title, intro, token } = snap.list;
    await tx.shareList.upsert({ where: { id }, create: { id, title, intro, token }, update: { title, intro, token } });
    await tx.shareListItem.deleteMany({ where: { listId: id } });
    await tx.shareListItem.createMany({ data: snap.items.map((i) => ({ listId: id, ...i })) });
  });
}

const newToken = () => randomBytes(32).toString('base64url');

const Meta = z.object({ title: z.string().trim().min(1).max(120), intro: z.string().trim().max(1000).nullish() });
const Patch = Meta.partial();
const Item = z.object({ showKey: z.string().min(1).max(300), note: z.string().trim().max(500).nullish() });
const Note = z.object({ note: z.string().trim().max(500).nullable() });
const Order = z.object({ showKeys: z.array(z.string().min(1).max(300)).max(500) });
const Link = z.object({ enabled: z.boolean(), renew: z.boolean().optional() });

/** Empty text is no text. */
const orNull = (s: string | null | undefined) => (s === undefined || s === null || s === '' ? null : s);

export function shareListRoutes(db: Db): Router {
  const router = Router();
  router.use(requireUser);

  const change = async (userId: string, id: string, action: string, mutate: (snap: ListSnapshot) => ListSnapshot) => {
    const before = await listSnapshot(db, id);
    const next = mutate(structuredClone(before));
    const after = { ...next, items: next.items.map((r, position) => ({ ...r, position })) };
    await restoreList(db, id, after);
    await record(db, { userId, entity: 'share_list', entityId: id, action, before: before as object, after });
  };

  const found = async (req: Request<{ id: string }>, res: Response) => {
    const list = await db.shareList.findUnique({ where: { id: req.params.id }, select: { id: true } }).catch(() => null);
    if (list === null) res.status(404).json({ error: 'no such list' });
    return list !== null;
  };

  router.get('/', (_req, res, next) => {
    void (async () => {
      const lists = await db.shareList.findMany({ orderBy: { updatedAt: 'desc' }, include: { items: { orderBy: { position: 'asc' }, select: { showKey: true } } } });
      res.json({ items: lists.map((l) => ({ id: l.id, title: l.title, intro: l.intro, token: l.token, count: l.items.length, showKeys: l.items.map((i) => i.showKey), updatedAt: l.updatedAt.toISOString() })) });
    })().catch(next);
  });

  /** A new list, shared from the start: making one is for sending it to someone. */
  router.post('/', (req, res, next) => {
    const body = Meta.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'a title is required' });
      return;
    }
    void (async () => {
      const id = (await db.shareList.create({ data: { title: body.data.title, intro: orNull(body.data.intro), token: newToken() } })).id;
      const after = await listSnapshot(db, id);
      await record(db, { userId: req.auth?.userId ?? '', entity: 'share_list', entityId: id, action: 'created', before: { list: null, items: [] }, after: after as object });
      res.status(201).json({ id });
    })().catch(next);
  });

  router.get('/:id', (req, res, next) => {
    void (async () => {
      if (!(await found(req, res))) return;
      const snap = await listSnapshot(db, req.params['id']);
      const states = await db.showState.findMany({ where: { showKey: { in: snap.items.map((i) => i.showKey) } }, select: { showKey: true, title: true } });
      const title = new Map(states.map((s) => [s.showKey, s.title]));
      res.json({ ...snap.list, items: snap.items.map((i) => ({ ...i, title: title.get(i.showKey) ?? i.showKey })) });
    })().catch(next);
  });

  router.put('/:id', (req, res, next) => {
    const body = Patch.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'title must be 1–120 characters' });
      return;
    }
    void (async () => {
      if (!(await found(req, res))) return;
      await change(req.auth?.userId ?? '', req.params['id'], 'edited', (s) => ({
        ...s,
        list: s.list === null ? null : { ...s.list, ...(body.data.title !== undefined ? { title: body.data.title } : {}), ...(body.data.intro !== undefined ? { intro: orNull(body.data.intro) } : {}) },
      }));
      res.status(204).end();
    })().catch(next);
  });

  router.delete('/:id', (req, res, next) => {
    void (async () => {
      if (!(await found(req, res))) return;
      await change(req.auth?.userId ?? '', req.params['id'], 'deleted', () => ({ list: null, items: [] }));
      res.status(204).end();
    })().catch(next);
  });

  /** Sharing on or off; `renew` makes a new link, so whoever had the old one no longer can read it. */
  router.put('/:id/link', (req, res, next) => {
    const body = Link.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'enabled is required' });
      return;
    }
    void (async () => {
      if (!(await found(req, res))) return;
      const action = !body.data.enabled ? 'unshared' : body.data.renew === true ? 'link_renewed' : 'shared';
      await change(req.auth?.userId ?? '', req.params['id'], action, (s) => ({
        ...s,
        list: s.list === null ? null : { ...s.list, token: !body.data.enabled ? null : body.data.renew === true || s.list.token === null ? newToken() : s.list.token },
      }));
      res.json({ token: (await db.shareList.findUnique({ where: { id: req.params['id'] }, select: { token: true } }))?.token ?? null });
    })().catch(next);
  });

  router.post('/:id/items', (req, res, next) => {
    const body = Item.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'showKey is required' });
      return;
    }
    void (async () => {
      if (!(await found(req, res))) return;
      if ((await db.showState.findUnique({ where: { showKey: body.data.showKey } })) === null) {
        res.status(404).json({ error: 'no such show' });
        return;
      }
      await change(req.auth?.userId ?? '', req.params['id'], 'added', (s) => {
        const had = s.items.find((i) => i.showKey === body.data.showKey);
        if (had !== undefined) return { ...s, items: s.items.map((i) => (i === had && body.data.note !== undefined ? { ...i, note: orNull(body.data.note) } : i)) };
        return { ...s, items: [...s.items, { showKey: body.data.showKey, position: s.items.length, note: orNull(body.data.note) }] };
      });
      res.status(201).end();
    })().catch(next);
  });

  router.put('/:id/order', (req, res, next) => {
    const body = Order.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'showKeys is required' });
      return;
    }
    void (async () => {
      if (!(await found(req, res))) return;
      const rank = new Map(body.data.showKeys.map((k, i) => [k, i]));
      await change(req.auth?.userId ?? '', req.params['id'], 'reordered', (s) => ({ ...s, items: [...s.items].sort((a, b) => (rank.get(a.showKey) ?? Infinity) - (rank.get(b.showKey) ?? Infinity) || a.position - b.position) }));
      res.status(204).end();
    })().catch(next);
  });

  router.put('/:id/items/:showKey', (req, res, next) => {
    const body = Note.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'note must be text or null' });
      return;
    }
    const key = req.params['showKey'];
    void (async () => {
      if (!(await found(req, res))) return;
      await change(req.auth?.userId ?? '', req.params['id'], 'note', (s) => ({ ...s, items: s.items.map((i) => (i.showKey === key ? { ...i, note: orNull(body.data.note) } : i)) }));
      res.status(204).end();
    })().catch(next);
  });

  router.delete('/:id/items/:showKey', (req, res, next) => {
    const key = req.params['showKey'];
    void (async () => {
      if (!(await found(req, res))) return;
      await change(req.auth?.userId ?? '', req.params['id'], 'removed', (s) => ({ ...s, items: s.items.filter((i) => i.showKey !== key) }));
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

/** A Show's first Crunchyroll series: where its art, synopsis and Crunchyroll page come from. */
async function seriesOf(db: Db, showKeys: readonly string[]): Promise<Map<string, string>> {
  const shows = await db.show.findMany({ where: { showKey: { in: showKeys.filter((k) => !k.startsWith('cr:')) } }, select: { showKey: true, seriesIds: true } });
  const out = new Map(shows.flatMap((s) => (s.seriesIds[0] === undefined ? [] : [[s.showKey, s.seriesIds[0]] as const])));
  for (const k of showKeys) if (k.startsWith('cr:')) out.set(k, k.slice(3));
  return out;
}

/**
 * The public side, mounted without requireUser: /public/lists/:token and its art. A token that is
 * not a live list's is a 404, the same as one that never was. Responses are never indexed and send
 * no referrer, so the link does not leak from the page to Crunchyroll or a search engine.
 */
export function publicListRoutes(db: Db, cache: ImageCache | undefined): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  });

  const listFor = async (token: string) => (token.length < 20 || token.length > 100 ? null : db.shareList.findUnique({ where: { token }, include: { items: { orderBy: { position: 'asc' } } } }));

  router.get('/:token', (req, res, next) => {
    void (async () => {
      const list = await listFor(req.params['token']);
      if (list === null) {
        res.status(404).json({ error: 'this list is not shared' });
        return;
      }
      const keys = list.items.map((i) => i.showKey);
      const [states, series, showItems] = await Promise.all([
        db.showState.findMany({ where: { showKey: { in: keys } }, select: { showKey: true, title: true, totalEpisodes: true } }),
        seriesOf(db, keys),
        db.showItem.findMany({ where: { showKey: { in: keys } }, orderBy: { position: 'asc' }, select: { showKey: true, kind: true, catalogEntryId: true } }),
      ]);
      const [crSeries, entries] = await Promise.all([
        db.crSeries.findMany({ where: { id: { in: [...series.values()] } }, select: { id: true, title: true, description: true, slugTitle: true, raw: true } }),
        db.catalogEntry.findMany({ where: { id: { in: showItems.map((i) => i.catalogEntryId) } }, select: { id: true, seasonYear: true, tags: true } }),
      ]);
      const state = new Map(states.map((s) => [s.showKey, s]));
      const cr = new Map(crSeries.map((s) => [s.id, s]));
      const entry = new Map(entries.map((e) => [e.id, e]));
      res.setHeader('cache-control', 'no-store');
      res.json({
        title: list.title,
        intro: list.intro,
        items: list.items.map((i, n) => {
          const s = cr.get(series.get(i.showKey) ?? '');
          const raw = (s?.raw ?? {}) as { series_launch_year?: unknown; season_count?: unknown };
          const parts = showItems.filter((x) => x.showKey === i.showKey);
          const first = entry.get(parts[0]?.catalogEntryId ?? '');
          const seasons = parts.filter((p) => p.kind === 'season').length;
          return {
            position: n,
            title: state.get(i.showKey)?.title ?? s?.title ?? 'Untitled',
            note: i.note,
            description: s?.description ?? null,
            year: first?.seasonYear ?? (typeof raw.series_launch_year === 'number' ? raw.series_launch_year : null),
            seasons: seasons > 0 ? seasons : typeof raw.season_count === 'number' ? raw.season_count : null,
            episodes: state.get(i.showKey)?.totalEpisodes ?? null,
            tags: (first?.tags ?? []).slice(0, 4),
            crunchyrollUrl: s === undefined ? null : `https://www.crunchyroll.com/series/${s.id}${s.slugTitle === null ? '' : `/${s.slugTitle}`}`,
          };
        }),
      });
    })().catch(next);
  });

  // Art for the list's own Shows only, by position: the public side can fetch nothing else.
  router.get('/:token/img/:position/:kind', (req, res, next) => {
    const kind = req.params['kind'] === 'banner' ? 'poster_wide' : req.params['kind'] === 'poster' ? 'poster_tall' : null;
    void (async () => {
      const list = cache === undefined || kind === null ? null : await listFor(req.params['token']);
      const item = list?.items[Number(req.params['position'])];
      const seriesId = item === undefined ? undefined : (await seriesOf(db, [item.showKey])).get(item.showKey);
      const s = seriesId === undefined ? null : await db.crSeries.findUnique({ where: { id: seriesId }, select: { raw: true } });
      const source = kind === null ? null : pickImage((s?.raw as { images?: unknown } | undefined)?.images, kind, kind === 'poster_wide' ? 1200 : 480);
      const image = source === null || cache === undefined ? null : await cache.get(source);
      if (image === null) {
        res.status(404).end();
        return;
      }
      res.setHeader('content-type', image.contentType);
      res.setHeader('cache-control', 'private, max-age=86400');
      res.end(image.body);
    })().catch(next);
  });

  return router;
}
