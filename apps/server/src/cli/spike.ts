import { randomUUID } from 'node:crypto';
import { CrSidecar, CrSidecarError } from '../adapters/crunchyroll.js';
import { prompt } from './prompt.js';

/**
 * KURO-T-0.6 — does the premise hold? Signs in to Crunchyroll once through the sidecar, walks the
 * whole watch history, and prints only aggregate facts: how many pages, how far back, and whether
 * a rewatched episode shows up more than once. It stores nothing, writes nothing, and prints no
 * IDs, titles or tokens — the output is safe to paste into Foreman.
 *
 *   docker compose run --rm -it kuro-server node dist/cli/main.js spike      (on the Zima)
 *   KURO_CR_URL=http://127.0.0.1:8080 pnpm kuro spike                          (anywhere)
 */

const PAGE_SIZE = 100;
const PAUSE_MS = 1500; // paced, as the real backfill will be (KURO-REQ-003)

interface Entry {
  id?: unknown;
  date_played?: unknown;
  fully_watched?: unknown;
}

export async function spike(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const sidecar = new CrSidecar(env['KURO_CR_URL'] ?? 'http://kuro-cr:8080');
  const email = env['CR_EMAIL'] ?? (await prompt('Crunchyroll email: '));
  const password = env['CR_PASSWORD'] ?? (await prompt('Crunchyroll password (not shown, used once): ', { hidden: true }));
  const deviceId = randomUUID();

  const started = Date.now();
  let session;
  try {
    session = await sidecar.linkWithPassword(email, password, deviceId);
  } catch (err) {
    report({ outcome: 'sign-in failed', kind: err instanceof CrSidecarError ? err.kind : 'unknown', message: err instanceof Error ? err.message : String(err) });
    return 1;
  }
  console.log('✓ signed in through the sidecar (password grant from this IP works)');

  let refreshToken = session.refreshToken;
  let page = 1;
  let total: number | null = null;
  let entries = 0;
  let fullyWatched = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  const perEpisode = new Map<string, number>();
  const perYear = new Map<string, number>();

  for (;;) {
    let result;
    try {
      result = await sidecar.historyPage({ refreshToken, deviceId, accountId: session.accountId, page, pageSize: PAGE_SIZE });
    } catch (err) {
      report({ outcome: `stopped at page ${String(page)}`, kind: err instanceof CrSidecarError ? err.kind : 'unknown', message: err instanceof Error ? err.message : String(err), pagesRead: page - 1, entries });
      return 1;
    }
    refreshToken = result.refreshToken;
    total ??= result.total;
    if (result.items.length === 0) break;
    for (const raw of result.items as Entry[]) {
      entries++;
      if (raw.fully_watched === true) fullyWatched++;
      if (typeof raw.id === 'string') perEpisode.set(raw.id, (perEpisode.get(raw.id) ?? 0) + 1);
      if (typeof raw.date_played === 'string') {
        if (oldest === null || raw.date_played < oldest) oldest = raw.date_played;
        if (newest === null || raw.date_played > newest) newest = raw.date_played;
        const year = raw.date_played.slice(0, 4);
        perYear.set(year, (perYear.get(year) ?? 0) + 1);
      }
    }
    process.stdout.write(`\r… page ${String(page)}${total !== null ? ` of ~${String(Math.ceil(total / PAGE_SIZE))}` : ''}, ${String(entries)} entries`);
    if (total !== null && entries >= total) break;
    page++;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  process.stdout.write('\n');

  const repeated = [...perEpisode.values()].filter((n) => n > 1).length;
  report({
    outcome: 'complete',
    pages: page,
    entries,
    reportedTotal: total,
    distinctEpisodes: perEpisode.size,
    fullyWatched,
    oldestDatePlayed: oldest,
    newestDatePlayed: newest,
    entriesPerYear: Object.fromEntries([...perYear.entries()].sort()),
    episodesAppearingMoreThanOnce: repeated,
    rewatchesCollapsed: repeated === 0 ? 'yes — each episode appears once; rewatches must be detected going forward (KURO-REQ-023)' : 'no — a replay is its own entry',
    seconds: Math.round((Date.now() - started) / 1000),
  });
  return 0;
}

function report(facts: Record<string, unknown>): void {
  console.log('\nKURO-T-0.6 spike result (aggregates only — safe to paste):');
  console.log(JSON.stringify(facts, null, 2));
}
