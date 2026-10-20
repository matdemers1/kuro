import { z } from 'zod';
import type { Db } from '../db.js';
import type { OverrideIn } from '../derive/grouping.js';

/**
 * Grouping overrides (KURO-T-2.6): what the owner said about how Shows are put together. Stored as
 * written and applied in order of creation, so a later correction wins over an earlier one.
 */

const Ids = z.array(z.string().min(1).max(300)).min(1).max(50);
export const OverrideBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merge'), seriesIds: Ids.min(2) }),
  z.object({ kind: z.literal('split'), entryIds: Ids }),
  z.object({ kind: z.literal('reorder'), entryIds: Ids.min(2) }),
  z.object({ kind: z.literal('attach'), entryId: z.string().min(1).max(300), afterEntryId: z.string().min(1).max(300) }),
]);
export type OverrideBody = z.infer<typeof OverrideBody>;

export async function loadOverrides(db: Db): Promise<OverrideIn[]> {
  const rows = await db.override.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.flatMap((r) => {
    const parsed = OverrideBody.safeParse({ ...(r.payload as object), kind: r.kind });
    return parsed.success ? [parsed.data] : [];
  });
}

/** The ids an override is anchored on: what the Show page shows it under. */
export function anchors(o: OverrideBody): string[] {
  switch (o.kind) {
    case 'merge':
      return [...o.seriesIds];
    case 'split':
    case 'reorder':
      return [...o.entryIds];
    case 'attach':
      return [o.entryId, o.afterEntryId];
  }
}
