import webpush from 'web-push';

/**
 * `kuro vapid-keys` — print a new VAPID key pair as two env lines, for server.env. Generated once
 * per installation; changing them invalidates every existing push subscription.
 */
export function vapidKeys(): number {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  return 0;
}
