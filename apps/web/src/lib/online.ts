import { useEffect, useState } from 'react';

/** Whether the browser thinks it is online; offline, Kurō is read-only (KURO-REQ-019). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => { setOnline(true); };
    const off = () => { setOnline(false); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
