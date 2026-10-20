import webpush from 'web-push';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

/**
 * Web Push is Kurō's only alert channel (KURO-ADR-010). The transport is an adapter so tests need
 * no push service; alerts carry a key, and a key that was already sent is never sent again.
 */

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type DeliveryResult = 'ok' | 'gone' | 'failed';

export interface PushTransport {
  send(target: PushTarget, payload: string): Promise<DeliveryResult>;
}

export function vapidTransport(keys: { publicKey: string; privateKey: string; subject: string }, log: Logger): PushTransport {
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return {
    async send(target, payload) {
      try {
        await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, { TTL: 24 * 60 * 60 });
        return 'ok';
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return 'gone';
        log.warn({ status }, 'push delivery failed');
        return 'failed';
      }
    },
  };
}

export interface AlertInput {
  /** Identifies the event, not the message: the same key never notifies twice. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
}

export class Alerts {
  constructor(
    private readonly db: Db,
    private readonly transport: PushTransport | null,
    private readonly log: Logger,
  ) {}

  /** Send once. Returns false when the key was already sent (or there is no transport). */
  async send(alert: AlertInput): Promise<boolean> {
    // Claim the key first: two racing checks cannot both send.
    const claimed = await this.db.alert.createMany({ data: [{ key: alert.key, title: alert.title, body: alert.body, url: alert.url ?? null }], skipDuplicates: true });
    if (claimed.count === 0) return false;
    if (this.transport === null) {
      this.log.info({ key: alert.key }, 'alert recorded; push is not configured');
      return true;
    }
    const payload = JSON.stringify({ title: alert.title, body: alert.body, url: alert.url ?? '/', tag: alert.key });
    let delivered = 0;
    for (const target of await this.db.pushSubscription.findMany()) {
      const result = await this.transport.send(target, payload);
      if (result === 'ok') {
        delivered++;
        await this.db.pushSubscription.update({ where: { id: target.id }, data: { lastOkAt: new Date() } });
      } else if (result === 'gone') {
        await this.db.pushSubscription.delete({ where: { id: target.id } });
      }
    }
    await this.db.alert.update({ where: { key: alert.key }, data: { delivered } });
    this.log.info({ key: alert.key, delivered }, 'alert sent');
    return true;
  }
}
