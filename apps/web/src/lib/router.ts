import { useEffect, useState } from 'react';

/** A tiny path router: four tabs and a Show page do not need a dependency. */
export function usePath(): string {
  const [path, setPath] = useState(() => (typeof window === 'undefined' ? '/' : window.location.pathname));
  useEffect(() => {
    const onPop = () => { setPath(window.location.pathname); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('kuro:navigate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('kuro:navigate', onPop);
    };
  }, []);
  return path;
}

export function navigate(to: string): void {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('kuro:navigate'));
  window.scrollTo(0, 0);
}
