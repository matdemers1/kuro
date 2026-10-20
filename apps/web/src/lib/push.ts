import { api } from './api.js';

/** The key the push service needs, in the form the browser takes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Ask once, subscribe this device, and tell the server. On iPhone this works from the home-screen app. */
export async function enablePush(): Promise<'enabled' | 'denied' | 'unavailable'> {
  if (!pushSupported()) return 'unavailable';
  const { publicKey } = await api<{ publicKey: string | null }>('/api/push/key');
  if (publicKey === null) return 'unavailable';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api('/api/push/subscribe', { body: subscription.toJSON() });
  return 'enabled';
}
