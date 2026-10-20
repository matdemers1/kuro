import type { Db } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Every user mutation writes a row here (KURO-REQ-022), with what it replaced. Undo arrives in
 * KURO-T-1.12; the row shape is already the one undo needs.
 */
export async function record(
  db: Db | Prisma.TransactionClient,
  entry: {
    userId: string | null;
    entity: string;
    entityId: string;
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.changeLog.create({
    data: {
      userId: entry.userId,
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      ...(entry.before !== undefined ? { before: entry.before } : {}),
      ...(entry.after !== undefined ? { after: entry.after } : {}),
    },
  });
}
